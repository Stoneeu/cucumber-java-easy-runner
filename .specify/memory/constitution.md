<!--
SYNC IMPACT REPORT
==================
Version Change: Initial → 1.0.0
Principles Established:
  - I. VS Code Extension Architecture (NEW)
  - II. Test Explorer Integration (NEW)
  - III. User Experience First (NEW)
  - IV. Multi-Mode Support (NEW)
  - V. Observability & Logging (NEW)
Sections Added:
  - Technical Standards (NEW)
  - Development Workflow (NEW)
Templates Requiring Updates:
  ✅ plan-template.md - Constitution Check section validated
  ✅ spec-template.md - User scenarios and requirements align
  ✅ tasks-template.md - Task structure supports principles
Follow-up TODOs: None
-->

# Cucumber Java Easy Runner Constitution

## Core Principles

### I. VS Code Extension Architecture

The extension MUST integrate seamlessly with VS Code's native APIs and patterns:

- Extension activation MUST be scoped to Gherkin files and workspace feature detection using `activationEvents`
- Test discovery MUST use VS Code's `TestController` API for native Test Explorer integration
- Commands MUST be registered through `contributes.commands` in package.json with clear naming
- File watching MUST use VS Code's workspace file system watcher APIs
- Configuration MUST use VS Code's settings system (`workspace.getConfiguration`)
- Output MUST use OutputChannel for user-facing logs and test results
- All UI interactions MUST follow VS Code UX patterns (status bar, quick pick, input boxes)

**Rationale**: VS Code extensions that follow platform conventions provide superior user experience, better performance, and easier maintenance. Non-standard implementations lead to conflicts and user confusion.

### II. Test Explorer Integration

Test Explorer MUST be the primary interface for test execution:

- All feature files, scenarios, and examples MUST appear as discrete test items in Test Explorer
- Test hierarchy MUST reflect feature → scenario → step structure accurately
- Test execution MUST report real-time status updates (started, passed, failed, skipped) per test item
- CodeLens buttons are OPTIONAL and disabled by default (`enableCodeLens: false`)
- Test item ranges MUST map correctly to source file line numbers for navigation
- Build/target directories MUST be excluded from test discovery to prevent duplicates

**Rationale**: Test Explorer is VS Code's standardized testing interface. Users expect consistent behavior across all testing extensions. CodeLens clutters the editor and duplicates Test Explorer functionality.

### III. User Experience First

User workflow simplicity MUST take precedence over technical complexity:

- Zero configuration MUST be the default: auto-detect glue paths, test classes, and project structure
- User prompts MUST only appear when auto-detection genuinely fails
- Configuration caching MUST remember user choices (test class mapping, glue paths) with opt-out available
- Error messages MUST be actionable and guide users to resolution
- Status bar MUST clearly indicate current execution mode (Java/Maven)
- Output MUST be filtered and structured for readability (step results, errors, summaries)

**Rationale**: Developer tools succeed when they reduce friction. Every prompt or configuration requirement is a barrier to adoption.

### IV. Multi-Mode Support

The extension MUST support both direct Java execution and Maven test execution modes:

- Execution mode MUST be easily toggleable via status bar or command palette
- Java mode MUST execute features directly via Cucumber CLI for simple single-module projects
- Maven mode MUST use `mvn test` with appropriate parameters for multi-module projects
- Both modes MUST support feature-level, scenario-level, and example-level execution
- Configuration options (Maven profile, tags, environment variables) MUST be available per mode
- Mode switching MUST preserve user context and cached configurations

**Rationale**: Different project structures require different execution strategies. Forcing a single approach excludes valid use cases.

### V. Observability & Logging

All execution paths MUST provide transparent visibility into operations:

- Extension operations MUST log to dedicated "Cucumber Java Easy Runner - Logs" output channel
- Test results MUST stream to dedicated "Cucumber Test Results" output channel
- Real-time step execution status MUST be parsed and displayed during test runs
- Log levels MUST be appropriate (INFO, WARN, ERROR, DEBUG) with timestamps
- Output parsing MUST handle ANSI codes, multi-line errors, and Cucumber symbols correctly
- Failed steps MUST display full error messages and stack traces

**Rationale**: When tests fail or execution stalls, users need immediate insight into what happened. Silent failures and opaque execution are unacceptable in developer tools.

## Technical Standards

**Technology Stack**:
- Language: TypeScript 5.0+
- Runtime: Node.js 16+
- Platform: VS Code Extension API 1.93.1+
- Build: TypeScript Compiler with strict mode enabled
- Target: ES2020

**Project Structure**:
```
src/
  extension.ts          # Main entry point, activation, command registration
tests/                  # Extension tests (if added)
out/                    # Compiled JavaScript output
package.json            # Extension manifest
tsconfig.json           # TypeScript configuration
```

**Dependencies**:
- VS Code extension dependencies MUST be minimal and well-maintained
- No external UI frameworks - use VS Code's native APIs
- Node standard library for file system, child process operations

**Code Quality**:
- TypeScript strict mode MUST be enabled
- ESLint MUST be configured and pass on all source files
- All public APIs MUST have JSDoc comments describing purpose and parameters
- Complex parsing logic MUST have inline comments explaining algorithm
- No magic numbers - use named constants or configuration

**Performance Constraints**:
- Test discovery MUST complete within 2 seconds for 100 feature files
- File watcher MUST debounce events to avoid duplicate processing
- Output parsing MUST not block UI thread
- Test execution MUST stream output, not buffer entire result

## Development Workflow

**Feature Development**:
1. New features MUST have corresponding configuration options if they alter default behavior
2. User-facing changes MUST update README.md with examples
3. Commands MUST be registered in both package.json and extension.ts
4. Breaking changes to configuration MUST preserve backward compatibility or provide migration guidance

**Code Review Requirements**:
- All changes MUST pass `npm run compile` without errors
- All changes MUST pass `npm run lint` without warnings
- Complex logic (parsers, watchers, execution) MUST have explanatory comments
- Configuration changes MUST document rationale and default values

**Testing Gates**:
- Manual smoke test MUST verify: test discovery, feature execution, scenario execution, example execution
- Both Java and Maven modes MUST be tested before release
- Configuration changes MUST be tested with both default and custom values
- Test Explorer integration MUST correctly reflect pass/fail/skip states

**Versioning**:
- Follow semantic versioning: MAJOR.MINOR.PATCH
- MAJOR: Breaking changes to configuration, commands, or VS Code API compatibility
- MINOR: New features, new execution modes, new configuration options
- PATCH: Bug fixes, performance improvements, documentation updates

## Governance

This constitution supersedes all other development practices for the Cucumber Java Easy Runner extension.

**Compliance Verification**:
- All feature specifications MUST verify against Core Principles before implementation
- All code reviews MUST confirm adherence to Technical Standards
- Configuration changes MUST maintain User Experience First principle
- New execution modes MUST maintain Multi-Mode Support principle

**Amendment Process**:
- Constitution amendments require clear rationale tied to user needs or platform changes
- Breaking changes to principles require migration plan for existing features
- Version MUST increment according to semantic rules when amended

**Complexity Justification**:
- Deviations from principles MUST be documented with specific justification
- Alternative simpler approaches MUST be evaluated and documented if rejected
- Temporary complexity for migration MUST have sunset timeline

**Runtime Guidance**:
- Use this constitution for architecture decisions and feature design
- Consult README.md for user-facing feature documentation
- Refer to package.json for current configuration schema

**Version**: 1.0.0 | **Ratified**: 2025-11-09 | **Last Amended**: 2025-11-09
