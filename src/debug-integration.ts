/**
 * Debug Integration Module for Cucumber Java Easy Runner
 * 
 * This module provides debug support for running Cucumber tests in VS Code Test Explorer.
 * 
 * Features:
 * - Debug Profile integration with Test Explorer
 * - Dynamic debug port allocation
 * - JDWP configuration for Java debugging
 * - Automatic debugger attachment
 * - Test run lifecycle management
 * 
 * @module debug-integration
 */

import * as vscode from 'vscode';
import { ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';

/**
 * Extract Maven artifactId from pom.xml
 * This is the correct project name for VS Code Java debugger
 * 
 * @param pomPath Absolute path to pom.xml file
 * @returns Maven artifactId or null if extraction fails
 */
export async function extractMavenArtifactId(pomPath: string): Promise<string | null> {
  try {
    const pomContent = await fs.promises.readFile(pomPath, 'utf-8');
    
    // Simple XML parsing for <artifactId>...</artifactId>
    // Note: This gets the first <artifactId>, which should be the project's own artifactId
    // Parent artifactId comes later in the file
    const match = pomContent.match(/<project[^>]*>[\s\S]*?<artifactId>([^<]+)<\/artifactId>/);
    if (match && match[1]) {
      return match[1].trim();
    }
  } catch (error) {
    // Return null if read fails - caller will use fallback
    return null;
  }
  return null;
}

/**
 * Debug configuration specific for Cucumber Java tests - Attach Mode (Deprecated in v13)
 * @deprecated Use CucumberLaunchDebugConfig instead
 */
export interface CucumberDebugConfig extends vscode.DebugConfiguration {
  type: 'java';
  name: string;
  request: 'attach';
  hostName: string;
  port: number;
  timeout?: number;
  projectName?: string;
  sourcePaths?: string[];
  classPaths?: string[];
}

/**
 * Debug configuration for Cucumber Java tests - Launch Mode (v13+)
 * This is the preferred approach for breakpoint debugging
 */
export interface CucumberLaunchDebugConfig extends vscode.DebugConfiguration {
  type: 'java';
  name: string;
  request: 'launch';
  mainClass: string;
  args: string[];
  vmArgs?: string[];
  classPaths?: string[];
  modulePaths?: string[];
  projectName?: string;
  sourcePaths?: string[];
  console?: 'internalConsole' | 'integratedTerminal' | 'externalTerminal';
  cwd?: string;
  env?: { [key: string]: string };
  noDebug?: boolean;
}

/**
 * Debug port manager - manages allocation and release of debug ports
 */
export class DebugPortManager {
  private static readonly PORT_RANGE_START = 5005;
  private static readonly PORT_RANGE_END = 5100;
  private static usedPorts = new Set<number>();
  private static portSessionMap = new Map<number, string>();

  /**
   * Allocate an available debug port for a session
   */
  static async allocatePort(sessionId: string): Promise<number> {
    for (let port = this.PORT_RANGE_START; port <= this.PORT_RANGE_END; port++) {
      if (!this.usedPorts.has(port) && await this.isPortAvailable(port)) {
        this.usedPorts.add(port);
        this.portSessionMap.set(port, sessionId);
        console.log(`[DebugPortManager] Allocated port ${port} for session ${sessionId}`);
        return port;
      }
    }

    throw new Error(
      `No available debug ports in range ${this.PORT_RANGE_START}-${this.PORT_RANGE_END}. ` +
      `Currently used ports: ${Array.from(this.usedPorts).join(', ')}`
    );
  }

  /**
   * Release a debug port
   */
  static releasePort(port: number): void {
    const sessionId = this.portSessionMap.get(port);
    this.usedPorts.delete(port);
    this.portSessionMap.delete(port);
    console.log(`[DebugPortManager] Released port ${port} (session: ${sessionId})`);
  }

  /**
   * Check if a port is available for binding
   */
  private static async isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();

      server.once('error', (err: NodeJS.ErrnoException) => {
        resolve(err.code !== 'EADDRINUSE');
      });

      server.once('listening', () => {
        server.close();
        resolve(true);
      });

      server.listen(port, 'localhost');
    });
  }

  /**
   * Get all currently used ports
   */
  static getUsedPorts(): number[] {
    return Array.from(this.usedPorts);
  }

  /**
   * Cleanup all ports (called on extension deactivation)
   */
  static cleanup(): void {
    this.usedPorts.clear();
    this.portSessionMap.clear();
    console.log('[DebugPortManager] Cleaned up all debug ports');
  }
}

/**
 * Create a debug configuration for attaching to a Cucumber test
 */
export function createDebugConfiguration(
  workspaceFolder: vscode.WorkspaceFolder,
  debugPort: number,
  testName: string = 'Cucumber Test',
  projectSourcePaths?: string[],
  projectName?: string,
  projectClassPaths?: string[],
  logFunction?: (message: string, level?: string) => void
): CucumberDebugConfig {
  const userConfig = vscode.workspace.getConfiguration('cucumberJavaEasyRunner.debug');
  const timeout = userConfig.get<number>('timeout', 30000);

  // Use provided source paths or default patterns
  let sourcePaths: string[];
  if (projectSourcePaths && projectSourcePaths.length > 0) {
    sourcePaths = projectSourcePaths;
  } else {
    // Default patterns for both single and multi-module projects
    const configuredPaths = userConfig.get<string[]>('sourcePaths', []);
    if (configuredPaths.length > 0) {
      sourcePaths = configuredPaths;
    } else {
      // Auto-detect common Maven patterns
      sourcePaths = [
        'src/test/java',
        'src/main/java',
        '*/src/test/java',  // Multi-module pattern
        '*/src/main/java'    // Multi-module pattern
      ];
    }
  }

  // Convert relative paths to absolute paths for Java debugger
  const absoluteSourcePaths = sourcePaths.map(sp => {
    // If already absolute, use as-is
    if (path.isAbsolute(sp)) {
      return sp;
    }
    // Convert relative path to absolute based on workspace folder
    return path.resolve(workspaceFolder.uri.fsPath, sp);
  });
  
  // Build classPaths for .class file mapping
  let classPaths: string[] | undefined;
  if (projectClassPaths && projectClassPaths.length > 0) {
    classPaths = projectClassPaths;
  }
  // ⭐ v11: 如果沒有提供 classPaths,不要給預設值!
  // 讓 Java Debug Extension 自動呼叫 resolveClasspath() 來取得完整的 Maven dependencies

  // Convert relative classPaths to absolute paths (only if provided)
  const absoluteClassPaths = classPaths?.map(cp => {
    if (path.isAbsolute(cp)) {
      return cp;
    }
    return path.resolve(workspaceFolder.uri.fsPath, cp);
  });
  
  // Use provided projectName or fallback to workspace folder name
  const effectiveProjectName = projectName || workspaceFolder.name;
  
  // Log debug configuration details
  if (logFunction) {
    logFunction(`[createDebugConfiguration] Relative source paths: ${sourcePaths.join(', ')}`, 'DEBUG');
    logFunction(`[createDebugConfiguration] Absolute source paths: ${absoluteSourcePaths.join(', ')}`, 'DEBUG');
    if (absoluteClassPaths) {
      logFunction(`[createDebugConfiguration] Absolute class paths: ${absoluteClassPaths.join(', ')}`, 'DEBUG');
    } else {
      logFunction(`[createDebugConfiguration] Class paths: <auto-resolve by Java Extension>`, 'DEBUG');
    }
    logFunction(`[createDebugConfiguration] Project name: ${effectiveProjectName}`, 'DEBUG');
    logFunction(`[createDebugConfiguration] Debug port: ${debugPort}`, 'DEBUG');
  }

  const debugConfig: CucumberDebugConfig = {
    type: 'java',
    name: `Attach to ${testName} (port ${debugPort})`,
    request: 'attach',
    hostName: 'localhost',
    port: debugPort,
    timeout: timeout,
    projectName: effectiveProjectName,
    sourcePaths: absoluteSourcePaths
  };

  // ⭐ v11: 只在有提供時才加入 classPaths
  // 如果沒提供,Java Extension 會自動解析完整的 Maven classpath
  if (absoluteClassPaths && absoluteClassPaths.length > 0) {
    debugConfig.classPaths = absoluteClassPaths;
  }

  return debugConfig;
}

/**
 * Create a launch debug configuration for running Cucumber tests
 * This is the v13+ approach that properly supports breakpoints
 * 
 * @param workspaceFolder Workspace folder containing the test
 * @param testClassName Fully qualified test class name (e.g., 'com.example.TestClass')
 * @param testMethodName Optional test method name for specific test
 * @param featureFile Optional feature file path for Cucumber CLI mode
 * @param projectName Maven artifactId or project name
 * @param projectSourcePaths Source paths for the project
 * @param absoluteClassPaths Resolved absolute classpaths (v14: use actual resolved paths, not $Auto)
 * @param logFunction Optional logging function
 */
export function createLaunchDebugConfiguration(
  workspaceFolder: vscode.WorkspaceFolder,
  testClassName: string,
  testMethodName?: string,
  featureFile?: string,
  projectName?: string,
  projectSourcePaths?: string[],
  absoluteClassPaths?: string[],
  logFunction?: (message: string, level?: string) => void
): CucumberLaunchDebugConfig {
  // Use provided source paths or default patterns
  let sourcePaths: string[];
  if (projectSourcePaths && projectSourcePaths.length > 0) {
    sourcePaths = projectSourcePaths;
  } else {
    sourcePaths = [
      'src/test/java',
      'src/main/java',
      '*/src/test/java',
      '*/src/main/java'
    ];
  }

  // Convert to absolute paths
  const absoluteSourcePaths = sourcePaths.map(sp => {
    if (path.isAbsolute(sp)) {
      return sp;
    }
    return path.resolve(workspaceFolder.uri.fsPath, sp);
  });

  const effectiveProjectName = projectName || workspaceFolder.name;

  // v13-v22: Used JUnit Platform Console Launcher (DEPRECATED - didn't work reliably)
  // v23: Use Cucumber CLI directly - bypasses Maven/Surefire/JaCoCo completely
  // This is the proven approach from lucasbiel7/cucumber-java-runner
  const mainClass = 'io.cucumber.core.cli.Main';
  
  // Build test selector arguments
  const args: string[] = [];
  
  if (testClassName && testMethodName) {
    // Run specific test method
    args.push('--select-method', `${testClassName}#${testMethodName}`);
  } else if (testClassName) {
    // Run all tests in class
    args.push('--select-class', testClassName);
  } else if (featureFile) {
    // Fallback: use Cucumber CLI main class for feature files
    // Note: This might require different configuration
    logFunction?.(`⚠️ Feature file mode not fully supported in launch mode yet`, 'WARN');
  }

  // Add output options
  args.push('--reports-dir', 'target/test-reports');
  args.push('--disable-ansi-colors');

  if (logFunction) {
    logFunction(`[createLaunchDebugConfiguration] ⭐ v23: Using Cucumber CLI directly`, 'INFO');
    logFunction(`[createLaunchDebugConfiguration] Main class: ${mainClass}`, 'DEBUG');
    logFunction(`[createLaunchDebugConfiguration] Args: ${args.join(' ')}`, 'DEBUG');
    logFunction(`[createLaunchDebugConfiguration] Project name: ${effectiveProjectName}`, 'DEBUG');
    logFunction(`[createLaunchDebugConfiguration] Source paths: ${absoluteSourcePaths.join(', ')}`, 'DEBUG');
    if (absoluteClassPaths && absoluteClassPaths.length > 0) {
      logFunction(`[createLaunchDebugConfiguration] ⭐ v23: Using ${absoluteClassPaths.length} resolved classpaths`, 'INFO');
      logFunction(`[createLaunchDebugConfiguration] First 3 classpaths: ${absoluteClassPaths.slice(0, 3).join(', ')}`, 'DEBUG');
    } else {
      logFunction(`[createLaunchDebugConfiguration] ⚠️ No classpaths provided, using $Auto (NOT RECOMMENDED)`, 'WARN');
    }
  }

  const launchConfig: CucumberLaunchDebugConfig = {
    type: 'java',
    name: `Debug ${testClassName || 'Cucumber Test'}`,
    request: 'launch',
    mainClass: mainClass,  // ⭐ v23: Changed to Cucumber CLI
    args: args,
    projectName: effectiveProjectName,
    sourcePaths: absoluteSourcePaths,
    // v23: Use programmatically resolved classpaths (from resolveMavenClasspath)
    classPaths: (absoluteClassPaths && absoluteClassPaths.length > 0) ? absoluteClassPaths : ['$Auto'],
    console: 'integratedTerminal',
    cwd: workspaceFolder.uri.fsPath,
    noDebug: false
  };

  return launchConfig;
}

/**
 * v23: Create Launch Mode debug configuration for Cucumber tests
 * This function uses Cucumber CLI directly, bypassing Maven/Surefire/JaCoCo
 * 
 * @param workspaceFolder - VS Code workspace folder
 * @param cucumberArgs - Cucumber CLI arguments (from buildCucumberArgs in maven-utils)
 * @param classPaths - Resolved classpaths (from resolveMavenClasspath in maven-utils)
 * @param isDebug - true for debug mode, false for run mode
 * @param projectName - Maven project name (optional)
 * @param projectSourcePaths - Source paths for debugging (optional)
 * @param logFunction - Logging callback (optional)
 * @returns Debug configuration ready for vscode.debug.startDebugging()
 */
export function createCucumberLaunchConfig(
  workspaceFolder: vscode.WorkspaceFolder,
  cucumberArgs: string[],
  classPaths: string[],
  isDebug: boolean,
  modulePath?: string,
  projectName?: string,
  projectSourcePaths?: string[],
  logFunction?: (message: string, level?: string) => void
): CucumberLaunchDebugConfig {
  // Use provided source paths or default patterns
  let sourcePaths: string[];
  if (projectSourcePaths && projectSourcePaths.length > 0) {
    sourcePaths = projectSourcePaths;
  } else {
    sourcePaths = [
      'src/test/java',
      'src/main/java',
      '*/src/test/java',
      '*/src/main/java'
    ];
  }

  // Convert to absolute paths
  const absoluteSourcePaths = sourcePaths.map(sp => {
    if (path.isAbsolute(sp)) {
      return sp;
    }
    return path.resolve(workspaceFolder.uri.fsPath, sp);
  });

  const effectiveProjectName = projectName || workspaceFolder.name;

  if (logFunction) {
    logFunction(`[createCucumberLaunchConfig] ⭐ v23: Launch Mode with Cucumber CLI`, 'INFO');
    logFunction(`[createCucumberLaunchConfig] Mode: ${isDebug ? 'DEBUG' : 'RUN'}`, 'INFO');
    logFunction(`[createCucumberLaunchConfig] Classpath entries: ${classPaths.length}`, 'INFO');
    logFunction(`[createCucumberLaunchConfig] Cucumber args: ${cucumberArgs.join(' ')}`, 'DEBUG');
    logFunction(`[createCucumberLaunchConfig] First 3 classpaths:`, 'DEBUG');
    classPaths.slice(0, 3).forEach((cp, idx) => {
      logFunction(`  [${idx + 1}] ${cp}`, 'DEBUG');
    });
  }

  // ⭐ v23.32: Use module path as cwd for multi-module projects
  const workingDirectory = modulePath || workspaceFolder.uri.fsPath;
  
  if (logFunction && modulePath) {
    logFunction(`[v23.32] Using module path as cwd: ${modulePath}`, 'INFO');
  }

  const launchConfig: CucumberLaunchDebugConfig = {
    type: 'java',
    name: isDebug ? 'Debug Cucumber Test' : 'Run Cucumber Test',
    request: 'launch',
    mainClass: 'io.cucumber.core.cli.Main',  // ⭐ v23: Cucumber CLI
    args: cucumberArgs,
    projectName: effectiveProjectName,
    sourcePaths: absoluteSourcePaths,
    classPaths: classPaths,
    console: 'integratedTerminal',
    cwd: workingDirectory,  // ⭐ v23.32: Multi-module support
    noDebug: !isDebug  // ⭐ v23: Unified run/debug control
  };

  return launchConfig;
}

/**
 * Wait for debug server to be ready by detecting "Listening for transport" message
 */
export async function waitForDebugServerReady(
  process: ChildProcess,
  timeoutMs: number = 30000
): Promise<void> {
  return new Promise((resolve, reject) => {
    let outputBuffer = '';
    const startTime = Date.now();

    const timeout = setTimeout(() => {
      reject(new Error(
        `Timeout waiting for debug server (${timeoutMs}ms).\n` +
        `Output so far:\n${outputBuffer.substring(0, 500)}`
      ));
    }, timeoutMs);

    const checkOutput = (chunk: Buffer) => {
      const output = chunk.toString();
      outputBuffer += output;
      
      // Log each line for debugging (only non-empty lines)
      const lines = output.split('\n').filter(line => line.trim());
      lines.forEach(line => {
        console.log(`[JDWP-Watch] ${line}`);
      });

      // Detect "Listening for transport dt_socket at address: 5005" pattern
      const readyPattern = /Listening for transport.*at address:\s*(\d+|localhost:\d+)/i;
      const match = output.match(readyPattern);

      if (match) {
        const elapsedTime = Date.now() - startTime;
        clearTimeout(timeout);

        console.log(
          `[waitForDebugServerReady] Debug server ready in ${elapsedTime}ms. ` +
          `Detected: "${match[0]}"`
        );

        // Wait a bit to ensure port is fully ready
        setTimeout(() => resolve(), 500);
      }
    };

    // Listen to both stdout and stderr (Maven may output to either)
    process.stdout?.on('data', checkOutput);
    process.stderr?.on('data', checkOutput);

    process.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Process error: ${err.message}`));
    });

    process.on('exit', (code) => {
      clearTimeout(timeout);
      if (code !== null && code !== 0) {
        reject(new Error(
          `Process exited with code ${code} before debug server was ready.\n` +
          `Output:\n${outputBuffer.substring(0, 500)}`
        ));
      }
    });
  });
}

/**
 * Wait for debug server with progress notification
 */
export async function waitForDebugServerWithProgress(
  process: ChildProcess,
  debugPort: number,
  testName: string
): Promise<void> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Starting debug server for ${testName}`,
      cancellable: true
    },
    async (progress, token) => {
      // Support user cancellation
      token.onCancellationRequested(() => {
        process.kill();
        throw new Error('Debug server wait cancelled by user');
      });

      // Update progress message
      let dots = 0;
      const progressInterval = setInterval(() => {
        dots = (dots + 1) % 4;
        const dotsStr = '.'.repeat(dots);
        progress.report({
          message: `Waiting for Java process on port ${debugPort}${dotsStr}`
        });
      }, 500);

      try {
        const config = vscode.workspace.getConfiguration('cucumberJavaEasyRunner.debug');
        const timeout = config.get<number>('timeout', 30000);

        await waitForDebugServerReady(process, timeout);
        progress.report({ message: 'Ready! Attaching debugger...' });
      } finally {
        clearInterval(progressInterval);
      }
    }
  );
}

/**
 * Start a debug session and attach to the test process
 */
export async function startDebugSession(
  workspaceFolder: vscode.WorkspaceFolder,
  debugPort: number,
  testName: string,
  testRun?: vscode.TestRun,
  projectSourcePaths?: string[],
  projectName?: string,
  projectClassPaths?: string[],
  logFunction?: (message: string, level?: string) => void
): Promise<vscode.DebugSession | undefined> {
  console.log(`[startDebugSession] Initiating debug session for "${testName}" on port ${debugPort}`);
  
  // Check if Java Debug extension is installed
  const javaDebugExt = vscode.extensions.getExtension('vscjava.vscode-java-debug');

  if (!javaDebugExt) {
    console.error(`[startDebugSession] Java Debug Extension not installed`);
    const action = await vscode.window.showErrorMessage(
      'Java Debug Extension (vscjava.vscode-java-debug) is required for debugging.',
      'Install Extension'
    );

    if (action === 'Install Extension') {
      vscode.commands.executeCommand('workbench.extensions.search', 'vscjava.vscode-java-debug');
    }
    return undefined;
  }
  
  console.log(`[startDebugSession] Java Debug Extension found: ${javaDebugExt.id}`);

  const debugConfig = createDebugConfiguration(
    workspaceFolder,
    debugPort,
    testName,
    projectSourcePaths,
    projectName,
    projectClassPaths,
    logFunction
  );
  console.log(`[startDebugSession] Debug configuration:`, JSON.stringify(debugConfig, null, 2));

  const debugOptions: vscode.DebugSessionOptions = testRun ? { testRun } : {};
  console.log(`[startDebugSession] Debug options:`, JSON.stringify(debugOptions));
  
  // List current breakpoints before starting
  const breakpoints = vscode.debug.breakpoints;
  console.log(`[startDebugSession] Current breakpoints count: ${breakpoints.length}`);
  breakpoints.forEach((bp, idx) => {
    if (bp instanceof vscode.SourceBreakpoint) {
      console.log(`  [${idx + 1}] ${bp.location.uri.fsPath}:${bp.location.range.start.line + 1} (enabled: ${bp.enabled})`);
    }
  });

  console.log(`[startDebugSession] Calling vscode.debug.startDebugging()...`);
  const success = await vscode.debug.startDebugging(
    workspaceFolder,
    debugConfig,
    debugOptions
  );

  if (!success) {
    console.error(`[startDebugSession] startDebugging() returned false`);
    throw new Error('Failed to start debug session');
  }
  
  console.log(`[startDebugSession] startDebugging() returned true`);

  // Wait for debug session to be active
  console.log(`[startDebugSession] Waiting for debug session to become active (2s)...`);
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Find the active debug session
  const activeSession = vscode.debug.activeDebugSession;
  if (activeSession) {
    console.log(`[startDebugSession] Active debug session found:`);
    console.log(`  ID: ${activeSession.id}`);
    console.log(`  Name: ${activeSession.name}`);
    console.log(`  Type: ${activeSession.type}`);
    console.log(`  Workspace: ${activeSession.workspaceFolder?.name}`);
    
    // Setup debug event listeners
    const eventDisposables: vscode.Disposable[] = [];
    
    eventDisposables.push(vscode.debug.onDidChangeBreakpoints(e => {
      console.log(`[DebugEvent] Breakpoints changed:`);
      console.log(`  Added: ${e.added.length}, Removed: ${e.removed.length}, Changed: ${e.changed.length}`);
    }));
    
    eventDisposables.push(vscode.debug.onDidTerminateDebugSession(session => {
      if (session.id === activeSession.id) {
        console.log(`[DebugEvent] Debug session terminated: ${session.name}`);
        eventDisposables.forEach(d => d.dispose());
      }
    }));
    
    return activeSession;
  } else {
    console.error(`[startDebugSession] No active debug session found after 2s wait`);
    console.log(`  All sessions:`, vscode.debug.activeDebugSession);
  }

  return undefined;
}

/**
 * Build JDWP arguments for Maven Surefire
 */
export function buildJdwpArgsForMaven(debugPort: number): string {
  const config = vscode.workspace.getConfiguration('cucumberJavaEasyRunner.debug');
  const suspend = config.get<boolean>('suspend', true);

  // Use new JDWP syntax (Java 9+)
  // Note: timeout is not a standard JDWP parameter, removed it
  return [
    'transport=dt_socket',
    'server=y',
    `suspend=${suspend ? 'y' : 'n'}`,
    `address=${debugPort}`  // Use just port number, not localhost:port for newer Java
  ].join(',');
}

/**
 * Build JDWP arguments for direct Java execution
 */
export function buildJdwpArgsForJava(debugPort: number): string {
  const jdwpArgs = buildJdwpArgsForMaven(debugPort);
  return `-agentlib:jdwp=${jdwpArgs}`;
}

/**
 * Handle debug-related errors and provide fallback options
 */
export async function handleDebugError(
  error: Error,
  testProcess?: ChildProcess
): Promise<boolean> {
  console.error('[handleDebugError]', error.message);

  const action = await vscode.window.showErrorMessage(
    `Debug failed: ${error.message}\n\nWould you like to continue running the test without debugging?`,
    'Continue Without Debug',
    'Stop Test'
  );

  if (action === 'Continue Without Debug') {
    // Continue test execution without debug
    return true;
  } else {
    // Stop the test
    if (testProcess) {
      testProcess.kill();
    }
    return false;
  }
}

/**
 * Start a debug session using launch mode (v13+)
 * 
 * Launch mode starts the Java process under debugger control from the beginning,
 * ensuring breakpoints are properly bound before any code execution.
 * 
 * @param workspaceFolder Workspace folder for the debug session
 * @param testClassName Fully qualified test class name
 * @param testMethodName Optional test method name
 * @param featureFile Optional feature file path
 * @param projectName Maven artifactId or project name
 * @param projectSourcePaths Optional custom source paths
 * @param run TestRun instance for output streaming
 * @param logFunction Optional function for logging
 * @returns Active debug session or undefined if failed
 */
export async function startLaunchDebugSession(
  workspaceFolder: vscode.WorkspaceFolder,
  testClassName: string,
  testMethodName?: string,
  featureFile?: string,
  projectName?: string,
  projectSourcePaths?: string[],
  absoluteClassPaths?: string[],  // v14: Add classPaths parameter
  run?: vscode.TestRun,
  logFunction?: (message: string, level?: string) => void
): Promise<vscode.DebugSession | undefined> {
  console.log(`[startLaunchDebugSession] Starting launch mode debug for ${testClassName}`);

  // 1. Check if Java Debug Extension is installed
  const javaDebugExt = vscode.extensions.getExtension('vscjava.vscode-java-debug');
  if (!javaDebugExt) {
    console.error(`[startLaunchDebugSession] Java Debug Extension not installed`);
    vscode.window.showErrorMessage(
      'Java Debug Extension is required for debugging. Please install "Debugger for Java"'
    );
    return undefined;
  }

  // Activate extension if needed
  if (!javaDebugExt.isActive) {
    console.log(`[startLaunchDebugSession] Activating Java Debug Extension...`);
    await javaDebugExt.activate();
  }

  console.log(`[startLaunchDebugSession] Java Debug Extension active: ${javaDebugExt.id}`);

  // 2. Create launch configuration
  const launchConfig = createLaunchDebugConfiguration(
    workspaceFolder,
    testClassName,
    testMethodName,
    featureFile,
    projectName,
    projectSourcePaths,
    absoluteClassPaths,  // v14: Pass resolved classpaths
    logFunction
  );

  console.log(`[startLaunchDebugSession] Launch configuration:`, JSON.stringify(launchConfig, null, 2));

  // 3. Check current breakpoints
  const breakpoints = vscode.debug.breakpoints;
  console.log(`[startLaunchDebugSession] Current breakpoints: ${breakpoints.length}`);
  if (breakpoints.length > 0 && logFunction) {
    logFunction(`Active breakpoints: ${breakpoints.length}`, 'INFO');
    breakpoints.slice(0, 3).forEach(bp => {
      if (bp instanceof vscode.SourceBreakpoint) {
        logFunction(`  - ${path.basename(bp.location.uri.fsPath)}:${bp.location.range.start.line + 1}`, 'DEBUG');
      }
    });
  }

  // 4. Start debugging with launch mode
  console.log(`[startLaunchDebugSession] Calling vscode.debug.startDebugging()...`);

  const debugOptions: vscode.DebugSessionOptions = run ? { testRun: run } : {};
  const started = await vscode.debug.startDebugging(
    workspaceFolder,
    launchConfig,
    debugOptions
  );

  if (!started) {
    console.error(`[startLaunchDebugSession] startDebugging() returned false`);
    return undefined;
  }

  console.log(`[startLaunchDebugSession] startDebugging() succeeded`);

  // 5. Wait for debug session to become active
  console.log(`[startLaunchDebugSession] Waiting for debug session...`);
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Find the active debug session
  const activeSession = vscode.debug.activeDebugSession;
  if (activeSession) {
    console.log(`[startLaunchDebugSession] Active debug session:`);
    console.log(`  - ID: ${activeSession.id}`);
    console.log(`  - Name: ${activeSession.name}`);
    console.log(`  - Type: ${activeSession.type}`);
    console.log(`  - Workspace: ${activeSession.workspaceFolder?.name}`);
  } else {
    console.error(`[startLaunchDebugSession] No active debug session found`);
  }

  return activeSession;
}

