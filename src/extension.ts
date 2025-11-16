// VS Code extension main file
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import { execFile } from 'child_process';
import { spawn } from 'child_process';
import * as glob from 'glob';
import {
  DebugPortManager,
  createDebugConfiguration,
  createLaunchDebugConfiguration,
  createCucumberLaunchConfig,
  createMavenSurefireAttachConfig,
  waitForDebugServerWithProgress,
  startDebugSession,
  startLaunchDebugSession,
  buildJdwpArgsForMaven,
  handleDebugError,
  extractMavenArtifactId
} from './debug-integration';
import {
  resolveMavenClasspath,
  extractGluePackage,
  buildCucumberArgs,
  buildMavenDebugCommand,
  extractFeatureRelativePath,
  extractTestClassName,
  convertToWorkspaceFolderPaths,
  isValidMavenProject,
  findAllSourcePathsCached
} from './maven-utils';

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

export interface StepResult {
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
 * v23.2: Tag cache for performance optimization
 * Caches extracted tags to avoid re-parsing files
 */
interface TagCacheEntry {
  tags: string[];
  mtime: number; // File modification time in milliseconds
}

interface TagCache {
  [filePath: string]: TagCacheEntry;
}

// Global tag cache
const tagCache: TagCache = {};

/**
 * Cucumber output parser for real-time step results
 */
export class CucumberOutputParser {
  private outputChannel: vscode.OutputChannel;
  private currentStep: StepResult | null = null;
  private showStepResults: boolean;
  private isCapturingError = false;
  private errorLines: string[] = [];
  private onStepStatusChange?: (step: StepResult) => void;

  constructor(
    outputChannel: vscode.OutputChannel,
    showStepResults = true,
    onStepStatusChange?: (step: StepResult) => void
  ) {
    this.outputChannel = outputChannel;
    this.showStepResults = showStepResults;
    this.onStepStatusChange = onStepStatusChange;
  }

  parseLine(line: string): StepResult | null {
    // Remove ANSI color codes first
    const cleanLine = this.stripAnsiCodes(line);
    if (extensionLogChannel) {
      logToExtension(`Parsing line: "${cleanLine}"`, 'DEBUG');
    }

    // Pattern for Cucumber step execution with success/failure/skipped symbols
    // Examples:
    // "    ✔ And [MKT05A06] 存下取得的JWT身份驗證代碼    # tw.datahunter..."
    // "    ✘ When [MKT05A06] 創建動態分眾...    # tw.datahunter..."
    // "    ↷ Then [MKT05A06] 驗證分眾創建成功    # tw.datahunter..."
    // "    Given I am on the login page    # StepDefinitions.loginPage()"
    const stepMatch = cleanLine.match(/^\s*[✔✘✓✗×↷⊝−]?\s*(Given|When|Then|And|But)\s+(.+?)\s*(?:#|$)/);

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

      // Detect step status from symbol
      let status: 'passed' | 'failed' | 'skipped';
      if (cleanLine.includes('✘') || cleanLine.includes('✗') || cleanLine.includes('×')) {
        status = 'failed';
      } else if (cleanLine.includes('↷') || cleanLine.includes('⊝') || cleanLine.includes('−')) {
        status = 'skipped';
      } else {
        status = 'passed';
      }

      // Create new step
      this.currentStep = {
        keyword: keyword,
        name: stepText,
        status: status
      };

      if (extensionLogChannel) {
        logToExtension(`Found step: ${keyword} ${stepText}, status: ${this.currentStep.status}`, 'INFO');
      }

      // For passed steps, notify immediately since they don't have error details
      // For failed steps, we'll wait for error details
      // For skipped steps, notify immediately
      if (status === 'passed') {
        // Passed steps don't have error details, notify immediately
        this.displayStepResult(this.currentStep);
        const result = this.currentStep;
        this.currentStep = null;
        return result;
      } else if (status === 'skipped') {
        // Skipped steps don't have error details, notify immediately
        this.displayStepResult(this.currentStep);
        const result = this.currentStep;
        this.currentStep = null;
        return result;
      }

      // For failed steps, keep currentStep and wait for error details
      return this.currentStep;
    }

    // Check if this line indicates an error/exception from Cucumber (not application logs)
    // Cucumber error messages are indented and don't have timestamps
    // Examples: "      org.opentest4j.AssertionFailedError:", "      at java.base/..."
    // EXCLUDE: "2025-11-09 20:46:31.944 [grpc-default-executor-0] ERROR" (application logs)
    
    // First, check if this is an application log line (has timestamp pattern)
    const isApplicationLog = /^\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/.test(cleanLine);
    
    if (!isApplicationLog) {
      // Now check if this is a Cucumber error/stack trace line
      const errorPattern = /^\s+(java\.|org\.|Error|Exception|AssertionError|at\s+|Caused by:|\.\.\.)/;

      if (errorPattern.test(cleanLine)) {
        if (extensionLogChannel) {
          logToExtension(`Found Cucumber error line: ${cleanLine.trim()}`, 'DEBUG');
        }

        // Only capture error details if current step is already marked as failed
        // Don't change step status based on error stack traces - rely on Cucumber's ✘ symbol
        if (this.currentStep && this.currentStep.status === 'failed') {
          this.isCapturingError = true;
          this.errorLines.push(cleanLine.trim());
        }
        return null;
      }
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
        if (extensionLogChannel) {
          logToExtension(`Step PASSED: ${result.keyword} ${result.name}`, 'INFO');
        }
        break;
      case 'failed':
        icon = '❌';
        if (extensionLogChannel) {
          logToExtension(`Step FAILED: ${result.keyword} ${result.name}`, 'ERROR');
        }
        break;
      case 'skipped':
        icon = '⊝';
        if (extensionLogChannel) {
          logToExtension(`Step SKIPPED: ${result.keyword} ${result.name}`, 'WARN');
        }
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
        if (extensionLogChannel) {
          logToExtension(`Error details: ${result.errorMessage}`, 'ERROR');
        }
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

    // Set up test run handler for normal execution
    this.controller.createRunProfile(
      'Run Cucumber Tests',
      vscode.TestRunProfileKind.Run,
      (request, token) => this.runTests(request, token, false),
      true  // isDefault
    );

    // Set up debug profile for debugging
    this.controller.createRunProfile(
      'Debug Cucumber Tests',
      vscode.TestRunProfileKind.Debug,
      (request, token) => this.runTests(request, token, true),
      false  // not default
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
      
      if (!featureInfo) {return;}

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

    if (!featureName) {return null;}

    return {
      name: featureName,
      scenarios,
      filePath: document.uri.fsPath,
      lineNumber: featureLineNumber
    };
  }

  private async runTests(request: vscode.TestRunRequest, token: vscode.CancellationToken, isDebug: boolean = false) {
    const run = this.controller.createTestRun(request);
    
    const testItems = request.include || this.gatherAllTests();
    
    // Log execution mode
    if (isDebug) {
      logToExtension('Starting tests in DEBUG mode', 'INFO');
    } else {
      logToExtension('Starting tests in RUN mode', 'INFO');
    }
    
    for (const testItem of testItems) {
      if (token.isCancellationRequested) {
        break;
      }

      await this.runSingleTest(testItem, run, isDebug);
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

  private async runSingleTest(testItem: vscode.TestItem, run: vscode.TestRun, isDebug: boolean = false) {
    // TestRun lifecycle: started() → running → passed()/failed()/skipped() → end()
    // Mark test item as started to show "preparing" state in Test Explorer
    run.started(testItem);

    try {
      const uri = testItem.uri!;
      
      // Log test execution mode
      logToExtension(
        `Running test "${testItem.label}" in ${isDebug ? 'DEBUG' : 'RUN'} mode`,
        'INFO'
      );

      // Create a map to track step test items by their text for real-time updates
      const stepItemsMap = new Map<string, vscode.TestItem>();
      let hasFailedStep = false; // Track if any step has failed
      
      // Track Background/Before hook steps (not in feature file scenario)
      let beforeStepsContainer: vscode.TestItem | undefined = undefined;
      const backgroundStepsMap = new Map<string, vscode.TestItem>(); // Track Background steps by text
      const backgroundStepsOrder: vscode.TestItem[] = []; // Track Background steps execution order
      const processedSteps = new Set<string>(); // Track which steps have been updated

      // If running a scenario, collect all step children IN ORDER (sorted by line number)
      if (testItem.id.includes(':scenario:') && !testItem.id.includes(':step:')) {
        logToExtension(`╔═══════════════════════════════════════════════════════════════╗`, 'INFO');
        logToExtension(`║ Initializing Test Run - Scenario Steps                       ║`, 'INFO');
        logToExtension(`╚═══════════════════════════════════════════════════════════════╝`, 'INFO');
        
        // CRITICAL FIX v25.1.3: Create Before container FIRST before starting any steps
        // But DO NOT call run.started() yet - delay until first Background step detected
        // This ensures Before container appears at the TOP of Test Result tree
        if (testItem.id.includes(':scenario:')) {
          const beforeId = `${testItem.id}:before`;
          beforeStepsContainer = this.controller.createTestItem(
            beforeId,
            '⚙️ Before (Background/Hooks)',
            uri
          );
          // Add as first child of scenario
          testItem.children.add(beforeStepsContainer);
          
          // DO NOT call run.started() here - will be called when first Background step detected
          // This ensures correct display order in Test Result panel
          
          logToExtension(`📦 Created Before steps container: ${beforeId}`, 'INFO');
          logToExtension(`⏸️  Before container created but NOT started yet (will start when first Background step detected)`, 'INFO');
        }
        
        // Collect all step children into an array
        const stepChildren: vscode.TestItem[] = [];
        testItem.children.forEach(child => {
          if (child.id.includes(':step:')) {
            stepChildren.push(child);
          }
        });

        // Sort by line number (extracted from step ID: "...:step:lineNumber")
        stepChildren.sort((a, b) => {
          const lineA = parseInt(a.id.split(':step:')[1]) || 0;
          const lineB = parseInt(b.id.split(':step:')[1]) || 0;
          return lineA - lineB;
        });

        logToExtension(`📋 Pre-registering ${stepChildren.length} steps in Test Explorer (in order):`, 'INFO');
        
        // Add to map in sorted order AND mark all as started immediately
        // This makes all steps visible in Test Result panel from the beginning
        // IMPORTANT: Use step ID as map key (not stepText) to handle duplicate step texts
        for (let i = 0; i < stepChildren.length; i++) {
          const child = stepChildren[i];
          const stepText = child.label;
          const lineNum = child.id.split(':step:')[1];
          const stepId = child.id; // Use unique ID as key
          
          // Add to map using step ID as key (handles duplicate step texts)
          stepItemsMap.set(stepId, child);
          
          // Mark step as started immediately to show in Test Result
          run.started(child);
          
          logToExtension(`  [${i + 1}/${stepChildren.length}] ▶️  Started: "${stepText}" (line ${lineNum}, id: ${child.id})`, 'INFO');
        }
        
        logToExtension(`✅ All ${stepItemsMap.size} steps initialized and visible in Test Result panel`, 'INFO');
        logToExtension(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'INFO');
      }

      // Callback for real-time step status updates
      // Each step goes through lifecycle: started() → passed()/failed()/skipped()
      // This callback is invoked by CucumberOutputParser when it detects step completion
      const onStepUpdate = (stepResult: StepResult) => {
        const stepText = `${stepResult.keyword} ${stepResult.name}`;
        let stepItem: vscode.TestItem | undefined = undefined;

        logToExtension(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'INFO');
        logToExtension(`onStepUpdate called:`, 'INFO');
        logToExtension(`  stepText from Maven: "${stepText}"`, 'INFO');
        logToExtension(`  status: ${stepResult.status}`, 'INFO');
        logToExtension(`  stepItemsMap size: ${stepItemsMap.size}`, 'INFO');

        // NEW APPROACH: Since Map now uses step ID (not text) as key,
        // we need to find the step by matching the label text
        // For duplicate step texts (e.g., same step in different lines),
        // we need to match them sequentially based on execution order
        
        // Try to find step by exact label match
        // For duplicate steps, we use the first unprocessed one (not yet marked passed/failed/skipped)
        let foundSteps: Array<{id: string, item: vscode.TestItem}> = [];
        
        for (const [stepId, item] of stepItemsMap.entries()) {
          // Check if label matches (exact match or fuzzy match)
          const itemLabel = item.label;
          
          // Try exact match first
          if (itemLabel === stepText) {
            foundSteps.push({id: stepId, item});
            continue;
          }
          
          // Try fuzzy match (remove tags like [MKT05A06])
          const cleanedItemLabel = itemLabel.replace(/\[[\w\d]+\]\s*/g, '').trim();
          const cleanedStepText = stepText.replace(/\[[\w\d]+\]\s*/g, '').trim();
          
          if (cleanedItemLabel === cleanedStepText) {
            foundSteps.push({id: stepId, item});
          }
        }
        
        if (foundSteps.length > 0) {
          // For duplicate steps, use the first unprocessed one
          let selectedStep = foundSteps[0];
          
          // If multiple matches, try to find the first unprocessed one
          if (foundSteps.length > 1) {
            logToExtension(`🔍 Multiple steps with same label detected (${foundSteps.length} matches)`, 'WARN');
            logToExtension(`  Looking for first unprocessed step...`, 'DEBUG');
            
            for (const fs of foundSteps) {
              const isProcessed = processedSteps.has(fs.id);
              const lineNum = fs.id.split(':step:')[1];
              logToExtension(`    [Check] Line ${lineNum}: ${isProcessed ? '✓ already processed' : '⭘ not yet processed'}`, 'DEBUG');
              
              if (!isProcessed) {
                selectedStep = fs;
                logToExtension(`    ✅ Selected unprocessed step at line ${lineNum}`, 'INFO');
                break;
              }
            }
            
            // If all steps are already processed, something is wrong
            if (processedSteps.has(selectedStep.id)) {
              logToExtension(`    ⚠️ WARNING: All matching steps already processed! This should not happen.`, 'ERROR');
              logToExtension(`    ⚠️ Received duplicate step result from Maven output:`, 'ERROR');
              logToExtension(`       Step text: "${stepText}"`, 'ERROR');
              logToExtension(`       Status: ${stepResult.status}`, 'ERROR');
              logToExtension(`    ⚠️ This step result will be ignored to avoid overwriting.`, 'ERROR');
              return; // Ignore this duplicate result
            }
          }
          
          stepItem = selectedStep.item;
          logToExtension(`✅ Found step match: "${stepItem.label}"`, 'INFO');
          logToExtension(`  Step ID: ${stepItem.id}`, 'INFO');
          logToExtension(`  Total matches found: ${foundSteps.length}`, foundSteps.length > 1 ? 'WARN' : 'DEBUG');
          
          if (foundSteps.length > 1) {
            logToExtension(`  ℹ️  All steps with same text:`, 'INFO');
            foundSteps.forEach((s, idx) => {
              const processed = processedSteps.has(s.id) ? '✓ processed' : '⭘ pending';
              const lineNum = s.id.split(':step:')[1];
              const isCurrent = s.id === selectedStep.item.id ? ' ← CURRENT' : '';
              logToExtension(`    [${idx}] Line ${lineNum}: ${s.item.label} (${processed})${isCurrent}`, 'INFO');
            });
          }
        } else {
          logToExtension(`❌ No matching step found in stepItemsMap`, 'WARN');
          logToExtension(`  Available steps (${stepItemsMap.size}):`, 'DEBUG');
          let count = 0;
          for (const [stepId, item] of stepItemsMap.entries()) {
            const lineNum = stepId.split(':step:')[1];
            logToExtension(`  [${count++}] Line ${lineNum}: "${item.label}"`, 'DEBUG');
          }
          
          // This is likely a Background or Before hook step
          // Create a dynamic step item in the Before container
          if (beforeStepsContainer) {
            logToExtension(`🔧 Detected Background/Before hook step: "${stepText}"`, 'INFO');
            logToExtension(`  Execution order: #${backgroundStepsOrder.length + 1}`, 'DEBUG');
            
            // CRITICAL FIX v26.1: Start Before container on FIRST Background step detection
            // This ensures correct display order in Test Result panel
            if (backgroundStepsOrder.length === 0) {
              run.started(beforeStepsContainer);
              logToExtension(`▶️  Started Before container NOW (first Background step detected)`, 'INFO');
            }
            
            // Check if we already created this background step
            const backgroundStepKey = `${stepText}_${stepResult.status}`;
            let backgroundStep = backgroundStepsMap.get(stepText);
            
            if (!backgroundStep) {
              // Create new background step item with execution order in ID
              const executionOrder = backgroundStepsOrder.length;
              const backgroundStepId = `${beforeStepsContainer.id}:bg_step:${executionOrder}`;
              backgroundStep = this.controller.createTestItem(
                backgroundStepId,
                stepText,
                uri
              );
              
              // CRITICAL FIX v26.1: Set sortText to ensure display order matches execution order
              // VSCode Test Explorer sorts by sortText (or label if not set)
              // Use zero-padded execution order to ensure correct sorting: "000", "001", "002", etc.
              backgroundStep.sortText = executionOrder.toString().padStart(3, '0');
              
              // Add to Before container
              beforeStepsContainer.children.add(backgroundStep);
              backgroundStepsMap.set(stepText, backgroundStep);
              backgroundStepsOrder.push(backgroundStep); // Track execution order
              
              // Mark as started immediately after Before container
              run.started(backgroundStep);
              
              logToExtension(`  ✨ Created new Background step: ${backgroundStepId}`, 'INFO');
              logToExtension(`  📍 Added to Before container (position: ${executionOrder}, total: ${backgroundStepsMap.size})`, 'INFO');
              logToExtension(`  📊 Execution order array size: ${backgroundStepsOrder.length}`, 'DEBUG');
              logToExtension(`  🌳 Test Result tree structure:`, 'DEBUG');
              logToExtension(`     └─ ${testItem.label}`, 'DEBUG');
              logToExtension(`        ├─ ⚙️ Before (${backgroundStepsOrder.length} step${backgroundStepsOrder.length > 1 ? 's' : ''})`, 'DEBUG');
              backgroundStepsOrder.forEach((bs, idx) => {
                const marker = idx === backgroundStepsOrder.length - 1 ? '└─' : '├─';
                logToExtension(`        │  ${marker} [${idx}] ${bs.label}`, 'DEBUG');
              });
              // Show scenario steps after Before container
              const scenarioSteps: string[] = [];
              testItem.children.forEach(child => {
                if (child.id.includes(':step:')) {
                  scenarioSteps.push(child.label);
                }
              });
              if (scenarioSteps.length > 0) {
                scenarioSteps.forEach((stepLabel, idx) => {
                  const marker = idx === scenarioSteps.length - 1 ? '└─' : '├─';
                  logToExtension(`        ${marker} ${stepLabel}`, 'DEBUG');
                });
              }
            } else {
              logToExtension(`  ⚠️  Background step already exists: ${backgroundStep.id}`, 'WARN');
              logToExtension(`  Current execution order position: ${backgroundStepsOrder.findIndex(s => s.id === backgroundStep!.id)}`, 'DEBUG');
            }
            
            // Use this background step as the stepItem to update
            stepItem = backgroundStep;
          }
        }

        if (stepItem) {
          logToExtension(`Updating step status: ${stepText} - ${stepResult.status}`, 'INFO');
          logToExtension(`  Step ID: ${stepItem.id}`, 'DEBUG');
          logToExtension(`  Step label: ${stepItem.label}`, 'DEBUG');

          // NOTE: run.started() was already called during pre-registration above
          // We only need to update the terminal state (passed/failed/skipped)
          // TestRun lifecycle: started() [DONE] → passed()/failed()/skipped() [NOW]
          
          // Mark this step as processed
          processedSteps.add(stepItem.id);
          
          // Transition to terminal state based on step result
          switch (stepResult.status) {
            case 'passed':
              run.passed(stepItem);
              logToExtension(`✅ Step PASSED: ${stepText}`, 'INFO');
              logToExtension(`  TestRun.passed() called for: ${stepItem.id}`, 'DEBUG');
              break;
            case 'failed': {
              hasFailedStep = true; // Mark that we have a failed step
              const errorMsg = stepResult.errorMessage || 'Step failed';
              run.failed(stepItem, new vscode.TestMessage(errorMsg));
              logToExtension(`❌ Step FAILED: ${stepText}`, 'ERROR');
              logToExtension(`  Error message: ${errorMsg}`, 'ERROR');
              logToExtension(`  TestRun.failed() called for: ${stepItem.id}`, 'DEBUG');

              // Immediately mark the scenario as failed if it's a scenario test
              if (testItem.id.includes(':scenario:')) {
                logToExtension(`Marking scenario as FAILED due to step failure: ${stepText}`, 'ERROR');
                run.failed(testItem, new vscode.TestMessage(`Step failed: ${stepText}\n${errorMsg}`));
                logToExtension(`  TestRun.failed() called for scenario: ${testItem.id}`, 'DEBUG');
              }
              break;
            }
            case 'skipped':
              run.skipped(stepItem);
              logToExtension(`⊝ Step SKIPPED: ${stepText}`, 'WARN');
              logToExtension(`  TestRun.skipped() called for: ${stepItem.id}`, 'DEBUG');
              break;
          }
        } else {
          logToExtension(`⚠️ Step not found in Test Explorer: ${stepText}`, 'WARN');
          logToExtension(`  This step is likely from Background or Before hooks`, 'INFO');
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
        
        let exitCode: number;
        if (isDebug) {
          // Debug mode execution
          exitCode = await runSelectedTestInDebugMode(
            uri,
            testItem,
            run,
            scenarioLine,
            exampleLine,
            onStepUpdate
          );
        } else {
          // Normal mode execution
          exitCode = await runSelectedTestAndWait(
            uri,
            scenarioLine,
            exampleLine,
            (data) => run.appendOutput(data, undefined, testItem),
            onStepUpdate
          );
        }
        // Mark example as passed if no steps failed, regardless of exit code
        if (!hasFailedStep) {
          run.passed(testItem);
          logToExtension(`Example PASSED (no failed steps, exit code ${exitCode})`, 'INFO');
        }
        // If hasFailedStep is true, we already marked it as failed in onStepUpdate
      } else if (testItem.id.includes(':scenario:')) {
        // This is a scenario
        const parts = testItem.id.split(':scenario:');
        const lineNumber = parseInt(parts[1].split(':')[0]); // Get first part before any additional colons
        logToExtension(`Running scenario at line ${lineNumber}`, 'INFO');
        
        let exitCode: number;
        if (isDebug) {
          logToExtension('🐛 Branch: DEBUG mode', 'INFO');
          // Debug mode execution
          exitCode = await runSelectedTestInDebugMode(
            uri,
            testItem,
            run,
            lineNumber,
            undefined,
            onStepUpdate
          );
        } else {
          logToExtension('▶️  Branch: RUN mode - calling runSelectedTestAndWait', 'INFO');
          // Normal mode execution
          exitCode = await runSelectedTestAndWait(
            uri,
            lineNumber,
            undefined,
            (data) => run.appendOutput(data, undefined, testItem),
            onStepUpdate
          );
          logToExtension(`▶️  runSelectedTestAndWait returned with exit code: ${exitCode}`, 'INFO');
        }

        // Mark scenario as passed if no steps failed, regardless of exit code
        // (exit code may be non-zero due to other tests failing in multi-module projects)
        // TestRun lifecycle: We determine final state based on step failures, not exit code
        // Scenario was already marked as started at the beginning of runSingleTest()
        if (!hasFailedStep) {
          run.passed(testItem);
          logToExtension(`Scenario PASSED (no failed steps, exit code ${exitCode})`, 'INFO');
        }
        // If hasFailedStep is true, we already marked it as failed in onStepUpdate
      } else {
        // This is a feature file
        logToExtension(`Running entire feature file`, 'INFO');
        
        let exitCode: number;
        if (isDebug) {
          // Debug mode execution
          exitCode = await runSelectedTestInDebugMode(
            uri,
            testItem,
            run,
            undefined,
            undefined,
            onStepUpdate
          );
        } else {
          // Normal mode execution
          exitCode = await runSelectedTestAndWait(
            uri,
            undefined,
            undefined,
            (data) => run.appendOutput(data, undefined, testItem),
            onStepUpdate
          );
        }

        // Mark feature as passed if no steps failed, regardless of exit code
        // (exit code may be non-zero due to other tests failing in multi-module projects)
        // TestRun lifecycle: Feature state determined by child step failures
        if (!hasFailedStep) {
          run.passed(testItem);
          logToExtension(`Feature PASSED (no failed steps, exit code ${exitCode})`, 'INFO');
        }
        // If hasFailedStep is true, we already marked it as failed in onStepUpdate
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
  if (!extensionLogChannel) {return;}

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
  const runFeatureCommand = vscode.commands.registerCommand('cucumberJavaEasyRunner.runFeature', async (uri: vscode.Uri) => {
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
  const runFeatureCodeLensCommand = vscode.commands.registerCommand('cucumberJavaEasyRunner.runFeatureCodeLens', async (uri: vscode.Uri) => {
    console.log('runFeatureCodeLensCommand called with URI:', uri.toString());
    vscode.window.showInformationMessage('Feature test starting...');
    runSelectedTest(uri);
  });

  // CodeLens command to run a single scenario
  const runScenarioCodeLensCommand = vscode.commands.registerCommand('cucumberJavaEasyRunner.runScenarioCodeLens', async (uri: vscode.Uri, lineNumber: number) => {
    console.log('runScenarioCodeLensCommand called with URI:', uri.toString(), 'line:', lineNumber);
    vscode.window.showInformationMessage(`Scenario test starting at line ${lineNumber}...`);
    runSelectedTest(uri, lineNumber);
  });

  // CodeLens command to run a single example
  const runExampleCodeLensCommand = vscode.commands.registerCommand('cucumberJavaEasyRunner.runExampleCodeLens', async (uri: vscode.Uri, scenarioLine: number, exampleLine: number) => {
    console.log('runExampleCodeLensCommand called with URI:', uri.toString(), 'scenario line:', scenarioLine, 'example line:', exampleLine);
    vscode.window.showInformationMessage(`Example test starting at line ${exampleLine}...`);
    runSelectedTest(uri, scenarioLine, exampleLine);
  });

  // Command to run a single scenario
  const runScenarioCommand = vscode.commands.registerCommand('cucumberJavaEasyRunner.runScenario', async () => {
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
  const runExampleCommand = vscode.commands.registerCommand('cucumberJavaEasyRunner.runExample', async () => {
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
  const toggleExecutionModeCommand = vscode.commands.registerCommand('cucumberJavaEasyRunner.toggleExecutionMode', async () => {
    const config = vscode.workspace.getConfiguration('cucumberJavaEasyRunner');
    const currentMode = config.get<string>('executionMode', 'java');
    const newMode = currentMode === 'java' ? 'maven' : 'java';

    await config.update('executionMode', newMode, vscode.ConfigurationTarget.Workspace);
    updateExecutionModeStatusBar();

    vscode.window.showInformationMessage(`Execution mode switched to: ${newMode.toUpperCase()}`);
  });

  // Command to clear test class cache
  const clearTestClassCacheCommand = vscode.commands.registerCommand('cucumberJavaEasyRunner.clearTestClassCache', async () => {
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
  logToExtension('🔵 ======== runSelectedTestAndWait CALLED ========', 'INFO');
  logToExtension(`📄 URI: ${uri.fsPath}`, 'INFO');
  logToExtension(`📍 Line: ${lineNumber}, Example: ${exampleLine}`, 'INFO');
  
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('Feature file is not inside a workspace.');
    return 1;
  }

  const workspaceRoot = workspaceFolder.uri.fsPath;

  // Get configuration
  const config = vscode.workspace.getConfiguration('cucumberJavaEasyRunner');
  const executionMode = config.get<string>('executionMode', 'maven');
  const configuredTestClass = config.get<string>('testClassName', '');
  
  logToExtension(`⚙️  Execution mode: ${executionMode}`, 'INFO');
  logToExtension(`🧪 Configured test class: ${configuredTestClass || '(auto-detect)'}`, 'INFO');

  // Find the Maven module for this feature file
  const moduleInfo = findMavenModule(uri.fsPath, workspaceRoot);

  const relativePath = path.relative(workspaceRoot, uri.fsPath);

  try {
    if (executionMode === 'maven') {
      logToExtension('🔶 Branch: Maven execution mode', 'INFO');
      // Maven execution mode
      let testClassName: string = configuredTestClass;

      // Auto-detect test class if not configured
      if (!testClassName) {
        logToExtension('🔍 Auto-detecting test class...', 'INFO');
        const autoDetectedClass = await findCucumberTestClass(moduleInfo.modulePath);

        if (!autoDetectedClass) {
          logToExtension('❌ Auto-detection failed, prompting user...', 'WARN');
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
          logToExtension(`✅ Auto-detected test class: ${autoDetectedClass}`, 'INFO');
          testClassName = autoDetectedClass;
        }
      } else {
        logToExtension(`✅ Using configured test class: ${testClassName}`, 'INFO');
      }

      // ⭐ Use the same unified execution function as Debug mode, but without debugger
      logToExtension(`🚀 Calling unified Maven execution (RUN mode, no debugger)...`, 'INFO');
      return await runCucumberTestWithMavenUnified(
        workspaceRoot,
        workspaceFolder,
        moduleInfo,
        relativePath,
        testClassName,
        false, // isDebug = false for Run mode
        lineNumber,
        exampleLine,
        undefined, // projectName
        onOutput,
        onStepUpdate
      );
    } else {
      logToExtension('🔶 Branch: Java execution mode', 'INFO');
      // Java execution mode (original behavior)
      logToExtension('🔍 Finding glue path...', 'INFO');
      const gluePath = await findGluePath(moduleInfo.modulePath);

      if (!gluePath) {
        logToExtension('❌ Glue path not found, prompting user...', 'WARN');
        const userInput = await vscode.window.showInputBox({
          prompt: 'Enter glue path for steps directory (e.g. org.example.steps)',
          placeHolder: 'org.example.steps'
        });
        if (!userInput) {
          logToExtension('❌ User cancelled glue path input', 'ERROR');
          vscode.window.showErrorMessage('Glue path not specified, operation cancelled.');
          return 1;
        }
        logToExtension(`📝 User provided glue path: ${userInput}`, 'INFO');
        logToExtension('🚀 Calling runCucumberTestWithResult (with user input)...', 'INFO');
        return await runCucumberTestWithResult(moduleInfo.modulePath, relativePath, userInput, lineNumber, exampleLine, onOutput);
      } else {
        logToExtension(`✅ Found glue path: ${gluePath}`, 'INFO');
        logToExtension('🚀 Calling runCucumberTestWithResult (auto-detected)...', 'INFO');
        return await runCucumberTestWithResult(moduleInfo.modulePath, relativePath, gluePath, lineNumber, exampleLine, onOutput);
      }
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(`Error: ${error.message || 'Unknown error'}`);
    return 1;
  }
}

/**
 * Runs the selected test in DEBUG mode with debugger attachment
 */
async function runSelectedTestInDebugMode(
  uri: vscode.Uri,
  testItem: vscode.TestItem,
  run: vscode.TestRun,
  lineNumber?: number,
  exampleLine?: number,
  onStepUpdate?: (step: StepResult) => void
): Promise<number> {
  // ⭐ v25: Use Maven Surefire Debug Mode
  // Maven handles all classpath, dependencies, and Spring configuration correctly
  logToExtension('=== v25 DEBUG MODE: Maven Surefire Debug ===', 'INFO');
  
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('Feature file is not inside a workspace.');
    return 1;
  }

  const workspaceRoot = workspaceFolder.uri.fsPath;
  const config = vscode.workspace.getConfiguration('cucumberJavaEasyRunner');

  // 1. Check breakpoints
  const allBreakpoints = vscode.debug.breakpoints;
  logToExtension(`Total breakpoints in workspace: ${allBreakpoints.length}`, 'INFO');
  
  if (allBreakpoints.length > 0) {
    logToExtension('Breakpoints details:', 'DEBUG');
    allBreakpoints.forEach((bp, index) => {
      if (bp instanceof vscode.SourceBreakpoint) {
        logToExtension(`  [${index}] ${bp.location.uri.fsPath}:${bp.location.range.start.line + 1} - Enabled: ${bp.enabled}`, 'DEBUG');
      }
    });
  } else {
    logToExtension('⚠️ WARNING: No breakpoints detected in workspace!', 'WARN');
    vscode.window.showWarningMessage('No breakpoints set. Set breakpoints in your step definitions before debugging.');
  }

  try {
    // 2. Find Maven module and test class
    const moduleInfo = findMavenModule(uri.fsPath, workspaceRoot);
    const relativePath = path.relative(workspaceRoot, uri.fsPath);

    const configuredTestClass = config.get<string>('testClassName', '');
    let testClassName: string = configuredTestClass;

    if (!testClassName) {
      // ⭐ v25: Try smart detection from feature file first
      const smartDetected = await findCucumberTestClassFromFeature(moduleInfo.modulePath, uri.fsPath);
      
      if (smartDetected) {
        testClassName = smartDetected;
        logToExtension(`⭐ v25: Smart detection selected test class: ${testClassName}`, 'INFO');
      } else {
        // Fallback to old method
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
    }

    // 3. Extract Maven artifactId as project name
    let projectName: string | undefined;
    const pomPath = path.join(moduleInfo.modulePath, 'pom.xml');
    if (fs.existsSync(pomPath)) {
      const artifactId = await extractMavenArtifactId(pomPath);
      if (artifactId) {
        projectName = artifactId;
        logToExtension(`Maven artifactId: ${projectName}`, 'DEBUG');
      }
    }

    if (!projectName) {
      projectName = path.basename(moduleInfo.modulePath);
    }

    // 5. ⭐ v26: Execute using UNIFIED function (DEBUG mode = isDebug:true)
    logToExtension('⭐ v26: Executing test using UNIFIED function with DEBUG mode...', 'INFO');
    
    const exitCode = await runCucumberTestWithMavenUnified(
      workspaceRoot,
      workspaceFolder,
      moduleInfo,
      path.relative(workspaceRoot, uri.fsPath), // relativePath
      testClassName,
      true, // ⭐ isDebug = true for DEBUG mode
      lineNumber,
      exampleLine,
      projectName,
      (data: any) => run.appendOutput(data, undefined, testItem),
      onStepUpdate
    );

    logToExtension(`v26 UNIFIED (DEBUG) completed with exit code: ${exitCode}`, 'INFO');
    return exitCode;

  } catch (error: any) {
    logToExtension(`v25 Debug mode error: ${error.message}`, 'ERROR');
    
    const shouldContinue = await handleDebugError(error);
    if (shouldContinue) {
      logToExtension('Falling back to normal run mode', 'WARN');
      return await runSelectedTestAndWait(
        uri,
        lineNumber,
        exampleLine,
        (data) => run.appendOutput(data, undefined, testItem),
        onStepUpdate
      );
    }

    return 1;
  }
}

/**
 * v16-v22: OLD Attach Mode implementation (DEPRECATED)
 * Kept for reference, but no longer used
 * 
 * @deprecated Use runSelectedTestInDebugMode (v23) instead
 */
async function runSelectedTestInDebugModeAttachV22(
  uri: vscode.Uri,
  testItem: vscode.TestItem,
  run: vscode.TestRun,
  lineNumber?: number,
  exampleLine?: number,
  onStepUpdate?: (step: StepResult) => void
): Promise<number> {
  logToExtension('=== DEBUG MODE: Starting debug test execution ===', 'INFO');
  
  // 1. Check current breakpoints
  const allBreakpoints = vscode.debug.breakpoints;
  logToExtension(`Total breakpoints in workspace: ${allBreakpoints.length}`, 'INFO');
  
  if (allBreakpoints.length > 0) {
    logToExtension('Breakpoints details:', 'DEBUG');
    allBreakpoints.forEach((bp, index) => {
      if (bp instanceof vscode.SourceBreakpoint) {
        logToExtension(`  [${index}] ${bp.location.uri.fsPath}:${bp.location.range.start.line + 1} - Enabled: ${bp.enabled}`, 'DEBUG');
      }
    });
  } else {
    logToExtension('⚠️ WARNING: No breakpoints detected in workspace!', 'WARN');
    vscode.window.showWarningMessage('No breakpoints set. Set breakpoints in your step definitions before debugging.');
  }
  
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('Feature file is not inside a workspace.');
    return 1;
  }

  const workspaceRoot = workspaceFolder.uri.fsPath;

  // Get configuration
  const config = vscode.workspace.getConfiguration('cucumberJavaEasyRunner');
  const executionMode = config.get<string>('executionMode', 'java');

  // Currently only Maven mode supports debug
  if (executionMode !== 'maven') {
    const action = await vscode.window.showWarningMessage(
      'Debug mode currently only supports Maven execution mode. Switch to Maven mode?',
      'Switch to Maven',
      'Cancel'
    );

    if (action === 'Switch to Maven') {
      await config.update('executionMode', 'maven', vscode.ConfigurationTarget.Workspace);
      vscode.window.showInformationMessage('Switched to Maven mode. Please try debugging again.');
    }
    return 1;
  }

  let debugPort: number | undefined;
  let debugSession: vscode.DebugSession | undefined;

  try {
    // ⭐ v21: Always use attach mode (launch mode has mainClass issues with Cucumber)
    // Provide clear guidance about JaCoCo conflicts
    const debugConfig = vscode.workspace.getConfiguration('cucumberJavaEasyRunner.debug');
    const userRequestMode = debugConfig.get<string>('requestMode', 'attach');
    
    // v21: Force attach mode and warn about JaCoCo if needed
    const debugRequestMode = 'attach';
    
    if (userRequestMode === 'launch') {
      logToExtension(`⚠️ v21: launch mode not supported for Cucumber, using attach mode`, 'WARN');
    }
    
  logToExtension(`🎯 v22: Using debug request mode: ${debugRequestMode}`, 'INFO');
  logToExtension(`⚠️ v22: Using MAVEN_OPTS for JDWP (bypasses pom.xml argLine issues)`, 'WARN');
  logToExtension(`   MAVEN_OPTS is inherited by Surefire fork, works regardless of pom.xml config`, 'INFO');    // 2. Find Maven module and test class (common for both modes)
    const moduleInfo = findMavenModule(uri.fsPath, workspaceRoot);
    const relativePath = path.relative(workspaceRoot, uri.fsPath);

    const configuredTestClass = config.get<string>('testClassName', '');
    let testClassName: string = configuredTestClass;

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
    
    // ⭐ v24: Removed hardcoded sourcePaths logic
    // Source paths will be auto-detected by v24 mechanism when needed
    // (Currently only used in Launch Mode, not in Attach Mode below)
    
    // Extract Maven artifactId as project name for accurate debugging (common for both modes)
    let projectName: string | undefined;
    const pomPath = path.join(moduleInfo.modulePath, 'pom.xml');
    if (fs.existsSync(pomPath)) {
      const artifactId = await extractMavenArtifactId(pomPath);
      if (artifactId) {
        projectName = artifactId;
        logToExtension(`Extracted Maven artifactId as projectName: ${projectName}`, 'DEBUG');
      } else {
        logToExtension(`Failed to extract artifactId from ${pomPath}, will use fallback`, 'WARN');
      }
    } else {
      logToExtension(`pom.xml not found at ${pomPath}, using fallback projectName`, 'DEBUG');
    }
    
    // Fallback to module folder name if extraction fails
    if (!projectName) {
      projectName = path.basename(moduleInfo.modulePath);
      logToExtension(`Using module folder name as projectName: ${projectName}`, 'DEBUG');
    }
    
    // ⭐ v21: Only attach mode supported (launch mode has Cucumber mainClass issues)
    // Direct to attach mode implementation
    {
      // ═══════════════════════════════════════════════════════════════════════
      // ⭐ v12: ATTACH MODE - Spawn Maven then attach debugger
      // ═══════════════════════════════════════════════════════════════════════
      
      // 1. Allocate debug port
      debugPort = await DebugPortManager.allocatePort(testItem.id);
      logToExtension(`Allocated debug port: ${debugPort} for test: ${testItem.label}`, 'INFO');
      
      // Verify port is available
      const net = require('net');
      const portAvailable = await new Promise<boolean>((resolve) => {
        const tester = net.createServer();
        tester.once('error', () => resolve(false));
        tester.once('listening', () => {
          tester.close();
          resolve(true);
        });
        tester.listen(debugPort, '127.0.0.1');
      });
      logToExtension(`Port ${debugPort} is ${portAvailable ? 'AVAILABLE ✓' : 'IN USE ✗'}`, portAvailable ? 'INFO' : 'ERROR');
      
      // 2. Start Maven with JDWP debug parameters
      logToExtension(`Starting Maven in debug mode on port ${debugPort}`, 'INFO');

      const mavenProcess = await runCucumberTestWithMavenDebug(
        workspaceRoot,
        moduleInfo,
        relativePath,
        testClassName,
        debugPort,
        lineNumber,
        exampleLine,
        (data: string) => run.appendOutput(data, undefined, testItem),
        onStepUpdate
      );

      // ⭐ v19: Wait for Surefire to start test JVM (not Maven main JVM)
      // In v19, MAVEN_OPTS doesn't have JDWP, only -DargLine does
      // So we need to wait for Surefire's forked JVM to output "Listening for transport"
      await waitForDebugServerWithProgress(mavenProcess, debugPort, testItem.label);

      // 4. Attach debugger
      logToExtension('Attaching debugger...', 'INFO');
      logToExtension('⭐ v12: Actively resolving classpath via Java Language Server...', 'INFO');
      
      let classPaths: string[] | undefined;
      try {
        // 需要取得 test class 的 fully qualified name
        // 從 testClassName (e.g., "TagClassAdminCrudTest") 找出完整的 class name
        const testClassFqn = await findTestClassFqn(moduleInfo.modulePath, testClassName);
        
        if (testClassFqn) {
          logToExtension(`Resolving classpath for mainClass: ${testClassFqn}, projectName: ${projectName}`, 'DEBUG');
          
          // 呼叫 Java Extension 的 resolveClasspath command
          const result = await vscode.commands.executeCommand<[string[], string[]]>(
            'vscode.java.resolveClasspath',
            testClassFqn,
            projectName
          );
          
          if (result && result[1]) {
            classPaths = result[1];
            logToExtension(`✓ Resolved ${classPaths.length} classpaths from Java Language Server`, 'INFO');
            logToExtension(`First 3 classpaths: ${classPaths.slice(0, 3).join(', ')}`, 'DEBUG');
          } else {
            logToExtension('⚠️ resolveClasspath returned no classpaths, will use undefined', 'WARN');
          }
        } else {
          logToExtension(`⚠️ Could not find fully qualified name for ${testClassName}, using undefined classPaths`, 'WARN');
        }
      } catch (error: any) {
        logToExtension(`⚠️ Error resolving classpath: ${error.message}, will use undefined`, 'WARN');
      }
      
      debugSession = await startDebugSession(
        workspaceFolder,
        debugPort,
        testItem.label,
        run,
        undefined, // ⭐ v24: Let debug-integration handle sourcePaths
        projectName,
        classPaths,  // ⭐ v12: 傳入主動解析的 classPaths!
        (message: string, level?: string) => {
          const validLevel = (level === 'DEBUG' || level === 'INFO' || level === 'WARN' || level === 'ERROR') ? level : 'INFO';
          logToExtension(message, validLevel);
        }
      );

      if (debugSession) {
        logToExtension(`✓ Debug session started: ${debugSession.id}`, 'INFO');
        logToExtension(`  Session name: ${debugSession.name}`, 'DEBUG');
        logToExtension(`  Session type: ${debugSession.type}`, 'DEBUG');
        logToExtension(`  Port: ${debugPort}`, 'DEBUG');
        
        // ⭐ v16: Wait for breakpoints to bind before continuing
        logToExtension(`⭐ v16: Waiting for breakpoints to bind...`, 'INFO');
        await new Promise(resolve => setTimeout(resolve, 2000));  // Give debugger time to bind breakpoints
        
        // Re-check breakpoints after session start
        const currentBps = vscode.debug.breakpoints;
        logToExtension(`Active breakpoints after debug session start: ${currentBps.length}`, 'INFO');
        
        // ⭐ v16: Log breakpoint binding status
        const sourceBps = currentBps.filter(bp => bp instanceof vscode.SourceBreakpoint) as vscode.SourceBreakpoint[];
        if (sourceBps.length > 0) {
          logToExtension(`⭐ v16: ${sourceBps.length} source breakpoints detected`, 'INFO');
          sourceBps.slice(0, 5).forEach((bp, index) => {
            const file = path.basename(bp.location.uri.fsPath);
            const line = bp.location.range.start.line + 1;
            logToExtension(`  [${index + 1}] ${file}:${line} - ${bp.enabled ? 'Enabled' : 'Disabled'}`, 'DEBUG');
          });
        } else {
          logToExtension(`⚠️ v16: No source breakpoints found! Debug may not stop.`, 'WARN');
        }
        
        logToExtension(`💡 Debug Session Tips:`, 'INFO');
        logToExtension(`  • Breakpoints must be in .java files (step definitions)`, 'INFO');
        logToExtension(`  • Source paths will be auto-detected by debugger`, 'INFO');
        logToExtension(`  • Test execution will now proceed with debugger attached`, 'INFO');
        
        // ⭐ v18: CRITICAL FIX - Resume JVM after breakpoint binding
        // Problem: suspend=y pauses JVM, but v16/v17 never sent continue command
        // Result: JVM hangs forever, test never executes
        try {
          logToExtension(`⭐ v18: Sending continue command to resume JVM...`, 'INFO');
          await debugSession.customRequest('continue');
          logToExtension(`✓ v18: JVM resumed successfully`, 'INFO');
        } catch (error: any) {
          logToExtension(`⚠️ v18: Failed to resume JVM: ${error.message}`, 'WARN');
          logToExtension(`  The debugger may not support 'continue' request`, 'WARN');
        }
        
        vscode.window.showInformationMessage(
          `Debugger attached to ${testItem.label} on port ${debugPort}`
        );
      } else {
        logToExtension('⚠️ WARNING: Debug session started but not active!', 'WARN');
      }

      // 6. Wait for process to complete
      const exitCode = await new Promise<number>((resolve) => {
        mavenProcess.on('close', (code: number | null) => {
          resolve(typeof code === 'number' ? code : 1);
        });
      });

      logToExtension(`Maven process exited with code: ${exitCode}`, 'INFO');
      return exitCode;
    }  // End of attach mode branch

  } catch (error: any) {
    logToExtension(`Debug mode error: ${error.message}`, 'ERROR');

    // Handle error and offer fallback
    const shouldContinue = await handleDebugError(error);

    if (shouldContinue) {
      // Fallback to normal run mode
      logToExtension('Falling back to normal run mode', 'WARN');
      return await runSelectedTestAndWait(
        uri,
        lineNumber,
        exampleLine,
        (data) => run.appendOutput(data, undefined, testItem),
        onStepUpdate
      );
    }

    return 1;

  } finally {
    // 7. Cleanup: release debug port
    if (debugPort) {
      DebugPortManager.releasePort(debugPort);
      logToExtension(`Released debug port: ${debugPort}`, 'INFO');
    }
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
      const name = currentLine.substring(currentLine.indexOf(':') + 1).trim();
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

/**
 * v23.3: Extract tags from Feature file
 * 
 * Parses Feature file and extracts all @tag annotations
 * Tags can appear at Feature level or Scenario level
 * 
 * Example Feature file:
 * ```
 * @mkt_segment_criteria_update_test
 * @integration
 * Feature: MKT05A06R01-MktSegment-Criteria 更新邏輯驗證
 * 
 *   @smoke
 *   Scenario: 01 - [創建新 segment]
 * ```
 * 
 * @param featureFilePath - Absolute path to .feature file
 * @returns Array of tag names (without @ prefix)
 */
async function extractTagsFromFeature(featureFilePath: string): Promise<string[]> {
  try {
    if (!fs.existsSync(featureFilePath)) {
      logToExtension(`[v23.3] Feature file not found: ${featureFilePath}`, 'WARN');
      return [];
    }

    // Check cache first
    const stats = fs.statSync(featureFilePath);
    const currentMtime = stats.mtimeMs;
    
    if (tagCache[featureFilePath] && tagCache[featureFilePath].mtime === currentMtime) {
      logToExtension(`[v23.3] Using cached tags for feature (${tagCache[featureFilePath].tags.length} tags)`, 'DEBUG');
      return tagCache[featureFilePath].tags;
    }

    const content = fs.readFileSync(featureFilePath, 'utf8');
    const lines = content.split('\n');
    const tags: string[] = [];

    // Extract tags from Feature level (before "Feature:" keyword)
    // Stop at first non-comment, non-tag, non-blank line
    for (const line of lines) {
      const trimmed = line.trim();
      
      // Skip comments and blank lines
      if (trimmed.startsWith('#') || trimmed === '') {
        continue;
      }
      
      // Stop when we hit Feature keyword
      if (trimmed.startsWith('Feature:')) {
        break;
      }
      
      // Extract tags (lines starting with @)
      if (trimmed.startsWith('@')) {
        // Split multiple tags on same line: @tag1 @tag2 @tag3
        const lineTags = trimmed.match(/@[\w_]+/g);
        if (lineTags) {
          lineTags.forEach(tag => {
            const tagName = tag.substring(1); // Remove @ prefix
            if (!tags.includes(tagName)) {
              tags.push(tagName);
            }
          });
        }
      }
    }

    // Update cache
    tagCache[featureFilePath] = {
      tags: tags,
      mtime: currentMtime
    };

    logToExtension(`[v23.3] Extracted ${tags.length} tags from feature: ${tags.join(', ')}`, 'DEBUG');
    return tags;

  } catch (error: any) {
    logToExtension(`[v23.3] Error extracting tags from feature: ${error.message}`, 'ERROR');
    return [];
  }
}

/**
 * v23.3: Extract tags from Test Class file
 * 
 * Parses Java test class and extracts tags from:
 * 1. @ConfigurationParameter (Cucumber 7+, highest priority)
 * 2. @CucumberOptions (Legacy support)
 * 
 * Pattern 1 - @ConfigurationParameter (v23.3 NEW):
 * ```java
 * @ConfigurationParameter(
 *     key = Constants.FILTER_TAGS_PROPERTY_NAME,
 *     value = "@mkt_segment_criteria_update_test")
 * 
 * @ConfigurationParameter(
 *     key = Constants.FILTER_TAGS_PROPERTY_NAME,
 *     value = "@tag1 or @tag2 or @tag3")
 * ```
 * 
 * Pattern 2 - @CucumberOptions (Legacy):
 * ```java
 * @CucumberOptions(tags = "@mkt_segment_criteria_update_test")
 * @CucumberOptions(tags = {"@tag1", "@tag2"})
 * ```
 * 
 * @param testClassPath - Absolute path to *Test.java file
 * @returns Array of tag names (without @ prefix)
 */
async function extractTagsFromTestClass(testClassPath: string): Promise<string[]> {
  try {
    if (!fs.existsSync(testClassPath)) {
      logToExtension(`[v23.3] Test class not found: ${testClassPath}`, 'DEBUG');
      return [];
    }

    // Check cache first
    const stats = fs.statSync(testClassPath);
    const currentMtime = stats.mtimeMs;
    
    if (tagCache[testClassPath] && tagCache[testClassPath].mtime === currentMtime) {
      return tagCache[testClassPath].tags;
    }

    const content = fs.readFileSync(testClassPath, 'utf8');
    const tags: string[] = [];

    // ⭐ Priority 1: @ConfigurationParameter (Cucumber 7+)
    // Pattern: @ConfigurationParameter(key = Constants.FILTER_TAGS_PROPERTY_NAME, value = "...")
    // Multi-line support with string concatenation:
    //   @ConfigurationParameter(
    //       key = Constants.FILTER_TAGS_PROPERTY_NAME,
    //       value = "@tag1 or @tag2"
    //               + " or @tag3")
    
    // Strategy: Find the entire annotation block, then extract all @tag patterns
    const configParamRegex = /@ConfigurationParameter\s*\(\s*key\s*=\s*Constants\.FILTER_TAGS_PROPERTY_NAME\s*,\s*value\s*=\s*([^)]+)\)/gs;
    let configMatch;
    
    while ((configMatch = configParamRegex.exec(content)) !== null) {
      const valueBlock = configMatch[1];
      
      // Extract all @tag patterns from the entire value block
      // This handles both simple strings and Java string concatenation (+ "...")
      const tagMatches = valueBlock.match(/@[\w_]+/g);
      
      if (tagMatches) {
        tagMatches.forEach(tag => {
          const tagName = tag.substring(1); // Remove @ prefix
          if (!tags.includes(tagName)) {
            tags.push(tagName);
          }
        });
      }
    }

    // ⭐ Priority 2: @CucumberOptions (Legacy support)
    // Only search if no tags found from @ConfigurationParameter
    if (tags.length === 0) {
      const cucumberOptionsMatch = content.match(/@CucumberOptions\s*\([^)]*tags\s*=\s*([^)]+)\)/s);
      
      if (cucumberOptionsMatch) {
        const tagsContent = cucumberOptionsMatch[1];
        
        // Extract all @tag patterns
        const tagMatches = tagsContent.match(/@[\w_]+/g);
        
        if (tagMatches) {
          tagMatches.forEach(tag => {
            const tagName = tag.substring(1); // Remove @ prefix
            if (!tags.includes(tagName)) {
              tags.push(tagName);
            }
          });
        }
      }
    }

    // Update cache
    tagCache[testClassPath] = {
      tags: tags,
      mtime: currentMtime
    };

    logToExtension(`[v23.3] Extracted ${tags.length} tags from test class ${path.basename(testClassPath)}: ${tags.join(', ')}`, 'DEBUG');
    return tags;

  } catch (error: any) {
    logToExtension(`[v23.3] Error extracting tags from test class: ${error.message}`, 'ERROR');
    return [];
  }
}

/**
 * v23.3.1: Extract glue package from Test Class file
 * 
 * Parses Java test class and extracts glue package from @ConfigurationParameter
 * 
 * Pattern:
 * ```java
 * @ConfigurationParameter(
 *     key = Constants.GLUE_PROPERTY_NAME,
 *     value = "tw.datahunter.spring.system")
 * ```
 * 
 * @param testClassPath - Absolute path to *Test.java file
 * @returns Glue package string or null if not found
 */
async function extractGluePackageFromTestClass(testClassPath: string): Promise<string | null> {
  try {
    if (!fs.existsSync(testClassPath)) {
      logToExtension(`[v23.3.1] Test class not found: ${testClassPath}`, 'DEBUG');
      return null;
    }

    const content = fs.readFileSync(testClassPath, 'utf8');

    // Pattern: @ConfigurationParameter(key = Constants.GLUE_PROPERTY_NAME, value = "package.name")
    // Match entire annotation block until closing )
    const glueParamRegex = /@ConfigurationParameter\s*\(\s*key\s*=\s*Constants\.GLUE_PROPERTY_NAME\s*,\s*value\s*=\s*"([^"]+)"/gs;
    const match = glueParamRegex.exec(content);
    
    if (match && match[1]) {
      const gluePackage = match[1].trim();
      logToExtension(`[v23.3.1] Extracted glue package from @ConfigurationParameter: ${gluePackage}`, 'DEBUG');
      return gluePackage;
    }

    logToExtension(`[v23.3.1] No glue package found in @ConfigurationParameter`, 'DEBUG');
    return null;

  } catch (error: any) {
    logToExtension(`[v23.3.1] Error extracting glue package: ${error.message}`, 'ERROR');
    return null;
  }
}

/**
 * v23.3: Match test class by tag comparison
 * 
 * Finds test class that has matching tags with the feature file
 * Uses tag intersection to find best match
 * 
 * Strategy:
 * 1. Extract tags from feature file
 * 2. Search all *Test.java files in test directory
 * 3. Extract tags from each test class (@ConfigurationParameter or @CucumberOptions)
 * 4. Find test class with maximum tag overlap
 * 
 * @param modulePath - Path to Maven module
 * @param featureFilePath - Path to feature file
 * @returns Test class name if found, null otherwise
 */
async function matchTestClassByTag(
  modulePath: string,
  featureFilePath: string
): Promise<string | null> {
  try {
    // Step 1: Extract tags from feature file
    const featureTags = await extractTagsFromFeature(featureFilePath);
    
    if (featureTags.length === 0) {
      logToExtension(`[v23.3] No tags found in feature file, skipping tag-based matching`, 'DEBUG');
      return null;
    }

    logToExtension(`[v23.3] Feature tags: [${featureTags.join(', ')}]`, 'INFO');

    // Step 2: Find all test classes
    const testDir = path.join(modulePath, 'src', 'test', 'java');
    if (!fs.existsSync(testDir)) {
      logToExtension(`[v23.3] Test directory not found: ${testDir}`, 'WARN');
      return null;
    }

    const pattern = path.join(testDir, '**', '*Test.java');
    const testFiles = glob.sync(pattern, { nodir: true });

    if (testFiles.length === 0) {
      logToExtension(`[v23.3] No test files found in ${testDir}`, 'WARN');
      return null;
    }

    logToExtension(`[v23.3] Searching ${testFiles.length} test files for tag match...`, 'DEBUG');

    // Step 3: Find best matching test class
    let bestMatch: { file: string; score: number } | null = null;

    for (const testFile of testFiles) {
      const testTags = await extractTagsFromTestClass(testFile);
      
      if (testTags.length === 0) {
        continue;
      }

      // Calculate intersection score
      const intersection = featureTags.filter(tag => testTags.includes(tag));
      const score = intersection.length;

      if (score > 0) {
        logToExtension(`[v23.3] Match found: ${path.basename(testFile)} - ${score} common tags: [${intersection.join(', ')}]`, 'DEBUG');
        
        if (!bestMatch || score > bestMatch.score) {
          bestMatch = { file: testFile, score };
        }
      }
    }

    // Step 4: Return best match
    if (bestMatch) {
      const className = path.basename(bestMatch.file, '.java');
      logToExtension(`[v23.3] ⭐ Tag-based match selected: ${className} (score: ${bestMatch.score})`, 'INFO');
      return className;
    }

    logToExtension(`[v23.3] No test class found with matching tags`, 'DEBUG');
    return null;

  } catch (error: any) {
    logToExtension(`[v23.3] Error in tag-based matching: ${error.message}`, 'ERROR');
    return null;
  }
}

/**
 * v23.3: Smart detection - infer test class from feature file
 * 
 * Three-layer strategy:
 * 1. Tag-based matching (v23.3 with @ConfigurationParameter) - Most accurate
 * 2. Folder code matching (v23.1) - Structural matching
 * 3. Filename similarity (v23.0) - Fallback
 * 
 * Example:
 * Feature: .../MKT05A06R01-mktSegment_CriteriaUpdate.feature
 *   @mkt_segment_criteria_update_test
 * → Test Class: .../MKT05A06/MktSegmentCriteriaUpdateTest.java
 *   @ConfigurationParameter(key = Constants.FILTER_TAGS_PROPERTY_NAME, 
 *                          value = "@mkt_segment_criteria_update_test")
 */
async function findCucumberTestClassFromFeature(
  modulePath: string,
  featureFilePath: string
): Promise<string | null> {
  logToExtension(`[v23.3] === Smart Test Class Detection ===`, 'DEBUG');
  logToExtension(`[v23.3] Feature: ${path.basename(featureFilePath)}`, 'DEBUG');

  // ⭐ Strategy 1: Tag-based matching (v23.3 - Highest priority)
  logToExtension(`[v23.3] Strategy 1: Tag-based matching...`, 'DEBUG');
  const tagMatch = await matchTestClassByTag(modulePath, featureFilePath);
  if (tagMatch) {
    logToExtension(`[v23.3] ✓ Tag-based match found: ${tagMatch}`, 'INFO');
    return tagMatch;
  }

  // Strategy 2: Folder code matching (v23.1 - Medium priority)
  logToExtension(`[v23.3] Strategy 2: Folder code matching...`, 'DEBUG');
  const featureFileName = path.basename(featureFilePath, '.feature');
  
  // Extract folder code pattern: MKT05A06R01-xxx → MKT05A06
  // Pattern: [LETTERS][DIGITS][LETTERS][DIGITS] stops before R[DIGITS]
  // MKT05A06R01 → MKT05A06 (stop before R01)
  // MKT01R01 → MKT01 (stop before R01)
  let folderCode = '';
  const folderMatch = featureFileName.match(/^([A-Z]+\d+[A-Z]*\d*)(?=R\d+|-|$)/);
  if (folderMatch) {
    folderCode = folderMatch[1];
  } else {
    // Fallback: try simple pattern (all uppercase and digits until dash or R)
    const simpleMatch = featureFileName.match(/^([A-Z0-9]+?)(?=R\d+|-)/);
    if (simpleMatch) {
      folderCode = simpleMatch[1];
    }
  }
  
  if (!folderCode) {
    logToExtension(`[v23.3] Cannot extract folder code from feature: ${featureFileName}`, 'WARN');
    return null;
  }
  
  logToExtension(`[v23.3] Extracted folder code: ${folderCode} from ${featureFileName}`, 'DEBUG');
  
  // Search for test class in corresponding folder
  const testDir = path.join(modulePath, 'src', 'test', 'java');
  const expectedFolder = path.join(testDir, '**', folderCode);
  
  // Find all test classes in this folder
  const pattern = path.join(testDir, '**', folderCode, '*Test.java');
  
  try {
    const files = glob.sync(pattern, { nodir: true });
    
    if (files.length === 0) {
      logToExtension(`[v23.3] No test class found in folder: ${folderCode}`, 'WARN');
      return null;
    }
    
    // Strategy 3: Filename similarity matching (v23.0 - Lowest priority)
    logToExtension(`[v23.3] Strategy 3: Filename similarity matching...`, 'DEBUG');
    const featureBaseName = featureFileName.replace(/^[A-Z0-9]+-/, ''); // Remove prefix
    const preferredFile = files.find((f: string) => {
      const fileName = path.basename(f, '.java');
      return fileName.toLowerCase().includes(featureBaseName.toLowerCase().replace(/-/g, ''));
    });
    
    const selectedFile = preferredFile || files[0];
    const className = path.basename(selectedFile, '.java');
    
    logToExtension(`[v23.3] ✓ Folder + filename match found: ${className}`, 'INFO');
    return className;
    
  } catch (error: any) {
    logToExtension(`[v23.3] Error finding test class: ${error.message}`, 'ERROR');
    return null;
  }
}

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
 * Finds the fully qualified name (FQN) of a test class
 * @param modulePath - Path to the Maven module
 * @param testClassName - Simple class name (e.g., "TagClassAdminCrudTest")
 * @returns Fully qualified class name (e.g., "tw.datahunter.uc_api.bdd.TagClassAdminCrudTest") or null
 */
async function findTestClassFqn(modulePath: string, testClassName: string): Promise<string | null> {
  const testDir = path.join(modulePath, 'src', 'test', 'java');

  if (!fs.existsSync(testDir)) {
    logToExtension(`Test directory not found: ${testDir}`, 'WARN');
    return null;
  }

  // Recursively search for the test class file
  const testClassPath = await findTestClassPath(testDir, testClassName);
  
  if (!testClassPath) {
    logToExtension(`Test class file not found for: ${testClassName}`, 'WARN');
    return null;
  }

  // Convert file path to package name
  // e.g., /path/to/src/test/java/tw/datahunter/uc_api/bdd/TagClassAdminCrudTest.java
  //    -> tw.datahunter.uc_api.bdd.TagClassAdminCrudTest
  const relativePath = path.relative(testDir, testClassPath);
  const fqn = relativePath
    .replace(/\\/g, '/')           // Normalize path separators
    .replace(/\.java$/, '')        // Remove .java extension
    .replace(/\//g, '.');          // Convert path to package notation
  
  logToExtension(`Found FQN for ${testClassName}: ${fqn}`, 'DEBUG');
  return fqn;
}

/**
 * Recursively searches for a test class file by simple name
 */
async function findTestClassPath(dir: string, className: string): Promise<string | null> {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    
    if (entry.isDirectory()) {
      const result = await findTestClassPath(fullPath, className);
      if (result) {
        return result;
      }
    } else if (entry.name === `${className}.java`) {
      return fullPath;
    }
  }
  
  return null;
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
    if (mvnRes.stdout) {onOutput(mvnRes.stdout);}
    if (mvnRes.stderr) {onOutput(mvnRes.stderr);}
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
    if (javacRes.stdout) {onOutput(javacRes.stdout);}
    if (javacRes.stderr) {onOutput(javacRes.stderr);}
  }
  if (javacRes.code !== 0) {
    return javacRes.code;
  }

  // 3) Run tests and stream output
  const runCp = [fullClasspath, tmpDir].join(delimiter);
  const child = spawn('java', ['-cp', runCp, 'CucumberRunner'], { cwd: projectRoot });
  return await new Promise<number>((resolve) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      if (onOutput) {onOutput(chunk.toString());}
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (onOutput) {onOutput(chunk.toString());}
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
 * Runs the Cucumber test using Maven test command in DEBUG mode
 * Returns the child process so caller can wait for debug attach before completion
 */
async function runCucumberTestWithMavenDebug(
  workspaceRoot: string,
  moduleInfo: ModuleInfo,
  featurePath: string,
  testClassName: string,
  debugPort: number,
  lineNumber?: number,
  exampleLineNumber?: number,
  onOutput?: (chunk: string) => void,
  onStepUpdate?: (step: StepResult) => void
): Promise<any> {
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

  // **KEY DIFFERENCE: Add debug parameters**
  const jdwpArgs = buildJdwpArgsForMaven(debugPort);
  const jdwpAgentArg = `-agentlib:jdwp=${jdwpArgs}`;
  
  // ⭐ v22: Disable JaCoCo (if present) but DON'T use -DargLine
  // Reason: -DargLine only works if pom.xml explicitly has ${argLine} placeholder
  //         Many projects configure Surefire without ${argLine}, breaking -DargLine
  // Solution: Use MAVEN_OPTS instead (set below in spawnEnv)
  mvnArgs.push('-Djacoco.skip=true');
  mvnArgs.push('-Dmaven.jacoco.skip=true');
  // ❌ v22: Removed -DargLine (doesn't work when pom.xml lacks ${argLine})
  
  // Add additional Maven arguments
  if (mavenArgs) {
    mvnArgs.push(...mavenArgs.split(' ').filter(arg => arg.length > 0));
  }
  
  logToExtension(`Maven DEBUG command: mvn ${mvnArgs.join(' ')}`, 'INFO');
  logToExtension(`JDWP will be passed via MAVEN_OPTS (inherited by Surefire fork)`, 'DEBUG');
  logToExtension(`Disabling JaCoCo plugin completely in debug mode`, 'DEBUG');

  // Create output parser with step status callback
  const parser = cucumberOutputChannel ? new CucumberOutputParser(cucumberOutputChannel, showStepResults, onStepUpdate) : null;

  // ⭐ v22: CRITICAL FIX - Use MAVEN_OPTS for Surefire inheritance
  // Problem in v21: -DargLine doesn't work when pom.xml has <configuration> without ${argLine}
  //                 Many projects configure Surefire but forget to add ${argLine} placeholder
  // Solution: Use MAVEN_OPTS - Surefire ALWAYS inherits parent JVM's MAVEN_OPTS
  //           This bypasses pom.xml argLine configuration entirely
  // Note: No port conflict because Maven main JVM doesn't fork during test phase
  const spawnEnv = { 
    ...process.env, 
    ...envVars,
    MAVEN_OPTS: jdwpAgentArg  // ✅ v22: Surefire fork will inherit this
  };

  // **IMPORTANT: No grep filtering in debug mode to see debug messages**
  const mvnCommand = `mvn ${mvnArgs.join(' ')}`;

	logToExtension(`Starting Maven in debug mode...`, 'INFO');
	logToExtension(`Working directory: ${workspaceRoot}`, 'DEBUG');
	logToExtension(`Full Maven command: ${mvnCommand}`, 'DEBUG');
	
	// Log all debug-related environment variables
	const envEntries = Object.entries(spawnEnv as Record<string, string>);
	envEntries.filter(([key]) => key.includes('JAVA') || key.includes('MAVEN')).forEach(([key, value]) => {
		logToExtension(`  ${key}=${value}`, 'DEBUG');
	});

	const child = spawn('sh', ['-c', mvnCommand], { cwd: workspaceRoot, env: spawnEnv });
	logToExtension(`Maven debug process started (PID: ${child.pid})`, 'INFO');
	logToExtension(`Waiting for JDWP server to start on port ${debugPort}...`, 'INFO');  // Set up output handling
  child.stdout?.on('data', (chunk: Buffer) => {
    const output = chunk.toString();

    // Parse output for step results
    if (parser) {
      const lines = output.split('\n');
      for (const line of lines) {
        parser.parseLine(line);
      }
    }

    // Forward to output channel
    if (onOutput) {
      onOutput(output);
    }

    // Also log to output channel
    if (cucumberOutputChannel) {
      cucumberOutputChannel.append(output);
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    const errorOutput = chunk.toString();
    logToExtension(`Maven stderr: ${errorOutput.substring(0, 200)}`, 'DEBUG');

    if (onOutput) {
      onOutput(errorOutput);
    }

    if (cucumberOutputChannel) {
      cucumberOutputChannel.append(errorOutput);
    }
  });

  child.on('error', (err) => {
    logToExtension(`Maven process error: ${err.message}`, 'ERROR');
  });

  // Return the process so caller can wait for it
  return child;
}

/**
 * ⭐ UNIFIED: Execute Cucumber test using Maven (Run or Debug mode)
 * This function unifies Run and Debug execution paths to ensure consistent result parsing
 * 
 * @param isDebug - true: attach debugger, false: run without debugger
 */
async function runCucumberTestWithMavenUnified(
  workspaceRoot: string,
  workspaceFolder: vscode.WorkspaceFolder,
  moduleInfo: ModuleInfo,
  relativePath: string,
  testClassName: string,
  isDebug: boolean,
  lineNumber?: number,
  exampleLine?: number,
  projectName?: string,
  onOutput?: (chunk: any) => void,
  onStepUpdate?: (step: StepResult) => void
): Promise<number> {
  const modeLabel = isDebug ? 'DEBUG' : 'RUN';
  logToExtension(`⭐ UNIFIED: Executing Cucumber test (${modeLabel} MODE)`, 'INFO');
  logToExtension(`  Module: ${moduleInfo.moduleRelativePath}`, 'INFO');
  logToExtension(`  Test class: ${testClassName}`, 'INFO');
  logToExtension(`  Feature: ${relativePath}${lineNumber ? ':' + lineNumber : ''}`, 'INFO');

  try {
    // Step 1: Build Maven command (same for both modes, just add debug flag if needed)
    const absoluteFeaturePath = path.join(workspaceRoot, relativePath);
    const featureRelativePath = extractFeatureRelativePath(absoluteFeaturePath, moduleInfo.modulePath);
    
    // Build base Maven args
    const mavenArgs = isDebug 
      ? buildMavenDebugCommand(moduleInfo.moduleRelativePath, testClassName, featureRelativePath, lineNumber)
      : buildMavenCommand(moduleInfo.moduleRelativePath, testClassName, featureRelativePath, lineNumber, exampleLine);

    const mavenCommand = `mvn ${mavenArgs.join(' ')}`;
    logToExtension(`[UNIFIED] Maven command: ${mavenCommand}`, 'INFO');

    // Step 2: Create output parser
    const config = vscode.workspace.getConfiguration('cucumberJavaEasyRunner');
    const showStepResults = config.get<boolean>('showStepResults', true);
    
    if (!cucumberOutputChannel) {
      cucumberOutputChannel = vscode.window.createOutputChannel('Cucumber');
    }
    
    const parser = new CucumberOutputParser(
      cucumberOutputChannel,
      showStepResults,
      onStepUpdate
    );

    // Step 3: Start Maven process
    logToExtension(`[UNIFIED] Starting Maven process...`, 'INFO');
    const mavenProcess = spawn('mvn', mavenArgs, {
      cwd: workspaceRoot,
      env: process.env
    });

    let fullOutput = '';
    let outputBuffer = '';  // ⭐ Buffer for accumulating partial lines

    // Step 4: Capture and parse output in real-time
    mavenProcess.stdout.on('data', (data: Buffer) => {
      const output = data.toString();
      fullOutput += output;
      outputBuffer += output;  // ⭐ Accumulate in buffer
      
      // ⭐ Process complete lines only
      const lines = outputBuffer.split('\n');
      // Keep the last incomplete line in buffer
      outputBuffer = lines.pop() || '';
      
      // Parse complete lines
      for (const line of lines) {
        parser.parseLine(line);
      }
      
      if (onOutput) {
        onOutput(output);
      }
    });

    mavenProcess.stderr.on('data', (data: Buffer) => {
      const output = data.toString();
      fullOutput += output;
      outputBuffer += output;  // ⭐ Accumulate in buffer
      
      // ⭐ Process complete lines only
      const lines = outputBuffer.split('\n');
      // Keep the last incomplete line in buffer
      outputBuffer = lines.pop() || '';
      
      // Parse complete lines
      for (const line of lines) {
        parser.parseLine(line);
      }
      
      if (onOutput) {
        onOutput(output);
      }
    });

    // Step 5: If Debug mode, wait for port and attach debugger
    if (isDebug) {
      logToExtension('[UNIFIED-DEBUG] Waiting for debug port 5005...', 'INFO');
      vscode.window.showInformationMessage('Waiting for Maven Surefire to start debug server (port 5005)...');

      const portReady = await waitForPort(5005, 30000);
      
      if (!portReady) {
        logToExtension('[UNIFIED-DEBUG] ❌ Timeout waiting for debug port', 'ERROR');
        mavenProcess.kill();
        vscode.window.showErrorMessage('Timeout waiting for Maven Surefire debug server to start');
        return 1;
      }

      logToExtension('[UNIFIED-DEBUG] ✓ Debug port ready, attaching debugger...', 'INFO');
      
      const debugConfig = await createMavenSurefireAttachConfig(
        workspaceFolder,
        projectName || testClassName,
        workspaceRoot,
        (msg: string, level?: string) => logToExtension(msg, level as any)
      );

      const started = await vscode.debug.startDebugging(workspaceFolder, debugConfig);

      if (!started) {
        logToExtension('[UNIFIED-DEBUG] ❌ Failed to attach debugger', 'ERROR');
        mavenProcess.kill();
        vscode.window.showErrorMessage('Failed to attach debugger');
        return 1;
      }

      logToExtension('[UNIFIED-DEBUG] ✓ Debugger attached', 'INFO');
      vscode.window.showInformationMessage(`🐛 Debugger attached to ${testClassName}`);
    }

    // Step 6: Wait for Maven to complete
    const exitCode = await new Promise<number>((resolve) => {
      mavenProcess.on('close', (code) => {
        logToExtension(`[UNIFIED] Maven process exited with code: ${code}`, 'INFO');
        
        // ⭐ Process any remaining incomplete line in buffer
        if (outputBuffer.trim()) {
          parser.parseLine(outputBuffer);
        }
        
        // Finalize parser
        parser.finalize();
        
        // Parse summary from output
        const testSummary = parseTestSummary(fullOutput);
        
        // Show summary
        showTestSummary(testSummary, code || 0, modeLabel);
        
        resolve(code || 0);
      });

      mavenProcess.on('error', (error) => {
        logToExtension(`[UNIFIED] Maven process error: ${error.message}`, 'ERROR');
        resolve(1);
      });
    });

    return exitCode;

  } catch (error: any) {
    logToExtension(`[UNIFIED] Error: ${error.message}`, 'ERROR');
    vscode.window.showErrorMessage(`Test execution failed: ${error.message}`);
    return 1;
  }
}

/**
 * Helper: Build Maven command for Run mode
 */
function buildMavenCommand(
  moduleRelativePath: string,
  testClassName: string,
  featureRelativePath: string,
  lineNumber?: number,
  exampleLine?: number
): string[] {
  const config = vscode.workspace.getConfiguration('cucumberJavaEasyRunner');
  const mavenProfile = config.get<string>('mavenProfile', '');
  const cucumberTags = config.get<string>('cucumberTags', '');
  const mavenArgs = config.get<string>('mavenArgs', '');

  const args = ['test'];

  if (mavenProfile) {
    args.push(`-P${mavenProfile}`);
  }

  let cucumberFeatures = `classpath:${featureRelativePath}`;
  if (lineNumber && lineNumber > 0) {
    cucumberFeatures += ':' + (exampleLine || lineNumber);
  }

  args.push(`-Dcucumber.features=${cucumberFeatures}`);

  // ⭐ Add Cucumber pretty plugin for step-by-step output with status symbols
  args.push('-Dcucumber.plugin=pretty');

  // ⭐ Prevent test execution twice (same as DEBUG mode)
  args.push('-Dsurefire.includeJUnit5Engines=cucumber');

  if (cucumberTags) {
    args.push(`-Dcucumber.filter.tags=${cucumberTags}`);
  }

  args.push(`-Dtest=${testClassName}`);

  if (moduleRelativePath !== '.') {
    args.push('-pl', moduleRelativePath.replace(/\\/g, '/'));
  }

  if (mavenArgs) {
    args.push(...mavenArgs.split(' ').filter(arg => arg.length > 0));
  }

  return args;
}

/**
 * Helper: Parse test summary from output
 */
function parseTestSummary(output: string): {
  scenarios: number;
  steps: number;
  passed: number;
  failures: number;
  skipped: number;
} {
  const testSummary = {
    scenarios: 0,
    steps: 0,
    passed: 0,
    failures: 0,
    skipped: 0
  };

  const lines = output.split('\n');
  
  for (const line of lines) {
    const scenarioMatch = line.match(/(\d+)\s+Scenarios?\s+\(([^)]+)\)/i);
    if (scenarioMatch) {
      testSummary.scenarios = parseInt(scenarioMatch[1]);
      const details = scenarioMatch[2];
      const failedMatch = details.match(/(\d+)\s+failed/);
      const passedMatch = details.match(/(\d+)\s+passed/);
      const skippedMatch = details.match(/(\d+)\s+skipped/);
      if (failedMatch) {testSummary.failures = parseInt(failedMatch[1]);}
      if (passedMatch) {testSummary.passed = parseInt(passedMatch[1]);}
      if (skippedMatch) {testSummary.skipped = parseInt(skippedMatch[1]);}
    }

    const stepsMatch = line.match(/(\d+)\s+Steps?\s+\(([^)]+)\)/i);
    if (stepsMatch) {
      testSummary.steps = parseInt(stepsMatch[1]);
    }
  }

  return testSummary;
}

/**
 * Helper: Show test summary
 */
function showTestSummary(
  testSummary: { scenarios: number; steps: number; passed: number; failures: number; skipped: number },
  exitCode: number,
  mode: string
): void {
  const testsPassed = testSummary.failures === 0 && exitCode === 0;

  if (cucumberOutputChannel) {
    cucumberOutputChannel.appendLine('\n═══════════════════════════════════════════');
    cucumberOutputChannel.appendLine(`📊 Test Summary (${mode} Mode)`);
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

    if (testsPassed) {
      vscode.window.showInformationMessage(`✅ ${mode}: All tests passed! (${testSummary.scenarios} scenarios, ${testSummary.steps} steps)`);
    } else {
      vscode.window.showErrorMessage(`❌ ${mode}: Tests failed! (${testSummary.failures} ${testSummary.failures === 1 ? 'failure' : 'failures'})`);
    }
  }
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

  // Build grep filter pattern for Cucumber-related output
  // This filters at Maven execution stage, dramatically reducing output volume
  const grepPattern = [
    '✔', '✘', '✓', '✗', '×', '↷', '⊝', '−',  // Step symbols
    'Given', 'When', 'Then', 'And', 'But',     // Step keywords
    'Scenario', 'Feature', 'Background',        // Cucumber markers
    'ERROR', 'Exception', 'AssertionError',     // Error indicators
    'at\\s+', 'Caused by:', 'java\\.', 'org\\.junit', 'org\\.opentest4j',  // Stack traces
    '[0-9]+\\s+(Scenarios?|Steps?)\\s+'        // Summary lines
  ].join('|');

  // ⭐ Execute Maven test WITHOUT grep filter (same as Debug mode for consistency)
  // This ensures all Cucumber output is captured and parsed correctly
  const mvnCommand = `mvn ${mvnArgs.join(' ')}`;

  logToExtension('═══════════════════════════════════════════════════════════════', 'INFO');
  logToExtension('🚀 STARTING MAVEN TEST EXECUTION (RUN MODE)', 'INFO');
  logToExtension('═══════════════════════════════════════════════════════════════', 'INFO');
  logToExtension(`📂 Working Directory: ${workspaceRoot}`, 'INFO');
  logToExtension(`📦 Module: ${moduleInfo.moduleRelativePath}`, 'INFO');
  logToExtension(`🧪 Test Class: ${testClassName}`, 'INFO');
  logToExtension(`🥒 Feature: ${cucumberFeatures}`, 'INFO');
  logToExtension(`⚙️  Maven Command: ${mvnCommand}`, 'INFO');
  logToExtension(`⏰ Start Time: ${new Date().toLocaleTimeString()}`, 'INFO');
  logToExtension('═══════════════════════════════════════════════════════════════', 'INFO');

  // ⭐ Use direct mvn spawn (same as Debug mode), not shell with grep
  const child = spawn('mvn', mvnArgs, { cwd: workspaceRoot, env: spawnEnv });
  logToExtension(`✅ Maven process spawned (PID: ${child.pid})`, 'INFO');

  const testSummary = {
    scenarios: 0,
    steps: 0,
    failures: 0,
    skipped: 0,
    passed: 0
  };

  // Collect all output for batch processing at the end
  let fullOutput = '';
  let outputChunks = 0;
  let errorChunks = 0;

  return await new Promise<number>((resolve) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      outputChunks++;
      const output = chunk.toString();
      
      if (outputChunks === 1) {
        logToExtension(`📨 First stdout chunk received (${output.length} bytes)`, 'INFO');
      }
      if (outputChunks % 10 === 0) {
        logToExtension(`📨 Received ${outputChunks} stdout chunks so far...`, 'DEBUG');
      }
      
      // Collect output for batch processing
      fullOutput += output;
      
      // ⭐ REAL-TIME parsing: Parse output immediately for step results (same as debug mode)
      if (parser) {
        const lines = output.split('\n');
        for (const line of lines) {
          parser.parseLine(line);
        }
      }
      
      if (onOutput) {onOutput(output);}
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      errorChunks++;
      const errorOutput = chunk.toString();
      
      // Collect stderr output too
      fullOutput += errorOutput;
      
      if (errorChunks === 1) {
        logToExtension(`📨 First stderr chunk received (${errorOutput.length} bytes)`, 'INFO');
      }
      logToExtension(`⚠️  Maven stderr [${errorChunks}]: ${errorOutput.substring(0, 200)}`, 'WARN');
      
      // ⭐ Also parse stderr for step results (Maven outputs test results to stderr sometimes)
      if (parser) {
        const lines = errorOutput.split('\n');
        for (const line of lines) {
          parser.parseLine(line);
        }
      }
      
      if (onOutput) {onOutput(errorOutput);}
    });

    child.on('error', (err) => {
      logToExtension(`❌ Maven process error: ${err.message}`, 'ERROR');
      logToExtension(`Error stack: ${err.stack}`, 'ERROR');
    });

    child.on('close', (code) => {
      const exitCode = typeof code === 'number' ? code : 1;
      logToExtension('═══════════════════════════════════════════════════════════════', 'INFO');
      logToExtension(`⏹️  Maven process exited with code: ${exitCode}`, 'INFO');
      logToExtension(`📊 Output Statistics:`, 'INFO');
      logToExtension(`   - stdout chunks: ${outputChunks}`, 'INFO');
      logToExtension(`   - stderr chunks: ${errorChunks}`, 'INFO');
      logToExtension(`   - Total output size: ${fullOutput.length} bytes`, 'INFO');
      logToExtension(`⏰ End Time: ${new Date().toLocaleTimeString()}`, 'INFO');
      logToExtension('═══════════════════════════════════════════════════════════════', 'INFO');

      // Parse test summary from collected output (steps already parsed in real-time)
      if (fullOutput.trim()) {
        logToExtension('Parsing test summary from Maven output...', 'INFO');
        
        const lines = fullOutput.split('\n');
        
        for (const line of lines) {
          // Parse test summary - Pattern: "5 Scenarios (2 failed, 3 passed)"
          const scenarioMatch = line.match(/(\d+)\s+Scenarios?\s+\(([^)]+)\)/i);
          if (scenarioMatch) {
            testSummary.scenarios = parseInt(scenarioMatch[1]);
            const details = scenarioMatch[2];

            const failedMatch = details.match(/(\d+)\s+failed/);
            const passedMatch = details.match(/(\d+)\s+passed/);
            const skippedMatch = details.match(/(\d+)\s+skipped/);

            if (failedMatch) {testSummary.failures = parseInt(failedMatch[1]);}
            if (passedMatch) {testSummary.passed = parseInt(passedMatch[1]);}
            if (skippedMatch) {testSummary.skipped = parseInt(skippedMatch[1]);}

            logToExtension(`Parsed scenario summary: ${testSummary.scenarios} total, ${testSummary.failures} failed, ${testSummary.passed} passed`, 'INFO');
          }

          // Parse step summary - Pattern: "15 Steps (2 failed, 3 skipped, 10 passed)"
          const stepsMatch = line.match(/(\d+)\s+Steps?\s+\(([^)]+)\)/i);
          if (stepsMatch) {
            testSummary.steps = parseInt(stepsMatch[1]);
            const details = stepsMatch[2];

            const failedMatch = details.match(/(\d+)\s+failed/);
            const skippedMatch = details.match(/(\d+)\s+skipped/);

            if (failedMatch) {testSummary.failures = parseInt(failedMatch[1]);}
            if (skippedMatch) {testSummary.skipped = parseInt(skippedMatch[1]);}

            logToExtension(`Parsed steps summary: ${testSummary.steps} total, ${testSummary.failures} failed, ${testSummary.skipped} skipped`, 'INFO');
          }
        }
        
        // Finalize parser to complete any pending step
        if (parser) {
          parser.finalize();
          logToExtension('Parser finalized', 'INFO');
        }
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

/**
 * v23: Execute Cucumber test using Launch Mode (Direct Cucumber CLI execution)
 * 
 * This function bypasses Maven/Surefire/JaCoCo completely by:
 * 1. Resolving classpath programmatically via mvn dependency:build-classpath
 * 2. Launching Cucumber CLI directly via VS Code Debug API
 * 3. Using noDebug flag to unify run/debug execution paths
 * 
 * Benefits over v16-v22 (Attach Mode):
 * - ✅ No JDWP injection conflicts with JaCoCo/pom.xml
 * - ✅ Breakpoints work reliably without pom.xml modifications
 * - ✅ Faster startup (no Maven test phase overhead)
 * - ✅ Unified run/debug logic (single code path)
 * 
 * @param workspaceRoot - Absolute path to workspace root
 * @param workspaceFolder - VS Code workspace folder
 * @param moduleInfo - Maven module information
 * @param featurePath - Relative path to .feature file
 * @param testClassPath - Absolute path to test class file (for glue package extraction)
 * @param isDebug - true for debug mode, false for run mode
 * @param lineNumber - Optional scenario line number
 * @param projectName - Maven project name (optional)
 * @param sourcePaths - Source paths for debugging (optional)
 * @param onOutput - Output callback
 * @returns Promise<number> - Exit code
 */
/**
 * ⭐ v25: Execute Cucumber test using Maven Surefire Debug Mode
 * 
 * This approach uses Maven's built-in debug support which properly handles:
 * - All Maven dependencies and classpath
 * - Spring Boot configuration
 * - Cucumber Spring integration
 * - Multi-module projects
 * 
 * Command: mvn test -Dcucumber.features=... -pl <module> -Dtest=<TestClass> -Dmaven.surefire.debug
 * 
 * @param workspaceRoot - Workspace root directory
 * @param workspaceFolder - VS Code workspace folder
 * @param moduleInfo - Module information
 * @param absoluteFeaturePath - Absolute path to feature file
 * @param testClassName - Simple test class name (e.g., 'MktSegmentCriteriaUpdateTest')
 * @param lineNumber - Optional scenario line number
 * @param projectName - Maven artifactId
 * @param onOutput - Output callback
 * @returns Promise<number> - Exit code
 */
async function runCucumberTestV25MavenSurefireDebug(
  workspaceRoot: string,
  workspaceFolder: vscode.WorkspaceFolder,
  moduleInfo: ModuleInfo,
  absoluteFeaturePath: string,
  testClassName: string,
  lineNumber?: number,
  projectName?: string,
  onOutput?: (chunk: any) => void
): Promise<number> {
  logToExtension(`⭐ v25: Executing Cucumber test using Maven Surefire Debug`, 'INFO');
  logToExtension(`  Module: ${moduleInfo.moduleRelativePath}`, 'INFO');
  logToExtension(`  Test class: ${testClassName}`, 'INFO');
  logToExtension(`  Feature: ${path.basename(absoluteFeaturePath)}${lineNumber ? ':' + lineNumber : ''}`, 'INFO');

  try {
    // Step 1: Build Maven debug command
    const featureRelativePath = extractFeatureRelativePath(absoluteFeaturePath, moduleInfo.modulePath);
    const mavenArgs = buildMavenDebugCommand(
      moduleInfo.moduleRelativePath,
      testClassName,
      featureRelativePath,
      lineNumber
    );

    // ⭐ v25.1.3: Log complete Maven command for verification
    const mavenCommand = `mvn ${mavenArgs.join(' ')}`;
    logToExtension(`[v25.1.3] Complete Maven command:`, 'INFO');
    logToExtension(`  Working directory: ${workspaceRoot}`, 'INFO');
    logToExtension(`  Command: ${mavenCommand}`, 'INFO');
    logToExtension(`[v25] Maven command: mvn ${mavenArgs.join(' ')}`, 'INFO');

    // Step 2: Create debug configuration (will attach to port 5005)
    logToExtension('[v25] Creating attach debug configuration...', 'INFO');
    const debugConfig = await createMavenSurefireAttachConfig(
      workspaceFolder,
      projectName || testClassName,
      workspaceRoot,
      (msg: string, level?: string) => logToExtension(msg, level as any)
    );

    // Step 3: Start Maven process with surefire debug
    logToExtension('[v25] Starting Maven process...', 'INFO');
    const mavenProcess = spawn('mvn', mavenArgs, {
      cwd: workspaceRoot,
      env: process.env
    });

    // Capture output
    mavenProcess.stdout.on('data', (data: Buffer) => {
      const output = data.toString();
      logToExtension(`[Maven] ${output}`, 'DEBUG');
      if (onOutput) {
        onOutput(output);
      }
    });

    mavenProcess.stderr.on('data', (data: Buffer) => {
      const output = data.toString();
      logToExtension(`[Maven Error] ${output}`, 'DEBUG');
      if (onOutput) {
        onOutput(output);
      }
    });

    // Step 4: Wait for Surefire to start listening on debug port
    logToExtension('[v25] Waiting for Maven Surefire to start debug server...', 'INFO');
    vscode.window.showInformationMessage('Waiting for Maven Surefire to start debug server (port 5005)...');

    // Wait for port 5005 to be available (Surefire default)
    const portReady = await waitForPort(5005, 30000);
    
    if (!portReady) {
      logToExtension('[v25] ❌ Timeout waiting for debug port 5005', 'ERROR');
      mavenProcess.kill();
      vscode.window.showErrorMessage('Timeout waiting for Maven Surefire debug server to start');
      return 1;
    }

    logToExtension('[v25] ✓ Debug port 5005 is ready', 'INFO');

    // Step 5: Attach debugger
    logToExtension('[v25] Attaching debugger...', 'INFO');
    const started = await vscode.debug.startDebugging(
      workspaceFolder,
      debugConfig
    );

    if (!started) {
      logToExtension('[v25] ❌ Failed to start debug session', 'ERROR');
      mavenProcess.kill();
      vscode.window.showErrorMessage('Failed to attach debugger to Maven Surefire');
      return 1;
    }

    logToExtension('[v25] ✓ Debugger attached successfully', 'INFO');
    vscode.window.showInformationMessage(`🐛 Debugger attached to ${testClassName}`);

    // Step 6: Wait for Maven process to complete
    const exitCode = await new Promise<number>((resolve) => {
      mavenProcess.on('close', (code) => {
        logToExtension(`[v25] Maven process exited with code: ${code}`, 'INFO');
        resolve(code || 0);
      });

      mavenProcess.on('error', (error) => {
        logToExtension(`[v25] Maven process error: ${error.message}`, 'ERROR');
        resolve(1);
      });
    });

    return exitCode;

  } catch (error: any) {
    logToExtension(`[v25] Error: ${error.message}`, 'ERROR');
    logToExtension(`[v25] Stack: ${error.stack}`, 'DEBUG');
    throw error;
  }
}

/**
 * Wait for a TCP port to become available
 * @param port - Port number to wait for
 * @param timeout - Timeout in milliseconds
 * @returns Promise<boolean> - true if port is ready
 */
async function waitForPort(port: number, timeout: number): Promise<boolean> {
  const startTime = Date.now();
  const checkInterval = 500; // Check every 500ms

  while (Date.now() - startTime < timeout) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = new net.Socket();
        
        socket.once('connect', () => {
          socket.destroy();
          resolve();
        });

        socket.once('error', () => {
          socket.destroy();
          reject();
        });

        socket.connect(port, 'localhost');
      });

      // Port is connectable
      return true;
    } catch {
      // Port not ready yet, wait and retry
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
  }

  return false;
}

/**
 * ⭐ v25.1: Run Cucumber test with Maven Surefire Debug + Result Parsing
 * Combines the best of both worlds:
 * - Maven Surefire Debug Mode (like v25)
 * - CucumberOutputParser for test result synchronization (like Run Test)
 */
async function runCucumberTestWithMavenDebugAndResult(
  workspaceRoot: string,
  workspaceFolder: vscode.WorkspaceFolder,
  moduleInfo: ModuleInfo,
  relativePath: string,
  testClassName: string,
  lineNumber?: number,
  exampleLine?: number,
  projectName?: string,
  onOutput?: (chunk: any) => void,
  onStepUpdate?: (step: StepResult) => void
): Promise<number> {
  logToExtension(`⭐ v25.1: Executing Cucumber test using Maven Surefire Debug + Result Parsing`, 'INFO');
  logToExtension(`  Module: ${moduleInfo.moduleRelativePath}`, 'INFO');
  logToExtension(`  Test class: ${testClassName}`, 'INFO');
  logToExtension(`  Feature: ${relativePath}${lineNumber ? ':' + lineNumber : ''}`, 'INFO');

  try {
    // Step 1: Build Maven debug command
    const absoluteFeaturePath = path.join(workspaceRoot, relativePath);
    const featureRelativePath = extractFeatureRelativePath(absoluteFeaturePath, moduleInfo.modulePath);
    const mavenArgs = buildMavenDebugCommand(
      moduleInfo.moduleRelativePath,
      testClassName,
      featureRelativePath,
      lineNumber
    );

    // ⭐ v25.1.3: Log complete Maven command for verification
    const mavenCommand = `mvn ${mavenArgs.join(' ')}`;
    logToExtension(`[v25.1.3] Complete Maven command:`, 'INFO');
    logToExtension(`  Working directory: ${workspaceRoot}`, 'INFO');
    logToExtension(`  Command: ${mavenCommand}`, 'INFO');
    logToExtension(`[v25.1] Maven command: mvn ${mavenArgs.join(' ')}`, 'INFO');

    // Step 2: Create output parser (same as Run Test)
    const config = vscode.workspace.getConfiguration('cucumberJavaEasyRunner');
    const showStepResults = config.get<boolean>('showStepResults', true);
    
    // Ensure cucumberOutputChannel exists
    if (!cucumberOutputChannel) {
      cucumberOutputChannel = vscode.window.createOutputChannel('Cucumber');
    }
    
    const parser = new CucumberOutputParser(
      cucumberOutputChannel,
      showStepResults,
      onStepUpdate
    );

    // Step 3: Create debug configuration
    logToExtension('[v25.1] Creating attach debug configuration...', 'INFO');
    const debugConfig = await createMavenSurefireAttachConfig(
      workspaceFolder,
      projectName || testClassName,
      workspaceRoot,
      (msg: string, level?: string) => logToExtension(msg, level as any)
    );

    // Step 4: Start Maven process
    logToExtension('[v25.1] Starting Maven process...', 'INFO');
    const mavenProcess = spawn('mvn', mavenArgs, {
      cwd: workspaceRoot,
      env: process.env
    });

    // Collect full output for batch processing
    let fullOutput = '';

    // Capture stdout
    mavenProcess.stdout.on('data', (data: Buffer) => {
      const output = data.toString();
      fullOutput += output;
      
      logToExtension(`[Maven] ${output}`, 'DEBUG');
      if (onOutput) {
        onOutput(output);
      }
    });

    // Capture stderr
    mavenProcess.stderr.on('data', (data: Buffer) => {
      const output = data.toString();
      fullOutput += output;
      
      logToExtension(`[Maven Error] ${output}`, 'DEBUG');
      if (onOutput) {
        onOutput(output);
      }
    });

    // Step 5: Wait for debug port
    logToExtension('[v25.1] Waiting for Maven Surefire to start debug server...', 'INFO');
    vscode.window.showInformationMessage('Waiting for Maven Surefire to start debug server (port 5005)...');

    const portReady = await waitForPort(5005, 30000);
    
    if (!portReady) {
      logToExtension('[v25.1] ❌ Timeout waiting for debug port 5005', 'ERROR');
      mavenProcess.kill();
      vscode.window.showErrorMessage('Timeout waiting for Maven Surefire debug server to start');
      return 1;
    }

    logToExtension('[v25.1] ✓ Debug port 5005 is ready', 'INFO');

    // Step 6: Attach debugger
    logToExtension('[v25.1] Attaching debugger...', 'INFO');
    const started = await vscode.debug.startDebugging(
      workspaceFolder,
      debugConfig
    );

    if (!started) {
      logToExtension('[v25.1] ❌ Failed to start debug session', 'ERROR');
      mavenProcess.kill();
      vscode.window.showErrorMessage('Failed to attach debugger to Maven Surefire');
      return 1;
    }

    logToExtension('[v25.1] ✓ Debugger attached successfully', 'INFO');
    vscode.window.showInformationMessage(`🐛 Debugger attached to ${testClassName}`);

    // Step 7: Wait for Maven to complete
    const exitCode = await new Promise<number>((resolve) => {
      mavenProcess.on('close', (code) => {
        logToExtension(`[v25.1] Maven process exited with code: ${code}`, 'INFO');
        
        // Step 8: Parse output (same as Run Test)
        logToExtension('[v25.1] Parsing test output for results...', 'INFO');
        const lines = fullOutput.split('\n');
        
        // Initialize test summary
        const testSummary = {
          scenarios: 0,
          steps: 0,
          passed: 0,
          failures: 0,
          skipped: 0
        };
        
        let stepsProcessed = 0;
        for (const line of lines) {
          const stepResult = parser.parseLine(line);
          if (stepResult) {
            stepsProcessed++;
          }
          
          // Parse test summary from Maven output
          const summaryMatch = line.match(/(\d+)\s+Scenarios\s+\(.*\)/);
          if (summaryMatch) {
            testSummary.scenarios = parseInt(summaryMatch[1]);
          }
          
          const stepsMatch = line.match(/(\d+)\s+Steps\s+\(/);
          if (stepsMatch) {
            testSummary.steps = parseInt(stepsMatch[1]);
            
            // Extract passed, failed, skipped from same line
            const passedMatch = line.match(/(\d+)\s+passed/);
            const failedMatch = line.match(/(\d+)\s+failed/);
            const skippedMatch = line.match(/(\d+)\s+(?:skipped|pending)/);
            
            if (passedMatch) {testSummary.passed = parseInt(passedMatch[1]);}
            if (failedMatch) {testSummary.failures = parseInt(failedMatch[1]);}
            if (skippedMatch) {testSummary.skipped = parseInt(skippedMatch[1]);}
            
            logToExtension(`Parsed steps summary: ${testSummary.steps} total, ${testSummary.failures} failed, ${testSummary.skipped} skipped`, 'INFO');
          }
        }
        
        parser.finalize();
        logToExtension(`[v25.1] Batch parsing completed. Processed ${stepsProcessed} steps.`, 'INFO');

        // Step 9: Show test summary (same as Run Test)
        const testsPassed = testSummary.failures === 0 && code === 0;
        logToExtension(`[v25.1] Test result: ${testsPassed ? 'PASSED' : 'FAILED'}, failures: ${testSummary.failures}, exitCode: ${code}`, 'INFO');

        if (cucumberOutputChannel) {
          cucumberOutputChannel.appendLine('\n═══════════════════════════════════════════');
          cucumberOutputChannel.appendLine('📊 Test Summary (Debug Mode)');
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
          cucumberOutputChannel.appendLine(`\nExit Code: ${code}`);
          cucumberOutputChannel.appendLine('═══════════════════════════════════════════\n');

          // Show notification
          if (testsPassed) {
            vscode.window.showInformationMessage(`✅ Debug: All tests passed! (${testSummary.scenarios} scenarios, ${testSummary.steps} steps)`);
          } else {
            vscode.window.showErrorMessage(`❌ Debug: Tests failed! (${testSummary.failures} ${testSummary.failures === 1 ? 'failure' : 'failures'})`);
          }
        }

        resolve(code || 0);
      });

      mavenProcess.on('error', (error) => {
        logToExtension(`[v25.1] Maven process error: ${error.message}`, 'ERROR');
        resolve(1);
      });
    });

    return exitCode;

  } catch (error: any) {
    logToExtension(`[v25.1] Error: ${error.message}`, 'ERROR');
    logToExtension(`[v25.1] Stack: ${error.stack}`, 'DEBUG');
    throw error;
  }
}

async function runCucumberTestV23LaunchMode(
  workspaceRoot: string,
  workspaceFolder: vscode.WorkspaceFolder,
  moduleInfo: ModuleInfo,
  featurePath: string,
  testClassPath: string,
  isDebug: boolean,
  lineNumber?: number,
  projectName?: string,
  sourcePaths?: string[],
  onOutput?: (chunk: string) => void
): Promise<number> {
  logToExtension(`⭐ v23: Executing Cucumber test using Launch Mode`, 'INFO');
  logToExtension(`  Mode: ${isDebug ? 'DEBUG' : 'RUN'}`, 'INFO');
  logToExtension(`  Feature: ${featurePath}`, 'DEBUG');
  logToExtension(`  Test class: ${testClassPath}`, 'DEBUG');

  try {
    // Step 1: Validate Maven project
    if (!isValidMavenProject(moduleInfo.modulePath)) {
      throw new Error(`Not a valid Maven project: ${moduleInfo.modulePath}`);
    }

    // Step 1.5: ⭐ v24: Auto-detect source paths if not provided
    let effectiveSourcePaths = sourcePaths;
    if (!effectiveSourcePaths || effectiveSourcePaths.length === 0) {
      logToExtension('[v24] Auto-detecting source paths for multi-module project...', 'INFO');
      try {
        const detectedPaths = await findAllSourcePathsCached(
          workspaceRoot,
          (msg: string, level?: string) => logToExtension(msg, level as any)
        );
        
        if (detectedPaths && detectedPaths.length > 0) {
          effectiveSourcePaths = detectedPaths;
          logToExtension(`[v24] ✓ Detected ${effectiveSourcePaths.length} source paths`, 'INFO');
          
          // Log first few paths for debugging
          effectiveSourcePaths.slice(0, 5).forEach((sp, idx) => {
            const rel = path.relative(workspaceRoot, sp);
            logToExtension(`  [${idx + 1}] ${rel}`, 'DEBUG');
          });
          if (effectiveSourcePaths.length > 5) {
            logToExtension(`  ... and ${effectiveSourcePaths.length - 5} more`, 'DEBUG');
          }
        }
      } catch (error: any) {
        logToExtension(`[v24] Warning: Failed to auto-detect source paths: ${error.message}`, 'WARN');
        logToExtension(`[v24] Will use default source path patterns`, 'INFO');
        // Leave effectiveSourcePaths undefined to use defaults in createCucumberLaunchConfig
      }
    } else {
      logToExtension(`[v24] Using provided source paths: ${effectiveSourcePaths.length}`, 'DEBUG');
    }

    // Step 2: Resolve Maven classpath programmatically
    logToExtension('[v23] Step 1: Resolving Maven classpath...', 'INFO');
    const classPaths = await resolveMavenClasspath(
      moduleInfo.modulePath,
      (msg, level) => logToExtension(msg, level as any)
    );

    if (classPaths.length === 0) {
      throw new Error('Failed to resolve Maven classpath');
    }

    logToExtension(`[v23] ✓ Resolved ${classPaths.length} classpath entries`, 'INFO');

    // Step 3: Extract glue package from test class
    // Priority 1: From @ConfigurationParameter(key = GLUE_PROPERTY_NAME, value = "...")
    // Priority 2: From test class file path
    let gluePackage = await extractGluePackageFromTestClass(testClassPath);
    
    if (!gluePackage) {
      // Fallback to path-based extraction
      gluePackage = extractGluePackage(testClassPath, moduleInfo.modulePath);
      logToExtension(`[v23.3.1] Using path-based glue package: ${gluePackage}`, 'DEBUG');
    } else {
      logToExtension(`[v23.3.1] Using @ConfigurationParameter glue package: ${gluePackage}`, 'INFO');
    }
    
    logToExtension(`[v23] Glue package: ${gluePackage || '(empty - will scan all)'}`, 'DEBUG');

    // Step 4: Build Cucumber CLI arguments
    const absoluteFeaturePath = path.isAbsolute(featurePath)
      ? featurePath
      : path.join(workspaceRoot, featurePath);

    const cucumberArgs = buildCucumberArgs(
      absoluteFeaturePath,
      gluePackage,
      lineNumber,
      moduleInfo.modulePath
    );

    logToExtension(`[v23] Cucumber args: ${cucumberArgs.join(' ')}`, 'DEBUG');

    // Step 5: Create Launch Mode debug configuration
    logToExtension('[v23] Step 2: Creating Launch Mode configuration...', 'INFO');
    const debugConfig = createCucumberLaunchConfig(
      workspaceFolder,
      cucumberArgs,
      classPaths,
      isDebug,
      moduleInfo.modulePath,  // ⭐ v23.32: Pass module path for correct cwd
      projectName,
      effectiveSourcePaths,  // ⭐ v24: Use auto-detected or provided source paths
      (msg, level) => logToExtension(msg, level as any)
    );

    // Step 6: Start debug/run session via VS Code Debug API
    logToExtension(`[v23] Step 3: Starting ${isDebug ? 'debug' : 'run'} session...`, 'INFO');
    
    const started = await vscode.debug.startDebugging(
      workspaceFolder,
      debugConfig
    );

    if (!started) {
      throw new Error('Failed to start debug session');
    }

    logToExtension(`[v23] ✓ ${isDebug ? 'Debug' : 'Run'} session started`, 'INFO');

    // Get active debug session
    const activeSession = vscode.debug.activeDebugSession;
    if (activeSession) {
      logToExtension(`[v23] Active session: ${activeSession.name} (${activeSession.id})`, 'DEBUG');
    }

    if (isDebug) {
      // Wait for breakpoints to bind
      logToExtension('[v23] Waiting for breakpoints to bind...', 'DEBUG');
      await new Promise(resolve => setTimeout(resolve, 1000));

      const breakpoints = vscode.debug.breakpoints;
      logToExtension(`[v23] Active breakpoints: ${breakpoints.length}`, 'INFO');

      vscode.window.showInformationMessage(
        `🐛 Debugger started for ${path.basename(featurePath)}${lineNumber ? `:${lineNumber}` : ''}`
      );
    } else {
      vscode.window.showInformationMessage(
        `▶️  Running ${path.basename(featurePath)}${lineNumber ? `:${lineNumber}` : ''}`
      );
    }

    // Step 7: Wait for session to complete
    // We need to track which session we started since VS Code doesn't return session object
    const sessionName = debugConfig.name;
    
    return await new Promise<number>((resolve) => {
      const disposable = vscode.debug.onDidTerminateDebugSession((session) => {
        if (session.name === sessionName || session.configuration.mainClass === 'io.cucumber.core.cli.Main') {
          logToExtension(`[v23] Debug session terminated: ${session.name}`, 'INFO');
          disposable.dispose();
          resolve(0); // Assume success (VS Code doesn't provide exit code easily)
        }
      });

      // Timeout fallback (30 minutes)
      setTimeout(() => {
        logToExtension('[v23] ⚠️ Debug session timeout (30 min)', 'WARN');
        disposable.dispose();
        resolve(1);
      }, 30 * 60 * 1000);
    });

  } catch (error: any) {
    logToExtension(`[v23] ❌ Error: ${error.message}`, 'ERROR');
    logToExtension(`[v23] Stack: ${error.stack}`, 'DEBUG');
    vscode.window.showErrorMessage(`Cucumber test failed: ${error.message}`);
    return 1;
  }
}

// Deactivate function - called when extension is deactivated
export function deactivate() {
  // Cleanup debug ports
  DebugPortManager.cleanup();
  logToExtension('Extension deactivated, debug ports cleaned up', 'INFO');
} 