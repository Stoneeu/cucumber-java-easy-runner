# Quick Start: Fix Test Explorer Real-time Status Updates

**Date**: 2025-11-09  
**Feature**: Fix Test Explorer Real-time Status Updates

This guide helps developers quickly understand and implement fixes for Test Explorer real-time status update issues.

---

## Overview

This feature fixes bugs in the real-time status display for Cucumber tests in VS Code's Test Explorer. The main issues are:

1. Test items not showing "running" state before completion
2. Step-level status not updating in real-time
3. Incorrect step name matching causing missed updates
4. Parser not finalizing pending steps on test completion

---

## Prerequisites

### Knowledge Requirements

- TypeScript fundamentals
- VS Code Extension API basics
- Cucumber test execution flow
- Node.js child process streaming

### Development Environment

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch mode for development
npm run watch

# Package extension
npm run package
```

### Testing Environment

- VS Code 1.93.1+
- Java 11+ (for test execution)
- Maven 3.6+ (for Maven mode tests)
- Sample Cucumber project with .feature files

---

## Architecture Quick Reference

### Key Components

```
┌──────────────────────────┐
│  CucumberTestController  │  ← Manages Test Explorer integration
└────────────┬─────────────┘
             │ creates
             ▼
┌──────────────────────────┐
│      TestController      │  ← VS Code API: Test tree management
│      TestRun             │  ← VS Code API: Execution session
└────────────┬─────────────┘
             │ uses
             ▼
┌──────────────────────────┐
│ CucumberOutputParser     │  ← Parses Cucumber output in real-time
└────────────┬─────────────┘
             │ emits
             ▼
┌──────────────────────────┐
│    StepResult events     │  ← Status updates (passed/failed/skipped)
└──────────────────────────┘
```

### File Structure

```
src/
└── extension.ts           # All code currently in one file (~2100 lines)
    ├── CucumberTestController (lines 320-600)
    ├── CucumberOutputParser (lines 65-315)
    ├── runSelectedTest() (lines 1300-1500)
    └── runCucumberTestWithMavenResult() (lines 1950-2115)
```

---

## Common Issues & Fixes

### Issue 1: Steps Not Showing "Running" State

**Symptom**: Steps immediately show passed/failed without showing running icon first.

**Root Cause**: Missing `TestRun.started()` call before terminal state.

**Location**: `src/extension.ts` lines 862-946 (onStepUpdate callback)

**Fix**:

```typescript
// ❌ BEFORE (incorrect)
switch (stepResult.status) {
  case 'passed':
    run.passed(stepItem);  // Missing started() call
    break;
}

// ✅ AFTER (correct)
run.started(stepItem);  // Add this line!
switch (stepResult.status) {
  case 'passed':
    run.passed(stepItem);
    break;
}
```

**Verification**:
1. Run any scenario with multiple steps
2. Observe steps showing spinner icon before checkmark
3. Check Extension logs for "TestRun.started() called" messages

---

### Issue 2: Step Names Not Matching (Fuzzy Match Failure)

**Symptom**: Parser detects step completion but UI doesn't update. Extension logs show "Step not found in Test Explorer".

**Root Cause**: Step name in output includes tags `[XXX]` not present in feature file.

**Location**: `src/extension.ts` lines 870-885 (fuzzy matching logic)

**Fix**:

```typescript
// Improve fuzzy matching algorithm
const cleanedStepName = stepResult.name
  .replace(/\[[\w\d]+\]\s*/g, '')  // Remove tags like [MKT05A06]
  .replace(/\s+/g, ' ')            // Normalize whitespace
  .trim();

for (const [label, item] of stepItemsMap.entries()) {
  const cleanedLabel = label
    .replace(/\[[\w\d]+\]\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  
  if (cleanedLabel === cleanedKey) {
    stepItem = item;
    break;
  }
}
```

**Verification**:
1. Run scenario with tagged steps: `Given [TAG] I login`
2. Check Extension logs for "Found fuzzy match" messages
3. Verify step status updates in Test Explorer

---

### Issue 3: Parser Not Finalizing Pending Steps

**Symptom**: Last step in scenario doesn't update status. Extension logs show step parsed but no status update.

**Root Cause**: Parser holds `currentStep` waiting for more lines, never finalizes on process end.

**Location**: `src/extension.ts` lines 2075-2090 (close event handler)

**Fix**:

```typescript
child.on('close', (code) => {
  // ✅ Add: Process any remaining buffered content
  if (lineBuffer.trim()) {
    parser.parseLine(lineBuffer);
  }
  
  // ✅ Add: Force finalize pending steps
  parser.finalize();
  
  resolve(exitCode);
});
```

**Verification**:
1. Run scenario with 5 steps
2. Verify all 5 steps show final status (not stuck in running)
3. Check Extension logs for "Parser finalized" message

---

### Issue 4: Scenario Marked Failed Despite Exit Code 0

**Symptom**: Scenario shows failed in Test Explorer, but Maven reports tests passed.

**Root Cause**: Using exit code instead of step failure tracking to determine scenario result.

**Location**: `src/extension.ts` lines 920-945 (scenario result determination)

**Fix**:

```typescript
// Track failures in callback
let hasFailedStep = false;

const onStepUpdate = (stepResult: StepResult) => {
  // ...
  if (stepResult.status === 'failed') {
    hasFailedStep = true;
    run.failed(scenarioItem, errorMsg);
  }
};

await executeWithCallback(uri, onStepUpdate);

// ✅ Use step failure tracking, not exit code
if (!hasFailedStep) {
  run.passed(scenarioItem);
}
// Scenario already marked failed in callback if hasFailedStep
```

**Verification**:
1. Run scenario in multi-module Maven project
2. Verify scenario marked passed when all steps pass
3. Check exit code logging vs. step failure tracking

---

## Development Workflow

### 1. Local Testing

```bash
# Terminal 1: Compile in watch mode
npm run watch

# Terminal 2: Press F5 in VS Code to launch Extension Development Host

# In Extension Development Host:
# 1. Open sample Cucumber project
# 2. Open .feature file
# 3. Open Test Explorer (Ctrl+Shift+T)
# 4. Run scenario and observe real-time updates
```

### 2. Enable Debug Logging

```typescript
// In extension.ts, change log levels
function logToExtension(message: string, level = 'DEBUG') {  // Change to DEBUG
  // ...
}
```

Check logs in:
- Output panel: "Cucumber Java Easy Runner - Logs"
- Developer Tools Console: `Ctrl+Shift+I` → Console tab

### 3. Verify Fixes

**Checklist**:
- [ ] Steps show "running" icon before completion
- [ ] Steps update to passed/failed/skipped within 500ms
- [ ] Scenario status reflects actual step results
- [ ] All steps finalize (none stuck in running state)
- [ ] Fuzzy matching works with tagged steps
- [ ] Error messages display for failed steps
- [ ] Works in both Java and Maven execution modes

---

## Code Examples

### Example 1: Adding Real-time Step Status Callback

```typescript
// In runCucumberTestWithMavenResult()
const parser = new CucumberOutputParser(
  cucumberOutputChannel,
  true,
  onStepUpdate  // ← Add callback here
);

// Callback implementation
const onStepUpdate = (stepResult: StepResult) => {
  const stepKey = `${stepResult.keyword} ${stepResult.name}`;
  let stepItem = stepItemsMap.get(stepKey);
  
  // Fuzzy match if needed
  if (!stepItem) {
    stepItem = fuzzyFindStep(stepKey, stepItemsMap);
  }
  
  if (stepItem) {
    run.started(stepItem);  // ← CRITICAL: Call started() first
    
    switch (stepResult.status) {
      case 'passed':
        run.passed(stepItem);
        break;
      case 'failed':
        run.failed(stepItem, new vscode.TestMessage(
          stepResult.errorMessage || 'Failed'
        ));
        break;
      case 'skipped':
        run.skipped(stepItem);
        break;
    }
  }
};
```

### Example 2: Collecting Step Items for Callback

```typescript
// Before test execution
const stepItemsMap = new Map<string, vscode.TestItem>();

if (testItem.id.includes(':scenario:')) {
  testItem.children.forEach(child => {
    if (child.id.includes(':step:')) {
      const stepText = child.label;  // "Given I login"
      stepItemsMap.set(stepText, child);
    }
  });
}

// Pass to executor
await executeWithCallback(uri, lineNumber, (stepResult) => {
  const stepItem = stepItemsMap.get(...);
  // Update status
});
```

### Example 3: Line Buffering for Streaming Output

```typescript
const child = spawn('mvn', ['test', ...]);
let lineBuffer = '';

child.stdout?.on('data', (chunk: Buffer) => {
  const output = chunk.toString();
  lineBuffer += output;  // Accumulate
  
  const lines = lineBuffer.split('\n');
  lineBuffer = lines.pop() || '';  // Keep incomplete line
  
  for (const line of lines) {
    parser.parseLine(line);  // Process complete lines
  }
});

child.on('close', () => {
  if (lineBuffer.trim()) {
    parser.parseLine(lineBuffer);  // Process final line
  }
  parser.finalize();  // Finalize pending steps
});
```

---

## Debugging Tips

### Check Extension Logs

```typescript
logToExtension(`Step registered: ${stepText}`, 'DEBUG');
logToExtension(`onStepUpdate called: ${stepKey}`, 'INFO');
logToExtension(`Exact match failed, trying fuzzy match`, 'DEBUG');
logToExtension(`Found fuzzy match: "${label}"`, 'INFO');
logToExtension(`TestRun.started() called for: ${stepItem.id}`, 'DEBUG');
```

View logs: Output panel → "Cucumber Java Easy Runner - Logs"

### Common Log Patterns

**Successful update**:
```
[INFO] Step registered: Given I am logged in
[INFO] onStepUpdate called: Given I am logged in - passed
[INFO] Updating step in Test Explorer: Given I am logged in - passed
[DEBUG] TestRun.started() called for: /path/feature.feature:scenario:10:step:12
[DEBUG] TestRun.passed() called for: /path/feature.feature:scenario:10:step:12
```

**Failed fuzzy match**:
```
[INFO] onStepUpdate called: Given [TAG] I am logged in - passed
[WARN] ⚠️ Step not found in Test Explorer after fuzzy match: Given [TAG] I am logged in
[DEBUG] Available steps: Given I am logged in, When I create segment, ...
```

### Use VS Code Debugger

1. Set breakpoints in `extension.ts`:
   - Line 104: `parseLine()` method
   - Line 862: `onStepUpdate` callback
   - Line 920: Scenario result determination

2. Press F5 to launch Extension Development Host with debugger attached

3. Run test in Extension Development Host

4. Debugger pauses at breakpoints, inspect variables:
   - `stepResult.status`
   - `stepItemsMap` contents
   - `hasFailedStep` flag

---

## Performance Optimization

### grep Filtering (Maven Mode)

Reduces output volume by 90%+:

```typescript
const grepPattern = [
  '✔', '✘', 'Given', 'When', 'Then',  // Cucumber markers
  'ERROR', 'Exception',                // Error markers
  '[0-9]+\\s+Scenarios'                // Summary
].join('|');

const cmd = `mvn test 2>&1 | grep --line-buffered -E "${grepPattern}"`;
const child = spawn('sh', ['-c', cmd]);
```

### Auto-collapse Large Test Suites

```typescript
// Future implementation
if (totalSteps > 500) {
  scenarioItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
}
```

---

## Testing Checklist

### Manual Smoke Tests

- [ ] **Java mode**: Run feature file, verify all steps update
- [ ] **Maven mode**: Run scenario, verify all steps update
- [ ] **Tagged steps**: Run with `[TAG]` in output, verify fuzzy match
- [ ] **Failed step**: Verify error message displays in Test Explorer
- [ ] **Skipped steps**: After failure, verify remaining steps show skipped
- [ ] **Example rows**: Run Scenario Outline, verify each example updates
- [ ] **Cancellation**: Cancel mid-run, verify partial results preserved

### Log Verification

- [ ] All steps show "TestRun.started() called" log
- [ ] All steps show "TestRun.passed/failed/skipped() called" log
- [ ] No "Step not found" warnings for valid steps
- [ ] "Parser finalized" log appears after each test run

---

## Next Steps

1. **Review research.md** for technical background
2. **Review data-model.md** for entity relationships
3. **Review contracts/** for API specifications
4. **Implement fixes** following examples above
5. **Test thoroughly** using checklist
6. **Update extension logs** for better observability

---

## Resources

### Documentation

- [VS Code Test API](https://code.visualstudio.com/api/extension-guides/testing)
- [Cucumber JVM Pretty Format](https://cucumber.io/docs/cucumber/reporting/)
- [Node.js child_process](https://nodejs.org/api/child_process.html)

### Code References

- `src/extension.ts`: All implementation
- `specs/001-fix-test-explorer-realtime/`: This feature documentation
- `.specify/memory/constitution.md`: Project principles

---

## Summary

Key points to remember:

1. ✅ **Always call `TestRun.started()` before terminal state**
2. ✅ **Implement fuzzy matching for step names with tags**
3. ✅ **Call `parser.finalize()` on process close**
4. ✅ **Use step failure tracking, not exit codes**
5. ✅ **Enable DEBUG logging during development**
6. ✅ **Test both Java and Maven execution modes**

Follow this guide to quickly understand and fix Test Explorer real-time status update issues.
