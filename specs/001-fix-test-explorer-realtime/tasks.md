---
description: "Task list for fixing Test Explorer real-time status updates"
---

# Tasks: Fix Test Explorer Real-time Status Updates

**Input**: Design documents from `/specs/001-fix-test-explorer-realtime/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/parser-api.md, contracts/testrun-api.md

**Feature**: Fix real-time status update issues in Cucumber Java Easy Runner VS Code extension's Test Explorer integration

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3, US4)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and verification

- [ ] T001 Verify VS Code extension project structure and dependencies in package.json
- [ ] T002 Verify TypeScript compilation configuration in tsconfig.json
- [ ] T003 [P] Read and understand current extension.ts implementation (lines 1-2100)
- [ ] T004 [P] Review CucumberOutputParser class implementation in src/extension.ts (lines 65-315)
- [ ] T005 [P] Review CucumberTestController class implementation in src/extension.ts (lines 320-600)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core fixes that MUST be complete before ANY user story can work properly

**⚠️ CRITICAL**: These fixes are required for all real-time status updates to function

- [ ] T006 Add onStepStatusChange callback parameter to CucumberOutputParser constructor in src/extension.ts (line ~70)
- [ ] T007 Implement finalize() method in CucumberOutputParser class in src/extension.ts (ensures pending steps are flushed)
- [ ] T008 Add line buffering logic to handle incomplete output lines in src/extension.ts (line ~2028-2061)
- [ ] T009 Ensure stripAnsiCodes() method properly removes ANSI escape sequences in src/extension.ts (line ~210-214)
- [ ] T010 Update parseLine() to support all Cucumber status symbols (✔✘✓✗×↷⊝−) in src/extension.ts (line ~104-135)

**Checkpoint**: Foundation ready - user story implementation can now begin

---

## Phase 3: User Story 1 - Real-time Scenario Status Updates (Priority: P1) 🎯 MVP

**Goal**: Developers see scenario execution status update in real-time (preparing → running → passed/failed) without manual refresh

**Independent Test**: Run any scenario from Test Explorer and observe icon changes from idle → preparing → running → passed/failed in real-time

### Implementation for User Story 1

- [ ] T011 [US1] Add TestRun.started() call for scenario items before execution in src/extension.ts (line ~850 in runSingleTest method)
- [ ] T012 [US1] Implement "preparing" state by calling TestRun.started() immediately when test command is sent in src/extension.ts (line ~843)
- [ ] T013 [US1] Track first output received to transition from "preparing" to "running" state in src/extension.ts
- [ ] T014 [US1] Ensure scenario status updates to passed/failed within 1 second of test completion in src/extension.ts (line ~920-945)
- [ ] T015 [US1] Add scenario result determination based on step failures (not exit code) in src/extension.ts (line ~920-945)
- [ ] T016 [US1] Add logging for scenario lifecycle events (DEBUG level) in src/extension.ts

**Checkpoint**: Scenario-level real-time status updates should now be fully functional

---

## Phase 4: User Story 2 - Real-time Step-level Status Updates (Priority: P1)

**Goal**: Developers see individual steps (Given/When/Then/And/But) update their execution status in real-time within Test Explorer tree

**Independent Test**: Run a scenario with multiple steps and verify each step's icon updates to show running → passed/failed as test progresses

### Implementation for User Story 2

- [ ] T017 [P] [US2] Create step items map collection before test execution in src/extension.ts (line ~862)
- [ ] T018 [US2] Implement onStepUpdate callback function that receives StepResult from parser in src/extension.ts (line ~862-885)
- [ ] T019 [US2] Add TestRun.started() call for step items in onStepUpdate callback in src/extension.ts (line ~870)
- [ ] T020 [US2] Map StepResult.status to TestRun.passed/failed/skipped calls in onStepUpdate callback in src/extension.ts (line ~875-895)
- [ ] T021 [US2] Pass onStepUpdate callback to CucumberOutputParser constructor in src/extension.ts (line ~855)
- [ ] T022 [US2] Implement step-to-TestItem mapping using step text as primary key in src/extension.ts (line ~862-885)
- [ ] T023 [US2] Add logic to mark remaining steps as "skipped" when a step fails in src/extension.ts
- [ ] T024 [US2] Ensure TestRun.failed() includes full error message from StepResult in src/extension.ts (line ~890-895)
- [ ] T025 [US2] Add step execution timing to track 500ms update requirement in src/extension.ts

**Checkpoint**: Step-level real-time status updates should now be fully functional

---

## Phase 5: User Story 3 - Accurate Output Parsing for Both Execution Modes (Priority: P2)

**Goal**: Extension correctly parses console output for both Java direct mode and Maven mode, handling ANSI codes and different formats

**Independent Test**: Toggle between Java and Maven modes, run same scenario in both, verify step statuses are correctly detected in both modes

### Implementation for User Story 3

- [ ] T026 [P] [US3] Enhance parseLine() to handle Java direct execution output format in src/extension.ts (line ~104-135)
- [ ] T027 [P] [US3] Enhance parseLine() to handle Maven test execution output format in src/extension.ts (line ~104-135)
- [ ] T028 [US3] Add fuzzy step name matching with tag removal ([TAG] prefix handling) in src/extension.ts (line ~870-885)
- [ ] T029 [US3] Improve ANSI color code stripping regex pattern in src/extension.ts (line ~210-214)
- [ ] T030 [US3] Add support for unicode step names (Chinese, emoji, special characters) in src/extension.ts
- [ ] T031 [US3] Implement multi-line error message accumulation in parseLine() method in src/extension.ts (line ~121-135)
- [ ] T032 [US3] Add error pattern detection for stack traces in src/extension.ts (line ~125-135)
- [ ] T033 [US3] Update grep filtering pattern for Maven output in src/extension.ts (line ~2012-2027)
- [ ] T034 [US3] Test parsing with both Java and Maven output samples
- [ ] T035 [US3] Add logging for parsing edge cases and symbol detection in src/extension.ts

**Checkpoint**: Both Java and Maven execution modes should parse output correctly

---

## Phase 6: User Story 4 - Error Message Display in Test Explorer (Priority: P2)

**Goal**: Developers can click on failed steps in Test Explorer to see complete error messages and stack traces

**Independent Test**: Create scenario with intentionally failing step, run it, click failed step, verify full error message displays

### Implementation for User Story 4

- [ ] T036 [P] [US4] Ensure TestMessage includes full error text from StepResult.errorMessage in src/extension.ts (line ~890-895)
- [ ] T037 [US4] Format multi-line stack traces for TestMessage display in src/extension.ts
- [ ] T038 [US4] Preserve error message formatting (newlines, indentation) in src/extension.ts
- [ ] T039 [US4] Add error location information to TestMessage if available in src/extension.ts
- [ ] T040 [US4] Test error display with various error types (AssertionError, Exception, multi-line stack traces)
- [ ] T041 [US4] Ensure each failed step retains unique error message in src/extension.ts

**Checkpoint**: Error messages should be fully visible and properly formatted in Test Explorer

---

## Phase 7: Edge Cases & Performance

**Purpose**: Handle edge cases and optimize performance

- [ ] T042 [P] Implement auto-collapse for scenarios when total steps exceed 500 in src/extension.ts
- [ ] T043 [P] Add handling for test cancellation mid-run (preserve partial results) in src/extension.ts
- [ ] T044 [P] Add finalization call in process close event handler in src/extension.ts (line ~2075-2090)
- [ ] T045 Add handling for race conditions when multiple steps complete simultaneously in src/extension.ts
- [ ] T046 Add handling for extremely long step names (>200 characters) in src/extension.ts
- [ ] T047 [P] Add validation for step count performance limits in src/extension.ts
- [ ] T048 Test with large test suites (50 scenarios, 500+ steps)
- [ ] T049 Verify no memory leaks during long test runs

**Checkpoint**: Extension handles edge cases gracefully and performs well with large test suites

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Final improvements and documentation

- [ ] T050 [P] Update extension logs with consistent DEBUG/INFO/ERROR levels in src/extension.ts
- [ ] T051 [P] Add comprehensive logging for debugging step matching failures in src/extension.ts
- [ ] T052 [P] Update README.md with troubleshooting section for real-time status issues
- [ ] T053 Review and update quickstart.md validation scenarios in specs/001-fix-test-explorer-realtime/quickstart.md
- [ ] T054 Add inline code comments explaining TestRun lifecycle in src/extension.ts
- [ ] T055 Verify all success criteria from spec.md are met
- [ ] T056 Manual smoke testing with sample Cucumber projects
- [ ] T057 [P] Performance testing: verify <500ms step updates and <2s test discovery

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3-6)**: All depend on Foundational phase completion
  - User Story 1 and 2 are tightly coupled (should be done together for MVP)
  - User Story 3 can start after Foundational
  - User Story 4 can start after Foundational
- **Edge Cases (Phase 7)**: Depends on all user stories being complete
- **Polish (Phase 8)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - Required for MVP
- **User Story 2 (P1)**: Can start after Foundational (Phase 2) - Required for MVP (tightly coupled with US1)
- **User Story 3 (P2)**: Can start after Foundational (Phase 2) - Independent, but enhances US1 & US2
- **User Story 4 (P2)**: Can start after Foundational (Phase 2) - Independent, builds on US2

### Within Each User Story

**User Story 1**:
- T011-T012 first (add TestRun.started calls)
- T013-T014 next (state transitions)
- T015-T016 last (result determination and logging)

**User Story 2**:
- T017-T018 first (setup callback infrastructure)
- T019-T021 next (implement callback logic)
- T022-T025 last (mapping and error handling)

**User Story 3**:
- T026-T028 can run in parallel (different parsing aspects)
- T029-T032 next (ANSI and error handling)
- T033-T035 last (grep filtering and testing)

**User Story 4**:
- T036-T039 first (error message infrastructure)
- T040-T041 last (testing)

### Parallel Opportunities

- All Setup tasks marked [P] can run in parallel (reading/reviewing code)
- Within Foundational: T006-T010 should be done sequentially (they modify same parser class)
- User Story 1 & 2: Should be implemented together (tightly coupled for MVP)
- User Story 3 & 4: Can run in parallel (different concerns)
- Within US2: T017 and T018 can be done in parallel
- Within US3: T026, T027, T028 can be done in parallel
- Within US4: T036 and T037 can be done in parallel
- Phase 7: Most tasks marked [P] can run in parallel
- Phase 8: All tasks marked [P] can run in parallel

---

## Parallel Example: User Story 2

```bash
# Can work on these simultaneously (different functions):
Task T017: "Create step items map collection before test execution"
Task T018: "Implement onStepUpdate callback function"

# Then sequentially:
Task T019: "Add TestRun.started() call in callback"
Task T020: "Map StepResult.status to TestRun methods"
```

---

## Implementation Strategy

### MVP First (User Stories 1 + 2 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL - blocks all stories)
3. Complete Phase 3: User Story 1 + Phase 4: User Story 2 (together for MVP)
4. **STOP and VALIDATE**: Test real-time scenario and step updates
5. Deploy/demo if ready

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready
2. Add User Story 1 + 2 → Test independently → Deploy/Demo (MVP! - Core real-time updates working)
3. Add User Story 3 → Test independently → Deploy/Demo (Better parsing for both modes)
4. Add User Story 4 → Test independently → Deploy/Demo (Better error visibility)
5. Add Edge Cases handling → Test → Deploy/Demo (Production-ready)
6. Polish → Final release

### Sequential Single Developer Strategy

Recommended order for lone developer:

1. Phase 1: Setup (verify understanding)
2. Phase 2: Foundational (T006-T010 sequentially)
3. Phase 3 + Phase 4: User Stories 1 & 2 together (MVP)
4. Validate MVP works end-to-end
5. Phase 5: User Story 3 (parsing improvements)
6. Phase 6: User Story 4 (error display)
7. Phase 7: Edge cases
8. Phase 8: Polish

---

## Validation Checklist

After completing MVP (US1 + US2):
- [ ] Run feature file: scenario icon shows preparing → running → passed/failed
- [ ] Run scenario with 5 steps: each step icon updates sequentially
- [ ] Verify step updates happen within 500ms
- [ ] No "Step not found" warnings in logs
- [ ] All steps finalized (none stuck in running state)

After completing US3:
- [ ] Toggle to Java mode, run test: statuses correct
- [ ] Toggle to Maven mode, run test: statuses correct
- [ ] Test with unicode step names: parsed correctly
- [ ] Test with tagged steps [TAG]: fuzzy match works

After completing US4:
- [ ] Create failing step: error message displays in Test Explorer
- [ ] Multi-line stack trace: fully visible
- [ ] Multiple failing steps: each shows unique error

Final validation:
- [ ] All success criteria from spec.md (SC-001 through SC-007) met
- [ ] Manual smoke tests pass (from quickstart.md)
- [ ] Performance targets met (<500ms step updates, <2s discovery)
- [ ] Extension logs provide useful debugging information

---

## Notes

- [P] tasks = different files or independent code sections, no dependencies
- [Story] label maps task to specific user story for traceability
- All work is in single file: src/extension.ts (~2100 lines)
- Future refactoring will split into multiple files, but not in this feature
- Most fixes are in CucumberOutputParser class and runSingleTest/runCucumberTestWithMavenResult functions
- TestRun lifecycle (started → passed/failed/skipped) is critical for all user stories
- Commit after each task or logical group for safety
- Stop at any checkpoint to validate independently
