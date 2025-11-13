# VS Code Cucumber Debug 整合研究報告

**研究對象:** [lucasbiel7/cucumber-java-runner](https://github.com/lucasbiel7/cucumber-java-runner)  
**研究日期:** 2025-11-12  
**目的:** 了解成功的 Cucumber Java Debug 實作方式

---

## 📋 Executive Summary

**關鍵發現:** lucasbiel7/cucumber-java-runner 使用 **VS Code Debug API 的 Launch Mode**，完全繞過 Maven Surefire，直接啟動 `io.cucumber.core.cli.Main`。

**成功關鍵:**
1. ✅ **不依賴 Maven test phase** - 避免 Surefire 和 JaCoCo 干擾
2. ✅ **程式化解析 classpath** - 使用 `mvn dependency:build-classpath`
3. ✅ **統一 run/debug 模式** - 使用相同 API，只用 `noDebug` flag 區分
4. ✅ **先編譯後執行** - `mvn compile test-compile` 確保 .class 存在

---

## 🎯 核心架構

### 1. Debug 配置 (Launch Mode)

```typescript
// src/cucumberRunner.ts line 207-226
const config: vscode.DebugConfiguration = {
  type: 'java',
  name: configName,                          // e.g., "Cucumber Debug: Login scenario"
  request: 'launch',                         // ⭐ Launch mode (不是 attach)
  mainClass: 'io.cucumber.core.cli.Main',    // ⭐ 直接執行 Cucumber CLI
  projectName: path.basename(projectRoot),   // Maven project name
  cwd: '${workspaceFolder}',                 // 工作目錄
  args: cucumberArgs,                        // Cucumber 參數
  classPaths: classPaths,                    // ⭐ 程式化解析的 classpath
  vmArgs: `-Dfile.encoding=UTF-8`,           // JVM 參數
  console: 'integratedTerminal',             // 輸出到 Terminal
  noDebug: !isDebug,                         // ⭐ run vs debug 區分
  stopOnEntry: false,                        // 不在入口點暫停
  internalConsoleOptions: 'neverOpen',       // 不開內部 console
};
```

**為什麼這個配置有效:**
- ✅ `request: 'launch'` - Java Extension 直接啟動 JVM，完全掌控
- ✅ `mainClass: 'io.cucumber.core.cli.Main'` - Cucumber 官方 CLI 入口
- ✅ `classPaths: [...]` - 明確提供所有 JAR 路徑，不依賴 Maven
- ✅ `noDebug: !isDebug` - Run/Debug 共用同一套邏輯

### 2. Classpath 解析策略

```typescript
// src/mavenResolver.ts line 53-89
export async function resolveMavenClasspath(projectRoot: string): Promise<string[]> {
  // Step 1: 先編譯專案
  const compiled = await compileMavenProject(projectRoot);
  
  // Step 2: 使用 Maven 解析 dependencies
  const command = 'mvn dependency:build-classpath -DincludeScope=test -q -Dmdep.outputFile=/dev/stdout';
  
  exec(command, { cwd: projectRoot }, (error, stdout, stderr) => {
    const classPaths: string[] = [
      // ⭐ 關鍵路徑順序
      path.join(projectRoot, 'target', 'test-classes'),        // 測試 .class
      path.join(projectRoot, 'target', 'classes'),             // 主程式 .class
      path.join(projectRoot, 'target', 'generated-sources', 'annotations'),  // 產生的代碼
      path.join(projectRoot, 'target', 'generated-sources', 'swagger', 'java', 'main')
    ];
    
    // Step 3: 解析 Maven 輸出的 dependencies (用 : 分隔)
    const output = stdout.trim();
    if (output) {
      const dependencies = output.split(':').filter(dep => dep.trim().length > 0);
      classPaths.push(...dependencies);  // 加入所有 .m2/repository JAR
    }
  });
}
```

**關鍵技術點:**
1. **編譯在前** - `mvn compile test-compile` 確保 .class 最新
2. **Maven dependency:build-classpath** - 程式化取得所有 JAR 路徑
3. **包含 test-classes** - Cucumber step definitions 通常在測試目錄
4. **包含 generated-sources** - Lombok, Swagger 等產生的代碼

### 3. 編譯策略 (Incremental Compilation)

```typescript
// src/mavenResolver.ts line 17-51
async function compileMavenProject(projectRoot: string): Promise<boolean> {
  const config = vscode.workspace.getConfiguration('cucumberJavaRunner');
  const autoCompile = config.get('autoCompileMaven', true);
  
  if (!autoCompile) {
    return true;  // 用戶禁用自動編譯
  }
  
  // ⭐ 只在 target 不存在時才編譯 (增量編譯策略)
  const targetDir = path.join(projectRoot, 'target');
  if (!fs.existsSync(targetDir)) {
    // 顯示進度提示
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Compiling Maven project...',
    }, async () => {
      // 執行 Maven 編譯
      await exec('mvn compile test-compile', { cwd: projectRoot });
    });
  }
  
  return true;
}
```

**優點:**
- ⚡ **增量編譯** - `target` 存在就跳過，快速
- 🎯 **Maven 負責** - 利用 Maven 內建增量編譯
- 📊 **用戶控制** - `autoCompileMaven` 設定可關閉

---

## 🔄 完整執行流程

### Run/Debug Unified Flow

```
用戶點擊 "Run Test" 或 "Debug Test"
  ↓
runCucumberTest(uri, lineNumber, exampleLine, isDebug)  // isDebug = true/false
  ↓
runCucumberTestBatch([features], isDebug)
  ↓
executeCucumberTestBatch(projectRoot, features, gluePaths, isDebug)
  ↓
┌─────────────────────────────────────────────┐
│ 1. 解析 glue path                            │
│    findGluePath(projectRoot)                │
│    → 掃描 src/test/java 找 steps 目錄       │
└─────────────────────────────────────────────┘
  ↓
┌─────────────────────────────────────────────┐
│ 2. 編譯專案 (如果 target 不存在)            │
│    mvn compile test-compile                 │
└─────────────────────────────────────────────┘
  ↓
┌─────────────────────────────────────────────┐
│ 3. 解析 Maven classpath                     │
│    mvn dependency:build-classpath           │
│    → 取得所有 .m2/repository JAR            │
└─────────────────────────────────────────────┘
  ↓
┌─────────────────────────────────────────────┐
│ 4. 建構 Cucumber 參數                        │
│    --glue com.example.steps                 │
│    --plugin json:target/.cucumber-result.json│
│    src/test/resources/feature/Login.feature │
└─────────────────────────────────────────────┘
  ↓
┌─────────────────────────────────────────────┐
│ 5. 啟動 VS Code Debug Session               │
│    vscode.debug.startDebugging(             │
│      workspaceFolder,                       │
│      {                                      │
│        type: 'java',                        │
│        request: 'launch',                   │
│        mainClass: 'io.cucumber.core.cli.Main',│
│        classPaths: [...],                   │
│        args: cucumberArgs,                  │
│        noDebug: !isDebug  // ⭐ 關鍵區分    │
│      }                                      │
│    )                                        │
└─────────────────────────────────────────────┘
  ↓
┌─────────────────────────────────────────────┐
│ 6. 等待 Debug Session 結束                   │
│    vscode.debug.onDidTerminateDebugSession  │
└─────────────────────────────────────────────┘
  ↓
┌─────────────────────────────────────────────┐
│ 7. 解析測試結果                              │
│    讀取 .cucumber-result.json               │
│    → 標記 Test Explorer 的 pass/fail       │
└─────────────────────────────────────────────┘
```

---

## 💡 為什麼這個方法成功？

### 對比我們失敗的 v16-v22 方法

| 面向 | 我們的方法 (v16-v22) | lucasbiel7 的方法 | 結果 |
|------|---------------------|------------------|------|
| **執行方式** | Maven test (Surefire) | 直接執行 Cucumber CLI | ✅ 避開 Surefire |
| **Classpath** | -DargLine 或 MAVEN_OPTS | 程式化解析 | ✅ 完全掌控 |
| **JaCoCo 問題** | 需要禁用 | 不經過 Maven test，無影響 | ✅ 無干擾 |
| **pom.xml 依賴** | 需要 ${argLine} | 完全不依賴 | ✅ 通用性 |
| **Debug 模式** | Attach to Surefire fork JVM | Launch with Java Extension | ✅ 簡單可靠 |

### 核心差異

**我們的方法 (失敗):**
```
Maven main JVM
  → Surefire plugin
    → Fork test JVM (需要注入 JDWP)
      → 執行 Cucumber
        → 我們 attach debugger
```

**lucasbiel7 的方法 (成功):**
```
VS Code Java Extension
  → 直接啟動 JVM (Launch mode)
    → 執行 io.cucumber.core.cli.Main
      → Cucumber 執行測試
        → Debugger 已經附加 (如果 isDebug=true)
```

---

## 🎯 實作關鍵技術

### 1. Launch Mode Configuration

```typescript
// 完整的 Debug 配置
{
  type: 'java',                              // Java debugger
  name: 'Cucumber Debug: Login scenario',   // Session 名稱
  request: 'launch',                         // ⭐ LAUNCH (不是 attach)
  mainClass: 'io.cucumber.core.cli.Main',    // Cucumber CLI
  projectName: 'my-project',                 // Maven artifact ID
  cwd: '${workspaceFolder}',                 // 工作目錄
  
  // ⭐ Cucumber 參數
  args: '--glue com.example.steps --plugin json:target/result.json src/test/resources/feature/Login.feature:25',
  
  // ⭐ Classpath (程式化解析)
  classPaths: [
    '/project/target/test-classes',
    '/project/target/classes',
    '/home/user/.m2/repository/io/cucumber/cucumber-java/7.18.0/cucumber-java-7.18.0.jar',
    '/home/user/.m2/repository/io/cucumber/cucumber-core/7.18.0/cucumber-core-7.18.0.jar',
    // ... 所有 dependencies
  ],
  
  vmArgs: '-Dfile.encoding=UTF-8',           // JVM 參數
  console: 'integratedTerminal',             // Terminal 輸出
  noDebug: false,                            // ⭐ Debug mode
  stopOnEntry: false,                        // 不在 main 停止
  internalConsoleOptions: 'neverOpen'        // 不開 debug console
}
```

### 2. Classpath 解析細節

```bash
# Maven 命令
mvn dependency:build-classpath -DincludeScope=test -q -Dmdep.outputFile=/dev/stdout

# 輸出範例 (用 : 分隔)
/home/user/.m2/repository/io/cucumber/cucumber-java/7.18.0/cucumber-java-7.18.0.jar:/home/user/.m2/repository/io/cucumber/cucumber-core/7.18.0/cucumber-core-7.18.0.jar:/home/user/.m2/repository/...
```

**解析邏輯:**
```typescript
const dependencies = stdout.trim().split(':').filter(dep => dep.trim().length > 0);
```

### 3. Run vs Debug 區分

```typescript
// 完全相同的程式碼，只用一個 flag 區分
const config: vscode.DebugConfiguration = {
  // ... 所有其他配置相同
  noDebug: !isDebug  // ⭐ 關鍵: run mode 時 noDebug=true
};

await vscode.debug.startDebugging(workspaceFolder, config);
```

**優點:**
- ✅ 程式碼統一，不需要 run/debug 兩套
- ✅ `noDebug: true` 時 JVM 正常執行，無 debug overhead
- ✅ `noDebug: false` 時 debugger 自動附加

---

## 📊 與我們專案的對比

### 我們的 v22 方法 (失敗)

```typescript
// 使用 MAVEN_OPTS 注入 JDWP
const spawnEnv = {
  ...process.env,
  MAVEN_OPTS: '-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=5013'
};

// 執行 Maven test
spawn('sh', ['-c', 'mvn test -Dcucumber.features=... -Dtest=...'], {
  cwd: workspaceRoot,
  env: spawnEnv
});

// 等待 JDWP port 開啟
await waitForPort(5013);

// Attach debugger
const config = {
  type: 'java',
  request: 'attach',  // ⭐ Attach mode
  hostName: 'localhost',
  port: 5013
};
```

**問題:**
- ❌ 依賴 Surefire fork JVM
- ❌ MAVEN_OPTS 或 -DargLine 可能被覆蓋
- ❌ JaCoCo 干擾
- ❌ pom.xml 配置依賴

### lucasbiel7 的方法 (成功)

```typescript
// 1. 程式化解析 classpath
const classPaths = await resolveMavenClasspath(projectRoot);
// → ['/project/target/test-classes', '/home/user/.m2/repository/...jar', ...]

// 2. 直接 launch Cucumber
const config = {
  type: 'java',
  request: 'launch',  // ⭐ Launch mode
  mainClass: 'io.cucumber.core.cli.Main',
  classPaths: classPaths,  // ⭐ 明確提供
  args: cucumberArgs,
  noDebug: !isDebug  // ⭐ run/debug 統一
};

await vscode.debug.startDebugging(workspaceFolder, config);
```

**優點:**
- ✅ 完全繞過 Maven test phase
- ✅ 不受 Surefire 配置影響
- ✅ 不受 JaCoCo 影響
- ✅ 不需要修改 pom.xml
- ✅ Run/Debug 統一邏輯

---

## 🔧 實作建議

### 短期: 快速修復 (v23)

**策略:** 完全複製 lucasbiel7 的 launch mode 方法

```typescript
// src/extension.ts
async function runDebugTest(testItem: vscode.TestItem, isDebug: boolean) {
  // 1. 解析 glue path
  const gluePaths = await findGluePath(projectRoot);
  
  // 2. 編譯專案 (如果需要)
  await compileMavenProject(projectRoot);
  
  // 3. 解析 classpath
  const classPaths = await resolveMavenClasspath(projectRoot);
  
  // 4. 建構 Cucumber 參數
  const cucumberArgs = [
    ...gluePaths.flatMap(g => ['--glue', g]),
    '--plugin', 'json:target/cucumber-result.json',
    `${featurePath}:${lineNumber}`
  ].join(' ');
  
  // 5. Launch Cucumber
  const config: vscode.DebugConfiguration = {
    type: 'java',
    request: 'launch',
    mainClass: 'io.cucumber.core.cli.Main',
    projectName: path.basename(projectRoot),
    cwd: '${workspaceFolder}',
    args: cucumberArgs,
    classPaths: classPaths,
    vmArgs: '-Dfile.encoding=UTF-8',
    console: 'integratedTerminal',
    noDebug: !isDebug,
    stopOnEntry: false
  };
  
  await vscode.debug.startDebugging(workspaceFolder, config);
}
```

**優點:**
- ✅ 立即解決所有 Maven/Surefire/JaCoCo 問題
- ✅ Run/Debug 統一
- ✅ 不需要修改 pom.xml

### 中期: 優化 (v24+)

1. **增量編譯策略**
   ```typescript
   // 只在 target 不存在時編譯
   if (!fs.existsSync(path.join(projectRoot, 'target'))) {
     await exec('mvn compile test-compile');
   }
   ```

2. **Classpath 快取**
   ```typescript
   // 快取解析結果，避免重複執行 Maven
   const classpathCache = new Map<string, string[]>();
   ```

3. **進度提示**
   ```typescript
   await vscode.window.withProgress({
     location: vscode.ProgressLocation.Notification,
     title: 'Compiling and resolving dependencies...'
   }, async () => {
     // 編譯 + 解析
   });
   ```

### 長期: 架構改善

1. **移除 attach mode 相關代碼**
   - 刪除 JDWP 注入邏輯
   - 刪除 waitForPort 等待
   - 刪除 -DargLine 參數

2. **簡化配置**
   - 移除 JaCoCo skip 相關配置
   - 移除 attach mode 相關設定

3. **統一測試執行**
   - Run 和 Debug 共用同一個函數
   - 只用 `noDebug` flag 區分

---

## ⚠️ 注意事項

### 1. Java Extension 依賴

**必須安裝:**
- **Language Support for Java(TM) by Red Hat** 或
- **Extension Pack for Java by Microsoft**

**原因:**
- `type: 'java'` debug configuration 需要 Java debugger
- `vscode.debug.startDebugging()` 會呼叫 Java Extension

**驗證:**
```typescript
const javaExtension = vscode.extensions.getExtension('redhat.java') ||
                     vscode.extensions.getExtension('vscjava.vscode-java-pack');

if (!javaExtension) {
  vscode.window.showErrorMessage('Please install Java Extension Pack');
}
```

### 2. Maven dependency:build-classpath 版本

**需求:** Maven 3.0+

**驗證:**
```bash
mvn -version
# Apache Maven 3.6.3 (或更高)
```

### 3. Cucumber CLI 版本

**支援:** Cucumber JVM 6.0+

**mainClass 演進:**
```
Cucumber 4.x: cucumber.api.cli.Main
Cucumber 5.x: io.cucumber.core.cli.Main
Cucumber 6.x+: io.cucumber.core.cli.Main
```

**檢測:**
```typescript
// 檢查 pom.xml 的 Cucumber 版本
const pomXml = fs.readFileSync('pom.xml', 'utf-8');
const match = pomXml.match(/<cucumber\.version>(\d+)\./);
const majorVersion = match ? parseInt(match[1]) : 7;

const mainClass = majorVersion >= 5 
  ? 'io.cucumber.core.cli.Main' 
  : 'cucumber.api.cli.Main';
```

### 4. Step Definitions 掃描

**lucasbiel7 的方法:**
```typescript
// 遞迴掃描 src/test/java 找 steps 目錄
async function findStepsDir(dir: string): Promise<string | null> {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === 'steps' || entry.name === 'stepdefinitions') {
        return path.join(dir, entry.name);
      }
      // 遞迴搜尋
      const found = await findStepsDir(path.join(dir, entry.name));
      if (found) return found;
    }
  }
  return null;
}
```

**轉換為 Java package:**
```typescript
// src/test/java/com/example/steps → com.example.steps
const relativePath = path.relative(
  path.join(projectRoot, 'src', 'test', 'java'),
  stepsDir
);
const gluePath = relativePath.replace(/[\/\\]/g, '.');
```

---

## 📝 總結

### ✅ 成功關鍵

1. **Launch Mode** - 完全掌控 JVM 啟動
2. **程式化 Classpath** - 不依賴 Maven test phase
3. **Run/Debug 統一** - `noDebug` flag 區分
4. **先編譯後執行** - 確保 .class 存在

### ❌ 我們失敗的原因

1. **Attach Mode** - 依賴 Surefire fork JVM
2. **JDWP 注入** - 被 JaCoCo argLine 覆蓋
3. **pom.xml 依賴** - 不同專案配置不同
4. **Maven plugin 衝突** - 無法從外部完全控制

### 🎯 下一步

**立即行動 (v23):**
1. 實作 `resolveMavenClasspath()` 函數
2. 修改 debug 邏輯為 launch mode
3. 移除所有 JDWP 注入相關代碼
4. 測試驗證

**預期結果:**
- ✅ Debug 功能正常運作
- ✅ 不需要修改 pom.xml
- ✅ 支援所有 Maven 專案
- ✅ Run/Debug 統一邏輯

---

## 📚 參考資料

1. **lucasbiel7/cucumber-java-runner**
   - GitHub: https://github.com/lucasbiel7/cucumber-java-runner
   - 關鍵檔案: `src/cucumberRunner.ts`, `src/mavenResolver.ts`

2. **VS Code Debug API**
   - DebugConfiguration: https://code.visualstudio.com/api/references/vscode-api#DebugConfiguration
   - Debug Session: https://code.visualstudio.com/api/references/vscode-api#DebugSession

3. **Cucumber JVM CLI**
   - Main Class: `io.cucumber.core.cli.Main`
   - Arguments: https://cucumber.io/docs/cucumber/api/#options

4. **Maven Dependency Plugin**
   - build-classpath: https://maven.apache.org/plugins/maven-dependency-plugin/build-classpath-mojo.html

---

**文檔版本:** v1.0  
**最後更新:** 2025-11-12  
**作者:** GitHub Copilot  
**審查:** 需要技術團隊 review
