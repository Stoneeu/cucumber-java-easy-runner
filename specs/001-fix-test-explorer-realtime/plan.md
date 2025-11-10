# Implementation Plan: Fix Test Explorer Real-time Status Updates

**Branch**: `001-fix-test-explorer-realtime` | **Date**: 2025-11-09 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-fix-test-explorer-realtime/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command. See `.specify/templates/commands/plan.md` for the execution workflow.

## Summary

Fix real-time status update issues in the Cucumber Java Easy Runner VS Code extension's Test Explorer integration. The extension supports both Java and Maven execution modes but currently has problems with displaying real-time scenario and step-level status updates. This plan focuses on debugging and fixing the integration between VS Code's Test Explorer API, Cucumber output parsing (handling both Java and Maven output formats), and the TestRun lifecycle management to ensure accurate, real-time status updates for scenarios and individual steps.

## Technical Context

**Language/Version**: TypeScript 5.0+ (compiled to ES2020)  
**Primary Dependencies**: 
- VS Code Extension API 1.93.1+ (vscode module)
- Node.js 16+ child_process for Java/Maven execution
- Cucumber JVM (runtime dependency, not direct)

**Storage**: Workspace state for test class mapping cache (VS Code ExtensionContext.workspaceState)  
**Testing**: Manual smoke testing (feature/scenario/example execution, both Java and Maven modes)  
**Target Platform**: VS Code 1.93.1+ on Linux, macOS, Windows  
**Project Type**: VS Code Extension (single TypeScript project)  
**Performance Goals**: 
- Test discovery: <2 seconds for 100 feature files
- Step status update: <500ms from step completion to UI update
- UI responsiveness: No blocking during test execution

**Constraints**: 
- MUST use VS Code's native Test Explorer API (no custom UI)
- MUST support both Java direct execution and Maven test execution
- MUST handle ANSI color codes in terminal output
- MUST parse Cucumber pretty format output with multiple unicode variants (✔✘✓✗×↷⊝−)
- MUST work with multi-module Maven projects

**Scale/Scope**: 
- Up to 50 scenarios per feature file
- Up to 500 total steps across all active scenarios
- Multi-module Maven projects with nested pom.xml files
- Unicode step names (Chinese, emoji, special characters)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Principle I: VS Code Extension Architecture ✅ PASS
- Uses TestController API for Test Explorer integration
- File watching uses VS Code's workspace file system watcher APIs
- Configuration uses VS Code's settings system
- Output uses OutputChannel for logs and results
- All UI interactions follow VS Code patterns

### Principle II: Test Explorer Integration ✅ PASS
- Test Explorer is the primary interface (CodeLens disabled by default)
- Feature → Scenario → Step hierarchy is implemented
- Real-time status updates use TestRun.started/passed/failed/skipped methods
- Build/target directories excluded from test discovery
- Test item ranges map to source file line numbers

### Principle III: User Experience First ✅ PASS
- Auto-detection of glue paths and test classes
- Configuration caching for test class mapping (opt-out available)
- Error messages displayed in Test Explorer on failed steps
- Status bar indicates current execution mode
- Output filtered and structured for readability

### Principle IV: Multi-Mode Support ✅ PASS
- Supports both Java direct execution and Maven test execution
- Mode toggleable via status bar command
- Both modes support feature/scenario/example-level execution
- Maven mode handles multi-module projects with -pl parameter

### Principle V: Observability & Logging ✅ PASS
- Extension operations logged to "Cucumber Java Easy Runner - Logs" channel
- Test results stream to "Cucumber Test Results" channel
- Real-time step execution status parsed and displayed
- Log levels: ERROR for critical failures, INFO/WARN/DEBUG for diagnostics
- Failed steps display full error messages and stack traces

### Gate Evaluation: ✅ NO VIOLATIONS
All constitutional principles are satisfied. The feature fixes existing issues without introducing new violations.

### Post-Design Re-evaluation: ✅ CONFIRMED

After completing Phase 0 (Research) and Phase 1 (Design), all constitutional principles remain satisfied:

**Principle I**: ✅ Design uses TestController/TestRun API correctly, maintains VS Code patterns  
**Principle II**: ✅ Real-time updates via TestRun lifecycle methods, proper hierarchy preserved  
**Principle III**: ✅ Fixes improve UX by ensuring reliable status updates, no new user prompts  
**Principle IV**: ✅ Fixes apply to both Java and Maven modes equally  
**Principle V**: ✅ Enhanced logging for step status tracking maintains observability  

**Design changes**:
- Added onStepStatusChange callback pattern (maintains event-driven architecture)
- Enhanced fuzzy matching algorithm (improves reliability without complexity)
- Added line buffering for streaming (standard Node.js pattern)
- All changes follow constitution principles

**No new violations introduced**. Design approved for implementation.

## Project Structure

### Documentation (this feature)

```text
specs/001-fix-test-explorer-realtime/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
│   ├── parser-api.md    # CucumberOutputParser interface contract
│   └── testrun-api.md   # TestRun lifecycle usage contract
└── checklists/
    └── requirements.md  # Existing requirements checklist
```

### Source Code (repository root)

```text
src/
├── extension.ts         # Main entry point, activation, command registration
│                        # Contains: CucumberTestController, CucumberCodeLensProvider
│                        # Contains: CucumberOutputParser, test execution functions
│                        # ~2100 lines - needs refactoring in future iteration
└── (future modularization)
    ├── testController.ts     # CucumberTestController class
    ├── outputParser.ts       # CucumberOutputParser class
    ├── executors/
    │   ├── javaExecutor.ts   # Java direct execution logic
    │   └── mavenExecutor.ts  # Maven test execution logic
    └── types.ts              # Shared interfaces (StepInfo, ScenarioInfo, etc.)

tests/                   # Extension tests (to be added)

out/                     # Compiled JavaScript output

.specify/                # Spec-kit documentation and scripts
├── memory/
│   └── constitution.md  # Project constitution
├── templates/           # Spec templates
└── scripts/             # Automation scripts

specs/                   # Feature specifications
└── 001-fix-test-explorer-realtime/  # This feature

package.json             # Extension manifest with commands, configuration schema
tsconfig.json            # TypeScript configuration (strict mode)
```

**Structure Decision**: Single TypeScript project structure maintained per constitution. Current implementation is monolithic in `extension.ts` (acceptable for now), but future features should modularize into separate files as codebase grows beyond 3000 lines.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| [e.g., 4th project] | [current need] | [why 3 projects insufficient] |
| [e.g., Repository pattern] | [specific problem] | [why direct DB access insufficient] |
