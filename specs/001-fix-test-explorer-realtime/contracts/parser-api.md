# CucumberOutputParser API Contract

**Version**: 1.0  
**Date**: 2025-11-09

This document defines the interface contract for the `CucumberOutputParser` class, which parses Cucumber test execution output in real-time and emits step status events.

---

## Interface

```typescript
class CucumberOutputParser {
  constructor(
    outputChannel: vscode.OutputChannel,
    showStepResults: boolean = true,
    onStepStatusChange?: (step: StepResult) => void
  );

  parseLine(line: string): StepResult | null;
  finalize(): void;
  reset(): void;
}
```

---

## Constructor

### Signature

```typescript
constructor(
  outputChannel: vscode.OutputChannel,
  showStepResults: boolean = true,
  onStepStatusChange?: (step: StepResult) => void
)
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `outputChannel` | vscode.OutputChannel | ✅ Yes | VS Code output channel for logging step results |
| `showStepResults` | boolean | ❌ No (default: true) | Whether to display step results in output channel |
| `onStepStatusChange` | (step: StepResult) => void | ❌ No | Callback fired when step result is finalized |

### Behavior

- Initializes parser state: `currentStep = null`, `errorLines = []`, `isCapturingError = false`
- Stores callback for later invocation
- Does NOT display any output until `parseLine()` is called

### Example

```typescript
const parser = new CucumberOutputParser(
  cucumberOutputChannel,
  true,
  (stepResult) => {
    console.log(`Step ${stepResult.status}: ${stepResult.keyword} ${stepResult.name}`);
  }
);
```

---

## parseLine()

### Signature

```typescript
parseLine(line: string): StepResult | null
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `line` | string | Single line of Cucumber output (may contain ANSI codes) |

### Returns

| Value | Condition |
|-------|-----------|
| `StepResult` | When a step is finalized (passed/failed/skipped determined) |
| `null` | When buffering incomplete data or accumulating error lines |

### Behavior

1. **Strip ANSI codes**: Removes color codes via `stripAnsiCodes()`
2. **Match step pattern**: 
   ```regex
   /^\s*[✔✘✓✗×↷⊝−]?\s*(Given|When|Then|And|But)\s+(.+?)\s*(?:#|$)/
   ```
3. **If step matched**:
   - Finalize previous `currentStep` if exists
   - Create new `StepResult` with keyword, name, and status (from symbol)
   - If status is `skipped`: finalize immediately and return
   - Otherwise: store as `currentStep` and wait for error details
4. **If error pattern matched** (and `currentStep.status === 'failed'`):
   ```regex
   /^\s+(java\.|org\.|Error|Exception|AssertionError|at\s+|Caused by:|\.\.\.)/
   ```
   - Set `isCapturingError = true`
   - Append line to `errorLines[]`
5. **If finalization condition met**:
   - Blank line
   - New scenario/feature marker
   - Another step symbol
   - Attach `errorLines` to `currentStep.errorMessage`
   - Call `onStepStatusChange(currentStep)` callback
   - Display in output channel (if `showStepResults = true`)
   - Return finalized `StepResult`

### State Mutations

- `currentStep`: Set to new StepResult or null
- `errorLines`: Accumulates error message lines, cleared on finalization
- `isCapturingError`: Toggled when entering/exiting error capture mode

### Thread Safety

❌ **Not thread-safe**: Call `parseLine()` sequentially from single thread only.

### Example

```typescript
// Parse stream of lines
const lines = [
  "    ✔ Given I am logged in    # StepDefs.login()",
  "    ✘ When I create segment    # StepDefs.create()",
  "      java.lang.AssertionError: Expected 200 but got 400",
  "      at StepDefs.create(StepDefs.java:45)",
  "    ↷ Then I verify result    # StepDefs.verify()"
];

for (const line of lines) {
  const result = parser.parseLine(line);
  if (result) {
    console.log(`Finalized: ${result.status} - ${result.keyword} ${result.name}`);
  }
}

// Output:
// Finalized: passed - Given I am logged in
// Finalized: failed - When I create segment
// Finalized: skipped - Then I verify result
```

---

## finalize()

### Signature

```typescript
finalize(): void
```

### Parameters

None

### Returns

`void`

### Behavior

- If `currentStep` exists (pending finalization):
  - Attach accumulated `errorLines` to `currentStep.errorMessage`
  - Call `onStepStatusChange(currentStep)` callback
  - Display in output channel
- Clear all parser state: `currentStep = null`, `errorLines = []`, `isCapturingError = false`

### Use Case

Call at end of test execution to ensure no buffered steps are lost.

### Example

```typescript
child.on('close', (code) => {
  parser.finalize();  // Flush any pending step
  console.log(`Test execution complete with code ${code}`);
});
```

---

## reset()

### Signature

```typescript
reset(): void
```

### Parameters

None

### Returns

`void`

### Behavior

- Clear all parser state: `currentStep = null`, `errorLines = []`, `isCapturingError = false`
- Does NOT fire `onStepStatusChange` callback
- Does NOT display any output

### Use Case

Prepare parser for new test execution without displaying pending steps.

### Example

```typescript
// Reset before new test run
parser.reset();
runNewTest();
```

---

## Callback Contract

### onStepStatusChange

```typescript
type StepStatusChangeCallback = (step: StepResult) => void;
```

### When Called

- When a step is finalized (status determined, error captured if applicable)
- Before `parseLine()` returns the StepResult
- After displaying in output channel (if enabled)

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `step` | StepResult | Finalized step result with keyword, name, status, optional error |

### Expected Behavior

Callback should:
- ✅ Update Test Explorer UI (`TestRun.started/passed/failed/skipped`)
- ✅ Map step name to TestItem (handle fuzzy matching)
- ✅ Complete synchronously or queue async work
- ❌ NOT throw exceptions (will break parser state)
- ❌ NOT call `parseLine()` recursively

### Example

```typescript
const onStepUpdate = (stepResult: StepResult) => {
  const stepKey = `${stepResult.keyword} ${stepResult.name}`;
  const stepItem = stepItemsMap.get(stepKey);
  
  if (stepItem) {
    run.started(stepItem);
    switch (stepResult.status) {
      case 'passed':
        run.passed(stepItem);
        break;
      case 'failed':
        run.failed(stepItem, new vscode.TestMessage(stepResult.errorMessage || 'Failed'));
        break;
      case 'skipped':
        run.skipped(stepItem);
        break;
    }
  }
};
```

---

## Input Format Assumptions

### Cucumber Output Format

Parser expects Cucumber pretty formatter output:

```
Feature: User Authentication

  Scenario: Login with valid credentials
    ✔ Given I am on the login page    # StepDefs.loginPage()
    ✔ When I enter valid credentials    # StepDefs.enterCreds()
    ✔ Then I see the dashboard    # StepDefs.verifyDashboard()

  Scenario: Login with invalid credentials
    ✔ Given I am on the login page    # StepDefs.loginPage()
    ✘ When I enter invalid credentials    # StepDefs.enterCreds()
      java.lang.AssertionError: Expected redirect but got 401
        at StepDefs.enterCreds(StepDefs.java:34)
        at ✽.I enter invalid credentials(login.feature:12)
    ↷ Then I see error message    # StepDefs.verifyError()

2 Scenarios (1 failed, 1 passed)
6 Steps (1 failed, 1 skipped, 4 passed)
```

### Symbol Variants

| Status | Symbols |
|--------|---------|
| Passed | `✔` (U+2714), `✓` (U+2713) |
| Failed | `✘` (U+2718), `✗` (U+2717), `×` (U+00D7) |
| Skipped | `↷` (U+21B7), `⊝` (U+229D), `−` (U+2212) |

### ANSI Codes

Input may contain ANSI escape sequences:

```
\x1b[32m✔ Given I am logged in\x1b[0m
\x1b[31m✘ When I create segment\x1b[0m
```

Parser strips these before pattern matching.

---

## Error Handling

### Invalid Input

| Condition | Behavior |
|-----------|----------|
| Empty line | Triggers step finalization if currentStep exists |
| Unrecognized format | No-op, returns null |
| Malformed regex | Logged to console, returns null |

### State Corruption

If parser state becomes inconsistent:
- Call `reset()` to clear state
- Re-parse from clean state

---

## Performance Characteristics

| Operation | Time Complexity | Notes |
|-----------|----------------|-------|
| `parseLine()` | O(n) | n = line length (regex matching) |
| `stripAnsiCodes()` | O(n) | n = line length (regex replace) |
| `finalize()` | O(1) | Constant time |
| `reset()` | O(1) | Constant time |

### Memory

- `errorLines[]`: Grows with multi-line errors (typically <50 lines)
- `currentStep`: Single object (constant size)

---

## Compatibility

### Cucumber Versions

✅ Tested with:
- Cucumber JVM 6.x
- Cucumber JVM 7.x
- Cucumber JVM 8.x

### Node.js

✅ Requires Node.js 16+ (no external dependencies)

### VS Code

✅ Requires VS Code 1.93.1+ (for OutputChannel API)

---

## Example Usage

```typescript
// Setup
const cucumberOutputChannel = vscode.window.createOutputChannel('Cucumber Test Results');
const stepItemsMap = new Map<string, vscode.TestItem>();

const onStepUpdate = (stepResult: StepResult) => {
  const stepKey = `${stepResult.keyword} ${stepResult.name}`;
  let stepItem = stepItemsMap.get(stepKey);
  
  // Fuzzy match if exact match fails
  if (!stepItem) {
    const cleanedName = stepResult.name.replace(/\[[\w\d]+\]\s*/g, '').trim();
    const cleanedKey = `${stepResult.keyword} ${cleanedName}`;
    for (const [label, item] of stepItemsMap.entries()) {
      const cleanedLabel = label.replace(/\[[\w\d]+\]\s*/g, '').trim();
      if (cleanedLabel === cleanedKey) {
        stepItem = item;
        break;
      }
    }
  }
  
  if (stepItem) {
    run.started(stepItem);
    switch (stepResult.status) {
      case 'passed':
        run.passed(stepItem);
        break;
      case 'failed':
        run.failed(stepItem, new vscode.TestMessage(stepResult.errorMessage || 'Failed'));
        break;
      case 'skipped':
        run.skipped(stepItem);
        break;
    }
  }
};

const parser = new CucumberOutputParser(cucumberOutputChannel, true, onStepUpdate);

// Parse output stream
child.stdout?.on('data', (chunk: Buffer) => {
  const output = chunk.toString();
  lineBuffer += output;
  
  const lines = lineBuffer.split('\n');
  lineBuffer = lines.pop() || '';
  
  for (const line of lines) {
    parser.parseLine(line);
  }
});

child.on('close', (code) => {
  if (lineBuffer.trim()) {
    parser.parseLine(lineBuffer);
  }
  parser.finalize();
});
```

---

## Summary

The CucumberOutputParser contract defines:
- ✅ Real-time line-by-line parsing of Cucumber output
- ✅ Automatic ANSI code stripping
- ✅ Multi-line error message accumulation
- ✅ Callback-based step status notifications
- ✅ Stateful parser with finalization guarantees
- ✅ Support for multiple Cucumber symbol variants

Implementations must maintain state consistency and call finalize() to avoid data loss.
