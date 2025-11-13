# VS Code Debug Integration Research

**建立日期**: 2025-11-10  
**目的**: 研究如何整合 VS Code Debug API 到 Cucumber Java Easy Runner

## A.01 - VS Code Debug API 基礎架構

### 核心 API 元件

#### 1. Debug Namespace (`vscode.debug`)

主要的 debug 功能命名空間,提供以下關鍵功能:

```typescript
namespace debug {
  // 啟動 debug session
  function startDebugging(
    folder: WorkspaceFolder | undefined,
    nameOrConfiguration: string | DebugConfiguration,
    parentSessionOrOptions?: DebugSession | DebugSessionOptions
  ): Thenable<boolean>;

  // 註冊 debug configuration provider
  function registerDebugConfigurationProvider(
    debugType: string,
    provider: DebugConfigurationProvider,
    triggerKind?: DebugConfigurationProviderTriggerKind
  ): Disposable;

  // Debug session 事件
  const onDidStartDebugSession: Event<DebugSession>;
  const onDidTerminateDebugSession: Event<DebugSession>;
  const onDidChangeActiveDebugSession: Event<DebugSession | undefined>;
  const onDidReceiveDebugSessionCustomEvent: Event<DebugSessionCustomEvent>;

  // 當前 active debug sessions
  const activeDebugSession: DebugSession | undefined;
  const activeDebugConsole: DebugConsole;
}
```

#### 2. DebugConfiguration 介面

定義 debug 配置的結構:

```typescript
interface DebugConfiguration {
  // Debug adapter 類型 (例如 'java' for Java debugging)
  type: string;

  // Debug configuration 名稱
  name: string;

  // 請求類型: 'launch' 或 'attach'
  request: string;

  // 其他自定義屬性
  [key: string]: any;
}
```

**Java Debug 的典型配置**:

```json
{
  "type": "java",
  "name": "Attach to Cucumber Test",
  "request": "attach",
  "hostName": "localhost",
  "port": 5005
}
```

#### 3. DebugConfigurationProvider 介面

提供 debug configuration 的動態生成與解析:

```typescript
interface DebugConfigurationProvider {
  // 提供初始的 debug configurations (用於 launch.json 生成)
  provideDebugConfigurations?(
    folder: WorkspaceFolder | undefined,
    token?: CancellationToken
  ): ProviderResult<DebugConfiguration[]>;

  // 解析/驗證 debug configuration
  resolveDebugConfiguration?(
    folder: WorkspaceFolder | undefined,
    debugConfiguration: DebugConfiguration,
    token?: CancellationToken
  ): ProviderResult<DebugConfiguration>;

  // 變數替換後的最終解析
  resolveDebugConfigurationWithSubstitutedVariables?(
    folder: WorkspaceFolder | undefined,
    debugConfiguration: DebugConfiguration,
    token?: CancellationToken
  ): ProviderResult<DebugConfiguration>;
}
```

**使用方式**:

```typescript
const provider: DebugConfigurationProvider = {
  provideDebugConfigurations(folder) {
    return [
      {
        type: 'java',
        name: 'Debug Cucumber Tests',
        request: 'attach',
        hostName: 'localhost',
        port: 5005
      }
    ];
  },

  resolveDebugConfiguration(folder, config) {
    // 動態設定 port
    if (!config.port) {
      config.port = findAvailablePort();
    }
    return config;
  }
};

// 註冊 provider
context.subscriptions.push(
  vscode.debug.registerDebugConfigurationProvider('java', provider)
);
```

#### 4. DebugSession 介面

代表一個 active debug session:

```typescript
interface DebugSession {
  // 唯一識別碼
  readonly id: string;

  // Debug adapter 類型
  readonly type: string;

  // 父 session (用於 multi-session debugging)
  readonly parentSession?: DebugSession;

  // Session 名稱
  name: string;

  // 所屬 workspace folder
  readonly workspaceFolder: WorkspaceFolder | undefined;

  // 解析後的 configuration
  readonly configuration: DebugConfiguration;

  // 發送自定義請求給 debug adapter
  customRequest(command: string, args?: any): Thenable<any>;

  // 取得中斷點資訊
  getDebugProtocolBreakpoint(breakpoint: Breakpoint): Thenable<DebugProtocolBreakpoint | undefined>;
}
```

### Debug Session 生命週期

```
1. 準備階段
   ├─ 建立 DebugConfiguration
   ├─ 呼叫 provideDebugConfigurations() [optional]
   └─ 呼叫 resolveDebugConfiguration()

2. 啟動階段
   ├─ vscode.debug.startDebugging()
   ├─ 觸發 onDidStartDebugSession 事件
   └─ Debug adapter 開始連接

3. 執行階段
   ├─ 使用者設定中斷點
   ├─ 程式執行到中斷點
   ├─ 顯示 Variables/Call Stack/Watch
   └─ 使用 Debug Console

4. 結束階段
   ├─ 使用者停止 debug 或程式執行完畢
   ├─ 觸發 onDidTerminateDebugSession 事件
   └─ 清理資源
```

### Debug Session Options

啟動 debug 時的額外選項:

```typescript
interface DebugSessionOptions {
  // 父 session (用於建立 child session)
  parentSession?: DebugSession;

  // 生命週期關聯選項 (NEW!)
  lifecycleOptions?: DebugSessionLifecycleOptions;

  // 壓縮輸出 (避免 debug console 過載)
  compact?: boolean;

  // 不顯示 debug console
  noDebug?: boolean;

  // **重要**: 關聯到 Test Run (用於 Test Explorer 整合)
  testRun?: TestRun;
}
```

**關鍵發現**: `testRun` 選項可以將 debug session 與 test run 關聯,這樣 VS Code 會:
- 在 Test Explorer UI 中顯示 debug 狀態
- 自動管理 debug session 和 test run 的生命週期
- 在 test 結束時自動停止 debug session

---

## A.02 - Test Explorer Debug Profile 整合

### TestRunProfileKind.Debug

VS Code Test API 提供了 Debug Profile 支援:

```typescript
enum TestRunProfileKind {
  Run = 1,      // 一般執行
  Debug = 2,    // Debug 執行
  Coverage = 3  // Coverage 執行
}
```

### 建立 Debug Profile

在 `CucumberTestController` 中新增 Debug Profile:

```typescript
class CucumberTestController {
  private controller: vscode.TestController;
  private runProfile: vscode.TestRunProfile;
  private debugProfile: vscode.TestRunProfile;  // NEW!

  constructor(context: vscode.ExtensionContext) {
    this.controller = vscode.tests.createTestController(
      'cucumberJavaEasyRunner',
      'Cucumber Java Tests'
    );

    // 建立 Run Profile
    this.runProfile = this.controller.createRunProfile(
      'Run Cucumber Tests',
      vscode.TestRunProfileKind.Run,
      (request, token) => this.runTests(request, token, false),
      true  // isDefault
    );

    // 建立 Debug Profile (NEW!)
    this.debugProfile = this.controller.createRunProfile(
      'Debug Cucumber Tests',
      vscode.TestRunProfileKind.Debug,
      (request, token) => this.runTests(request, token, true),  // isDebug = true
      false  // not default
    );
  }

  private async runTests(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
    isDebug: boolean  // NEW parameter
  ) {
    const run = this.controller.createTestRun(request);

    for (const testItem of request.include || this.gatherAllTests()) {
      if (token.isCancellationRequested) break;

      // 傳遞 isDebug 參數給執行函數
      await this.runSingleTest(testItem, run, isDebug);
    }

    run.end();
  }

  private async runSingleTest(
    testItem: vscode.TestItem,
    run: vscode.TestRun,
    isDebug: boolean  // NEW parameter
  ) {
    run.started(testItem);

    try {
      const uri = testItem.uri!;

      if (isDebug) {
        // Debug 模式執行
        await this.runTestInDebugMode(uri, testItem, run);
      } else {
        // 一般執行模式
        await this.runTestInNormalMode(uri, testItem, run);
      }
    } catch (error) {
      run.failed(testItem, new vscode.TestMessage(`${error}`));
    }
  }

  private async runTestInDebugMode(
    uri: vscode.Uri,
    testItem: vscode.TestItem,
    run: vscode.TestRun
  ) {
    // TODO: 實作 debug 模式執行
  }

  private async runTestInNormalMode(
    uri: vscode.Uri,
    testItem: vscode.TestItem,
    run: vscode.TestRun
  ) {
    // 現有的執行邏輯
  }
}
```

---

## A.03 - Java Debug (JDWP) 基礎

### JDWP (Java Debug Wire Protocol)

JDWP 是 Java 平台的標準 debug 協議。

#### JVM Debug 參數

**舊版語法** (Java 8 及之前):
```bash
-Xdebug -Xrunjdwp:transport=dt_socket,server=y,suspend=y,address=5005
```

**新版語法** (Java 9+):
```bash
-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=*:5005
```

#### 參數說明

| 參數 | 說明 | 值 |
|------|------|-----|
| `transport` | 傳輸方式 | `dt_socket` (socket 連線) |
| `server` | 作為 debug server | `y` (是), `n` (否) |
| `suspend` | 暫停等待 debugger | `y` (等待), `n` (不等待) |
| `address` | Debug port | `5005` (預設), `*:5005` (Java 9+ 允許遠端連線) |

**建議設定** (用於 Test Explorer):
```bash
-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=localhost:5005
```

- `suspend=y`: 等待 debugger attach 後才開始執行 (確保不會錯過中斷點)
- `address=localhost:5005`: 只允許本地連線 (安全考量)

### Maven Surefire Debug 支援

Maven Surefire Plugin 提供內建的 debug 支援:

```bash
mvn test -Dmaven.surefire.debug
```

這會自動:
1. 加入 JDWP 參數到 JVM
2. 使用預設 port 5005
3. 設定 `suspend=y` (等待 debugger)
4. 顯示 "Listening for transport dt_socket at address: 5005"

**自訂 debug port**:
```bash
mvn test -Dmaven.surefire.debug="-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=localhost:5006"
```

---

## A.04 - 整合方案設計

### 整體架構

```
┌─────────────────────────────────────────────────────────┐
│ VS Code Test Explorer UI                                │
│  ├─ Run Button   → TestRunProfileKind.Run              │
│  └─ Debug Button → TestRunProfileKind.Debug            │
└─────────────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────┐
│ CucumberTestController                                   │
│  ├─ runTests(request, token, isDebug)                  │
│  └─ runSingleTest(testItem, run, isDebug)              │
└─────────────────────────────────────────────────────────┘
                      ↓
        ┌─────────────┴─────────────┐
        │                           │
┌───────▼─────────┐      ┌──────────▼─────────┐
│ Normal Mode     │      │ Debug Mode         │
│ (isDebug=false) │      │ (isDebug=true)     │
└───────┬─────────┘      └──────────┬─────────┘
        │                           │
        │                ┌──────────▼──────────┐
        │                │ 1. 找可用 port      │
        │                │ 2. 啟動 Maven/Java  │
        │                │    with JDWP args   │
        │                │ 3. 等待 "Listening" │
        │                │ 4. startDebugging() │
        │                │ 5. Link testRun     │
        │                └──────────┬──────────┘
        │                           │
┌───────▼───────────────────────────▼─────────┐
│ runCucumberTestWithMavenResult()            │
│  ├─ spawn Maven with JDWP                   │
│  ├─ Parse output for debug ready signal     │
│  └─ Stream output to Test Explorer          │
└─────────────────────────────────────────────┘
```

### Debug Port 管理策略

```typescript
class DebugPortManager {
  private static usedPorts = new Set<number>();
  private static readonly PORT_RANGE_START = 5005;
  private static readonly PORT_RANGE_END = 6000;

  static async allocatePort(): Promise<number> {
    for (let port = this.PORT_RANGE_START; port <= this.PORT_RANGE_END; port++) {
      if (!this.usedPorts.has(port) && await this.isPortAvailable(port)) {
        this.usedPorts.add(port);
        return port;
      }
    }
    throw new Error('No available debug ports');
  }

  static releasePort(port: number): void {
    this.usedPorts.delete(port);
  }

  private static async isPortAvailable(port: number): Promise<boolean> {
    // 使用 Node.js net module 檢查 port 是否可用
    const net = require('net');
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close();
        resolve(true);
      });
      server.listen(port, 'localhost');
    });
  }
}
```

### Debug Configuration 生成

```typescript
async function createDebugConfiguration(
  workspaceFolder: vscode.WorkspaceFolder,
  debugPort: number,
  testRun: vscode.TestRun
): Promise<vscode.DebugConfiguration> {
  return {
    type: 'java',
    name: 'Attach to Cucumber Test',
    request: 'attach',
    hostName: 'localhost',
    port: debugPort,
    // 關聯到 Test Run (重要!)
    __testRun: testRun
  };
}
```

### Debug 執行流程

```typescript
async function runTestInDebugMode(
  uri: vscode.Uri,
  testItem: vscode.TestItem,
  run: vscode.TestRun
): Promise<void> {
  // 1. 分配 debug port
  const debugPort = await DebugPortManager.allocatePort();
  logToExtension(`Allocated debug port: ${debugPort}`, 'INFO');

  try {
    // 2. 啟動 Maven/Java with JDWP
    const mavenProcess = spawnMavenWithDebug(uri, debugPort);

    // 3. 等待 "Listening for transport..." 訊息
    await waitForDebugReady(mavenProcess, 30000);  // 30 秒超時
    logToExtension('Maven debug server ready', 'INFO');

    // 4. 建立 debug configuration
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri)!;
    const debugConfig = await createDebugConfiguration(
      workspaceFolder,
      debugPort,
      run
    );

    // 5. 啟動 debug session (with testRun linkage)
    const debugSuccess = await vscode.debug.startDebugging(
      workspaceFolder,
      debugConfig,
      { testRun: run }  // 關鍵: 關聯到 TestRun!
    );

    if (!debugSuccess) {
      throw new Error('Failed to start debug session');
    }

    logToExtension('Debug session started successfully', 'INFO');

    // 6. 等待測試執行完成
    await waitForProcessCompletion(mavenProcess);

  } finally {
    // 7. 釋放 debug port
    DebugPortManager.releasePort(debugPort);
    logToExtension(`Released debug port: ${debugPort}`, 'INFO');
  }
}

function spawnMavenWithDebug(uri: vscode.Uri, debugPort: number): ChildProcess {
  const debugArgs = `-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=localhost:${debugPort}`;

  // 使用 Surefire debug 參數
  const mvnArgs = [
    'test',
    `-Dmaven.surefire.debug=${debugArgs}`,
    // ... 其他參數
  ];

  return spawn('mvn', mvnArgs, { cwd: workspaceRoot });
}

async function waitForDebugReady(
  process: ChildProcess,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout waiting for debug server'));
    }, timeoutMs);

    process.stdout?.on('data', (chunk: Buffer) => {
      const output = chunk.toString();
      
      // 檢測 "Listening for transport dt_socket at address: 5005"
      if (output.includes('Listening for transport')) {
        clearTimeout(timeout);
        resolve();
      }
    });

    process.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}
```

---

## A.02 - Java Debug 配置需求詳解

### JDWP (Java Debug Wire Protocol) 完整參數

JDWP 是 Java 平台標準的 debug 通訊協議,由 Java Platform Debugger Architecture (JPDA) 定義。

#### 完整參數列表

```bash
-agentlib:jdwp=<options>
```

**所有可用選項**:

| 選項 | 說明 | 可用值 | 預設值 | 範例 |
|------|------|--------|--------|------|
| `transport` | 傳輸協議 | `dt_socket`, `dt_shmem` (僅 Windows) | 必填 | `dt_socket` |
| `server` | 作為 debug server | `y`, `n` | `n` | `y` |
| `suspend` | 啟動時暫停等待 debugger | `y`, `n` | `y` | `y` |
| `address` | 監聽位址和埠號 | `<host>:<port>` 或 `<port>` | `localhost:0` | `localhost:5005` |
| `timeout` | Attach 超時時間 (毫秒) | 數字 | 無限制 | `10000` |
| `onthrow` | 特定例外時中斷 | 例外類別名 | 無 | `java.lang.NullPointerException` |
| `onuncaught` | 未捕獲例外時中斷 | `y`, `n` | `n` | `y` |
| `launch` | 啟動目標程式 | 程式路徑 | 無 | `/path/to/app` |
| `mutf8` | 使用修改版 UTF-8 | `y`, `n` | `n` | `n` |
| `quiet` | 靜默模式 (不輸出訊息) | `y`, `n` | `n` | `n` |

#### Java 版本差異

**Java 8 及之前** (舊版語法):
```bash
-Xdebug -Xrunjdwp:transport=dt_socket,server=y,suspend=y,address=5005
```

**Java 9+** (新版語法,推薦):
```bash
-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=*:5005
```

**差異**:
- Java 9+ 的 `address` 支援 `*:port` 語法 (允許所有網路介面)
- `localhost:port` 限制只允許本機連線 (更安全)
- Java 8 的 `address=5005` 等同於 `address=localhost:5005`

### Cucumber 測試的推薦配置

#### 方案 1: Suspend Mode (暫停等待)

**適用場景**: 需要在測試開始前設定中斷點

```bash
-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=localhost:5005
```

**執行流程**:
```
1. JVM 啟動
2. 顯示 "Listening for transport dt_socket at address: 5005"
3. 暫停執行,等待 debugger attach
4. Debugger 連接成功
5. 繼續執行程式碼
6. 遇到中斷點時停止
```

**優點**:
- ✅ 不會錯過測試初始化階段的中斷點
- ✅ 確保 debugger 在程式執行前就緒
- ✅ 適合 debug `@Before` hooks

**缺點**:
- ❌ 必須等待 debugger attach (增加啟動時間)
- ❌ 如果忘記 attach 會永久等待

#### 方案 2: Non-Suspend Mode (不暫停)

**適用場景**: 程式已經在執行,想要 attach debugger

```bash
-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=localhost:5005
```

**執行流程**:
```
1. JVM 啟動並立即執行
2. 顯示 "Listening for transport dt_socket at address: 5005"
3. 程式繼續執行
4. Debugger 可隨時 attach
5. Attach 後才能觸發中斷點
```

**優點**:
- ✅ 不需等待,立即執行
- ✅ 可以隨時 attach/detach debugger
- ✅ 適合長時間執行的測試

**缺點**:
- ❌ 可能錯過早期執行階段的中斷點
- ❌ Attach 之前的中斷點不會觸發

#### **推薦配置**: Suspend Mode + Timeout

```bash
-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=localhost:5005,timeout=30000
```

- `suspend=y`: 等待 debugger (確保不錯過中斷點)
- `timeout=30000`: 30 秒超時 (避免永久等待)
- 如果 30 秒內沒有 debugger attach,則自動繼續執行

### Maven Surefire Plugin Debug 配置

#### 內建 Debug 支援

Maven Surefire 提供簡化的 debug 支援:

```bash
mvn test -Dmaven.surefire.debug
```

**等同於**:
```bash
mvn test -Dmaven.surefire.debug="-Xdebug -Xrunjdwp:transport=dt_socket,server=y,suspend=y,address=5005"
```

**輸出訊息**:
```
-------------------------------------------------------
 T E S T S
-------------------------------------------------------
Listening for transport dt_socket at address: 5005
```

#### 自訂 Debug 參數

```bash
# 自訂 port
mvn test -Dmaven.surefire.debug="-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=localhost:5006"

# 不暫停執行
mvn test -Dmaven.surefire.debug="-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=localhost:5005"

# 加入 timeout
mvn test -Dmaven.surefire.debug="-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=localhost:5005,timeout=30000"
```

#### Surefire Debug 選項

可透過 `pom.xml` 或命令列設定:

```xml
<!-- pom.xml -->
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-surefire-plugin</artifactId>
  <configuration>
    <!-- Debug 預設參數 -->
    <debugForkedProcess>true</debugForkedProcess>
    
    <!-- 自訂 JVM 參數 -->
    <argLine>
      -agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=localhost:5005,timeout=30000
    </argLine>
  </configuration>
</plugin>
```

### VS Code Java Debug Extension 整合

VS Code 的 Java debug 功能由 `vscode-java-debug` extension 提供。

#### Debug Configuration 結構

**Attach 模式** (用於 attach 到已執行的 Java 程序):

```json
{
  "type": "java",
  "name": "Attach to Cucumber Test",
  "request": "attach",
  "hostName": "localhost",
  "port": 5005,
  "timeout": 30000,  // attach 超時時間 (毫秒)
  "projectName": "my-project",  // 可選: 指定專案名稱
  "sourcePaths": ["src/test/java", "src/main/java"]  // 可選: 指定原始碼路徑
}
```

**Launch 模式** (用於直接啟動 Java 程式):

```json
{
  "type": "java",
  "name": "Launch Cucumber Test",
  "request": "launch",
  "mainClass": "io.cucumber.core.cli.Main",
  "args": [
    "classpath:features/login.feature",
    "--glue", "com.example.steps",
    "--plugin", "pretty"
  ],
  "classPaths": [
    "${workspaceFolder}/target/test-classes",
    "${workspaceFolder}/target/classes"
  ],
  "projectName": "my-project"
}
```

#### 動態 Debug Configuration 生成

在 Extension 中動態建立 debug configuration:

```typescript
interface CucumberDebugConfig extends vscode.DebugConfiguration {
  type: 'java';
  name: string;
  request: 'attach';
  hostName: string;
  port: number;
  timeout?: number;
  projectName?: string;
  sourcePaths?: string[];
}

function createCucumberDebugConfig(
  workspaceFolder: vscode.WorkspaceFolder,
  debugPort: number
): CucumberDebugConfig {
  return {
    type: 'java',
    name: `Attach to Cucumber Test (port ${debugPort})`,
    request: 'attach',
    hostName: 'localhost',
    port: debugPort,
    timeout: 30000,  // 30 秒超時
    
    // 自動偵測專案名稱
    projectName: workspaceFolder.name,
    
    // 設定原始碼路徑 (用於中斷點對應)
    sourcePaths: [
      path.join(workspaceFolder.uri.fsPath, 'src/test/java'),
      path.join(workspaceFolder.uri.fsPath, 'src/main/java')
    ]
  };
}
```

### Debug Port 動態分配策略

#### Port 範圍選擇

```typescript
class DebugPortManager {
  // IANA 建議的 Dynamic/Private Ports 範圍: 49152-65535
  // 但為了方便記憶和除錯,使用較小的範圍
  private static readonly PORT_RANGE_START = 5005;  // Java debug 慣用 port
  private static readonly PORT_RANGE_END = 5100;    // 預留 95 個 ports

  private static usedPorts = new Set<number>();
  private static portSessionMap = new Map<number, string>();  // port -> session ID

  /**
   * 分配一個可用的 debug port
   */
  static async allocatePort(sessionId: string): Promise<number> {
    for (let port = this.PORT_RANGE_START; port <= this.PORT_RANGE_END; port++) {
      if (!this.usedPorts.has(port) && await this.isPortAvailable(port)) {
        this.usedPorts.add(port);
        this.portSessionMap.set(port, sessionId);
        logToExtension(`Allocated port ${port} for session ${sessionId}`, 'INFO');
        return port;
      }
    }
    
    throw new Error(`No available debug ports in range ${this.PORT_RANGE_START}-${this.PORT_RANGE_END}`);
  }

  /**
   * 釋放 debug port
   */
  static releasePort(port: number): void {
    const sessionId = this.portSessionMap.get(port);
    this.usedPorts.delete(port);
    this.portSessionMap.delete(port);
    logToExtension(`Released port ${port} (session: ${sessionId})`, 'INFO');
  }

  /**
   * 檢查 port 是否可用
   */
  private static async isPortAvailable(port: number): Promise<boolean> {
    const net = require('net');
    
    return new Promise((resolve) => {
      const server = net.createServer();
      
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          resolve(false);  // Port 已被使用
        } else {
          resolve(false);  // 其他錯誤也視為不可用
        }
      });
      
      server.once('listening', () => {
        server.close();
        resolve(true);  // Port 可用
      });
      
      server.listen(port, 'localhost');
    });
  }

  /**
   * 取得所有使用中的 ports
   */
  static getUsedPorts(): number[] {
    return Array.from(this.usedPorts);
  }

  /**
   * 取得特定 session 的 port
   */
  static getPortForSession(sessionId: string): number | undefined {
    for (const [port, sid] of this.portSessionMap.entries()) {
      if (sid === sessionId) {
        return port;
      }
    }
    return undefined;
  }

  /**
   * 清理所有 ports (用於 extension deactivate)
   */
  static cleanup(): void {
    this.usedPorts.clear();
    this.portSessionMap.clear();
    logToExtension('Cleaned up all debug ports', 'INFO');
  }
}
```

#### Port 衝突處理

```typescript
async function allocateDebugPortWithRetry(
  sessionId: string,
  maxRetries: number = 3
): Promise<number> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const port = await DebugPortManager.allocatePort(sessionId);
      return port;
    } catch (error) {
      lastError = error as Error;
      logToExtension(
        `Failed to allocate port (attempt ${attempt}/${maxRetries}): ${lastError.message}`,
        'WARN'
      );
      
      // 等待一小段時間再重試
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // 所有重試都失敗
  throw new Error(
    `Failed to allocate debug port after ${maxRetries} attempts. ` +
    `Last error: ${lastError?.message || 'Unknown error'}`
  );
}
```

### 等待 Debug Server 就緒的策略

#### 偵測 "Listening for transport" 訊息

```typescript
/**
 * 等待 Maven 輸出 "Listening for transport..." 訊息
 */
async function waitForDebugServerReady(
  process: ChildProcess,
  timeoutMs: number = 30000
): Promise<void> {
  return new Promise((resolve, reject) => {
    let outputBuffer = '';
    const startTime = Date.now();
    
    const timeout = setTimeout(() => {
      reject(new Error(
        `Timeout waiting for debug server (${timeoutMs}ms). ` +
        `Output so far:\n${outputBuffer}`
      ));
    }, timeoutMs);

    const checkOutput = (chunk: Buffer) => {
      const output = chunk.toString();
      outputBuffer += output;
      
      // 記錄原始輸出
      if (cucumberOutputChannel) {
        cucumberOutputChannel.append(output);
      }
      
      // 檢測 debug server ready 的訊號
      // Maven Surefire: "Listening for transport dt_socket at address: 5005"
      // Java direct: "Listening for transport dt_socket at address: 5005"
      const readyPattern = /Listening for transport.*at address:\s*(\d+|localhost:\d+)/i;
      const match = output.match(readyPattern);
      
      if (match) {
        const elapsedTime = Date.now() - startTime;
        clearTimeout(timeout);
        
        logToExtension(
          `Debug server ready in ${elapsedTime}ms. Detected: "${match[0]}"`,
          'INFO'
        );
        
        // 顯示通知
        vscode.window.showInformationMessage(
          `Debug server ready. Attaching debugger...`
        );
        
        // 等待一小段時間確保 port 真的準備好
        setTimeout(() => resolve(), 500);
      }
    };

    // 監聽 stdout 和 stderr (Maven 可能輸出到任一個)
    process.stdout?.on('data', checkOutput);
    process.stderr?.on('data', checkOutput);
    
    process.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Process error: ${err.message}`));
    });
    
    process.on('exit', (code) => {
      clearTimeout(timeout);
      if (code !== null && code !== 0) {
        reject(new Error(
          `Process exited with code ${code} before debug server was ready.\n` +
          `Output:\n${outputBuffer}`
        ));
      }
    });
  });
}
```

#### 使用者體驗優化

```typescript
/**
 * 顯示 "等待 debugger" 的進度提示
 */
async function waitForDebugServerWithProgress(
  process: ChildProcess,
  debugPort: number
): Promise<void> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Waiting for debug server on port ${debugPort}...`,
      cancellable: true
    },
    async (progress, token) => {
      // 支援使用者取消
      token.onCancellationRequested(() => {
        process.kill();
        throw new Error('Debug server wait cancelled by user');
      });

      // 更新進度訊息
      let dots = 0;
      const progressInterval = setInterval(() => {
        dots = (dots + 1) % 4;
        const dotsStr = '.'.repeat(dots);
        progress.report({
          message: `Waiting for Java process to start${dotsStr}`
        });
      }, 500);

      try {
        await waitForDebugServerReady(process, 30000);
        progress.report({ message: 'Ready! Attaching debugger...' });
      } finally {
        clearInterval(progressInterval);
      }
    }
  );
}
```

### 錯誤處理與降級策略

#### 場景 1: Debug Port 已被佔用

```typescript
try {
  const debugPort = await DebugPortManager.allocatePort(sessionId);
  // ...
} catch (error) {
  // 提供降級選項
  const action = await vscode.window.showErrorMessage(
    `No available debug ports. Would you like to run tests without debugging?`,
    'Run Without Debug',
    'Cancel'
  );

  if (action === 'Run Without Debug') {
    // 降級到 normal run mode
    await runTestInNormalMode(uri, testItem, run);
  } else {
    throw error;
  }
}
```

#### 場景 2: Debugger Attach 超時

```typescript
try {
  await waitForDebugServerReady(process, 30000);
  await vscode.debug.startDebugging(workspaceFolder, debugConfig);
} catch (error) {
  const action = await vscode.window.showErrorMessage(
    `Failed to attach debugger: ${error.message}\n\n` +
    `The test process is still running. Continue without debugging?`,
    'Continue Without Debug',
    'Stop Test'
  );

  if (action === 'Continue Without Debug') {
    // 繼續執行但不 debug
    // process 已經在執行,只是沒有 attach debugger
    await waitForProcessCompletion(process);
  } else {
    // 停止測試
    process.kill();
    throw error;
  }
}
```

#### 場景 3: Java Debug Extension 未安裝

```typescript
async function checkJavaDebugExtension(): Promise<boolean> {
  const javaDebugExt = vscode.extensions.getExtension('vscjava.vscode-java-debug');
  
  if (!javaDebugExt) {
    const action = await vscode.window.showWarningMessage(
      'Java Debug extension is not installed. Debug功能需要安裝 "Debugger for Java" extension.',
      'Install Extension',
      'Run Without Debug'
    );

    if (action === 'Install Extension') {
      await vscode.commands.executeCommand(
        'workbench.extensions.installExtension',
        'vscjava.vscode-java-debug'
      );
      return false;  // 需要重新載入
    }
    
    return false;  // 無法 debug
  }

  return true;  // 可以 debug
}
```

### 設定選項設計

#### package.json 新增設定

```json
{
  "contributes": {
    "configuration": {
      "title": "Cucumber Java Easy Runner",
      "properties": {
        "cucumberJavaEasyRunner.debug.enabled": {
          "type": "boolean",
          "default": true,
          "description": "Enable debug support for Cucumber tests"
        },
        "cucumberJavaEasyRunner.debug.port": {
          "type": "number",
          "default": 5005,
          "minimum": 1024,
          "maximum": 65535,
          "description": "Default debug port (will auto-increment if occupied)"
        },
        "cucumberJavaEasyRunner.debug.timeout": {
          "type": "number",
          "default": 30000,
          "description": "Timeout for debugger attach (milliseconds)"
        },
        "cucumberJavaEasyRunner.debug.suspend": {
          "type": "boolean",
          "default": true,
          "description": "Suspend execution until debugger is attached (suspend=y)"
        },
        "cucumberJavaEasyRunner.debug.autoAttach": {
          "type": "boolean",
          "default": true,
          "description": "Automatically attach debugger when debug mode is started"
        },
        "cucumberJavaEasyRunner.debug.sourcePaths": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "default": ["src/test/java", "src/main/java"],
          "description": "Source code paths for debugging (relative to workspace root)"
        }
      }
    }
  }
}
```

#### 讀取設定

```typescript
function getDebugConfiguration() {
  const config = vscode.workspace.getConfiguration('cucumberJavaEasyRunner.debug');
  
  return {
    enabled: config.get<boolean>('enabled', true),
    defaultPort: config.get<number>('port', 5005),
    timeout: config.get<number>('timeout', 30000),
    suspend: config.get<boolean>('suspend', true),
    autoAttach: config.get<boolean>('autoAttach', true),
    sourcePaths: config.get<string[]>('sourcePaths', ['src/test/java', 'src/main/java'])
  };
}
```

---

## A.02 完成總結

### 關鍵決策

1. **使用 Suspend Mode + Timeout**
   - `suspend=y`: 確保不錯過中斷點
   - `timeout=30000`: 避免永久等待

2. **Port 範圍 5005-5100**
   - 符合 Java debug 慣例
   - 足夠支援並行測試
   - 容易記憶和除錯

3. **優先支援 Maven Surefire**
   - 使用 `-Dmaven.surefire.debug`
   - 簡化實作
   - 輸出訊息一致

4. **Attach 模式優於 Launch 模式**
   - Attach 更靈活 (可 attach 到任何 Java 程序)
   - 與現有的 spawn 執行流程相容
   - 更容易整合

### 下一步

- ✅ [A.01] 完成
- ✅ [A.02] 完成
- ⏭️ [A.03] 分析現有程式碼架構
- ⏭️ [B.01] 實作 Debug Profile
- ⏭️ [B.03] 實作 Debug Configuration 生成器

---

### 1. TestRun Linkage 是關鍵

使用 `DebugSessionOptions.testRun` 可以:
- ✅ 自動管理 debug session 生命週期
- ✅ 在 Test Explorer 顯示 debug 狀態
- ✅ 測試結束時自動停止 debugger
- ✅ 提供更好的 UX (使用者不需手動停止 debug)

### 2. Port 管理很重要

- 需要動態分配 port (避免衝突)
- 需要追蹤已使用的 ports
- 需要在 session 結束時釋放 port
- 建議範圍: 5005-6000 (預留 1000 個 ports)

### 3. 等待機制必須可靠

- 必須等待 "Listening for transport" 訊息
- 需要設定合理的超時時間 (建議 30 秒)
- 超時時提供清楚的錯誤訊息
- 考慮加入 retry 機制

### 4. 使用者體驗優化

- 顯示 "Waiting for debugger..." 狀態
- 顯示使用的 debug port
- 提供取消按鈕
- Debug 失敗時提供 fallback 到 Run 模式的選項

### 5. Maven Surefire 簡化了實作

- 使用 `-Dmaven.surefire.debug` 簡化配置
- 自動設定 JDWP 參數
- 自動輸出 "Listening" 訊息
- 建議優先支援 Maven 模式的 debug

---

## 下一步行動

基於研究結果,建議的實作順序:

1. ✅ [A.01] 完成 (本文件)
2. ⏭️ [A.02] 研究 Java Debug 配置需求 (JDWP 詳細參數)
3. ⏭️ [A.03] 分析現有程式碼架構
4. ⏭️ [B.01] 擴充 TestController 支援 Debug Profile
5. ⏭️ [B.03] 建立 Debug Configuration 生成器
6. ⏭️ [C.01] 實作 Maven Debug 模式

---

## 參考資料

- [VS Code Debug API](https://code.visualstudio.com/api/references/vscode-api#debug)
- [VS Code Test API](https://code.visualstudio.com/api/references/vscode-api#tests)
- [Java Debug Wire Protocol (JDWP)](https://docs.oracle.com/javase/8/docs/technotes/guides/jpda/jdwp-spec.html)
- [Maven Surefire Plugin - Debugging Tests](https://maven.apache.org/surefire/maven-surefire-plugin/examples/debugging.html)
