# Feature Specification: Fix Test Explorer Real-time Status Updates

**Feature Branch**: `001-fix-test-explorer-realtime`  
**Created**: 2025-11-09  
**Status**: Draft  
**Input**: User description: "目前支援使用 java 與 mvn 在 shell 中來執行測試, 並取得測試結果輸出, 在 vscode 中 Test Explorer 中即時顯示, 每一個 Scenario, 以及當下的 steps 例如 given when then 步驟成功或失敗, 但目前的即時顯示功能尚有問題, 請詳細檢查程式碼, 以及相關技術 vscode extension, test explorer api, 以及 mvn cucumber 等等輸出的技術串接"

## Clarifications

### Session 2025-11-09

- Q: When test execution starts but no output is received yet, how should Test Explorer display loading/preparation state? → A: Show "preparing" icon/state before first output, then "running" after output starts
- Q: What log levels should the extension record during test execution for debugging purposes? → A: ERROR only for critical failures
- Q: When test execution exceeds performance limits (e.g., >500 steps), how should extension handle it to avoid UI lag? → A: Automatically collapse step details beyond threshold, expand on demand
- Q: When user cancels test execution mid-run, how should extension clean up and display partial results? → A: Preserve executed step results, mark incomplete steps as "cancelled"
- Q: When Cucumber output contains data tables or doc strings, how should extension display these in Test Explorer? → A: Ignore table/string content, show only step keyword and base text

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Real-time Scenario Status Updates (Priority: P1)

When a developer runs a Cucumber scenario from Test Explorer, they should see the scenario's execution status update in real-time (started → running → passed/failed), reflecting the actual test progress without delay or requiring manual refresh.

**Why this priority**: This is the core user value proposition of the extension. Without reliable real-time status updates, users cannot trust the Test Explorer UI and will revert to running tests manually in the terminal, defeating the purpose of the extension.

**Independent Test**: Can be fully tested by selecting any scenario in Test Explorer, clicking Run, and observing that the scenario icon changes from idle → running → passed/failed states in real-time as the test executes. Delivers immediate visual feedback on test execution status.

**Acceptance Scenarios**:

1. **Given** a feature file is open with multiple scenarios, **When** user clicks run on a single scenario in Test Explorer, **Then** the scenario item immediately shows "preparing" state, transitions to "running" state after first output is received, and updates to "passed" or "failed" within 1 second of test completion
2. **Given** a test is running, **When** the scenario completes execution, **Then** the Test Explorer UI reflects the final status (passed/failed/skipped) without requiring page refresh or reopening the panel
3. **Given** multiple scenarios in a feature, **When** running the entire feature, **Then** each scenario's status updates independently as it completes, not all at once at the end

---

### User Story 2 - Real-time Step-level Status Updates (Priority: P1)

When a developer runs a scenario, they should see individual steps (Given/When/Then/And/But) update their execution status in real-time within the Test Explorer tree, showing which step is currently executing and whether each step passed or failed.

**Why this priority**: Step-level visibility is critical for debugging test failures. Without it, users cannot quickly identify which specific step caused a scenario to fail, forcing them to read through raw terminal output instead of using the visual UI.

**Independent Test**: Can be fully tested by running a scenario with multiple steps in Test Explorer and verifying that each step's icon updates to show running → passed/failed states as the test progresses. Delivers granular debugging information.

**Acceptance Scenarios**:

1. **Given** a scenario with 5 steps (Given/When/Then/And/But), **When** user runs the scenario, **Then** Test Explorer shows each step updating to "passed" state sequentially as it executes, within 500ms of actual step completion
2. **Given** a scenario where the 3rd step fails, **When** the test runs, **Then** steps 1-2 show "passed", step 3 shows "failed" with error details, and steps 4-5 show "skipped" in real-time
3. **Given** a step with a complex operation taking 3 seconds, **When** the step is executing, **Then** Test Explorer shows that step in "running" state during execution, not just passed/failed after completion
4. **Given** a scenario with 5 steps is executing and 2 steps have completed, **When** user cancels the test execution, **Then** steps 1-2 retain their "passed" status, step 3 shows "cancelled", and steps 4-5 show "cancelled"

---

### User Story 3 - Accurate Output Parsing for Both Execution Modes (Priority: P2)

When a developer runs tests in either Java direct mode or Maven mode, the extension should correctly parse the console output format specific to each mode and extract step status information accurately, handling ANSI color codes, multi-line errors, and different output formats.

**Why this priority**: The extension supports two execution modes that produce different output formats. Reliable parsing for both modes is essential for features to work consistently regardless of user's project setup (single-module vs multi-module Maven projects).

**Independent Test**: Can be fully tested by switching between Java and Maven execution modes (via status bar toggle), running the same scenario in both modes, and verifying that step statuses are correctly detected and displayed in Test Explorer for both. Delivers consistent user experience across execution modes.

**Acceptance Scenarios**:

1. **Given** execution mode is set to Java, **When** running a scenario with unicode characters in step names (e.g., Chinese, emoji), **Then** all steps are correctly parsed and displayed with proper status indicators
2. **Given** execution mode is set to Maven, **When** a test produces multi-line error stack traces, **Then** the full error message is captured and associated with the correct failed step in Test Explorer
3. **Given** execution mode is set to Maven with ANSI color codes in output, **When** parsing step results, **Then** color codes are stripped correctly and step status symbols (✔✘↷) are recognized without interference

---

### User Story 4 - Error Message Display in Test Explorer (Priority: P2)

When a test step fails, the developer should be able to click on the failed step in Test Explorer and see the complete error message and stack trace in a readable format, without needing to scroll through terminal output.

**Why this priority**: Error visibility is crucial for efficient debugging. Without proper error display in the UI, the Test Explorer becomes just a status indicator rather than a debugging tool, reducing its value to users.

**Independent Test**: Can be fully tested by creating a scenario with a step that intentionally throws an assertion error, running it, and verifying that clicking the failed step in Test Explorer displays the full error message and stack trace. Delivers efficient debugging workflow.

**Acceptance Scenarios**:

1. **Given** a step fails with an AssertionError, **When** user clicks the failed step in Test Explorer, **Then** the error panel shows the full assertion message and file location where the assertion occurred
2. **Given** a step fails with a multi-line stack trace (10+ lines), **When** viewing the error in Test Explorer, **Then** the entire stack trace is preserved and displayed with proper formatting, not truncated
3. **Given** multiple steps fail in sequence, **When** viewing Test Explorer, **Then** each failed step retains its own unique error message accessible independently

---

### Edge Cases

- What happens when Cucumber output format changes between versions (e.g., different status symbols)?
- How does the system handle race conditions where multiple steps complete nearly simultaneously?
- What happens when Maven output includes unrelated warnings or errors between step results?
- How does parsing differentiate between step text and data table/doc string content in output?
- What happens when a step name contains special regex characters or symbols used for parsing?
- How does the extension handle extremely long step names (>200 characters) in the UI?
- How does the UI perform when step count exceeds 500 - are collapsed scenarios still interactive?
- What happens if cancellation occurs during step output parsing - is parser state properly finalized?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Extension MUST update Test Explorer scenario status to "preparing" immediately when test execution command is sent, then transition to "started/running" after first output is received
- **FR-002**: Extension MUST update Test Explorer scenario status to "passed" or "failed" within 1 second of test completion
- **FR-003**: Extension MUST update individual step statuses (Given/When/Then/And/But) in real-time as each step completes execution
- **FR-004**: Extension MUST correctly parse Cucumber output in both Java direct execution mode and Maven test execution mode
- **FR-005**: Extension MUST strip ANSI color codes from terminal output before parsing step status
- **FR-006**: Extension MUST recognize Cucumber status symbols (✔ ✘ ✓ ✗ × ↷ ⊝ − for passed/failed/skipped) in multiple unicode variants
- **FR-007**: Extension MUST associate multi-line error messages and stack traces with the correct failed step
- **FR-008**: Extension MUST handle fuzzy matching of step names when output format includes tags or annotations (e.g., [TAG_ID] prefixes)
- **FR-009**: Extension MUST mark steps as "skipped" when they are not executed due to earlier step failure
- **FR-010**: Extension MUST call TestRun.started() before TestRun.passed()/failed()/skipped() for each test item to properly update UI state
- **FR-011**: Extension MUST maintain accurate step-to-TestItem mapping using step text as primary key with fuzzy fallback matching
- **FR-012**: Extension MUST display full error messages in Test Explorer when user clicks on failed steps
- **FR-013**: Extension MUST finalize parser state when test execution completes to ensure all pending steps are marked
- **FR-014**: Extension MUST handle incomplete output lines by buffering and processing only complete lines for parsing
- **FR-015**: Extension MUST preserve test hierarchy (feature → scenario → step) in Test Explorer during real-time updates
- **FR-016**: Extension MUST log ERROR level messages for critical failures including parsing errors, API call failures, and execution process crashes
- **FR-017**: Extension MUST automatically collapse step-level details when total step count exceeds 500, allowing users to expand individual scenarios on demand to view their steps
- **FR-018**: Extension MUST preserve executed step results when test execution is cancelled, marking incomplete/unexecuted steps with "cancelled" status rather than clearing all results
- **FR-019**: Extension MUST display step names using only the keyword and base text, excluding data table and doc string content from Test Explorer tree display to maintain UI clarity

### Key Entities

- **CucumberOutputParser**: Responsible for parsing test output stream, extracting step status, and triggering UI updates via callbacks
- **StepResult**: Represents parsed step execution result with keyword, name, status (passed/failed/skipped), error message, and location
- **TestItem**: VS Code Test Explorer representation of a test entity (feature/scenario/step) with UI state and navigation range
- **TestRun**: VS Code Test Explorer execution session that tracks test execution progress and reports status updates

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users see scenario status change to "preparing" within 100ms of clicking run button, then to "running" within 100ms of first output received
- **SC-002**: Users see each step status update within 500ms of that step completing execution in the test process
- **SC-003**: 95% of test runs display accurate final status (passed/failed/skipped) for all scenarios and steps without requiring manual refresh
- **SC-004**: Users can identify the exact failing step and view its error message within 5 seconds of a test failure
- **SC-005**: Extension correctly parses and displays step statuses for both Java and Maven execution modes with 100% accuracy in standard test scenarios
- **SC-006**: Multi-line error messages (up to 50 lines) are fully captured and displayed for failed steps
- **SC-007**: Extension handles test runs with up to 50 scenarios and 500 total steps without UI lag, automatically collapsing step details beyond this threshold while maintaining real-time status updates at scenario level

## Assumptions

1. Cucumber output format follows standard pretty printer format with recognizable step keywords and status symbols
2. Maven test output includes Cucumber's test execution output in stdout or stderr streams
3. VS Code Test Explorer API provides TestRun.started/passed/failed/skipped methods for status updates
4. Step names in feature files match step names in execution output (allowing for additional tags/annotations)
5. Test execution produces line-buffered output that can be parsed incrementally
6. Users have configured their test setup to produce verbose step-level output (not summary-only mode)

## Technical Context

This feature involves debugging and fixing the integration between:
- VS Code Extension API (TestController, TestRun, TestItem)
- Cucumber output parsing (handling pretty format, symbols, ANSI codes)
- Child process management (Java/Maven execution, stdout/stderr streaming)
- Real-time UI updates (ensuring proper TestRun lifecycle methods are called)

The primary issue is likely related to timing of TestRun method calls, incomplete output parsing, or incorrect step name matching between feature file and execution output.
