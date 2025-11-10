# Cucumber Java Easy Runner - API 參考文件

本文件詳細說明擴充套件中各個類別、介面和函數的 API。

## 目錄

- [核心類別](#核心類別)
  - [CucumberOutputParser](#cucumberoutputparser)
  - [CucumberTestController](#cucumbertestcontroller)
  - [CucumberCodeLensProvider](#cucumbercodelens)
- [資料介面](#資料介面)
- [工具函數](#工具函數)
- [全域變數](#全域變數)

---

## 核心類別

### CucumberOutputParser

即時解析 Cucumber 測試輸出的解析器類別。

#### 建構子

```typescript
constructor(
  outputChannel: vscode.OutputChannel,
  showStepResults: boolean = true,
  onStepStatusChange?: (step: StepResult) => void
)
```

**參數**:
- `outputChannel`: VS Code 輸出通道，用於顯示結果
- `showStepResults`: 是否顯示步驟結果 (預設: `true`)
- `onStepStatusChange`: 步驟狀態變更時的回呼函數

#### 屬性

| 屬性 | 類型 | 說明 |
|------|------|------|
| `outputChannel` | `vscode.OutputChannel` | 輸出通道 |
| `currentStep` | `StepResult \| null` | 當前正在處理的步驟 |
| `showStepResults` | `boolean` | 是否顯示步驟結果 |
| `isCapturingError` | `boolean` | 是否正在擷取錯誤訊息 |
| `errorLines` | `string[]` | 錯誤行緩衝區 |
| `onStepStatusChange` | `(step: StepResult) => void` | 狀態變更回呼 |

#### 方法

##### parseLine(line: string): StepResult | null

解析單行 Cucumber 輸出。

**參數**:
- `line`: 要解析的輸出行

**回傳**: 如果偵測到完整的步驟結果，回傳 `StepResult`，否則回傳 `null`

**範例**:
```typescript
const parser = new CucumberOutputParser(outputChannel);
const result = parser.parseLine("    ✔ Given I am on the login page");
// result: { keyword: 'Given', name: 'I am on the login page', status: 'passed' }
```

##### stripAnsiCodes(str: string): string

移除字串中的 ANSI 色碼。

**參數**:
- `str`: 包含 ANSI 色碼的字串

**回傳**: 清理後的字串

**範例**:
```typescript
const clean = parser.stripAnsiCodes("\x1b[32mPassed\x1b[0m");
// clean: "Passed"
```

##### displayStepResult(result: StepResult): void

顯示步驟結果到輸出通道並觸發回呼。

**參數**:
- `result`: 步驟執行結果

**副作用**:
- 輸出到 `outputChannel`
- 呼叫 `onStepStatusChange` (如果有設定)
- 記錄到擴充套件日誌

##### finalize(): void

完成解析並處理任何待處理的步驟。

**使用時機**: 測試執行完成後

**範例**:
```typescript
parser.finalize(); // 確保最後一個步驟被正確處理
```

##### reset(): void

重置解析器狀態。

**範例**:
```typescript
parser.reset(); // 準備解析下一個測試
```

---

### CucumberTestController

管理 VS Code Test Explorer 整合的控制器類別。

#### 建構子

```typescript
constructor(context: vscode.ExtensionContext)
```

**參數**:
- `context`: VS Code 擴充套件上下文

**副作用**:
- 建立 Test Controller
- 註冊檔案監視器
- 註冊測試執行處理器
- 啟動初始測試掃描

#### 屬性

| 屬性 | 類型 | 說明 |
|------|------|------|
| `controller` | `vscode.TestController` | VS Code Test Controller 實例 |
| `watchedFiles` | `Map<string, vscode.TestItem>` | 已監視的檔案映射表 |

#### 方法

##### handleFileEvent(eventType: string, uri: vscode.Uri): void

處理檔案系統變更事件。

**參數**:
- `eventType`: 事件類型 (`'create'` | `'change'` | `'delete'`)
- `uri`: 檔案 URI

**過濾**: 自動排除建置目錄 (target, build, out, dist)

##### discoverTests(): Promise<void>

掃描工作區並發現所有 `.feature` 檔案。

**副作用**:
- 清除現有測試項目
- 建立新的測試階層結構
- 更新 Test Explorer UI

##### createOrUpdateTest(uri: vscode.Uri): Promise<void>

建立或更新單一功能檔案的測試項目。

**參數**:
- `uri`: 功能檔案 URI

**流程**:
1. 讀取檔案內容
2. 解析為 `FeatureInfo`
3. 建立 Feature TestItem
4. 建立 Scenario/Step/Example 子項目
5. 加入到 Test Controller

##### deleteTest(uri: vscode.Uri): void

刪除功能檔案對應的測試項目。

**參數**:
- `uri`: 功能檔案 URI

##### parseFeatureFile(document: vscode.TextDocument): FeatureInfo | null

解析功能檔案內容。

**參數**:
- `document`: VS Code 文件物件

**回傳**: 解析成功回傳 `FeatureInfo`，失敗回傳 `null`

**解析內容**:
- Feature 名稱和行號
- Scenario/Scenario Outline
- Steps (Given/When/Then/And/But)
- Examples 資料表

##### runTests(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void>

執行測試請求。

**參數**:
- `request`: 測試執行請求
- `token`: 取消令牌

##### runSingleTest(testItem: vscode.TestItem, run: vscode.TestRun): Promise<void>

執行單一測試項目。

**參數**:
- `testItem`: 要執行的測試項目
- `run`: Test Run 實例

**流程**:
1. 判斷測試類型 (Feature/Scenario/Example/Step)
2. 建立步驟映射表
3. 呼叫 `runSelectedTestAndWait` 並提供回呼
4. 即時更新步驟狀態
5. 根據步驟失敗狀態決定最終結果

##### gatherAllTests(): vscode.TestItem[]

收集所有測試項目。

**回傳**: 所有測試項目的陣列

##### dispose(): void

清理資源。

**副作用**:
- 釋放 Test Controller
- 清除監視檔案映射表

---

### CucumberCodeLensProvider

提供內嵌執行按鈕的 CodeLens Provider。

#### 方法

##### provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[]

提供 CodeLens 項目。

**參數**:
- `document`: 文件物件
- `token`: 取消令牌

**回傳**: CodeLens 項目陣列

**提供位置**:
- `Feature:` 行 → `$(play-circle)` 執行整個功能
- `Scenario:` / `Scenario Outline:` 行 → `$(play)` 執行情境
- 範例資料列 → `$(play)` 執行單一範例

##### findExampleRowInfo(lines: string[], currentLine: number): { scenarioLine: number } | null

判斷目前行是否為有效的範例資料列。

**參數**:
- `lines`: 檔案所有行
- `currentLine`: 目前行號

**回傳**: 如果是有效範例列，回傳對應的 Scenario Outline 行號

**驗證條件**:
1. 行以 `|` 開頭
2. 在 `Examples:` 區塊內
3. 不是標題列 (header row)
4. 屬於某個 `Scenario Outline`

---

## 資料介面

### StepInfo

步驟資訊介面。

```typescript
interface StepInfo {
  keyword: string;      // 關鍵字: Given, When, Then, And, But
  text: string;         // 步驟文字內容
  lineNumber: number;   // 行號 (1-indexed)
}
```

**範例**:
```typescript
const step: StepInfo = {
  keyword: 'Given',
  text: 'I am on the login page',
  lineNumber: 5
};
```

---

### ScenarioInfo

情境資訊介面。

```typescript
interface ScenarioInfo {
  name: string;                    // 情境名稱
  lineNumber: number;              // 行號 (1-indexed)
  exampleLineNumber?: number;      // 範例行號 (用於執行單一範例)
  examples?: ExampleInfo[];        // 範例資料列陣列
  steps?: StepInfo[];              // 步驟陣列
}
```

**範例**:
```typescript
const scenario: ScenarioInfo = {
  name: 'User login',
  lineNumber: 10,
  steps: [
    { keyword: 'Given', text: 'I am on the login page', lineNumber: 11 },
    { keyword: 'When', text: 'I enter credentials', lineNumber: 12 },
    { keyword: 'Then', text: 'I should see dashboard', lineNumber: 13 }
  ],
  examples: []
};
```

---

### ExampleInfo

範例資料列資訊介面。

```typescript
interface ExampleInfo {
  lineNumber: number;   // 行號 (1-indexed)
  data: string;         // 資料列內容 (包含 | 符號)
}
```

**範例**:
```typescript
const example: ExampleInfo = {
  lineNumber: 20,
  data: '| john | password123 |'
};
```

---

### FeatureInfo

功能檔案資訊介面。

```typescript
interface FeatureInfo {
  name: string;              // 功能名稱
  scenarios: ScenarioInfo[]; // 情境陣列
  filePath: string;          // 檔案絕對路徑
  lineNumber: number;        // Feature 關鍵字行號
}
```

**範例**:
```typescript
const feature: FeatureInfo = {
  name: 'User Authentication',
  scenarios: [/* ... */],
  filePath: '/path/to/login.feature',
  lineNumber: 1
};
```

---

### ModuleInfo

Maven 模組資訊介面。

```typescript
interface ModuleInfo {
  modulePath: string;           // 模組絕對路徑
  moduleRelativePath: string;   // 相對於工作區的路徑
  workspaceRoot: string;        // 工作區根目錄
}
```

**範例**:
```typescript
const module: ModuleInfo = {
  modulePath: '/workspace/backend/auth',
  moduleRelativePath: 'backend/auth',
  workspaceRoot: '/workspace'
};
```

---

### StepResult

步驟執行結果介面。

```typescript
interface StepResult {
  keyword: string;                                          // 步驟關鍵字
  name: string;                                             // 步驟名稱
  status: 'passed' | 'failed' | 'skipped' | 'pending' | 'undefined';
  errorMessage?: string;                                    // 錯誤訊息 (失敗時)
  location?: string;                                        // 位置資訊
}
```

**範例**:
```typescript
const result: StepResult = {
  keyword: 'When',
  name: 'I enter invalid credentials',
  status: 'failed',
  errorMessage: 'Expected: "Invalid credentials" but was: "Error"'
};
```

---

### TestClassMapping

測試類別快取映射介面。

```typescript
interface TestClassMapping {
  [featurePath: string]: string;  // 功能檔案路徑 → 測試類別名稱
}
```

**範例**:
```typescript
const mapping: TestClassMapping = {
  'features/login.feature': 'LoginTest',
  'features/signup.feature': 'SignupTest'
};
```

---

## 工具函數

### 專案結構探索

#### findMavenModule(featureFilePath: string, workspaceRoot: string): ModuleInfo

尋找功能檔案所屬的 Maven 模組。

**參數**:
- `featureFilePath`: 功能檔案絕對路徑
- `workspaceRoot`: 工作區根目錄

**回傳**: Maven 模組資訊

**演算法**: 從檔案目錄向上搜尋，直到找到 `pom.xml` 或到達工作區根目錄

**範例**:
```typescript
const moduleInfo = findMavenModule(
  '/workspace/backend/auth/src/test/resources/login.feature',
  '/workspace'
);
// 回傳: { modulePath: '/workspace/backend/auth', moduleRelativePath: 'backend/auth', workspaceRoot: '/workspace' }
```

---

#### findGluePath(projectRoot: string): Promise<string | null>

尋找 Cucumber 步驟定義套件路徑。

**參數**:
- `projectRoot`: 專案根目錄

**回傳**: Java 套件路徑 (例如: `org.example.steps`) 或 `null`

**搜尋位置**: `src/test/java` 目錄下的 `steps` 或 `step` 資料夾

**範例**:
```typescript
const gluePath = await findGluePath('/workspace/backend/auth');
// 回傳: "com.example.auth.steps"
```

---

#### findCucumberTestClass(modulePath: string): Promise<string | null>

自動偵測 Cucumber 測試類別。

**參數**:
- `modulePath`: Maven 模組路徑

**回傳**: 測試類別名稱或 `null`

**偵測條件**: 檔案包含 `@RunWith`、`@CucumberOptions` 或 `io.cucumber`

**範例**:
```typescript
const testClass = await findCucumberTestClass('/workspace/backend/auth');
// 回傳: "CucumberTestRunner"
```

---

### 測試執行

#### runSelectedTest(uri: vscode.Uri, lineNumber?: number, exampleLine?: number): Promise<void>

在終端機中執行選定的測試。

**參數**:
- `uri`: 功能檔案 URI
- `lineNumber`: 情境行號 (選填)
- `exampleLine`: 範例行號 (選填)

**行為**:
- 建立新終端機
- 根據 `executionMode` 選擇執行方式
- 顯示執行指令

**範例**:
```typescript
// 執行整個功能
await runSelectedTest(uri);

// 執行單一情境
await runSelectedTest(uri, 10);

// 執行單一範例
await runSelectedTest(uri, 10, 25);
```

---

#### runSelectedTestAndWait(uri: vscode.Uri, lineNumber?: number, exampleLine?: number, onOutput?: (chunk: string) => void, onStepUpdate?: (step: StepResult) => void): Promise<number>

執行測試並等待完成，適用於程式化執行。

**參數**:
- `uri`: 功能檔案 URI
- `lineNumber`: 情境行號
- `exampleLine`: 範例行號
- `onOutput`: 輸出回呼函數
- `onStepUpdate`: 步驟狀態更新回呼

**回傳**: 處理程序 exit code

**用途**: Test Explorer 整合執行

**範例**:
```typescript
const exitCode = await runSelectedTestAndWait(
  uri,
  10,
  undefined,
  (output) => console.log(output),
  (step) => updateTestExplorer(step)
);
```

---

#### runCucumberTestWithMaven(workspaceRoot: string, moduleInfo: ModuleInfo, featurePath: string, testClassName: string, terminal: vscode.Terminal, lineNumber?: number, exampleLineNumber?: number): Promise<void>

使用 Maven 在終端機執行測試。

**參數**:
- `workspaceRoot`: 工作區根目錄
- `moduleInfo`: Maven 模組資訊
- `featurePath`: 功能檔案相對路徑
- `testClassName`: 測試類別名稱
- `terminal`: VS Code 終端機
- `lineNumber`: 情境行號
- `exampleLineNumber`: 範例行號

**建構的指令範例**:
```bash
cd "/workspace" && mvn test \
  -Dcucumber.features="classpath:features/login.feature:10" \
  -pl backend/auth \
  -Dtest=CucumberTestRunner
```

---

#### runCucumberTestWithMavenResult(workspaceRoot: string, moduleInfo: ModuleInfo, featurePath: string, testClassName: string, lineNumber?: number, exampleLineNumber?: number, onOutput?: (chunk: string) => void, onStepUpdate?: (step: StepResult) => void): Promise<number>

使用 Maven 執行測試並回傳結果 (程式化)。

**參數**: 同 `runCucumberTestWithMaven`，但無 `terminal` 參數

**回傳**: Exit code

**特色**:
- 使用 `grep` 過濾輸出
- 即時解析步驟狀態
- 串流輸出到回呼函數

**過濾模式**:
```regex
✔|✘|✓|✗|×|↷|⊝|−|Given|When|Then|And|But|Scenario|Feature|Background|ERROR|Exception|AssertionError|at\s+|Caused by:|java\.|org\.junit|org\.opentest4j|[0-9]+\s+(Scenarios?|Steps?)\s+
```

---

### 解析輔助

#### findScenarioAtLine(document: vscode.TextDocument, line: number): ScenarioInfo | null

尋找游標位置所在的情境。

**參數**:
- `document`: 文件物件
- `line`: 行號 (0-indexed)

**回傳**: `ScenarioInfo` 或 `null`

**演算法**: 從目前行向上搜尋最近的 `Scenario:` 或 `Scenario Outline:`

**範例**:
```typescript
const scenario = findScenarioAtLine(document, 15);
// 回傳: { name: 'User login', lineNumber: 10 }
```

---

#### findExampleAtLine(document: vscode.TextDocument, line: number): ScenarioInfo | null

尋找游標位置所在的範例列。

**參數**:
- `document`: 文件物件
- `line`: 行號 (0-indexed)

**回傳**: `ScenarioInfo` (包含 `exampleLineNumber`) 或 `null`

**驗證**:
1. 行以 `|` 開頭
2. 在 `Examples:` 區塊內
3. 不是標題列
4. 屬於某個 Scenario Outline

**範例**:
```typescript
const example = findExampleAtLine(document, 25);
// 回傳: { name: 'example', lineNumber: 10, exampleLineNumber: 26 }
```

---

#### findExampleRowInfo(lines: string[], currentLine: number): { scenarioLine: number } | null

獨立函數版本的範例列偵測。

**參數**:
- `lines`: 所有行的陣列
- `currentLine`: 目前行號 (0-indexed)

**回傳**: Scenario Outline 行號或 `null`

---

#### convertToClasspathFormat(featureRelativePath: string, moduleRelativePath: string): string

轉換功能檔案路徑為 Maven classpath 格式。

**參數**:
- `featureRelativePath`: 功能檔案相對路徑
- `moduleRelativePath`: 模組相對路徑

**回傳**: Classpath 格式路徑

**轉換規則**:
- `src/test/resources/` → 移除
- `src/main/resources/` → 移除
- `src/test/java/` → 移除
- `src/main/java/` → 移除
- 加入 `classpath:` 前綴

**範例**:
```typescript
const classpath = convertToClasspathFormat(
  'backend/auth/src/test/resources/features/login.feature',
  'backend/auth'
);
// 回傳: "classpath:features/login.feature"
```

---

### 快取管理

#### getCachedTestClass(context: vscode.ExtensionContext, featurePath: string): string | undefined

取得快取的測試類別名稱。

**參數**:
- `context`: 擴充套件上下文
- `featurePath`: 功能檔案路徑

**回傳**: 測試類別名稱或 `undefined`

---

#### cacheTestClass(context: vscode.ExtensionContext, featurePath: string, testClassName: string): Promise<void>

快取測試類別名稱。

**參數**:
- `context`: 擴充套件上下文
- `featurePath`: 功能檔案路徑
- `testClassName`: 測試類別名稱

---

### 狀態列管理

#### updateExecutionModeStatusBar(): void

更新狀態列顯示。

**顯示**:
- Maven 模式: `$(package) Maven`
- Java 模式: `$(coffee) Java`

---

### 日誌記錄

#### logToExtension(message: string, level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG' = 'INFO'): void

記錄訊息到擴充套件日誌通道。

**參數**:
- `message`: 訊息內容
- `level`: 日誌等級

**輸出**:
- 擴充套件日誌通道
- 開發者主控台 (console.log)

**格式**:
```
[HH:MM:SS] [LEVEL] message
```

**範例**:
```typescript
logToExtension('Test started', 'INFO');
logToExtension('Failed to parse file', 'ERROR');
logToExtension('Detailed trace information', 'DEBUG');
```

---

## 全域變數

### globalTestController: CucumberTestController | undefined

全域測試控制器實例。

**用途**: 在擴充套件重新載入時清理舊實例

---

### cucumberOutputChannel: vscode.OutputChannel | undefined

Cucumber 測試結果輸出通道。

**內容**: 測試執行結果、步驟狀態、錯誤訊息

---

### extensionLogChannel: vscode.OutputChannel | undefined

擴充套件日誌輸出通道。

**內容**: 除錯日誌、資訊訊息、警告、錯誤

---

### executionModeStatusBar: vscode.StatusBarItem | undefined

執行模式狀態列項目。

**顯示**: 當前執行模式 (Java 或 Maven)
**互動**: 點擊切換模式

---

### globalContext: vscode.ExtensionContext | undefined

全域擴充套件上下文。

**用途**: 在非激活函數中存取工作區狀態

---

### TEST_CLASS_CACHE_KEY: string

測試類別快取的工作區狀態鍵。

**值**: `'cucumberTestClassMapping'`

---

## 生命週期函數

### activate(context: vscode.ExtensionContext): void

擴充套件啟動函數。

**執行流程**:
1. 儲存全域上下文
2. 清理舊的測試控制器
3. 建立輸出通道
4. 建立狀態列項目
5. 初始化測試控制器
6. 註冊 CodeLens Provider (如果啟用)
7. 註冊所有指令
8. 註冊配置變更監聽器

---

### deactivate(): void

擴充套件停用函數。

**目前**: 空實作 (資源清理由訂閱系統自動處理)

---

## 配置選項 API

所有配置選項都在 `cucumberJavaEasyRunner` 命名空間下。

### 存取配置

```typescript
const config = vscode.workspace.getConfiguration('cucumberJavaEasyRunner');
const executionMode = config.get<string>('executionMode', 'java');
```

### 更新配置

```typescript
await config.update('executionMode', 'maven', vscode.ConfigurationTarget.Workspace);
```

### 配置鍵值表

| 鍵 | 類型 | 預設值 | 說明 |
|----|------|--------|------|
| `executionMode` | `string` | `'java'` | 執行模式 (`'java'` \| `'maven'`) |
| `enableCodeLens` | `boolean` | `false` | 啟用 CodeLens |
| `showStepResults` | `boolean` | `true` | 顯示步驟結果 |
| `testClassName` | `string` | `''` | 測試類別名稱 |
| `mavenArgs` | `string` | `''` | Maven 參數 |
| `mavenProfile` | `string` | `''` | Maven profile |
| `cucumberTags` | `string` | `''` | Cucumber 標籤過濾 |
| `environmentVariables` | `object` | `{}` | 環境變數 |
| `rememberTestClass` | `boolean` | `true` | 記住測試類別 |

---

## 常數定義

### 符號映射

```typescript
// 步驟狀態符號
const STEP_SYMBOLS = {
  PASSED: ['✔', '✓'],
  FAILED: ['✘', '✗', '×'],
  SKIPPED: ['↷', '⊝', '−']
};
```

### 排除路徑

```typescript
const EXCLUDED_PATHS = [
  'target',
  'build',
  'out',
  'dist',
  'node_modules',
  '.git'
];
```

### 資源路徑前綴

```typescript
const RESOURCES_PREFIXES = [
  'src/test/resources/',
  'src/main/resources/',
  'src/test/java/',
  'src/main/java/'
];
```

---

## 錯誤碼

擴充套件沒有定義特定錯誤碼，但 exit code 有以下含義:

| Code | 說明 |
|------|------|
| `0` | 測試全部通過 |
| `1` | 測試失敗或執行錯誤 |
| 其他 | Maven 或 Java 處理程序錯誤 |

---

## 事件

### 檔案系統事件

```typescript
watcher.onDidCreate(uri => handleFileEvent('create', uri));
watcher.onDidChange(uri => handleFileEvent('change', uri));
watcher.onDidDelete(uri => handleFileEvent('delete', uri));
```

### 配置變更事件

```typescript
vscode.workspace.onDidChangeConfiguration((e) => {
  if (e.affectsConfiguration('cucumberJavaEasyRunner.executionMode')) {
    updateExecutionModeStatusBar();
  }
});
```

---

## 使用範例

### 完整的測試執行範例

```typescript
import * as vscode from 'vscode';

// 1. 取得功能檔案 URI
const uri = vscode.Uri.file('/workspace/features/login.feature');

// 2. 建立輸出回呼
const onOutput = (chunk: string) => {
  console.log(chunk);
};

// 3. 建立步驟狀態回呼
const onStepUpdate = (step: StepResult) => {
  console.log(`Step ${step.keyword} ${step.name}: ${step.status}`);
  if (step.errorMessage) {
    console.error(step.errorMessage);
  }
};

// 4. 執行測試
const exitCode = await runSelectedTestAndWait(
  uri,
  10,           // 情境行號
  undefined,    // 範例行號 (無)
  onOutput,
  onStepUpdate
);

console.log(`Test finished with exit code: ${exitCode}`);
```

### 自訂 CodeLens Provider

```typescript
class CustomCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const codeLenses: vscode.CodeLens[] = [];
    
    // 只在特定條件下提供 CodeLens
    if (document.fileName.includes('important')) {
      const range = new vscode.Range(0, 0, 0, 0);
      codeLenses.push(new vscode.CodeLens(range, {
        title: '🚀 Run Important Test',
        command: 'cucumberJavaEasyRunner.runFeature',
        arguments: [document.uri]
      }));
    }
    
    return codeLenses;
  }
}
```

---

## 最佳實踐

### 1. 錯誤處理

```typescript
try {
  const result = await runSelectedTestAndWait(uri);
  if (result !== 0) {
    vscode.window.showWarningMessage('Tests failed, check output for details');
  }
} catch (error) {
  vscode.window.showErrorMessage(`Error: ${error.message}`);
  logToExtension(error.stack, 'ERROR');
}
```

### 2. 取消支援

```typescript
async function runWithCancellation(
  uri: vscode.Uri,
  token: vscode.CancellationToken
) {
  if (token.isCancellationRequested) {
    return;
  }
  
  const result = await runSelectedTestAndWait(uri);
  
  if (token.isCancellationRequested) {
    logToExtension('Test execution cancelled', 'WARN');
    return;
  }
  
  // 處理結果...
}
```

### 3. 效能最佳化

```typescript
// 批次處理多個檔案
async function processFeatureFiles(uris: vscode.Uri[]) {
  // 使用 Promise.all 平行處理
  const results = await Promise.all(
    uris.map(uri => parseFeatureFile(uri))
  );
  
  // 批次更新 UI
  results.forEach(featureInfo => {
    if (featureInfo) {
      createTestItems(featureInfo);
    }
  });
}
```

---

## 除錯技巧

### 啟用詳細日誌

```typescript
// 在程式碼中
logToExtension('Detailed debug info', 'DEBUG');

// 在 VS Code 中查看
// 檢視 → 輸出 → Cucumber Java Easy Runner - Logs
```

### 檢查 Test Explorer 狀態

```typescript
// 列出所有測試項目
controller.items.forEach(item => {
  console.log(`Feature: ${item.label}`);
  item.children.forEach(child => {
    console.log(`  Scenario: ${child.label}`);
  });
});
```

### 追蹤 Maven 指令

```typescript
// 指令會記錄到日誌
logToExtension(`Maven test command: mvn ${mvnArgs.join(' ')}`, 'INFO');

// 查看完整的過濾指令
logToExtension(`Filtered Maven command: ${filteredCommand}`, 'DEBUG');
```
