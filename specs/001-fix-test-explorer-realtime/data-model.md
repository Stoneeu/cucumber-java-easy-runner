# Data Model: Fix Test Explorer Real-time Status Updates

**Date**: 2025-11-09  
**Feature**: Fix Test Explorer Real-time Status Updates

This document defines the core entities, their relationships, and state transitions for real-time Test Explorer status updates.

---

## Entity Diagram

```
┌─────────────────┐
│   FeatureInfo   │
├─────────────────┤
│ name: string    │
│ filePath: string│
│ lineNumber: int │
│ scenarios: []   │───┐
└─────────────────┘   │
                      │
                      ▼
           ┌──────────────────┐
           │  ScenarioInfo    │
           ├──────────────────┤
           │ name: string     │
           │ lineNumber: int  │
           │ steps: []        │───┐
           │ examples: []     │   │
           └──────────────────┘   │
                                  │
                                  ▼
                       ┌─────────────────┐
                       │    StepInfo     │
                       ├─────────────────┤
                       │ keyword: string │
                       │ text: string    │
                       │ lineNumber: int │
                       └─────────────────┘

┌──────────────────────┐
│  CucumberOutputParser│
├──────────────────────┤
│ currentStep: ?       │
│ errorLines: string[] │
│ isCapturingError: bool│
│ onStepStatusChange:  │
│   callback           │
├──────────────────────┤
│ parseLine()          │
│ stripAnsiCodes()     │
│ finalize()           │
│ reset()              │
└──────────────────────┘

┌──────────────────┐        ┌──────────────────┐
│   TestItem       │        │    TestRun       │
├──────────────────┤        ├──────────────────┤
│ id: string       │        │ started()        │
│ label: string    │        │ passed()         │
│ uri: Uri         │        │ failed()         │
│ range: Range     │        │ skipped()        │
│ children: []     │        │ appendOutput()   │
└──────────────────┘        │ end()            │
                            └──────────────────┘

┌──────────────────┐
│   StepResult     │
├──────────────────┤
│ keyword: string  │
│ name: string     │
│ status: enum     │
│ errorMessage?: str│
│ location?: string│
└──────────────────┘
```

---

## 1. FeatureInfo

Represents a parsed feature file with its scenarios.

### Fields

| Field | Type | Description | Validation |
|-------|------|-------------|------------|
| `name` | string | Feature name from `Feature:` line | Required, non-empty |
| `filePath` | string | Absolute path to .feature file | Required, valid file path |
| `lineNumber` | number | 1-indexed line number of Feature keyword | Required, > 0 |
| `scenarios` | ScenarioInfo[] | List of scenarios in this feature | Can be empty |

### Relationships

- **One-to-Many**: FeatureInfo contains multiple ScenarioInfo
- **Source**: Parsed from .feature file via `parseFeatureFile()`

### State Transitions

```
[File Created] → [Parsed] → [TestItem Created] → [Watched]
                                                      ↓
[File Modified] → [Re-parsed] → [TestItem Updated]
                                                      ↓
[File Deleted] → [TestItem Removed] → [Unwatched]
```

---

## 2. ScenarioInfo

Represents a single scenario or scenario outline in a feature file.

### Fields

| Field | Type | Description | Validation |
|-------|------|-------------|------------|
| `name` | string | Scenario name from `Scenario:` or `Scenario Outline:` | Required, non-empty |
| `lineNumber` | number | 1-indexed line number of Scenario keyword | Required, > 0 |
| `exampleLineNumber` | number? | Line number for specific example row (optional) | If present, > 0 |
| `steps` | StepInfo[]? | List of steps in this scenario | Optional |
| `examples` | ExampleInfo[]? | List of example rows for Scenario Outline | Optional |

### Relationships

- **Belongs-to**: ScenarioInfo belongs to one FeatureInfo
- **One-to-Many**: ScenarioInfo contains multiple StepInfo
- **One-to-Many**: ScenarioInfo contains multiple ExampleInfo (for outlines)

### State Transitions

```
[Idle] → [Started] → [Running] → [Passed]
                               ↘ [Failed]
                               ↘ [Skipped]
```

**Trigger events**:
- Started: `TestRun.started(scenarioItem)` called
- Running: First step begins execution
- Passed: All steps passed, no failures
- Failed: Any step failed
- Skipped: Entire scenario skipped (e.g., tag filter)

---

## 3. StepInfo

Represents a single step (Given/When/Then/And/But) in a scenario.

### Fields

| Field | Type | Description | Validation |
|-------|------|-------------|------------|
| `keyword` | string | Step keyword: Given, When, Then, And, But | Required, enum |
| `text` | string | Step text without keyword | Required, non-empty |
| `lineNumber` | number | 1-indexed line number of step in feature file | Required, > 0 |

### Relationships

- **Belongs-to**: StepInfo belongs to one ScenarioInfo

### State Transitions

```
[Idle] → [Started] → [Running] → [Passed]
                               ↘ [Failed]
                               ↘ [Skipped]
```

**Trigger events**:
- Started: `TestRun.started(stepItem)` called
- Running: Cucumber begins executing step
- Passed: Cucumber outputs success symbol (✔✓)
- Failed: Cucumber outputs failure symbol (✘✗×)
- Skipped: Cucumber outputs skip symbol (↷⊝−)

---

## 4. StepResult

Represents the execution result of a single step, parsed from Cucumber output.

### Fields

| Field | Type | Description | Validation |
|-------|------|-------------|------------|
| `keyword` | string | Step keyword: Given, When, Then, And, But | Required, enum |
| `name` | string | Step text (may include tags like [TAG]) | Required, non-empty |
| `status` | StepStatus | passed \| failed \| skipped \| pending \| undefined | Required, enum |
| `errorMessage` | string? | Full error message and stack trace (for failed steps) | Optional |
| `location` | string? | Step definition location (file:line) | Optional |

### Enum: StepStatus

```typescript
type StepStatus = 
  | 'passed'      // Step executed successfully
  | 'failed'      // Step threw exception or assertion failed
  | 'skipped'     // Step not executed (previous step failed)
  | 'pending'     // Step has no implementation
  | 'undefined';  // Step has no matching step definition
```

### Relationships

- **Created-by**: CucumberOutputParser creates StepResult from output lines
- **Consumed-by**: TestRun updates TestItem status based on StepResult

### Lifecycle

```
[Output Line Received]
         ↓
[Parser Detects Step Pattern]
         ↓
[Create StepResult with status]
         ↓
[Accumulate Error Lines (if failed)]
         ↓
[Finalize on Next Step/Blank Line]
         ↓
[Trigger onStepStatusChange Callback]
         ↓
[Update TestItem in Test Explorer]
```

---

## 5. CucumberOutputParser

Stateful parser for Cucumber test execution output.

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `outputChannel` | vscode.OutputChannel | VS Code output channel for logging |
| `currentStep` | StepResult \| null | Currently parsing step (pending finalization) |
| `showStepResults` | boolean | Whether to display step results in output |
| `isCapturingError` | boolean | Currently capturing multi-line error message |
| `errorLines` | string[] | Accumulated error message lines |
| `onStepStatusChange` | callback? | Callback fired when step result finalized |

### Methods

#### `parseLine(line: string): StepResult | null`

Parses a single line of Cucumber output.

**Input**: Raw output line (may contain ANSI codes)  
**Output**: StepResult if step finalized, null if buffering

**Algorithm**:
1. Strip ANSI color codes
2. Match step pattern with status symbol
3. If step matched:
   - Finalize previous step if exists
   - Create new currentStep
   - Return immediately if skipped
4. If error pattern matched and currentStep is failed:
   - Append to errorLines
5. If finalization condition met (blank line, new scenario, etc):
   - Attach errorLines to currentStep
   - Fire onStepStatusChange callback
   - Return finalized StepResult

**State mutations**: Updates `currentStep`, `errorLines`, `isCapturingError`

#### `stripAnsiCodes(str: string): string`

Removes ANSI escape sequences from string.

**Pattern**: `/\x1b\[[0-9;]*m/g`  
**Example**: `"\x1b[32m✔\x1b[0m"` → `"✔"`

#### `finalize(): void`

Forces finalization of pending currentStep.

**Called**: On test execution end to ensure no steps left buffered

#### `reset(): void`

Clears all parser state for new test run.

---

## 6. TestItem (VS Code API)

Represents a test entity in VS Code Test Explorer (provided by VS Code API, not defined by extension).

### Key Properties

| Property | Type | Description |
|----------|------|-------------|
| `id` | string | Unique identifier (file path + line number) |
| `label` | string | Display name in Test Explorer |
| `uri` | vscode.Uri | File URI for navigation |
| `range` | vscode.Range | Line range in file for gutter icons |
| `children` | TestItemCollection | Child test items (scenarios → steps) |

### Hierarchy

```
TestItem (Feature)
  ├── TestItem (Scenario 1)
  │     ├── TestItem (Step 1)
  │     ├── TestItem (Step 2)
  │     └── TestItem (Step 3)
  └── TestItem (Scenario 2)
        ├── TestItem (Example 1)
        └── TestItem (Example 2)
```

### ID Format

```
Feature:     /absolute/path/to/feature.feature
Scenario:    /absolute/path/to/feature.feature:scenario:12
Step:        /absolute/path/to/feature.feature:scenario:12:step:15
Example:     /absolute/path/to/feature.feature:scenario:12:example:20
```

---

## 7. TestRun (VS Code API)

Represents an active test execution session (provided by VS Code API).

### Key Methods

| Method | Parameters | Description |
|--------|------------|-------------|
| `started()` | testItem: TestItem | Mark item as started (shows running icon) |
| `passed()` | testItem: TestItem, duration?: number | Mark item as passed |
| `failed()` | testItem: TestItem, message: TestMessage, duration?: number | Mark item as failed with error |
| `skipped()` | testItem: TestItem | Mark item as skipped |
| `appendOutput()` | output: string, location?: Location, test?: TestItem | Append output to test result |
| `end()` | | Finalize test run |

### Method Call Order

**CRITICAL**: Must call `started()` before any terminal state method.

```typescript
// Correct:
run.started(item);
run.passed(item);

// Incorrect (UI won't show running state):
run.passed(item);  // Missing started() call
```

---

## Validation Rules

### Cross-Entity Constraints

1. **Feature → Scenario**: All scenario lineNumbers must be within feature file line range
2. **Scenario → Step**: All step lineNumbers must be between scenario line and next scenario line
3. **TestItem IDs**: Must be unique across entire Test Explorer tree
4. **Step Matching**: Step text in TestItem.label must fuzzy-match StepResult.name (after tag stripping)

### State Consistency

1. **Parser State**: At most one `currentStep` at any time
2. **Error Capture**: Only capture errors when `currentStep.status === 'failed'`
3. **TestRun Lifecycle**: Each TestItem receives exactly one started() and one terminal state call per run

---

## Data Flow

```
[Feature File] 
     ↓ parseFeatureFile()
[FeatureInfo + ScenarioInfo + StepInfo]
     ↓ createOrUpdateTest()
[TestItem hierarchy in Test Explorer]
     ↓ runSingleTest()
[TestRun session started]
     ↓ Execute Java/Maven process
[Cucumber output stream]
     ↓ CucumberOutputParser.parseLine()
[StepResult objects]
     ↓ onStepStatusChange callback
[TestRun.started/passed/failed/skipped]
     ↓
[Test Explorer UI updates in real-time]
```

---

## Summary

This data model supports:
- ✅ Hierarchical test structure (Feature → Scenario → Step)
- ✅ Real-time status parsing from Cucumber output
- ✅ Fuzzy step name matching with tag handling
- ✅ Multi-line error message accumulation
- ✅ Proper TestRun lifecycle management
- ✅ State consistency during concurrent parsing

All entities align with VS Code Test Explorer API requirements and Cucumber output format specifications.
