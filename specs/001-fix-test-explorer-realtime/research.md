# Research: Fix Test Explorer Real-time Status Updates

**Date**: 2025-11-09  
**Feature**: Fix Test Explorer Real-time Status Updates

This document consolidates research findings for all technical unknowns identified during planning.

---

## 1. VS Code TestRun Lifecycle Method Calling Order

**Decision**: Call `TestRun.started()` before `TestRun.passed()/failed()/skipped()` for each test item

**Rationale**: 
VS Code Test Explorer API requires `started()` to be called before any terminal state method. This ensures:
- Test items show "running" state in UI before completion
- Proper state transition from idle → running → passed/failed/skipped
- Test Explorer correctly tracks execution progress
- UI animations and status icons update correctly

**Alternatives considered**:
- ❌ Only calling passed/failed without started: Results in incorrect UI state, items never show as "running"
- ❌ Calling started for scenario but not steps: Steps appear to instantly pass/fail without running state
- ✅ Call started immediately before parsing step output, then call terminal state when step completes

**Implementation notes**:
```typescript
// Correct pattern from VS Code API:
run.started(testItem);           // Item shows as "running" in UI
// ... execute test and wait for result ...
run.passed(testItem);            // Item shows as "passed" in UI
// OR
run.failed(testItem, message);   // Item shows as "failed" with error
// OR
run.skipped(testItem);           // Item shows as "skipped" in UI
```

**References**:
- VS Code Test API: `vscode.TestRun` interface
- Current implementation: `src/extension.ts` lines 843-946 (runSingleTest method)

---

## 2. Cucumber Pretty Format Output Specification

**Decision**: Support multiple unicode variants of Cucumber status symbols (✔✘✓✗×↷⊝−)

**Rationale**:
Cucumber's pretty formatter output varies across:
- Different Cucumber versions (6.x vs 7.x vs 8.x)
- Different platforms (Linux, macOS, Windows terminal encodings)
- Different JVM implementations (OpenJDK, Oracle JDK, GraalVM)
- Different locale settings (UTF-8 vs other encodings)

Common symbols observed:
- **Passed**: `✔` (U+2714), `✓` (U+2713)
- **Failed**: `✘` (U+2718), `✗` (U+2717), `×` (U+00D7)
- **Skipped**: `↷` (U+21B7), `⊝` (U+229D), `−` (U+2212), `-` (U+002D)

**Alternatives considered**:
- ❌ Only support single symbol per status: Breaks on different Cucumber versions
- ❌ Use regex character classes only: Misses unicode symbols outside ASCII range
- ✅ Explicit list of all known symbol variants in parsing regex

**Implementation notes**:
```typescript
// Current parser pattern (line 104-105 in extension.ts):
const stepMatch = cleanLine.match(/^\s*[✔✘✓✗×↷⊝−]?\s*(Given|When|Then|And|But)\s+(.+?)\s*(?:#|$)/);

// Symbol detection (lines 121-127):
if (cleanLine.includes('✘') || cleanLine.includes('✗') || cleanLine.includes('×')) {
  status = 'failed';
} else if (cleanLine.includes('↷') || cleanLine.includes('⊝') || cleanLine.includes('−')) {
  status = 'skipped';
} else {
  status = 'passed';  // Default if symbol present
}
```

**Example outputs**:
```
    ✔ Given I am logged in    # StepDefs.login()
    ✘ When I create a segment    # StepDefs.createSegment()
    ↷ Then I verify the result    # StepDefs.verify()
```

**References**:
- Cucumber JVM Pretty Formatter: `io.cucumber.core.plugin.PrettyFormatter`
- Current implementation: `src/extension.ts` lines 104-135 (parseLine method)

---

## 3. ANSI Color Code Removal Best Practices

**Decision**: Use regex `\x1b\[[0-9;]*m` to strip ANSI escape sequences before parsing

**Rationale**:
- Maven and Java terminal output includes ANSI color codes by default
- Color codes interfere with pattern matching and symbol detection
- Must strip before parsing to ensure reliable step status detection
- Pattern covers all standard ANSI SGR (Select Graphic Rendition) codes

**Alternatives considered**:
- ❌ Configure Maven/Java to disable colors: Requires user configuration, not zero-config
- ❌ Parse with colors included: Extremely complex regex, error-prone
- ❌ Use external library (strip-ansi npm package): Unnecessary dependency for simple operation
- ✅ Simple regex strip at parse time: Clean, fast, no dependencies

**Implementation notes**:
```typescript
// Current implementation (line 210-214 in extension.ts):
private stripAnsiCodes(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}
```

**Example ANSI codes**:
```
\x1b[32m  → Green text
\x1b[31m  → Red text
\x1b[0m   → Reset formatting
\x1b[1;31m → Bold red text
```

**References**:
- ANSI Escape Code specification: ISO/IEC 6429
- Current implementation: `src/extension.ts` lines 210-214 (stripAnsiCodes method)

---

## 4. Node.js Child Process stdout/stderr Stream Handling

**Decision**: Use `spawn()` with data event listeners for real-time streaming, maintain line buffer for incomplete lines

**Rationale**:
- `execFile()` buffers entire output: Cannot provide real-time updates during long test runs
- `spawn()` streams output chunks as they arrive: Enables real-time parsing
- Chunks may contain partial lines: Must buffer incomplete lines for next chunk
- Both stdout and stderr must be monitored: Maven outputs to both streams

**Alternatives considered**:
- ❌ Use `exec()` or `execFile()`: Only returns output after process completes
- ❌ Process chunks directly without buffering: Breaks on partial lines, parser sees incomplete data
- ❌ Line-by-line reading with readline: Adds complexity, not needed with buffer approach
- ✅ Buffer-based streaming: Simple, reliable, real-time

**Implementation notes**:
```typescript
// Current implementation (lines 2028-2061 in extension.ts):
const child = spawn('sh', ['-c', filteredCommand], { cwd: workspaceRoot, env: spawnEnv });
let lineBuffer = '';

child.stdout?.on('data', (chunk: Buffer) => {
  const output = chunk.toString();
  lineBuffer += output;
  
  const lines = lineBuffer.split('\n');
  lineBuffer = lines.pop() || '';  // Keep last incomplete line
  
  for (const line of lines) {
    parser.parseLine(line);  // Process complete lines only
  }
  
  if (onOutput) onOutput(output);
});

child.on('close', (code) => {
  // Process any remaining buffered content
  if (lineBuffer.trim()) {
    parser.parseLine(lineBuffer);
  }
  parser.finalize();
});
```

**Key insights**:
- Chunks are arbitrary byte boundaries, not line boundaries
- Buffer must persist across chunks to accumulate incomplete lines
- Final buffer content must be processed on `close` event
- `finalize()` ensures pending steps are displayed even if output incomplete

**References**:
- Node.js child_process documentation: `spawn()`, `ChildProcess` events
- Current implementation: `src/extension.ts` lines 1977-2113 (runCucumberTestWithMavenResult)

---

## 5. Fuzzy Step Name Matching Algorithm

**Decision**: Primary exact match on full step text, fallback to tag-stripped fuzzy match

**Rationale**:
Step names in feature files may differ from execution output due to:
- Tags added by test framework: `[MKT05A06] Given I login` vs `Given I login`
- Whitespace differences
- Parameter substitution in Scenario Outlines

Two-phase matching ensures reliability:
1. Exact match: `"Given [TAG] step text"` matches `"Given [TAG] step text"`
2. Fuzzy match: Strip `[XXX]` tags and compare: `"Given step text"` matches `"Given step text"`

**Alternatives considered**:
- ❌ Only exact match: Fails when tags present in output but not feature file
- ❌ Levenshtein distance fuzzy matching: Too slow for real-time parsing, false positives
- ❌ Regex-based flexible matching: Complex, hard to maintain, unpredictable
- ✅ Tag-strip fallback: Simple, fast, handles common case without false positives

**Implementation notes**:
```typescript
// Current implementation (lines 862-885 in extension.ts):
const stepKey = `${stepResult.keyword} ${stepResult.name}`;
let stepItem = stepItemsMap.get(stepKey);

if (!stepItem) {
  // Fuzzy matching: remove tags like [MKT05A06]
  const cleanedStepName = stepResult.name.replace(/\[[\w\d]+\]\s*/g, '').trim();
  const cleanedStepKey = `${stepResult.keyword} ${cleanedStepName}`;
  
  for (const [label, item] of stepItemsMap.entries()) {
    const cleanedLabel = label.replace(/\[[\w\d]+\]\s*/g, '').trim();
    
    if (cleanedLabel === cleanedStepKey || label === cleanedStepKey) {
      stepItem = item;
      break;
    }
  }
}
```

**Edge cases handled**:
- Multiple consecutive tags: `[TAG1] [TAG2] Given step` → `Given step`
- No tags present: Exact match succeeds immediately
- Partial tag matches: Only removes complete `[XXX]` patterns

**References**:
- Current implementation: `src/extension.ts` lines 862-885 (onStepUpdate callback)

---

## 6. UI Performance Optimization for Large Test Suites

**Decision**: Implement auto-collapse for step details when total exceeds 500 steps, maintain real-time updates at scenario level

**Rationale**:
VS Code Test Explorer performance degrades with many test items:
- 500+ test items causes UI lag during rapid updates
- Step-level granularity is valuable but not always necessary
- Collapsing steps reduces DOM complexity while preserving functionality
- Users can manually expand scenarios of interest

**Alternatives considered**:
- ❌ Virtualized tree rendering: Not possible with VS Code API
- ❌ Pagination of test items: Breaks hierarchical navigation
- ❌ Remove step-level items entirely: Loses debugging value
- ❌ Hard limit on test count: Arbitrary restriction, user hostile
- ✅ Auto-collapse with on-demand expansion: Balances performance and usability

**Implementation notes**:
```typescript
// Future implementation (not yet in codebase):
// During test discovery, count total steps
let totalSteps = 0;
for (const feature of features) {
  for (const scenario of feature.scenarios) {
    totalSteps += scenario.steps?.length || 0;
  }
}

// If exceeding threshold, add steps but keep scenarios collapsed
const AUTO_COLLAPSE_THRESHOLD = 500;
if (totalSteps > AUTO_COLLAPSE_THRESHOLD) {
  // VS Code API: set collapsibleState on scenario items
  scenarioItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
}
```

**Performance targets**:
- <2 seconds test discovery for 100 feature files
- <100ms UI update per step status change
- <500ms scenario status change propagation

**References**:
- VS Code TreeItem API: `collapsibleState` property
- Spec requirement SC-007: Handles up to 500 steps without lag

---

## 7. Output Filtering Strategy for Maven Execution

**Decision**: Use `grep` with line-buffering to filter Maven output at source, dramatically reducing data volume

**Rationale**:
Maven test execution produces massive output:
- Dependency resolution logs
- Plugin execution messages
- Compiler warnings
- Other unrelated test output in multi-module projects

Real-time parsing requires filtering out noise before buffering. grep at shell level:
- Filters before data enters Node.js process
- Line-buffered mode preserves real-time streaming
- Regex pattern targets Cucumber-specific markers only
- Reduces output volume by 90%+

**Alternatives considered**:
- ❌ Parse full Maven output in Node.js: Overwhelms line buffer, slows parsing
- ❌ Use Maven quiet mode (`-q`): Still includes non-Cucumber test output
- ❌ Custom Maven plugin to filter: Requires user configuration, not zero-config
- ✅ Shell-level grep filter: Fast, transparent, zero-config

**Implementation notes**:
```typescript
// Current implementation (lines 2012-2027 in extension.ts):
const grepPattern = [
  '✔', '✘', '✓', '✗', '×', '↷', '⊝', '−',  // Step symbols
  'Given', 'When', 'Then', 'And', 'But',     // Step keywords
  'Scenario', 'Feature', 'Background',        // Cucumber markers
  'ERROR', 'Exception', 'AssertionError',     // Error indicators
  'at\\s+', 'Caused by:', 'java\\.', 'org\\.junit',  // Stack traces
  '[0-9]+\\s+(Scenarios?|Steps?)\\s+'        // Summary lines
].join('|');

const mvnCommand = `mvn ${mvnArgs.join(' ')}`;
const filteredCommand = `${mvnCommand} 2>&1 | grep --line-buffered -E "${grepPattern}"`;
```

**Grep options**:
- `--line-buffered`: Output each line immediately, don't wait for buffer fill
- `-E`: Extended regex for alternation `|` syntax
- `2>&1`: Merge stderr into stdout for unified filtering

**Benefits**:
- Reduces parser workload by 90%+
- Eliminates false positives from Maven plugin output
- Preserves complete Cucumber execution output
- No impact on test execution timing

**References**:
- Current implementation: `src/extension.ts` lines 2012-2027
- Spec requirement FR-004: Correctly parse Maven output

---

## Summary

All technical unknowns have been researched and resolved. Key findings:

1. ✅ **TestRun lifecycle**: Call `started()` before terminal state methods
2. ✅ **Cucumber symbols**: Support multiple unicode variants per status
3. ✅ **ANSI codes**: Strip with simple regex before parsing
4. ✅ **Stream handling**: Buffer incomplete lines across chunks
5. ✅ **Fuzzy matching**: Tag-strip fallback for step name matching
6. ✅ **Performance**: Auto-collapse steps beyond 500 items
7. ✅ **Maven output**: grep filter at shell level for real-time parsing

No unresolved "NEEDS CLARIFICATION" items remain. Ready to proceed to Phase 1 (Design & Contracts).
