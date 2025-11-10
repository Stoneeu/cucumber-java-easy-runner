# Cucumber Java Easy Runner - 擴充套件架構文件

## 概述

Cucumber Java Easy Runner 是一個 Visual Studio Code 擴充套件，專為 Java Cucumber 測試提供完整的整合支援。它提供了 Test Explorer 整合、即時測試執行、步驟級別的狀態追蹤，以及多模組 Maven 專案支援。

## 核心元件

### 1. CucumberOutputParser

**職責**: 即時解析 Cucumber 測試輸出，追蹤步驟執行狀態

**主要功能**:
- 解析 Cucumber 執行輸出中的步驟狀態符號 (✔ 通過, ✘ 失敗, ↷ 跳過)
- 擷取錯誤訊息和堆疊追蹤
- 移除 ANSI 色碼以便正確解析
- 透過回呼函數通知步驟狀態變更

**狀態機**:
```
空閒 → 發現步驟 → 擷取錯誤 (如果失敗) → 顯示結果 → 空閒
```

**關鍵方法**:
- `parseLine(line: string)`: 解析單行輸出
- `displayStepResult(result: StepResult)`: 顯示步驟結果
- `finalize()`: 完成解析並處理待處理的步驟
- `stripAnsiCodes(str: string)`: 移除 ANSI 色碼

### 2. CucumberTestController

**職責**: 管理 VS Code Test Explorer 整合

**主要功能**:
- 掃描工作區中的 `.feature` 檔案
- 建立測試層級結構 (Feature → Scenario → Steps/Examples)
- 處理檔案系統變更事件
- 執行測試並更新 UI 狀態
- 支援執行整個功能、單一情境或單一範例資料列

**測試項目階層**:
```
Feature (*.feature 檔案)
└── Scenario / Scenario Outline
    ├── Steps (Given/When/Then/And/But)
    └── Examples (資料表中的每一列)
```

**關鍵方法**:
- `discoverTests()`: 掃描並發現所有功能檔案
- `parseFeatureFile(document)`: 解析功能檔案結構
- `runSingleTest(testItem, run)`: 執行單一測試項目
- `handleFileEvent(eventType, uri)`: 處理檔案變更事件

### 3. CucumberCodeLensProvider

**職責**: 在功能檔案中提供內嵌的執行按鈕

**主要功能**:
- 在 Feature 行顯示 "▶" 按鈕
- 在 Scenario/Scenario Outline 行顯示執行按鈕
- 在範例資料列顯示執行按鈕
- 預設停用 (優先使用 Test Explorer)

**CodeLens 位置**:
- Feature: 行首 ($(play-circle) 圖示)
- Scenario: 行首 ($(play) 圖示)
- Example rows: 資料列行首 ($(play) 圖示)

### 4. 工具函數

#### 專案結構探索
- `findMavenModule(featureFilePath, workspaceRoot)`: 尋找最近的 Maven 模組
- `findGluePath(projectRoot)`: 尋找步驟定義目錄
- `findCucumberTestClass(modulePath)`: 自動偵測 Cucumber 測試類別

#### 測試執行
- `runSelectedTest(uri, lineNumber?, exampleLine?)`: 執行選定的測試 (終端機模式)
- `runSelectedTestAndWait(...)`: 執行測試並等待完成 (程式化模式)
- `runCucumberTest(...)`: Java 直接執行模式
- `runCucumberTestWithMaven(...)`: Maven 測試執行模式

#### 解析輔助
- `findScenarioAtLine(document, line)`: 尋找游標位置的情境
- `findExampleAtLine(document, line)`: 尋找游標位置的範例列
- `convertToClasspathFormat(...)`: 轉換為 Maven classpath 格式

## 資料結構

### StepInfo
```typescript
interface StepInfo {
  keyword: string;      // Given, When, Then, And, But
  text: string;         // 步驟文字
  lineNumber: number;   // 行號
}
```

### ScenarioInfo
```typescript
interface ScenarioInfo {
  name: string;
  lineNumber: number;
  exampleLineNumber?: number;
  examples?: ExampleInfo[];
  steps?: StepInfo[];
}
```

### FeatureInfo
```typescript
interface FeatureInfo {
  name: string;
  scenarios: ScenarioInfo[];
  filePath: string;
  lineNumber: number;
}
```

### ModuleInfo
```typescript
interface ModuleInfo {
  modulePath: string;           // Maven 模組的絕對路徑
  moduleRelativePath: string;   // 相對於工作區根目錄的路徑
  workspaceRoot: string;        // 工作區根目錄
}
```

### StepResult
```typescript
interface StepResult {
  keyword: string;
  name: string;
  status: 'passed' | 'failed' | 'skipped' | 'pending' | 'undefined';
  errorMessage?: string;
  location?: string;
}
```

## 執行模式

### 1. Java 直接執行模式 (`executionMode: 'java'`)

**優點**:
- 直接執行，無需完整 Maven 設定
- 適合簡單專案

**流程**:
1. 尋找 glue path (步驟定義套件)
2. 建立暫時的 `CucumberRunner.java`
3. 編譯並執行
4. 使用 Maven 建立 classpath

**限制**:
- 需要手動指定 glue path
- 不支援複雜的 Maven 設定

### 2. Maven 測試執行模式 (`executionMode: 'maven'`)

**優點**:
- 完整支援 Maven 生命週期
- 支援多模組專案
- 支援 Maven profiles 和自訂參數
- 自動偵測測試類別

**流程**:
1. 尋找或快取測試類別名稱
2. 轉換功能路徑為 classpath 格式
3. 建構 Maven 測試指令
4. 執行 `mvn test` 並過濾輸出
5. 即時解析步驟狀態

**Maven 指令範例**:
```bash
mvn test \
  -Dcucumber.features=classpath:features/login.feature:25 \
  -Dtest=CucumberTestRunner \
  -pl module-name
```

## 配置選項

### 基本設定
- `cucumberJavaEasyRunner.executionMode`: 執行模式 (`java` | `maven`)
- `cucumberJavaEasyRunner.enableCodeLens`: 啟用 CodeLens (預設: `false`)
- `cucumberJavaEasyRunner.showStepResults`: 顯示步驟結果 (預設: `true`)

### Maven 相關設定
- `cucumberJavaEasyRunner.testClassName`: 測試類別名稱
- `cucumberJavaEasyRunner.mavenArgs`: 額外的 Maven 參數
- `cucumberJavaEasyRunner.mavenProfile`: Maven profile
- `cucumberJavaEasyRunner.cucumberTags`: Cucumber 標籤過濾器
- `cucumberJavaEasyRunner.environmentVariables`: 環境變數
- `cucumberJavaEasyRunner.rememberTestClass`: 記住測試類別 (預設: `true`)

## 指令

### 公開指令
- `cucumberJavaEasyRunner.runFeature`: 執行整個功能檔案
- `cucumberJavaEasyRunner.runScenario`: 執行單一情境
- `cucumberJavaEasyRunner.runExample`: 執行單一範例列
- `cucumberJavaEasyRunner.toggleExecutionMode`: 切換執行模式
- `cucumberJavaEasyRunner.refreshTests`: 重新整理測試
- `cucumberJavaEasyRunner.clearTestClassCache`: 清除測試類別快取

### 內部指令 (CodeLens)
- `cucumberJavaEasyRunner.runFeatureCodeLens`
- `cucumberJavaEasyRunner.runScenarioCodeLens`
- `cucumberJavaEasyRunner.runExampleCodeLens`

## 輸出通道

### 1. Cucumber Test Results
顯示測試執行結果，包括:
- 步驟執行狀態 (✅ / ❌ / ⊝)
- 錯誤訊息
- 測試摘要統計

### 2. Cucumber Java Easy Runner - Logs
擴充套件內部日誌，包括:
- DEBUG: 詳細除錯訊息
- INFO: 一般資訊
- WARN: 警告訊息
- ERROR: 錯誤訊息

## 效能最佳化

### 1. 輸出過濾
使用 `grep` 在 Maven 執行階段即時過濾輸出，只保留關鍵資訊：
- 步驟狀態符號
- 錯誤訊息和堆疊追蹤
- 測試摘要
- Cucumber 關鍵字

**優勢**: 大幅減少需要處理的輸出量，提升效能

### 2. 測試類別快取
自動快取已偵測到的測試類別，避免重複掃描

### 3. 檔案監視過濾
排除建置目錄 (target, build, out, dist) 避免重複掃描

### 4. 延遲初始化
測試探索延遲 500ms 啟動，避免重複掃描

## Test Explorer 整合

### TestRun 生命週期
```
未開始 → started() → 執行中 → passed()/failed()/skipped() → 結束
```

### 步驟級別追蹤
1. 收集情境下的所有步驟項目
2. 建立步驟文字映射表
3. 透過 `onStepUpdate` 回呼接收即時狀態
4. 模糊匹配步驟 (移除標籤如 [MKT05A06])
5. 更新 Test Explorer UI

### 狀態判定邏輯
- **Scenario/Feature**: 如果任何步驟失敗則失敗，否則通過
- **Exit Code**: 不直接影響狀態 (支援多模組專案)
- **Steps**: 直接反映 Cucumber 輸出的狀態

## 錯誤處理

### 自動偵測失敗
1. 測試類別未設定 → 自動掃描或提示輸入
2. Glue path 未找到 → 提示使用者輸入
3. Maven 模組 → 自動向上搜尋 pom.xml

### 使用者提示
- 友善的錯誤訊息
- 自動建議解決方案
- 快取機制減少重複配置

## 多模組支援

### 模組偵測
從功能檔案向上搜尋，找到最近的 `pom.xml`

### Maven 指令建構
```bash
mvn test -pl module-path -Dcucumber.features=... -Dtest=...
```

### Classpath 轉換
```
src/test/resources/features/login.feature 
→ classpath:features/login.feature
```

## 狀態列整合

顯示當前執行模式:
- `$(coffee) Java`: Java 直接執行模式
- `$(package) Maven`: Maven 測試執行模式

點擊可切換模式

## 未來擴充性

### 架構設計考量
- **模組化**: 各元件職責清晰分離
- **可擴充**: 易於新增新的執行模式
- **可測試**: 介面設計便於單元測試
- **可配置**: 豐富的配置選項

### 潛在擴充方向
1. Gradle 支援
2. 測試報告產生
3. 覆蓋率整合
4. 遠端執行支援
5. 平行執行
6. 測試重試機制
