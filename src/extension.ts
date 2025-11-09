// VS Code extension main file
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { spawn } from 'child_process';

interface StepInfo {
  keyword: string;  // Given, When, Then, And, But
  text: string;     // Step text
  lineNumber: number;
}

interface ScenarioInfo {
  name: string;
  lineNumber: number;
  exampleLineNumber?: number;
  examples?: ExampleInfo[];
  steps?: StepInfo[];  // New: steps in this scenario
}

interface ExampleInfo {
  lineNumber: number;
  data: string;
}

interface FeatureInfo {
  name: string;
  scenarios: ScenarioInfo[];
  filePath: string;
  lineNumber: number;
}

interface ModuleInfo {
  modulePath: string;
  moduleRelativePath: string;
  workspaceRoot: string;
}

interface StepResult {
  keyword: string;
  name: string;
  status: 'passed' | 'failed' | 'skipped' | 'pending' | 'undefined';
  errorMessage?: string;
  location?: string;
}

interface TestClassMapping {
  [featurePath: string]: string;
}

/**
 * Cucumber output parser for real-time step results
 */
class CucumberOutputParser {
  private outputChannel: vscode.OutputChannel;
  private currentStep: StepResult | null = null;
  private showStepResults: boolean;
  private isCapturingError: boolean = false;
  private errorLines: string[] = [];
  private onStepStatusChange?: (step: StepResult) => void;

  constructor(
    outputChannel: vscode.OutputChannel,
    showStepResults: boolean = true,
    onStepStatusChange?: (step: StepResult) => void
  ) {
    this.outputChannel = outputChannel;
    this.showStepResults = showStepResults;
    this.onStepStatusChange = onStepStatusChange;
  }

  parseLine(line: string): StepResult | null {
    // Remove ANSI color codes first
    const cleanLine = this.stripAnsiCodes(line);
    logToExtension(`Parsing line: "${cleanLine}"`, 'DEBUG');

    // Pattern for Cucumber step execution with success/failure symbols
    // Examples:
    // "    ✔ And [MKT05A06] 存下取得的JWT身份驗證代碼    # tw.datahunter..."
    // "    ✘ When [MKT05A06] 創建動態分眾...    # tw.datahunter..."
    // "    Given I am on the login page    # StepDefinitions.loginPage()"
    const stepMatch = cleanLine.match(/^\s*[✔✘✓✗×]?\s*(Given|When|Then|And|But)\s+(.+?)\s*(?:#|$)/);

    if (stepMatch) {
      // If we were capturing an error for a previous step, finish it
      if (this.currentStep && this.isCapturingError) {
        this.currentStep.errorMessage = this.errorLines.join('\n');
        this.displayStepResult(this.currentStep);
        this.errorLines = [];
        this.isCapturingError = false;
      }

      const keyword = stepMatch[1];
      const stepText = stepMatch[2].trim();

      // Detect if the step already shows as failed (✘ symbol)
      const isFailed = cleanLine.includes('✘') || cleanLine.includes('✗') || cleanLine.includes('×');

      // Create new step
      this.currentStep = {
        keyword: keyword,
        name: stepText,
        status: isFailed ? 'failed' : 'passed'
      };

      logToExtension(`Found step: ${keyword} ${stepText}, status: ${this.currentStep.status}`, 'INFO');

      // If step is already marked as failed, we'll wait for error details
      // If step is passed, we can notify immediately (unless error follows)
      if (!isFailed) {
        // For passed steps, notify after a brief delay to see if error follows
        // We'll finalize in the next line if no error appears
      }

      return this.currentStep;
    }

    // Check if this line indicates an error/exception
    // Examples: "java.lang.AssertionError:", "Error:", "Exception:", indented error messages
    const errorPattern = /^\s+(java\.|org\.|Error|Exception|AssertionError|at\s+|Caused by:|\.\.\.)/;

    if (errorPattern.test(cleanLine)) {
      logToExtension(`Found error line: ${cleanLine.trim()}`, 'DEBUG');

      if (this.currentStep) {
        // Mark current step as failed
        if (this.currentStep.status === 'passed') {
          this.currentStep.status = 'failed';
          logToExtension(`Marking step as FAILED: ${this.currentStep.keyword} ${this.currentStep.name}`, 'WARN');
        }

        this.isCapturingError = true;
        this.errorLines.push(cleanLine.trim());
      }
      return null;
    }

    // If we have a current step and see a new step or certain markers, finalize the previous one
    if (this.currentStep && !this.isCapturingError) {
      // Check if this is a blank line, new scenario/feature, or another step symbol
      const shouldFinalize = cleanLine.trim() === '' ||
                            cleanLine.match(/^\s+(Scenario|Feature|Background)/) ||
                            cleanLine.match(/^\s*[✔✘✓✗×]\s+(Given|When|Then|And|But)/);

      if (shouldFinalize) {
        // This step is done, notify about its status
        this.displayStepResult(this.currentStep);
        const result = this.currentStep;
        this.currentStep = null;
        return result;
      }
    }

    // Continue capturing error lines if we're in error mode
    if (this.isCapturingError && cleanLine.trim().length > 0) {
      // Check if this looks like an error stack trace line
      if (cleanLine.match(/^\s+(at\s+|\.\.\.|\d+\s+more|Caused by:)/)) {
        this.errorLines.push(cleanLine.trim());
      } else {
        // End of error, finalize the failed step
        if (this.currentStep) {
          this.currentStep.errorMessage = this.errorLines.join('\n');
          this.displayStepResult(this.currentStep);
          this.errorLines = [];
          this.isCapturingError = false;
          this.currentStep = null;
        }
      }
    }

    return null;
  }

  /**
   * Strip ANSI color codes from a string
   * Example: "\x1b[32m[main]\x1b[0m" -> "[main]"
   */
  private stripAnsiCodes(str: string): string {
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1b\[[0-9;]*m/g, '');
  }

  private displayStepResult(result: StepResult): void {
    let icon = '';

    switch (result.status) {
      case 'passed':
        icon = '✅';
        logToExtension(`Step PASSED: ${result.keyword} ${result.name}`, 'INFO');
        break;
      case 'failed':
        icon = '❌';
        logToExtension(`Step FAILED: ${result.keyword} ${result.name}`, 'ERROR');
        break;
      case 'skipped':
        icon = '⊝';
        logToExtension(`Step SKIPPED: ${result.keyword} ${result.name}`, 'WARN');
        break;
      default:
        icon = '❓';
    }

    // Notify listeners about step status change
    if (this.onStepStatusChange) {
      this.onStepStatusChange(result);
    }

    if (this.showStepResults) {
      const message = `${icon} ${result.keyword} ${result.name}`;
      this.outputChannel.appendLine(message);

      if (result.errorMessage) {
        this.outputChannel.appendLine(`   Error: ${result.errorMessage}`);
        logToExtension(`Error details: ${result.errorMessage}`, 'ERROR');
      }
    }
  }

  finalize(): void {
    // Finalize any pending step
    if (this.currentStep) {
      if (this.isCapturingError) {
        this.currentStep.errorMessage = this.errorLines.join('\n');
      }
      this.displayStepResult(this.currentStep);
      this.currentStep = null;
      this.isCapturingError = false;
      this.errorLines = [];
    }
  }

  reset(): void {
    this.currentStep = null;
    this.isCapturingError = false;
    this.errorLines = [];
  }
}

/**
 * Test controller for Cucumber tests
 */
class CucumberTestController {
  private controller: vscode.TestController;
  private watchedFiles = new Map<string, vscode.TestItem>();

  constructor(context: vscode.ExtensionContext) {
    this.controller = vscode.tests.createTestController('cucumberJavaEasyRunner', 'Cucumber Java Tests');
    context.subscriptions.push(this.controller);

    // Set up file watcher - exclude build directories
    const watcher = vscode.workspace.createFileSystemWatcher(
      '**/*.feature',
      false, // ignoreCreateEvents
      false, // ignoreChangeEvents  
      false  // ignoreDeleteEvents
    );
    context.subscriptions.push(watcher);

    watcher.onDidCreate(uri => this.handleFileEvent('create', uri));
    watcher.onDidChange(uri => this.handleFileEvent('change', uri));
    watcher.onDidDelete(uri => this.handleFileEvent('delete', uri));

    // Set up test run handler
    this.controller.createRunProfile(
      'Run Cucumber Tests',
      vscode.TestRunProfileKind.Run,
      (request, token) => this.runTests(request, token),
      true
    );

    // Add refresh button to test controller
    this.controller.refreshHandler = () => {
      console.log('Test controller refresh triggered');
      this.discoverTests();
    };

    // Initial scan of workspace - delay to avoid duplicates
    setTimeout(() => {
      this.discoverTests();
    }, 500);

    // Add refresh command
    const refreshCommand = vscode.commands.registerCommand('cucumberJavaEasyRunner.refreshTests', () => {
      console.log('Refreshing Cucumber tests...');
      this.discoverTests();
    });
    context.subscriptions.push(refreshCommand);
  }

  private handleFileEvent(eventType: string, uri: vscode.Uri) {
    // Filter out files from build/target directories
    const filePath = uri.fsPath.toLowerCase();
    const excludedPaths = ['target', 'build', 'out', 'dist', 'node_modules', '.git'];
    
    if (excludedPaths.some(excluded => filePath.includes(`/${excluded}/`) || filePath.includes(`\\${excluded}\\`))) {
      console.log(`Ignoring ${eventType} event for build directory file: ${uri.fsPath}`);
      return;
    }

    console.log(`Handling ${eventType} event for: ${uri.fsPath}`);
    
    if (eventType === 'delete') {
      this.deleteTest(uri);
    } else {
      // Add small delay to ensure file is fully written
      setTimeout(() => {
        this.createOrUpdateTest(uri);
      }, 100);
    }
  }

  private async discoverTests() {
    // Clear all existing tests first
    this.controller.items.replace([]);
    this.watchedFiles.clear();
    
    // Exclude common build/target directories to avoid duplicates
    const featureFiles = await vscode.workspace.findFiles(
      '**/*.feature', 
      '{**/node_modules/**,**/target/**,**/build/**,**/out/**,**/dist/**,**/.git/**}'
    );
    
    console.log(`Found ${featureFiles.length} feature files`);
    
    for (const uri of featureFiles) {
      console.log(`Processing feature file: ${uri.fsPath}`);
      await this.createOrUpdateTest(uri);
    }
  }

  private async createOrUpdateTest(uri: vscode.Uri) {
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const featureInfo = this.parseFeatureFile(document);
      
      if (!featureInfo) return;

      // Create unique feature ID using normalized file path
      const featureId = path.normalize(uri.fsPath);
      
      // Check if feature already exists
      if (this.watchedFiles.has(featureId)) {
        console.log(`Feature already exists: ${featureId}`);
        return;
      }
      
      const featureItem = this.controller.createTestItem(featureId, featureInfo.name, uri);
      
      // Set range for feature to show play button in gutter
      featureItem.range = new vscode.Range(
        featureInfo.lineNumber - 1, 0,
        featureInfo.lineNumber - 1, 0
      );
      
      this.controller.items.add(featureItem);
      this.watchedFiles.set(featureId, featureItem);

      // Add scenarios as children
      for (const scenario of featureInfo.scenarios) {
        const scenarioId = `${featureId}:scenario:${scenario.lineNumber}`;
        const scenarioItem = this.controller.createTestItem(
          scenarioId,
          scenario.name,
          uri
        );

        scenarioItem.range = new vscode.Range(
          scenario.lineNumber - 1, 0,
          scenario.lineNumber - 1, 0
        );

        featureItem.children.add(scenarioItem);

        // Add steps as children of scenario
        if (scenario.steps && scenario.steps.length > 0) {
          for (const step of scenario.steps) {
            const stepId = `${scenarioId}:step:${step.lineNumber}`;
            const stepItem = this.controller.createTestItem(
              stepId,
              `${step.keyword} ${step.text}`,
              uri
            );

            stepItem.range = new vscode.Range(
              step.lineNumber - 1, 0,
              step.lineNumber - 1, 0
            );

            scenarioItem.children.add(stepItem);
          }
        }

        // Add example rows as children of scenario
        if (scenario.examples && scenario.examples.length > 0) {
          for (const example of scenario.examples) {
            const exampleId = `${scenarioId}:example:${example.lineNumber}`;
            const exampleItem = this.controller.createTestItem(
              exampleId,
              `Example: ${example.data.trim()}`,
              uri
            );

            exampleItem.range = new vscode.Range(
              example.lineNumber - 1, 0,
              example.lineNumber - 1, 0
            );

            scenarioItem.children.add(exampleItem);
          }
        }
      }

      console.log(`Added feature: ${featureInfo.name} with ${featureInfo.scenarios.length} scenarios`);

    } catch (error) {
      console.error('Error parsing feature file:', error);
    }
  }

  private deleteTest(uri: vscode.Uri) {
    const featureId = path.normalize(uri.fsPath);
    const featureItem = this.watchedFiles.get(featureId);
    
    if (featureItem) {
      this.controller.items.delete(featureId);
      this.watchedFiles.delete(featureId);
      console.log(`Deleted feature: ${featureId}`);
    }
  }

  private parseFeatureFile(document: vscode.TextDocument): FeatureInfo | null {
    const text = document.getText();
    const lines = text.split('\n');

    let featureName = '';
    let featureLineNumber = 0;
    const scenarios: ScenarioInfo[] = [];
    let currentScenario: ScenarioInfo | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('Feature:')) {
        featureName = line.substring(8).trim();
        featureLineNumber = i + 1;
      } else if (line.startsWith('Scenario:')) {
        const scenarioName = line.substring(9).trim();
        currentScenario = {
          name: scenarioName,
          lineNumber: i + 1,
          examples: [],
          steps: []  // Initialize steps array
        };
        scenarios.push(currentScenario);
      } else if (line.startsWith('Scenario Outline:')) {
        const scenarioName = line.substring(17).trim();
        currentScenario = {
          name: `${scenarioName} (Outline)`,
          lineNumber: i + 1,
          examples: [],
          steps: []  // Initialize steps array
        };
        scenarios.push(currentScenario);
      } else if (line.startsWith('|') && currentScenario && i > 0) {
        // Check if this is an example row (not header)
        const exampleInfo = findExampleRowInfo(lines, i);
        if (exampleInfo && currentScenario.examples) {
          currentScenario.examples.push({
            lineNumber: i + 1,
            data: line
          });
        }
      } else if (currentScenario && currentScenario.steps) {
        // Check if this line is a step (Given/When/Then/And/But)
        const stepMatch = line.match(/^(Given|When|Then|And|But)\s+(.+)/);
        if (stepMatch) {
          const keyword = stepMatch[1];
          const stepText = stepMatch[2].trim();
          currentScenario.steps.push({
            keyword: keyword,
            text: stepText,
            lineNumber: i + 1
          });
        }
      }
    }

    if (!featureName) return null;

    return {
      name: featureName,
      scenarios,
      filePath: document.uri.fsPath,
      lineNumber: featureLineNumber
    };
  }

  private async runTests(request: vscode.TestRunRequest, token: vscode.CancellationToken) {
    const run = this.controller.createTestRun(request);
    
    const testItems = request.include || this.gatherAllTests();
    
    for (const testItem of testItems) {
      if (token.isCancellationRequested) {
        break;
      }

      await this.runSingleTest(testItem, run);
    }

    run.end();
  }

  private gatherAllTests(): vscode.TestItem[] {
    const tests: vscode.TestItem[] = [];
    
    this.controller.items.forEach(item => {
      tests.push(item);
      item.children.forEach(child => tests.push(child));
    });
    
    return tests;
  }

  private async runSingleTest(testItem: vscode.TestItem, run: vscode.TestRun) {
    run.started(testItem);

    try {
      const uri = testItem.uri!;

      // Create a map to track step test items by their text for real-time updates
      const stepItemsMap = new Map<string, vscode.TestItem>();
      let hasFailedStep = false; // Track if any step has failed

      // If running a scenario, collect all step children
      if (testItem.id.includes(':scenario:') && !testItem.id.includes(':step:')) {
        testItem.children.forEach(child => {
          if (child.id.includes(':step:')) {
            // Extract step text from label (format: "Given step text")
            const stepText = child.label;
            stepItemsMap.set(stepText, child);
            // Mark all steps as started
            run.started(child);
            logToExtension(`Step queued: ${stepText}`, 'DEBUG');
          }
        });
      }

      // Callback for real-time step status updates
      const onStepUpdate = (stepResult: StepResult) => {
        const stepKey = `${stepResult.keyword} ${stepResult.name}`;
        let stepItem = stepItemsMap.get(stepKey);

        logToExtension(`onStepUpdate called: ${stepKey} - ${stepResult.status}`, 'INFO');

        // If exact match fails, try fuzzy matching (remove tags like [MKT05A06])
        if (!stepItem) {
          logToExtension(`Exact match failed, trying fuzzy match...`, 'DEBUG');

          // Remove common tags like [XXX] from the step name
          const cleanedStepName = stepResult.name.replace(/\[[\w\d]+\]\s*/g, '').trim();
          const cleanedStepKey = `${stepResult.keyword} ${cleanedStepName}`;

          logToExtension(`Trying cleaned key: ${cleanedStepKey}`, 'DEBUG');

          // Try to find a matching step by checking if the label contains the cleaned text
          for (const [label, item] of stepItemsMap.entries()) {
            // Remove tags from the stored label too
            const cleanedLabel = label.replace(/\[[\w\d]+\]\s*/g, '').trim();

            if (cleanedLabel === cleanedStepKey || label === cleanedStepKey) {
              stepItem = item;
              logToExtension(`Found fuzzy match: "${label}" matches "${stepKey}"`, 'INFO');
              break;
            }
          }
        }

        if (stepItem) {
          logToExtension(`Updating step in Test Explorer: ${stepKey} - ${stepResult.status}`, 'INFO');

          switch (stepResult.status) {
            case 'passed':
              run.passed(stepItem);
              logToExtension(`✅ Step PASSED in UI: ${stepKey}`, 'INFO');
              break;
            case 'failed':
              hasFailedStep = true; // Mark that we have a failed step
              const errorMsg = stepResult.errorMessage || 'Step failed';
              run.failed(stepItem, new vscode.TestMessage(errorMsg));
              logToExtension(`❌ Step FAILED in UI: ${stepKey}`, 'ERROR');

              // Immediately mark the scenario as failed if it's a scenario test
              if (testItem.id.includes(':scenario:')) {
                logToExtension(`Marking scenario as FAILED due to step failure: ${stepKey}`, 'ERROR');
                run.failed(testItem, new vscode.TestMessage(`Step failed: ${stepKey}\n${errorMsg}`));
              }
              break;
            case 'skipped':
              run.skipped(stepItem);
              logToExtension(`⊝ Step SKIPPED in UI: ${stepKey}`, 'WARN');
              break;
          }
        } else {
          logToExtension(`⚠️ Step not found in Test Explorer after fuzzy match: ${stepKey}`, 'WARN');
          logToExtension(`Available steps: ${Array.from(stepItemsMap.keys()).join(', ')}`, 'DEBUG');
        }
      };

      // Check test type based on ID structure
      if (testItem.id.includes(':step:')) {
        // This is a single step - cannot run independently, skip
        run.skipped(testItem);
        return;
      } else if (testItem.id.includes(':example:')) {
        // This is an example row
        const parts = testItem.id.split(':');
        const scenarioLine = parseInt(parts[2]); // scenario line number
        const exampleLine = parseInt(parts[4]); // example line number
        logToExtension(`Running example at scenario line ${scenarioLine}, example line ${exampleLine}`, 'INFO');
        const exitCode = await runSelectedTestAndWait(
          uri,
          scenarioLine,
          exampleLine,
          (data) => run.appendOutput(data, undefined, testItem),
          onStepUpdate
        );
        if (exitCode === 0) {
          run.passed(testItem);
        } else {
          run.failed(testItem, new vscode.TestMessage(`Test failed with exit code ${exitCode}`));
        }
      } else if (testItem.id.includes(':scenario:')) {
        // This is a scenario
        const parts = testItem.id.split(':scenario:');
        const lineNumber = parseInt(parts[1].split(':')[0]); // Get first part before any additional colons
        logToExtension(`Running scenario at line ${lineNumber}`, 'INFO');
        const exitCode = await runSelectedTestAndWait(
          uri,
          lineNumber,
          undefined,
          (data) => run.appendOutput(data, undefined, testItem),
          onStepUpdate
        );

        // Only mark as passed if no steps failed AND exit code is 0
        if (!hasFailedStep && exitCode === 0) {
          run.passed(testItem);
          logToExtension(`Scenario PASSED (no failed steps, exit code 0)`, 'INFO');
        } else if (!hasFailedStep) {
          // Exit code non-zero but no failed steps detected
          run.failed(testItem, new vscode.TestMessage(`Test failed with exit code ${exitCode}`));
          logToExtension(`Scenario FAILED (exit code ${exitCode})`, 'ERROR');
        }
        // If hasFailedStep is true, we already marked it as failed in onStepUpdate
      } else {
        // This is a feature file
        logToExtension(`Running entire feature file`, 'INFO');
        const exitCode = await runSelectedTestAndWait(
          uri,
          undefined,
          undefined,
          (data) => run.appendOutput(data, undefined, testItem),
          onStepUpdate
        );

        // Only mark as passed if no steps failed AND exit code is 0
        if (!hasFailedStep && exitCode === 0) {
          run.passed(testItem);
          logToExtension(`Feature PASSED (no failed steps, exit code 0)`, 'INFO');
        } else if (!hasFailedStep) {
          run.failed(testItem, new vscode.TestMessage(`Test failed with exit code ${exitCode}`));
          logToExtension(`Feature FAILED (exit code ${exitCode})`, 'ERROR');
        }
      }

    } catch (error) {
      console.error('Test execution error:', error);
      run.failed(testItem, new vscode.TestMessage(`Test failed: ${error}`));
    }
  }

  private async executeTest(uri: vscode.Uri, lineNumber?: number, exampleLine?: number) {
    // Use the existing runSelectedTest function
    await runSelectedTest(uri, lineNumber, exampleLine);
  }

  dispose() {
    this.controller.dispose();
    this.watchedFiles.clear();
  }
}

/**
 * CodeLens provider for Cucumber feature files - with compact buttons
 */
class CucumberCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[] {
    const codeLenses: vscode.CodeLens[] = [];
    
    if (path.extname(document.uri.fsPath) !== '.feature') {
      return codeLenses;
    }

    const text = document.getText();
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      if (line.startsWith('Feature:')) {
        // Position the button at the very beginning of the line
        const range = new vscode.Range(i, 0, i, 0);
        codeLenses.push(new vscode.CodeLens(range, {
          title: '$(play-circle) ',
          tooltip: 'Click to run the entire feature file',
          command: 'cucumberJavaEasyRunner.runFeatureCodeLens',
          arguments: [document.uri]
        }));
      } else if (line.startsWith('Scenario:') || line.startsWith('Scenario Outline:')) {
        // Position the button at the very beginning of the line
        const range = new vscode.Range(i, 0, i, 0);
        codeLenses.push(new vscode.CodeLens(range, {
          title: '$(play) ',
          tooltip: 'Click to run this scenario',
          command: 'cucumberJavaEasyRunner.runScenarioCodeLens',
          arguments: [document.uri, i + 1] // 1-indexed line number
        }));
      } else if (line.startsWith('|') && i > 0) {
        // Check if this is an example row (not header)
        const exampleInfo = this.findExampleRowInfo(lines, i);
        if (exampleInfo) {
          const range = new vscode.Range(i, 0, i, 0);
          codeLenses.push(new vscode.CodeLens(range, {
            title: '$(play) ',
            tooltip: 'Click to run this example row',
            command: 'cucumberJavaEasyRunner.runExampleCodeLens',
            arguments: [document.uri, exampleInfo.scenarioLine, i + 1] // scenario line and example line
          }));
        }
      }
    }

    return codeLenses;
  }

  private findExampleRowInfo(lines: string[], currentLine: number): { scenarioLine: number } | null {
    // Go backwards to find Examples heading
    let examplesLine = -1;
    let headerLine = -1;
    
    for (let i = currentLine; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('Examples:')) {
        examplesLine = i;
        break;
      }
    }
    
    if (examplesLine === -1) {
      return null;
    }
    
    // Find the header row (first | line after Examples)
    for (let i = examplesLine + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('|')) {
        headerLine = i;
        break;
      }
    }
    
    // Current line must be after header line to be a data row
    if (headerLine === -1 || currentLine <= headerLine) {
      return null;
    }
    
    // Find the Scenario Outline
    for (let i = examplesLine; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('Scenario Outline:')) {
        return { scenarioLine: i + 1 }; // 1-indexed
      }
    }
    
    return null;
  }
}

/**
 * Finds example row info
 */
function findExampleRowInfo(lines: string[], currentLine: number): { scenarioLine: number } | null {
  // Go backwards to find Examples heading
  let examplesLine = -1;
  let headerLine = -1;
  
  for (let i = currentLine; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('Examples:')) {
      examplesLine = i;
      break;
    }
  }
  
  if (examplesLine === -1) {
    return null;
  }
  
  // Find the header row (first | line after Examples)
  for (let i = examplesLine + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('|')) {
      headerLine = i;
      break;
    }
  }
  
  // Current line must be after header line to be a data row
  if (headerLine === -1 || currentLine <= headerLine) {
    return null;
  }
  
  // Find the Scenario Outline
  for (let i = examplesLine; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('Scenario Outline:')) {
      return { scenarioLine: i + 1 }; // 1-indexed
    }
  }
  
  return null;
}

// Global test controller instance
let globalTestController: CucumberTestController | undefined;

// Global output channel for Cucumber results
let cucumberOutputChannel: vscode.OutputChannel | undefined;

// Global output channel for Extension logs
let extensionLogChannel: vscode.OutputChannel | undefined;

// Global status bar item for execution mode
let executionModeStatusBar: vscode.StatusBarItem | undefined;

// Global extension context
let globalContext: vscode.ExtensionContext | undefined;

// Test class mapping cache (workspace state)
const TEST_CLASS_CACHE_KEY = 'cucumberTestClassMapping';

/**
 * Logs a message to the extension log channel
 */
function logToExtension(message: string, level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG' = 'INFO'): void {
  if (!extensionLogChannel) return;

  const timestamp = new Date().toLocaleTimeString();
  const prefix = `[${timestamp}] [${level}]`;
  extensionLogChannel.appendLine(`${prefix} ${message}`);

  // Also log to console for development
  console.log(`${prefix} ${message}`);
}

export function activate(context: vscode.ExtensionContext) {
  globalContext = context;

  // Dispose existing controller if it exists
  if (globalTestController) {
    try {
      globalTestController.dispose();
    } catch (error) {
      console.log('Error disposing previous controller:', error);
    }
  }

  // Create output channel for Extension logs
  extensionLogChannel = vscode.window.createOutputChannel('Cucumber Java Easy Runner - Logs');
  context.subscriptions.push(extensionLogChannel);
  logToExtension('Extension activated', 'INFO');

  // Create output channel for Cucumber results
  cucumberOutputChannel = vscode.window.createOutputChannel('Cucumber Test Results');
  context.subscriptions.push(cucumberOutputChannel);

  // Create status bar item for execution mode
  executionModeStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  executionModeStatusBar.command = 'cucumberJavaEasyRunner.toggleExecutionMode';
  executionModeStatusBar.tooltip = 'Click to toggle execution mode';
  updateExecutionModeStatusBar();
  executionModeStatusBar.show();
  context.subscriptions.push(executionModeStatusBar);
  logToExtension('Status bar created', 'DEBUG');

  // Create new test controller
  globalTestController = new CucumberTestController(context);
  logToExtension('Test controller initialized', 'INFO');
  
  // Check if CodeLens should be enabled (default: false since we have Test Explorer)
  const config = vscode.workspace.getConfiguration('cucumberJavaEasyRunner');
  const enableCodeLens = config.get('enableCodeLens', false);
  
  if (enableCodeLens) {
    // Register CodeLens provider only if enabled
    const codeLensProvider = new CucumberCodeLensProvider();
    const codeLensDisposable = vscode.languages.registerCodeLensProvider(
      { pattern: '**/*.feature' },
      codeLensProvider
    );
    context.subscriptions.push(codeLensDisposable);
    console.log('CodeLens provider registered');
  } else {
    console.log('CodeLens disabled - use Test Explorer instead');
  }

  // Command to run the entire feature file
  let runFeatureCommand = vscode.commands.registerCommand('cucumberJavaEasyRunner.runFeature', async (uri: vscode.Uri) => {
    let featureUri = uri;
    
    // If called from editor instead of explorer
    if (!featureUri && vscode.window.activeTextEditor) {
      featureUri = vscode.window.activeTextEditor.document.uri;
    }
    
    if (!featureUri) {
      vscode.window.showErrorMessage('Please open or select a feature file.');
      return;
    }
    
    runSelectedTest(featureUri);
  });

  // CodeLens command to run the entire feature file
  let runFeatureCodeLensCommand = vscode.commands.registerCommand('cucumberJavaEasyRunner.runFeatureCodeLens', async (uri: vscode.Uri) => {
    console.log('runFeatureCodeLensCommand called with URI:', uri.toString());
    vscode.window.showInformationMessage('Feature test starting...');
    runSelectedTest(uri);
  });

  // CodeLens command to run a single scenario
  let runScenarioCodeLensCommand = vscode.commands.registerCommand('cucumberJavaEasyRunner.runScenarioCodeLens', async (uri: vscode.Uri, lineNumber: number) => {
    console.log('runScenarioCodeLensCommand called with URI:', uri.toString(), 'line:', lineNumber);
    vscode.window.showInformationMessage(`Scenario test starting at line ${lineNumber}...`);
    runSelectedTest(uri, lineNumber);
  });

  // CodeLens command to run a single example
  let runExampleCodeLensCommand = vscode.commands.registerCommand('cucumberJavaEasyRunner.runExampleCodeLens', async (uri: vscode.Uri, scenarioLine: number, exampleLine: number) => {
    console.log('runExampleCodeLensCommand called with URI:', uri.toString(), 'scenario line:', scenarioLine, 'example line:', exampleLine);
    vscode.window.showInformationMessage(`Example test starting at line ${exampleLine}...`);
    runSelectedTest(uri, scenarioLine, exampleLine);
  });

  // Command to run a single scenario
  let runScenarioCommand = vscode.commands.registerCommand('cucumberJavaEasyRunner.runScenario', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('Please open a feature file.');
      return;
    }
    
    const uri = editor.document.uri;
    if (path.extname(uri.fsPath) !== '.feature') {
      vscode.window.showErrorMessage('This command only works with .feature files.');
      return;
    }
    
    const currentLine = editor.selection.active.line;
    const scenario = findScenarioAtLine(editor.document, currentLine);
    
    if (!scenario) {
      vscode.window.showErrorMessage('Please right-click inside a Scenario or Scenario Outline.');
      return;
    }
    
    runSelectedTest(uri, scenario.lineNumber);
  });
  
  // Command to run a single example row
  let runExampleCommand = vscode.commands.registerCommand('cucumberJavaEasyRunner.runExample', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('Please open a feature file.');
      return;
    }
    
    const uri = editor.document.uri;
    if (path.extname(uri.fsPath) !== '.feature') {
      vscode.window.showErrorMessage('This command only works with .feature files.');
      return;
    }
    
    const currentLine = editor.selection.active.line;
    console.log(`runExampleCommand called, line: ${currentLine}`);
    
    // First check if the line starts with |
    const lineText = editor.document.lineAt(currentLine).text.trim();
    if (!lineText.startsWith('|')) {
      vscode.window.showErrorMessage('Please right-click on a data row (starting with |) in an Examples table.');
      return;
    }
    
    const examples = findExampleAtLine(editor.document, currentLine);
    
    if (!examples) {
      vscode.window.showErrorMessage('Example row not detected. Please right-click on a data row (starting with |, not the header row) in an Examples table.');
      return;
    }
    
    runSelectedTest(uri, examples.lineNumber, examples.exampleLineNumber);
  });

  // Command to toggle execution mode
  let toggleExecutionModeCommand = vscode.commands.registerCommand('cucumberJavaEasyRunner.toggleExecutionMode', async () => {
    const config = vscode.workspace.getConfiguration('cucumberJavaEasyRunner');
    const currentMode = config.get<string>('executionMode', 'java');
    const newMode = currentMode === 'java' ? 'maven' : 'java';

    await config.update('executionMode', newMode, vscode.ConfigurationTarget.Workspace);
    updateExecutionModeStatusBar();

    vscode.window.showInformationMessage(`Execution mode switched to: ${newMode.toUpperCase()}`);
  });

  // Command to clear test class cache
  let clearTestClassCacheCommand = vscode.commands.registerCommand('cucumberJavaEasyRunner.clearTestClassCache', async () => {
    await context.workspaceState.update(TEST_CLASS_CACHE_KEY, {});
    vscode.window.showInformationMessage('Test class cache cleared successfully!');
  });

  context.subscriptions.push(runFeatureCommand);
  context.subscriptions.push(runFeatureCodeLensCommand);
  context.subscriptions.push(runScenarioCodeLensCommand);
  context.subscriptions.push(runExampleCodeLensCommand);
  context.subscriptions.push(runScenarioCommand);
  context.subscriptions.push(runExampleCommand);
  context.subscriptions.push(toggleExecutionModeCommand);
  context.subscriptions.push(clearTestClassCacheCommand);

  // Watch for configuration changes to update status bar
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cucumberJavaEasyRunner.executionMode')) {
        updateExecutionModeStatusBar();
      }
    })
  );
}

/**
 * Updates the status bar to show current execution mode
 */
function updateExecutionModeStatusBar(): void {
  if (!executionModeStatusBar) {
    return;
  }

  const config = vscode.workspace.getConfiguration('cucumberJavaEasyRunner');
  const executionMode = config.get<string>('executionMode', 'java');

  if (executionMode === 'maven') {
    executionModeStatusBar.text = '$(package) Maven';
    executionModeStatusBar.tooltip = 'Execution Mode: Maven Test\nClick to switch to Java mode';
  } else {
    executionModeStatusBar.text = '$(coffee) Java';
    executionModeStatusBar.tooltip = 'Execution Mode: Java Direct\nClick to switch to Maven mode';
  }
}

/**
 * Gets the cached test class for a feature file
 */
function getCachedTestClass(context: vscode.ExtensionContext, featurePath: string): string | undefined {
  const mapping = context.workspaceState.get<TestClassMapping>(TEST_CLASS_CACHE_KEY, {});
  return mapping[featurePath];
}

/**
 * Caches the test class for a feature file
 */
async function cacheTestClass(context: vscode.ExtensionContext, featurePath: string, testClassName: string): Promise<void> {
  const mapping = context.workspaceState.get<TestClassMapping>(TEST_CLASS_CACHE_KEY, {});
  mapping[featurePath] = testClassName;
  await context.workspaceState.update(TEST_CLASS_CACHE_KEY, mapping);
}

/**
 * Runs the selected feature, scenario, or example row
 */
async function runSelectedTest(uri: vscode.Uri, lineNumber?: number, exampleLine?: number) {
  const terminal = vscode.window.createTerminal('Cucumber Feature');

  // Find the project root directory
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('Feature file is not inside a workspace.');
    return false;
  }

  const workspaceRoot = workspaceFolder.uri.fsPath;

  // Get configuration
  const config = vscode.workspace.getConfiguration('cucumberJavaEasyRunner');
  const executionMode = config.get<string>('executionMode', 'java');
  const configuredTestClass = config.get<string>('testClassName', '');

  // Find the Maven module for this feature file
  const moduleInfo = findMavenModule(uri.fsPath, workspaceRoot);

  // Get the relative path of the feature file in the workspace
  const relativePath = path.relative(workspaceRoot, uri.fsPath);

  // Save the run mode information
  let runMode = 'feature';
  if (lineNumber && lineNumber > 0) {
    runMode = exampleLine ? 'example' : 'scenario';
  }

  logToExtension(`Run mode: ${runMode}`, 'INFO');
  logToExtension(`Execution mode: ${executionMode}`, 'INFO');
  logToExtension(`Module path: ${moduleInfo.modulePath}`, 'DEBUG');
  logToExtension(`Module relative path: ${moduleInfo.moduleRelativePath}`, 'DEBUG');
  logToExtension(`Feature: ${relativePath}`, 'INFO');
  logToExtension(`Scenario line: ${lineNumber || 'entire feature'}`, 'DEBUG');
  logToExtension(`Example line: ${exampleLine || 'all scenarios'}`, 'DEBUG');

  // Clear and show output channel
  if (cucumberOutputChannel) {
    cucumberOutputChannel.clear();
    cucumberOutputChannel.show(true);
    cucumberOutputChannel.appendLine('═══════════════════════════════════════════');
    cucumberOutputChannel.appendLine(`🥒 Cucumber Test Run - ${new Date().toLocaleTimeString()}`);
    cucumberOutputChannel.appendLine('═══════════════════════════════════════════');
    cucumberOutputChannel.appendLine(`📁 Feature: ${relativePath}`);
    cucumberOutputChannel.appendLine(`🔧 Mode: ${executionMode.toUpperCase()}`);
    cucumberOutputChannel.appendLine('═══════════════════════════════════════════\n');
  }

  try {
    if (executionMode === 'maven') {
      // Maven execution mode
      let testClassName: string = configuredTestClass;

      // Try to use cached test class if rememberTestClass is enabled
      const rememberTestClass = config.get<boolean>('rememberTestClass', true);
      if (!testClassName && rememberTestClass && globalContext) {
        const cachedClass = getCachedTestClass(globalContext, relativePath);
        if (cachedClass) {
          testClassName = cachedClass;
          console.log(`Using cached test class: ${testClassName}`);
        }
      }

      // Auto-detect test class if not configured
      if (!testClassName) {
        const autoDetectedClass = await findCucumberTestClass(moduleInfo.modulePath);

        if (!autoDetectedClass) {
          const userInput = await vscode.window.showInputBox({
            prompt: 'Enter test class name (e.g., MktSegmentCriteriaUpdateTest)',
            placeHolder: 'MktSegmentCriteriaUpdateTest'
          });

          if (!userInput) {
            vscode.window.showErrorMessage('Test class name not specified, operation cancelled.');
            return false;
          }
          testClassName = userInput;
        } else {
          testClassName = autoDetectedClass;
        }

        // Cache the test class for future use
        if (rememberTestClass && globalContext) {
          await cacheTestClass(globalContext, relativePath, testClassName);
        }
      }

      let message = '';
      if (runMode === 'feature') {
        message = `Running feature file with Maven test (${testClassName})`;
      } else if (runMode === 'scenario') {
        message = `Running scenario at line ${lineNumber} with Maven test (${testClassName})`;
      } else if (runMode === 'example') {
        message = `Running example at line ${lineNumber}:${exampleLine} with Maven test (${testClassName})`;
      }

      vscode.window.showInformationMessage(message);
      await runCucumberTestWithMaven(
        workspaceRoot,
        moduleInfo,
        relativePath,
        testClassName,
        terminal,
        lineNumber,
        exampleLine
      );
    } else {
      // Java execution mode (original behavior)
      const gluePath = await findGluePath(moduleInfo.modulePath);

      if (!gluePath) {
        const userInput = await vscode.window.showInputBox({
          prompt: 'Enter glue path for steps directory (e.g. org.example.steps)',
          placeHolder: 'org.example.steps'
        });

        if (!userInput) {
          vscode.window.showErrorMessage('Glue path not specified, operation cancelled.');
          return false;
        }

        runCucumberTest(moduleInfo.modulePath, relativePath, userInput, terminal, lineNumber, exampleLine);
      } else {
        let message = '';
        if (runMode === 'feature') {
          message = `Running feature file with glue path "${gluePath}"`;
        } else if (runMode === 'scenario') {
          message = `Running scenario at line ${lineNumber} with glue path "${gluePath}"`;
        } else if (runMode === 'example') {
          message = `Running example at line ${lineNumber}:${exampleLine} with glue path "${gluePath}"`;
        }

        vscode.window.showInformationMessage(message);
        runCucumberTest(moduleInfo.modulePath, relativePath, gluePath, terminal, lineNumber, exampleLine);
      }
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(`Error: ${error.message || 'Unknown error'}`);
  }
}

/**
 * Runs the selected test and waits for the Java process to finish. Streams output via the provided callback.
 */
async function runSelectedTestAndWait(
  uri: vscode.Uri,
  lineNumber?: number,
  exampleLine?: number,
  onOutput?: (chunk: string) => void,
  onStepUpdate?: (step: StepResult) => void
): Promise<number> {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('Feature file is not inside a workspace.');
    return 1;
  }

  const workspaceRoot = workspaceFolder.uri.fsPath;

  // Get configuration
  const config = vscode.workspace.getConfiguration('cucumberJavaEasyRunner');
  const executionMode = config.get<string>('executionMode', 'java');
  const configuredTestClass = config.get<string>('testClassName', '');

  // Find the Maven module for this feature file
  const moduleInfo = findMavenModule(uri.fsPath, workspaceRoot);

  const relativePath = path.relative(workspaceRoot, uri.fsPath);

  try {
    if (executionMode === 'maven') {
      // Maven execution mode
      let testClassName: string = configuredTestClass;

      // Auto-detect test class if not configured
      if (!testClassName) {
        const autoDetectedClass = await findCucumberTestClass(moduleInfo.modulePath);

        if (!autoDetectedClass) {
          const userInput = await vscode.window.showInputBox({
            prompt: 'Enter test class name (e.g., MktSegmentCriteriaUpdateTest)',
            placeHolder: 'MktSegmentCriteriaUpdateTest'
          });

          if (!userInput) {
            vscode.window.showErrorMessage('Test class name not specified, operation cancelled.');
            return 1;
          }
          testClassName = userInput;
        } else {
          testClassName = autoDetectedClass;
        }
      }

      return await runCucumberTestWithMavenResult(
        workspaceRoot,
        moduleInfo,
        relativePath,
        testClassName,
        lineNumber,
        exampleLine,
        onOutput,
        onStepUpdate
      );
    } else {
      // Java execution mode (original behavior)
      const gluePath = await findGluePath(moduleInfo.modulePath);

      if (!gluePath) {
        const userInput = await vscode.window.showInputBox({
          prompt: 'Enter glue path for steps directory (e.g. org.example.steps)',
          placeHolder: 'org.example.steps'
        });
        if (!userInput) {
          vscode.window.showErrorMessage('Glue path not specified, operation cancelled.');
          return 1;
        }
        return await runCucumberTestWithResult(moduleInfo.modulePath, relativePath, userInput, lineNumber, exampleLine, onOutput);
      } else {
        return await runCucumberTestWithResult(moduleInfo.modulePath, relativePath, gluePath, lineNumber, exampleLine, onOutput);
      }
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(`Error: ${error.message || 'Unknown error'}`);
    return 1;
  }
}

/**
 * Finds the scenario at the given line number
 */
function findScenarioAtLine(document: vscode.TextDocument, line: number): ScenarioInfo | null {
  const text = document.getText();
  const lines = text.split('\n');

  // Find the closest scenario heading from the line number backwards
  for (let i = line; i >= 0; i--) {
    const currentLine = lines[i].trim();
    if (currentLine.startsWith('Scenario:') || currentLine.startsWith('Scenario Outline:')) {
      let name = currentLine.substring(currentLine.indexOf(':') + 1).trim();
      return { name, lineNumber: i + 1 }; // 1-indexed line number for Cucumber
    }
  }

  // Find the feature heading (if no scenario was found)
  for (let i = 0; i < lines.length; i++) {
    const currentLine = lines[i].trim();
    if (currentLine.startsWith('Feature:')) {
      return { name: 'feature', lineNumber: 0 }; // 0 means entire feature
    }
  }

  return null;
}

/**
 * Finds the example row at the given line number
 */
function findExampleAtLine(document: vscode.TextDocument, line: number): ScenarioInfo | null {
  try {
    const text = document.getText();
    const lines = text.split('\n');
    
    // Check the line content for debugging
    const currentLineText = lines[line].trim();
    console.log(`Debug: Current line (${line}): "${currentLineText}"`);
    
    // Check if the line starts with |
    if (!currentLineText.startsWith('|')) {
      console.log('Debug: Line does not start with |');
      return null;
    }
    
    // Find the Examples block
    let examplesLine = -1;
    let scenarioOutlineLine = -1;
    let headerLine = -1;
    
    // First go backwards to find the Examples heading
    for (let i = line; i >= 0; i--) {
      const lineText = lines[i].trim();
      console.log(`Debug: Backward line (${i}): "${lineText}"`);
      
      if (lineText.startsWith('Examples:')) {
        examplesLine = i;
        console.log(`Debug: Examples heading found, line: ${examplesLine}`);
        break;
      }
    }
    
    if (examplesLine === -1) {
      console.log('Debug: Examples heading not found');
      return null;
    }
    
    // The first line starting with | after the Examples heading is the header row
    for (let i = examplesLine + 1; i < lines.length; i++) {
      const lineText = lines[i].trim();
      if (lineText.startsWith('|')) {
        headerLine = i;
        console.log(`Debug: Header row found, line: ${headerLine}`);
        break;
      }
    }
    
    if (headerLine === -1 || line <= headerLine) {
      console.log(`Debug: Valid header row not found or current line (${line}) is before header line (${headerLine})`);
      return null;
    }
    
    // Go backwards from Examples heading to find the Scenario Outline
    for (let i = examplesLine; i >= 0; i--) {
      const lineText = lines[i].trim();
      if (lineText.startsWith('Scenario Outline:')) {
        scenarioOutlineLine = i + 1; // 1-indexed
        console.log(`Debug: Scenario Outline found, line: ${scenarioOutlineLine}`);
        break;
      }
    }
    
    if (scenarioOutlineLine === -1) {
      console.log('Debug: Scenario Outline not found');
      return null;
    }
    
    // Set the current line directly as the line to run
    // Note: Cucumber's expected format: feature:scenario_line:example_line
    return {
      name: 'example',
      lineNumber: scenarioOutlineLine,
      exampleLineNumber: line + 1 // 1-indexed
    };
  } catch (err: any) {
    console.error(`Error in findExampleAtLine: ${err.message}`);
    return null;
  }
}

/**
 * Finds the nearest Maven module by searching upwards for pom.xml from the feature file
 */
function findMavenModule(featureFilePath: string, workspaceRoot: string): ModuleInfo {
  let currentDir = path.dirname(featureFilePath);

  // Search upwards for pom.xml
  while (currentDir.startsWith(workspaceRoot)) {
    const pomPath = path.join(currentDir, 'pom.xml');

    if (fs.existsSync(pomPath)) {
      // Found a pom.xml, this is our module
      const moduleRelativePath = path.relative(workspaceRoot, currentDir);

      return {
        modulePath: currentDir,
        moduleRelativePath: moduleRelativePath || '.',
        workspaceRoot: workspaceRoot
      };
    }

    // Move up one directory
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      // Reached the root
      break;
    }
    currentDir = parentDir;
  }

  // No pom.xml found, use workspace root as module
  return {
    modulePath: workspaceRoot,
    moduleRelativePath: '.',
    workspaceRoot: workspaceRoot
  };
}

/**
 * Finds the steps directories in the project and converts to Java package structure
 */
async function findGluePath(projectRoot: string): Promise<string | null> {
  // In Maven projects, test code is usually in src/test/java
  const testDir = path.join(projectRoot, 'src', 'test', 'java');

  if (!fs.existsSync(testDir)) {
    return null;
  }

  // Recursively search for steps directories
  const stepsDir = await findStepsDir(testDir);

  if (!stepsDir) {
    return null;
  }

  // Create the Java package name for the steps directory
  // src/test/java/org/example/steps -> org.example.steps
  const packagePath = path.relative(testDir, stepsDir).replace(/\\/g, '/').replace(/\//g, '.');

  return packagePath;
}

/**
 * Finds Cucumber test class names in the module
 */
async function findCucumberTestClass(modulePath: string): Promise<string | null> {
  const testDir = path.join(modulePath, 'src', 'test', 'java');

  if (!fs.existsSync(testDir)) {
    return null;
  }

  // Search for test classes with Cucumber annotations
  const testClass = await findTestClassWithCucumberAnnotations(testDir);

  return testClass;
}

/**
 * Recursively searches for Java test classes with Cucumber annotations
 */
async function findTestClassWithCucumberAnnotations(dir: string): Promise<string | null> {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const result = await findTestClassWithCucumberAnnotations(path.join(dir, entry.name));
      if (result) {
        return result;
      }
    } else if (entry.name.endsWith('Test.java') || entry.name.endsWith('Runner.java')) {
      const filePath = path.join(dir, entry.name);
      const content = fs.readFileSync(filePath, 'utf8');

      // Check if this file contains Cucumber annotations
      if (content.includes('@RunWith') || content.includes('@CucumberOptions') ||
          content.includes('io.cucumber')) {
        // Extract class name (without .java extension)
        return entry.name.replace('.java', '');
      }
    }
  }

  return null;
}

/**
 * Recursively searches for the steps directory
 */
async function findStepsDir(dir: string): Promise<string | null> {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  // First check if current directory is a steps folder
  if (dir.endsWith('steps') || dir.endsWith('step')) {
    // Check if it contains Java files directly
    const hasJavaFiles = entries.some(entry => !entry.isDirectory() && entry.name.endsWith('.java'));
    
    // Check Java files in subdirectories
    if (!hasJavaFiles) {
      // Recursive inner function to check directories
      const checkSubDirsForJavaFiles = (subDir: string): boolean => {
        const subEntries = fs.readdirSync(subDir, { withFileTypes: true });
        
        // Does this subdirectory have Java files?
        const hasDirectJavaFiles = subEntries.some(entry => !entry.isDirectory() && entry.name.endsWith('.java'));
        if (hasDirectJavaFiles) {
          return true;
        }
        
        // Check deeper subdirectories if they exist
        for (const entry of subEntries) {
          if (entry.isDirectory()) {
            const hasJavaInSubDir = checkSubDirsForJavaFiles(path.join(subDir, entry.name));
            if (hasJavaInSubDir) {
              return true;
            }
          }
        }
        
        return false;
      };
      
      // Accept this directory if subdirectories contain Java files
      const hasJavaFilesInSubDirs = entries.some(entry => {
        if (entry.isDirectory()) {
          return checkSubDirsForJavaFiles(path.join(dir, entry.name));
        }
        return false;
      });
      
      if (hasJavaFilesInSubDirs) {
        return dir;
      }
    } else {
      // If Java files exist directly in the directory
      return dir;
    }
  }
  
  // If nothing found, search in subdirectories
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const subDir = path.join(dir, entry.name);
      const result = await findStepsDir(subDir);
      if (result) {
        return result;
      }
    }
  }
  
  return null;
}

/**
 * Runs the Cucumber test
 */
function runCucumberTest(
  projectRoot: string, 
  featurePath: string, 
  gluePath: string, 
  terminal: vscode.Terminal,
  lineNumber?: number,
  exampleLineNumber?: number
) {
  // Path to the feature file to run
  let cucumberPath = featurePath.replace(/\\/g, '/');
  
  // If a specific line is specified, add that line
  if (lineNumber && lineNumber > 0) {
    if (exampleLineNumber && exampleLineNumber > 0) {
      // Running an example - use only the example line
      cucumberPath += ':' + exampleLineNumber;
      console.log(`Cucumber path (example): ${cucumberPath}`);
    } else {
      // Running a scenario
      cucumberPath += ':' + lineNumber;
      console.log(`Cucumber path (scenario): ${cucumberPath}`);
    }
  } else {
    console.log(`Cucumber path (feature): ${cucumberPath}`);
  }
  
  // Java code to find the classpath and package name
  const javaCode = `
import io.cucumber.core.cli.Main;

public class CucumberRunner {
  public static void main(String[] args) {
    System.out.println("Cucumber feature: ${cucumberPath}");
    String[] cucumberArgs = new String[] {
      "${cucumberPath}",
      "--glue", "${gluePath}",
      "--plugin", "pretty"
    };
    Main.main(cucumberArgs);
  }
}`;

  // Save the temporary Java file
  const tmpDir = path.join(projectRoot, 'target', 'tmp');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }
  
  const javaFilePath = path.join(tmpDir, 'CucumberRunner.java');
  fs.writeFileSync(javaFilePath, javaCode);

  // Compile and run the Java file
  terminal.sendText(`cd "${projectRoot}" && javac -cp "target/test-classes:target/classes:$(mvn dependency:build-classpath -q -Dmdep.outputFile=/dev/stdout)" ${javaFilePath} && java -cp "target/test-classes:target/classes:$(mvn dependency:build-classpath -q -Dmdep.outputFile=/dev/stdout):${path.dirname(javaFilePath)}" CucumberRunner`);
  terminal.show();
}

/**
 * Runs the Cucumber test via child_process and returns the exit code.
 */
async function runCucumberTestWithResult(
  projectRoot: string,
  featurePath: string,
  gluePath: string,
  lineNumber?: number,
  exampleLineNumber?: number,
  onOutput?: (chunk: string) => void
): Promise<number> {
  // Build cucumber path with optional line specifiers
  let cucumberPath = featurePath.replace(/\\/g, '/');
  if (lineNumber && lineNumber > 0) {
    if (exampleLineNumber && exampleLineNumber > 0) {
      cucumberPath += ':' + exampleLineNumber;
    } else {
      cucumberPath += ':' + lineNumber;
    }
  }

  const tmpDir = path.join(projectRoot, 'target', 'tmp');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  const javaFilePath = path.join(tmpDir, 'CucumberRunner.java');
  const javaCode = `
import io.cucumber.core.cli.Main;

public class CucumberRunner {
  public static void main(String[] args) {
    System.out.println("Cucumber feature: ${cucumberPath}");
    String[] cucumberArgs = new String[] {
      "${cucumberPath}",
      "--glue", "${gluePath}",
      "--plugin", "pretty"
    };
    Main.main(cucumberArgs);
  }
}`;
  fs.writeFileSync(javaFilePath, javaCode);

  const cpFile = path.join(tmpDir, 'classpath.txt');

  const execFilePromise = (file: string, args: string[], cwd: string) => new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    const child = execFile(file, args, { cwd, env: { ...process.env, MAVEN_OPTS: `${process.env.MAVEN_OPTS || ''}` } }, (error, stdout, stderr) => {
      resolve({ stdout, stderr, code: error ? (typeof (error as any).code === 'number' ? (error as any).code : 1) : 0 });
    });
  });

  // 1) Build classpath via Maven
  const mvnArgs = ['-q', '-DincludeScope=test', '-DskipTests', 'dependency:build-classpath', `-Dmdep.outputFile=${cpFile}`];
  const mvnRes = await execFilePromise('mvn', mvnArgs, projectRoot);
  if (onOutput) {
    if (mvnRes.stdout) onOutput(mvnRes.stdout);
    if (mvnRes.stderr) onOutput(mvnRes.stderr);
  }
  if (mvnRes.code !== 0) {
    return mvnRes.code;
  }

  // Read deps classpath
  const depsClasspathRaw = fs.existsSync(cpFile) ? fs.readFileSync(cpFile, 'utf8').trim() : '';
  const delimiter = path.delimiter;
  const testClasses = path.join(projectRoot, 'target', 'test-classes');
  const mainClasses = path.join(projectRoot, 'target', 'classes');
  const baseClasspath = [testClasses, mainClasses].join(delimiter);
  const fullClasspath = depsClasspathRaw ? [baseClasspath, depsClasspathRaw].join(delimiter) : baseClasspath;

  // 2) Compile runner
  const javacArgs = ['-cp', fullClasspath, '-d', tmpDir, javaFilePath];
  const javacRes = await execFilePromise('javac', javacArgs, projectRoot);
  if (onOutput) {
    if (javacRes.stdout) onOutput(javacRes.stdout);
    if (javacRes.stderr) onOutput(javacRes.stderr);
  }
  if (javacRes.code !== 0) {
    return javacRes.code;
  }

  // 3) Run tests and stream output
  const runCp = [fullClasspath, tmpDir].join(delimiter);
  const child = spawn('java', ['-cp', runCp, 'CucumberRunner'], { cwd: projectRoot });
  return await new Promise<number>((resolve) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      if (onOutput) onOutput(chunk.toString());
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (onOutput) onOutput(chunk.toString());
    });
    child.on('close', (code) => {
      resolve(typeof code === 'number' ? code : 1);
    });
  });
}

/**
 * Converts a feature file path to classpath format for Maven
 * Example: src/test/resources/feature/login.feature -> classpath:feature/login.feature
 */
function convertToClasspathFormat(featureRelativePath: string, moduleRelativePath: string): string {
  // Remove module path prefix if present
  let pathInModule = featureRelativePath;
  if (moduleRelativePath !== '.' && featureRelativePath.startsWith(moduleRelativePath)) {
    pathInModule = featureRelativePath.substring(moduleRelativePath.length + 1);
  }

  // Try to find the path within src/test/resources or src/main/resources
  const resourcesPrefixes = [
    'src/test/resources/',
    'src/main/resources/',
    'src/test/java/',
    'src/main/java/'
  ];

  for (const prefix of resourcesPrefixes) {
    if (pathInModule.startsWith(prefix)) {
      return 'classpath:' + pathInModule.substring(prefix.length);
    }
  }

  // If not in resources, just use the path as is with classpath prefix
  return 'classpath:' + pathInModule;
}

/**
 * Runs the Cucumber test using Maven test command (supports multi-module projects)
 */
async function runCucumberTestWithMaven(
  workspaceRoot: string,
  moduleInfo: ModuleInfo,
  featurePath: string,
  testClassName: string,
  terminal: vscode.Terminal,
  lineNumber?: number,
  exampleLineNumber?: number
) {
  // Get configuration
  const config = vscode.workspace.getConfiguration('cucumberJavaEasyRunner');
  const mavenArgs = config.get<string>('mavenArgs', '');
  const mavenProfile = config.get<string>('mavenProfile', '');
  const cucumberTags = config.get<string>('cucumberTags', '');
  const envVars = config.get<{ [key: string]: string }>('environmentVariables', {});

  // Convert feature path to classpath format
  const classpathFeature = convertToClasspathFormat(featurePath, moduleInfo.moduleRelativePath);

  // Build the cucumber.features parameter
  let cucumberFeatures = classpathFeature;
  if (lineNumber && lineNumber > 0) {
    if (exampleLineNumber && exampleLineNumber > 0) {
      cucumberFeatures += ':' + exampleLineNumber;
    } else {
      cucumberFeatures += ':' + lineNumber;
    }
  }

  // Set environment variables
  if (Object.keys(envVars).length > 0) {
    for (const [key, value] of Object.entries(envVars)) {
      terminal.sendText(`export ${key}="${value}"`);
    }
  }

  // Build the Maven command
  let mvnCommand = `cd "${workspaceRoot}" && mvn test`;

  // Add Maven profile
  if (mavenProfile) {
    mvnCommand += ` -P${mavenProfile}`;
  }

  // Add feature path
  mvnCommand += ` -Dcucumber.features="${cucumberFeatures}"`;

  // Add tags filter
  if (cucumberTags) {
    mvnCommand += ` -Dcucumber.filter.tags="${cucumberTags}"`;
  }

  // Add -pl parameter for multi-module projects
  if (moduleInfo.moduleRelativePath !== '.') {
    mvnCommand += ` -pl ${moduleInfo.moduleRelativePath.replace(/\\/g, '/')}`;
  }

  // Add -Dtest parameter for test class
  mvnCommand += ` -Dtest=${testClassName}`;

  // Add additional Maven arguments
  if (mavenArgs) {
    mvnCommand += ` ${mavenArgs}`;
  }

  console.log(`Maven test command: ${mvnCommand}`);

  terminal.sendText(mvnCommand);
  terminal.show();
}

/**
 * Runs the Cucumber test using Maven test command and returns the exit code
 */
async function runCucumberTestWithMavenResult(
  workspaceRoot: string,
  moduleInfo: ModuleInfo,
  featurePath: string,
  testClassName: string,
  lineNumber?: number,
  exampleLineNumber?: number,
  onOutput?: (chunk: string) => void,
  onStepUpdate?: (step: StepResult) => void
): Promise<number> {
  // Get configuration
  const config = vscode.workspace.getConfiguration('cucumberJavaEasyRunner');
  const mavenArgs = config.get<string>('mavenArgs', '');
  const mavenProfile = config.get<string>('mavenProfile', '');
  const cucumberTags = config.get<string>('cucumberTags', '');
  const showStepResults = config.get<boolean>('showStepResults', true);
  const envVars = config.get<{ [key: string]: string }>('environmentVariables', {});

  // Convert feature path to classpath format
  const classpathFeature = convertToClasspathFormat(featurePath, moduleInfo.moduleRelativePath);

  // Build the cucumber.features parameter
  let cucumberFeatures = classpathFeature;
  if (lineNumber && lineNumber > 0) {
    if (exampleLineNumber && exampleLineNumber > 0) {
      cucumberFeatures += ':' + exampleLineNumber;
    } else {
      cucumberFeatures += ':' + lineNumber;
    }
  }

  // Build Maven arguments
  const mvnArgs = ['test'];

  // Add Maven profile
  if (mavenProfile) {
    mvnArgs.push(`-P${mavenProfile}`);
  }

  mvnArgs.push(`-Dcucumber.features=${cucumberFeatures}`);

  // Add tags filter
  if (cucumberTags) {
    mvnArgs.push(`-Dcucumber.filter.tags=${cucumberTags}`);
  }

  mvnArgs.push(`-Dtest=${testClassName}`);

  // Add -pl parameter for multi-module projects
  if (moduleInfo.moduleRelativePath !== '.') {
    mvnArgs.push('-pl', moduleInfo.moduleRelativePath.replace(/\\/g, '/'));
  }

  // Add additional Maven arguments
  if (mavenArgs) {
    mvnArgs.push(...mavenArgs.split(' ').filter(arg => arg.length > 0));
  }

  logToExtension(`Maven test command: mvn ${mvnArgs.join(' ')}`, 'INFO');

  // Create output parser with step status callback
  const parser = cucumberOutputChannel ? new CucumberOutputParser(cucumberOutputChannel, showStepResults, onStepUpdate) : null;
  logToExtension(`Output parser created, showStepResults: ${showStepResults}, callback: ${onStepUpdate ? 'enabled' : 'disabled'}`, 'DEBUG');

  // Merge environment variables
  const spawnEnv = { ...process.env, ...envVars };
  if (Object.keys(envVars).length > 0) {
    logToExtension(`Environment variables: ${JSON.stringify(envVars)}`, 'DEBUG');
  }

  // Execute Maven test
  const child = spawn('mvn', mvnArgs, { cwd: workspaceRoot, env: spawnEnv });
  logToExtension(`Maven process started in: ${workspaceRoot}`, 'INFO');

  let testSummary = {
    scenarios: 0,
    steps: 0,
    failures: 0,
    skipped: 0,
    passed: 0
  };

  return await new Promise<number>((resolve) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      const output = chunk.toString();

      // Parse output for step results
      if (parser) {
        const lines = output.split('\n');
        for (const line of lines) {
          parser.parseLine(line);

          // Parse test summary - Pattern: "5 Scenarios (2 failed, 3 passed)"
          const scenarioMatch = line.match(/(\d+)\s+Scenarios?\s+\(([^)]+)\)/i);
          if (scenarioMatch) {
            testSummary.scenarios = parseInt(scenarioMatch[1]);
            const details = scenarioMatch[2];

            const failedMatch = details.match(/(\d+)\s+failed/);
            const passedMatch = details.match(/(\d+)\s+passed/);
            const skippedMatch = details.match(/(\d+)\s+skipped/);

            if (failedMatch) testSummary.failures = parseInt(failedMatch[1]);
            if (passedMatch) testSummary.passed = parseInt(passedMatch[1]);
            if (skippedMatch) testSummary.skipped = parseInt(skippedMatch[1]);

            logToExtension(`Parsed scenario summary: ${testSummary.scenarios} total, ${testSummary.failures} failed, ${testSummary.passed} passed`, 'INFO');
          }

          // Parse step summary - Pattern: "15 Steps (2 failed, 3 skipped, 10 passed)"
          const stepsMatch = line.match(/(\d+)\s+Steps?\s+\(([^)]+)\)/i);
          if (stepsMatch) {
            testSummary.steps = parseInt(stepsMatch[1]);
            const details = stepsMatch[2];

            const failedMatch = details.match(/(\d+)\s+failed/);
            const skippedMatch = details.match(/(\d+)\s+skipped/);

            if (failedMatch) testSummary.failures = parseInt(failedMatch[1]);
            if (skippedMatch) testSummary.skipped = parseInt(skippedMatch[1]);

            logToExtension(`Parsed steps summary: ${testSummary.steps} total, ${testSummary.failures} failed, ${testSummary.skipped} skipped`, 'INFO');
          }
        }
      }

      if (onOutput) onOutput(output);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const errorOutput = chunk.toString();
      logToExtension(`Maven stderr: ${errorOutput.substring(0, 200)}`, 'WARN');
      if (onOutput) onOutput(errorOutput);
    });

    child.on('close', (code) => {
      const exitCode = typeof code === 'number' ? code : 1;
      logToExtension(`Maven process exited with code: ${exitCode}`, 'INFO');

      // Finalize parser to display any pending steps
      if (parser) {
        parser.finalize();
        logToExtension('Parser finalized', 'DEBUG');
      }

      // Determine test result based on failures count and exit code
      const testsPassed = testSummary.failures === 0 && exitCode === 0;
      logToExtension(`Test result: ${testsPassed ? 'PASSED' : 'FAILED'}, failures: ${testSummary.failures}, exitCode: ${exitCode}`, 'INFO');

      // Show test summary in output channel
      if (cucumberOutputChannel) {
        cucumberOutputChannel.appendLine('\n═══════════════════════════════════════════');
        cucumberOutputChannel.appendLine('📊 Test Summary');
        cucumberOutputChannel.appendLine('═══════════════════════════════════════════');
        cucumberOutputChannel.appendLine(`Scenarios: ${testSummary.scenarios}`);
        cucumberOutputChannel.appendLine(`Steps: ${testSummary.steps}`);

        if (testSummary.passed > 0) {
          cucumberOutputChannel.appendLine(`✅ Passed: ${testSummary.passed}`);
        }
        if (testSummary.failures > 0) {
          cucumberOutputChannel.appendLine(`❌ Failures: ${testSummary.failures}`);
        }
        if (testSummary.skipped > 0) {
          cucumberOutputChannel.appendLine(`⊝ Skipped: ${testSummary.skipped}`);
        }
        cucumberOutputChannel.appendLine(`\nExit Code: ${exitCode}`);
        cucumberOutputChannel.appendLine('═══════════════════════════════════════════\n');

        // Show notification based on actual test result
        if (testsPassed) {
          vscode.window.showInformationMessage(`✅ All tests passed! (${testSummary.scenarios} scenarios, ${testSummary.steps} steps)`);
          logToExtension('Showing success notification', 'INFO');
        } else {
          vscode.window.showErrorMessage(`❌ Tests failed! (${testSummary.failures} ${testSummary.failures === 1 ? 'failure' : 'failures'})`);
          logToExtension('Showing failure notification', 'ERROR');
        }
      }

      resolve(exitCode);
    });
  });
}

export function deactivate() {} 