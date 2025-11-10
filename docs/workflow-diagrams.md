# Cucumber Java Easy Runner - 運作流程圖

本文件使用 Mermaid 圖表說明擴充套件的各種運作流程。

## 1. 擴充套件啟動流程

```mermaid
flowchart TD
    A[VS Code 啟動擴充套件] --> B[activate 函數]
    B --> C[建立輸出通道]
    C --> D[建立狀態列項目]
    D --> E[初始化 CucumberTestController]
    E --> F[註冊檔案監視器]
    F --> G[註冊指令]
    G --> H{啟用 CodeLens?}
    H -->|是| I[註冊 CodeLensProvider]
    H -->|否| J[跳過 CodeLens]
    I --> K[延遲 500ms]
    J --> K
    K --> L[掃描工作區測試檔案]
    L --> M[擴充套件就緒]
```

## 2. 測試探索流程

```mermaid
flowchart TD
    A[discoverTests 觸發] --> B[清除現有測試項目]
    B --> C[搜尋 *.feature 檔案]
    C --> D[排除建置目錄]
    D --> E{找到檔案?}
    E -->|是| F[讀取檔案內容]
    E -->|否| Z[完成]
    F --> G[解析 Feature 資訊]
    G --> H[建立 Feature TestItem]
    H --> I[解析 Scenarios]
    I --> J{有 Scenario?}
    J -->|是| K[建立 Scenario TestItem]
    J -->|否| Z
    K --> L[解析 Steps]
    L --> M[建立 Step TestItems]
    M --> N{Scenario Outline?}
    N -->|是| O[解析 Examples]
    N -->|否| P[加入到 Test Controller]
    O --> Q[建立 Example TestItems]
    Q --> P
    P --> R{還有檔案?}
    R -->|是| F
    R -->|否| Z
```

## 3. 功能檔案解析流程

```mermaid
flowchart TD
    A[parseFeatureFile] --> B[分割檔案為行]
    B --> C{處理每一行}
    C --> D{Feature:?}
    D -->|是| E[儲存 Feature 名稱]
    D -->|否| F{Scenario:?}
    E --> C
    F -->|是| G[建立新 ScenarioInfo]
    F -->|否| H{Scenario Outline:?}
    G --> I[加入到 scenarios 陣列]
    I --> C
    H -->|是| J[建立 Outline ScenarioInfo]
    H -->|否| K{以 | 開頭?}
    J --> I
    K -->|是| L{在 Examples 區塊?}
    K -->|否| M{Given/When/Then/And/But?}
    L -->|是| N[建立 ExampleInfo]
    L -->|否| C
    N --> O[加入到 currentScenario.examples]
    O --> C
    M -->|是| P[建立 StepInfo]
    M -->|否| C
    P --> Q[加入到 currentScenario.steps]
    Q --> C
    C --> R{還有行?}
    R -->|是| C
    R -->|否| S[回傳 FeatureInfo]
```

## 4. 測試執行流程 (Test Explorer)

```mermaid
flowchart TD
    A[使用者點擊執行] --> B[runTests 觸發]
    B --> C[建立 TestRun]
    C --> D{選擇項目?}
    D -->|是| E[使用選擇項目]
    D -->|否| F[收集所有測試]
    E --> G[迴圈處理每個項目]
    F --> G
    G --> H[runSingleTest]
    H --> I[TestRun.started]
    I --> J{測試類型?}
    J -->|Step| K[跳過 - 無法獨立執行]
    J -->|Example| L[提取行號]
    J -->|Scenario| M[提取行號]
    J -->|Feature| N[無行號限制]
    K --> O[TestRun.skipped]
    L --> P[建立步驟映射表]
    M --> P
    N --> P
    P --> Q[runSelectedTestAndWait]
    Q --> R[執行並串流輸出]
    R --> S[onStepUpdate 回呼]
    S --> T{步驟狀態?}
    T -->|passed| U[TestRun.passed]
    T -->|failed| V[TestRun.failed + 標記 hasFailedStep]
    T -->|skipped| W[TestRun.skipped]
    U --> X{還有步驟?}
    V --> X
    W --> X
    X -->|是| S
    X -->|否| Y{hasFailedStep?}
    Y -->|是| Z[測試已標記失敗]
    Y -->|否| AA[TestRun.passed]
    Z --> AB[TestRun.end]
    AA --> AB
    O --> AB
```

## 5. Maven 執行模式流程

```mermaid
flowchart TD
    A[runSelectedTestAndWait] --> B{executionMode?}
    B -->|maven| C[取得設定]
    B -->|java| D[Java 直接執行流程]
    C --> E{有測試類別名稱?}
    E -->|否| F{有快取?}
    E -->|是| G[使用設定的類別]
    F -->|是| H[使用快取類別]
    F -->|否| I[自動偵測測試類別]
    I --> J{找到?}
    J -->|否| K[提示使用者輸入]
    J -->|是| L[使用偵測到的類別]
    K --> M[快取測試類別]
    L --> M
    H --> N[轉換為 classpath 格式]
    G --> N
    M --> N
    N --> O[建構 Maven 參數]
    O --> P[加入 profile/tags/環境變數]
    P --> Q[建立 grep 過濾器]
    Q --> R[spawn mvn test | grep]
    R --> S[串流輸出到 parser]
    S --> T[CucumberOutputParser.parseLine]
    T --> U{偵測到步驟?}
    U -->|是| V[onStepUpdate 回呼]
    U -->|否| W[繼續讀取]
    V --> X[更新 Test Explorer]
    X --> W
    W --> Y{處理完成?}
    Y -->|否| S
    Y -->|是| Z[parser.finalize]
    Z --> AA[顯示測試摘要]
    AA --> AB[回傳 exit code]
```

## 6. 輸出解析流程 (CucumberOutputParser)

```mermaid
stateDiagram-v2
    [*] --> 空閒
    空閒 --> 解析步驟: 發現步驟符號
    解析步驟 --> 收集錯誤: 狀態=失敗
    解析步驟 --> 顯示結果: 狀態=通過/跳過
    收集錯誤 --> 收集錯誤: 堆疊追蹤行
    收集錯誤 --> 顯示結果: 空白行或新步驟
    顯示結果 --> 通知監聽器: onStepStatusChange
    通知監聽器 --> 輸出到通道: showStepResults=true
    通知監聽器 --> 空閒
    輸出到通道 --> 空閒
    
    note right of 解析步驟
        偵測符號:
        ✔ ✓ = passed
        ✘ ✗ × = failed
        ↷ ⊝ − = skipped
    end note
    
    note right of 收集錯誤
        匹配模式:
        - java.*
        - Error
        - Exception
        - at\s+
        - Caused by:
    end note
```

## 7. 檔案監視與更新流程

```mermaid
flowchart TD
    A[FileSystemWatcher 觸發] --> B{事件類型?}
    B -->|create| C[handleFileEvent create]
    B -->|change| D[handleFileEvent change]
    B -->|delete| E[handleFileEvent delete]
    C --> F{在建置目錄?}
    D --> F
    E --> G{在建置目錄?}
    F -->|是| H[忽略事件]
    F -->|否| I[延遲 100ms]
    G -->|是| H
    G -->|否| J[deleteTest]
    I --> K[createOrUpdateTest]
    K --> L[解析檔案]
    L --> M{已存在?}
    M -->|是| H
    M -->|否| N[建立 TestItem 階層]
    N --> O[加入到 Controller]
    J --> P[從 Controller 移除]
    O --> Q[完成]
    P --> Q
    H --> Q
```

## 8. 執行模式切換流程

```mermaid
flowchart TD
    A[使用者點擊狀態列] --> B[toggleExecutionMode 指令]
    B --> C[讀取當前模式]
    C --> D{當前模式?}
    D -->|java| E[切換為 maven]
    D -->|maven| F[切換為 java]
    E --> G[更新設定]
    F --> G
    G --> H[updateExecutionModeStatusBar]
    H --> I{新模式?}
    I -->|maven| J[顯示 $(package) Maven]
    I -->|java| K[顯示 $(coffee) Java]
    J --> L[顯示通知訊息]
    K --> L
    L --> M[完成]
```

## 9. 步驟狀態即時更新流程

```mermaid
sequenceDiagram
    participant User as 使用者
    participant TE as Test Explorer
    participant Controller as TestController
    participant Executor as runSelectedTestAndWait
    participant Maven as Maven Process
    participant Parser as CucumberOutputParser
    participant Callback as onStepUpdate
    
    User->>TE: 點擊執行測試
    TE->>Controller: runTests
    Controller->>Controller: 建立步驟映射表
    Controller->>Executor: runSelectedTestAndWait + callback
    Executor->>Maven: spawn mvn test | grep
    
    loop 測試執行中
        Maven->>Parser: 輸出行 (已過濾)
        Parser->>Parser: parseLine
        alt 偵測到步驟
            Parser->>Parser: 建立 StepResult
            Parser->>Callback: onStepUpdate(stepResult)
            Callback->>Controller: 接收步驟狀態
            Controller->>Controller: 模糊匹配步驟
            alt 找到對應的 TestItem
                Controller->>TE: TestRun.started(stepItem)
                alt 狀態=passed
                    Controller->>TE: TestRun.passed(stepItem)
                else 狀態=failed
                    Controller->>TE: TestRun.failed(stepItem)
                    Controller->>Controller: hasFailedStep = true
                    Controller->>TE: TestRun.failed(scenarioItem)
                else 狀態=skipped
                    Controller->>TE: TestRun.skipped(stepItem)
                end
                TE->>User: 更新 UI 顯示
            end
        end
    end
    
    Maven->>Parser: 處理完成
    Parser->>Parser: finalize()
    Executor->>Controller: 回傳 exit code
    Controller->>TE: TestRun.end()
```

## 10. 多模組 Maven 專案支援流程

```mermaid
flowchart TD
    A[開啟功能檔案] --> B[取得檔案路徑]
    B --> C[findMavenModule]
    C --> D[從檔案目錄開始]
    D --> E{在工作區內?}
    E -->|是| F{目錄有 pom.xml?}
    E -->|否| G[使用工作區根目錄]
    F -->|是| H[找到模組]
    F -->|否| I[向上一層目錄]
    I --> E
    H --> J[計算相對路徑]
    G --> K[moduleRelativePath = .]
    J --> L{是根目錄?}
    L -->|是| K
    L -->|否| M[moduleRelativePath = 相對路徑]
    K --> N[建立 ModuleInfo]
    M --> N
    N --> O[轉換功能路徑]
    O --> P[建構 Maven 指令]
    P --> Q{多模組?}
    Q -->|是| R[加入 -pl 參數]
    Q -->|否| S[不加入 -pl]
    R --> T[執行 Maven 測試]
    S --> T
```

## 11. 測試類別自動偵測流程

```mermaid
flowchart TD
    A[findCucumberTestClass] --> B[定位 src/test/java]
    B --> C{目錄存在?}
    C -->|否| Z[回傳 null]
    C -->|是| D[findTestClassWithCucumberAnnotations]
    D --> E[遞迴掃描目錄]
    E --> F{是目錄?}
    F -->|是| G[遞迴處理子目錄]
    F -->|否| H{檔名結尾?}
    H -->|Test.java| I[讀取檔案內容]
    H -->|Runner.java| I
    H -->|其他| E
    I --> J{包含 Cucumber 註解?}
    J -->|@RunWith| K[提取類別名稱]
    J -->|@CucumberOptions| K
    J -->|io.cucumber| K
    J -->|否| E
    K --> L[回傳類別名稱]
    G --> M{找到?}
    M -->|是| L
    M -->|否| E
    E --> N{還有項目?}
    N -->|是| E
    N -->|否| Z
```

## 12. Glue Path 自動偵測流程

```mermaid
flowchart TD
    A[findGluePath] --> B[定位 src/test/java]
    B --> C{目錄存在?}
    C -->|否| Z[回傳 null]
    C -->|是| D[findStepsDir]
    D --> E[遞迴掃描]
    E --> F{目錄名稱?}
    F -->|steps/step| G{有 .java 檔案?}
    F -->|其他| H[遞迴子目錄]
    G -->|直接有| I[找到 steps 目錄]
    G -->|子目錄有| I
    G -->|都沒有| H
    H --> J{找到?}
    J -->|是| I
    J -->|否| E
    I --> K[計算相對路徑]
    K --> L[轉換為套件名稱]
    L --> M[org/example/steps → org.example.steps]
    M --> N[回傳 glue path]
    E --> O{還有項目?}
    O -->|是| E
    O -->|否| Z
```

## 13. 功能檔案路徑轉換流程

```mermaid
flowchart TD
    A[convertToClasspathFormat] --> B[移除模組路徑前綴]
    B --> C{路徑開頭?}
    C -->|src/test/resources/| D[移除前綴]
    C -->|src/main/resources/| D
    C -->|src/test/java/| D
    C -->|src/main/java/| D
    C -->|其他| E[直接使用]
    D --> F[加入 classpath: 前綴]
    E --> F
    F --> G[範例: classpath:features/login.feature]
    G --> H{有行號?}
    H -->|Scenario| I[加入 :lineNumber]
    H -->|Example| J[加入 :scenarioLine:exampleLine]
    H -->|Feature| K[不加入行號]
    I --> L[完成路徑]
    J --> L
    K --> L
```

## 14. CodeLens 提供流程

```mermaid
flowchart TD
    A[provideCodeLenses] --> B{檔案類型?}
    B -->|非 .feature| Z[回傳空陣列]
    B -->|.feature| C[分割為行]
    C --> D[迴圈處理每一行]
    D --> E{行開頭?}
    E -->|Feature:| F[建立 Feature CodeLens]
    E -->|Scenario:| G[建立 Scenario CodeLens]
    E -->|Scenario Outline:| G
    E -->|管道符號 `|`| H[findExampleRowInfo]
    E -->|其他| D
    F --> I[位置: 行首, 圖示: $(play-circle)]
    G --> J[位置: 行首, 圖示: $(play)]
    H --> K{是範例資料列?}
    K -->|是| L[建立 Example CodeLens]
    K -->|否| D
    L --> M[位置: 行首, 圖示: $(play)]
    I --> N[加入到 codeLenses]
    J --> N
    M --> N
    N --> O{還有行?}
    O -->|是| D
    O -->|否| P[回傳 codeLenses 陣列]
```

## 15. 錯誤處理與使用者互動流程

```mermaid
flowchart TD
    A[執行測試] --> B{測試類別已設定?}
    B -->|否| C{有快取?}
    B -->|是| D[使用設定值]
    C -->|否| E[自動偵測]
    C -->|是| F[使用快取]
    E --> G{偵測成功?}
    G -->|否| H[showInputBox 提示]
    G -->|是| I[使用偵測值]
    H --> J{使用者輸入?}
    J -->|取消| K[顯示錯誤訊息]
    J -->|輸入| L[使用輸入值]
    K --> Z[中止執行]
    L --> M{記住設定?}
    I --> M
    F --> D
    M -->|是| N[快取到 workspaceState]
    M -->|否| O[不快取]
    N --> D
    O --> D
    D --> P[建構執行指令]
    P --> Q[執行測試]
```

## 16. 完整測試執行生命週期

```mermaid
gantt
    title 測試執行生命週期時序圖
    dateFormat X
    axisFormat %L ms

    section 準備階段
    建立 TestRun           :0, 10
    收集測試項目           :10, 20
    建立步驟映射表         :20, 30
    
    section Maven 執行
    建構 Maven 指令        :30, 50
    啟動 Maven 處理程序    :50, 100
    
    section 即時解析
    第一個步驟執行         :100, 200
    Parser 解析輸出        :150, 210
    onStepUpdate 回呼      :210, 220
    更新 Test Explorer     :220, 230
    
    第二個步驟執行         :230, 330
    Parser 解析輸出        :280, 340
    onStepUpdate 回呼      :340, 350
    更新 Test Explorer     :350, 360
    
    第三個步驟執行         :360, 460
    Parser 解析輸出        :410, 470
    onStepUpdate 回呼      :470, 480
    更新 Test Explorer     :480, 490
    
    section 完成階段
    Maven 處理程序結束     :490, 500
    Parser.finalize        :500, 510
    顯示測試摘要           :510, 530
    TestRun.end            :530, 540
```

## 17. 資料流圖

```mermaid
flowchart LR
    A[.feature 檔案] --> B[parseFeatureFile]
    B --> C[FeatureInfo]
    C --> D[TestController]
    D --> E[Test Explorer UI]
    
    F[使用者點擊] --> G[runTests]
    G --> H[runSelectedTestAndWait]
    H --> I[Maven Process]
    I --> J[stdout/stderr]
    J --> K[CucumberOutputParser]
    K --> L[StepResult]
    L --> M[onStepUpdate]
    M --> N[TestRun API]
    N --> E
    
    O[配置設定] --> P[vscode.workspace.getConfiguration]
    P --> Q[執行參數]
    Q --> H
    
    R[workspaceState] --> S[測試類別快取]
    S --> H
```

## 圖表說明

### 流程圖符號說明
- **矩形**: 處理步驟或函數
- **菱形**: 決策點或條件判斷
- **圓角矩形**: 開始/結束點
- **平行四邊形**: 輸入/輸出
- **圓柱**: 資料儲存

### 狀態圖符號說明
- **圓形**: 狀態
- **箭頭**: 狀態轉換
- **[*]**: 初始/結束狀態

### 時序圖符號說明
- **矩形**: 參與者
- **箭頭**: 訊息傳遞
- **虛線**: 回應
- **框**: 迴圈或條件區塊
