# TestRun API Usage Contract

**Version**: 1.0  
**Date**: 2025-11-09

This document defines the correct usage pattern for VS Code's `TestRun` API in the context of Cucumber test execution with real-time status updates.

---

## Interface Overview

```typescript
interface TestRun {
  // Lifecycle methods
  started(test: TestItem): void;
  passed(test: TestItem, duration?: number): void;
  failed(test: TestItem, message: TestMessage | readonly TestMessage[], duration?: number): void;
  skipped(test: TestItem): void;
  
  // Output methods
  appendOutput(output: string, location?: Location, test?: TestItem): void;
  
  // Completion
  end(): void;
}
```

---

## Critical Rule: Call Order

### ✅ CORRECT Pattern

**MUST** call `started()` before any terminal state method.

```typescript
// For each test item:
run.started(testItem);              // Mark as "running"
// ... wait for test execution ...
run.passed(testItem);               // Mark as "passed"
// OR
run.failed(testItem, message);      // Mark as "failed"
// OR
run.skipped(testItem);              // Mark as "skipped"
```

### ❌ INCORRECT Patterns

```typescript
// Missing started() call
run.passed(testItem);               // ❌ UI won't show "running" state

// Wrong order
run.passed(testItem);
run.started(testItem);              // ❌ Too late, already in terminal state

// Double terminal state
run.started(testItem);
run.passed(testItem);
run.failed(testItem, message);      // ❌ Item already in terminal state
```

---

## Method Contracts

### started()

#### Signature

```typescript
started(test: TestItem): void
```

#### Purpose

Mark test item as started/running in Test Explorer UI.

#### When to Call

- **Before test execution begins** for that specific item
- **Before parsing any output** for that item
- **Only once per item per test run**

#### Visual Effect

- Test Explorer shows "running" icon (spinner)
- Item highlighted in UI
- Duration timer starts

#### Example

```typescript
// Running a scenario with steps
run.started(scenarioItem);                    // Scenario shows as running

// For each step in scenario
for (const stepItem of scenarioItem.children) {
  run.started(stepItem);                      // Step shows as running
  // ... parse step output ...
  run.passed(stepItem);                       // Step shows as passed
}
```

---

### passed()

#### Signature

```typescript
passed(test: TestItem, duration?: number): void
```

#### Purpose

Mark test item as passed in Test Explorer UI.

#### When to Call

- **After** test execution completes successfully
- **After** `started()` has been called for this item
- **Only once per item per test run**

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `test` | TestItem | ✅ Yes | Test item to mark as passed |
| `duration` | number | ❌ No | Execution duration in milliseconds |

#### Visual Effect

- Test Explorer shows "passed" icon (green checkmark)
- Duration displayed if provided
- Item no longer highlighted

#### Example

```typescript
run.started(stepItem);
// Execute step...
run.passed(stepItem, 150);  // Passed in 150ms
```

---

### failed()

#### Signature

```typescript
failed(
  test: TestItem, 
  message: TestMessage | readonly TestMessage[], 
  duration?: number
): void
```

#### Purpose

Mark test item as failed with error message in Test Explorer UI.

#### When to Call

- **After** test execution fails (exception, assertion error, etc.)
- **After** `started()` has been called for this item
- **Only once per item per test run**

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `test` | TestItem | ✅ Yes | Test item to mark as failed |
| `message` | TestMessage \| TestMessage[] | ✅ Yes | Error message(s) to display |
| `duration` | number | ❌ No | Execution duration in milliseconds |

#### Visual Effect

- Test Explorer shows "failed" icon (red X)
- Error message displayed in test detail panel
- Stack trace shown if provided in TestMessage
- Item expanded to show error

#### TestMessage Format

```typescript
interface TestMessage {
  message: string;          // Error message text
  location?: Location;      // Source location of error
  expectedOutput?: string;  // Expected value (for assertions)
  actualOutput?: string;    // Actual value (for assertions)
}
```

#### Example

```typescript
run.started(stepItem);
// Execute step...
const errorMsg = new vscode.TestMessage(
  'AssertionError: Expected 200 but got 400\n' +
  '  at StepDefs.createSegment(StepDefs.java:45)'
);
run.failed(stepItem, errorMsg, 200);
```

---

### skipped()

#### Signature

```typescript
skipped(test: TestItem): void
```

#### Purpose

Mark test item as skipped in Test Explorer UI.

#### When to Call

- **When test is not executed** due to:
  - Previous step/scenario failure (Cucumber behavior)
  - Tag filter exclusion
  - Pending/undefined step
- **After** `started()` has been called for this item (optional but recommended)

#### Visual Effect

- Test Explorer shows "skipped" icon (gray dash)
- Item grayed out in UI
- No error message displayed

#### Example

```typescript
// Scenario with failing step
run.started(scenarioItem);
run.started(step1);
run.passed(step1);
run.started(step2);
run.failed(step2, errorMsg);

// Remaining steps are skipped
run.started(step3);
run.skipped(step3);
run.started(step4);
run.skipped(step4);
```

---

### appendOutput()

#### Signature

```typescript
appendOutput(output: string, location?: Location, test?: TestItem): void
```

#### Purpose

Append text output to test result (visible in test output panel).

#### When to Call

- During test execution to show real-time output
- Can be called multiple times per test
- Can be called before or after `started()`

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `output` | string | ✅ Yes | Text to append (can include newlines) |
| `location` | Location | ❌ No | Source location for output line |
| `test` | TestItem | ❌ No | Associate output with specific test item |

#### Example

```typescript
child.stdout?.on('data', (chunk: Buffer) => {
  const output = chunk.toString();
  run.appendOutput(output, undefined, scenarioItem);
});
```

---

### end()

#### Signature

```typescript
end(): void
```

#### Purpose

Finalize test run session.

#### When to Call

- **After all tests in run have completed**
- **Only once per TestRun**

#### Visual Effect

- Test run marked as complete
- UI stops showing active execution state
- Results finalized

#### Example

```typescript
const run = controller.createTestRun(request);
try {
  for (const testItem of testItems) {
    await runSingleTest(testItem, run);
  }
} finally {
  run.end();  // Always finalize
}
```

---

## Usage Patterns

### Pattern 1: Single Scenario Execution

```typescript
async function runScenario(scenarioItem: TestItem, run: TestRun) {
  // Mark scenario as started
  run.started(scenarioItem);
  
  // Execute scenario and wait for result
  const result = await executeScenario(scenarioItem.uri, scenarioLine);
  
  // Mark scenario as passed/failed based on result
  if (result.success) {
    run.passed(scenarioItem);
  } else {
    run.failed(scenarioItem, new vscode.TestMessage(result.error));
  }
}
```

### Pattern 2: Scenario with Real-time Step Updates

```typescript
async function runScenarioWithSteps(
  scenarioItem: TestItem, 
  run: TestRun
) {
  // Mark scenario as started
  run.started(scenarioItem);
  
  // Setup step tracking
  const stepItems = Array.from(scenarioItem.children);
  let hasFailedStep = false;
  
  // Callback for step status updates from parser
  const onStepUpdate = (stepResult: StepResult) => {
    const stepItem = findStepItem(stepResult, stepItems);
    if (!stepItem) return;
    
    // CRITICAL: Call started() before terminal state
    run.started(stepItem);
    
    switch (stepResult.status) {
      case 'passed':
        run.passed(stepItem);
        break;
      case 'failed':
        hasFailedStep = true;
        run.failed(stepItem, new vscode.TestMessage(
          stepResult.errorMessage || 'Step failed'
        ));
        // Also fail the scenario immediately
        run.failed(scenarioItem, new vscode.TestMessage(
          `Step failed: ${stepResult.keyword} ${stepResult.name}`
        ));
        break;
      case 'skipped':
        run.skipped(stepItem);
        break;
    }
  };
  
  // Execute with parser callback
  const exitCode = await executeWithCallback(scenarioItem.uri, onStepUpdate);
  
  // Mark scenario based on step results (not exit code)
  if (!hasFailedStep) {
    run.passed(scenarioItem);
  }
  // If hasFailedStep is true, scenario already marked as failed in callback
}
```

### Pattern 3: Batch Test Execution

```typescript
async function runTests(request: TestRunRequest, token: CancellationToken) {
  const run = controller.createTestRun(request);
  
  try {
    const testItems = request.include || getAllTests();
    
    for (const testItem of testItems) {
      // Check cancellation
      if (token.isCancellationRequested) {
        run.skipped(testItem);
        continue;
      }
      
      // Run test
      await runSingleTest(testItem, run);
    }
  } finally {
    // Always finalize run
    run.end();
  }
}
```

---

## State Transition Diagram

```
┌─────────┐
│  Idle   │  (Test item not in active run)
└────┬────┘
     │
     │ run.started(item)
     ▼
┌─────────┐
│ Running │  (Shows spinner in UI)
└────┬────┘
     │
     ├─────► run.passed(item)   → [Passed] (green checkmark)
     ├─────► run.failed(item)   → [Failed] (red X)
     └─────► run.skipped(item)  → [Skipped] (gray dash)
```

**Terminal states**: Passed, Failed, Skipped (cannot transition after reaching these)

---

## Error Handling

### Handling Test Execution Failures

```typescript
try {
  run.started(testItem);
  await executeTest(testItem);
  run.passed(testItem);
} catch (error) {
  run.failed(testItem, new vscode.TestMessage(
    `Test execution failed: ${error.message}`
  ));
}
```

### Handling Cancellation

```typescript
if (token.isCancellationRequested) {
  // Can skip without starting
  run.skipped(testItem);
  return;
}

run.started(testItem);
const result = await executeTest(testItem, token);

if (token.isCancellationRequested) {
  // Mark as skipped if cancelled mid-execution
  run.skipped(testItem);
} else if (result.success) {
  run.passed(testItem);
} else {
  run.failed(testItem, new vscode.TestMessage(result.error));
}
```

---

## Common Mistakes

### Mistake 1: Not Calling started()

```typescript
// ❌ WRONG
run.passed(testItem);  // UI never shows "running" state

// ✅ CORRECT
run.started(testItem);
run.passed(testItem);
```

### Mistake 2: Multiple Terminal States

```typescript
// ❌ WRONG
run.started(testItem);
run.passed(testItem);
run.failed(testItem, error);  // Already passed, this is ignored

// ✅ CORRECT
run.started(testItem);
if (success) {
  run.passed(testItem);
} else {
  run.failed(testItem, error);
}
```

### Mistake 3: Forgetting to end()

```typescript
// ❌ WRONG
const run = controller.createTestRun(request);
for (const item of items) {
  runSingleTest(item, run);
}
// Missing run.end() - test run never finalizes

// ✅ CORRECT
const run = controller.createTestRun(request);
try {
  for (const item of items) {
    await runSingleTest(item, run);
  }
} finally {
  run.end();
}
```

---

## Performance Considerations

### Batching Updates

- ✅ Call `started()` immediately when test begins
- ✅ Call terminal state as soon as result known
- ❌ Don't batch terminal states - update in real-time

### Output Buffering

- ✅ Can batch `appendOutput()` calls for efficiency
- ❌ Don't buffer terminal state calls - impacts UX

```typescript
// ✅ GOOD: Batch output, immediate status
let outputBuffer = '';
child.stdout?.on('data', (chunk) => {
  outputBuffer += chunk.toString();
  if (outputBuffer.includes('\n')) {
    run.appendOutput(outputBuffer, undefined, testItem);
    outputBuffer = '';
  }
});

// Step status updated immediately
onStepComplete((step) => {
  run.started(stepItem);
  run.passed(stepItem);  // No batching
});
```

---

## Summary

The TestRun API usage contract defines:
- ✅ **Mandatory call order**: `started()` before terminal state
- ✅ **One terminal state per item**: passed/failed/skipped (mutually exclusive)
- ✅ **Real-time updates**: Don't batch status calls
- ✅ **Finalization**: Always call `end()` in finally block
- ✅ **Error messages**: Include full stack traces in TestMessage
- ✅ **Cancellation**: Mark incomplete tests as skipped

Implementations must follow this contract to ensure correct Test Explorer UI behavior.
