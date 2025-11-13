/**
 * Maven utilities for classpath resolution and project management
 * v23: Support Launch Mode debugging with programmatic classpath resolution
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

/**
 * Resolve Maven project classpath including all dependencies
 * 
 * This function:
 * 1. Ensures project is compiled (mvn compile test-compile)
 * 2. Resolves all test-scope dependencies (mvn dependency:build-classpath)
 * 3. Returns complete classpath array including:
 *    - target/test-classes
 *    - target/classes
 *    - All Maven dependencies (JARs)
 * 
 * @param projectRoot - Absolute path to Maven project root (containing pom.xml)
 * @param logFunction - Optional logging callback
 * @returns Array of absolute classpath entries
 * 
 * @example
 * const classpaths = await resolveMavenClasspath('/path/to/project');
 * // Returns: [
 * //   '/path/to/project/target/test-classes',
 * //   '/path/to/project/target/classes',
 * //   '/home/user/.m2/repository/io/cucumber/cucumber-java/7.14.0/cucumber-java-7.14.0.jar',
 * //   ... more JARs
 * // ]
 */
export async function resolveMavenClasspath(
  projectRoot: string,
  logFunction?: (message: string, level?: string) => void
): Promise<string[]> {
  const log = (msg: string, level: string = 'INFO') => {
    if (logFunction) {
      logFunction(msg, level);
    }
  };

  log(`[resolveMavenClasspath] Starting classpath resolution for: ${projectRoot}`, 'DEBUG');

  // Create temporary file for classpath output
  const cpFile = path.join(os.tmpdir(), `cucumber-cp-${Date.now()}.txt`);
  log(`[resolveMavenClasspath] Using temp file: ${cpFile}`, 'DEBUG');

  try {
    // ⭐ v23.37: Check if auto-compile is enabled in settings
    const config = vscode.workspace.getConfiguration('cucumberJavaEasyRunner');
    const autoCompile = config.get<boolean>('autoCompileBeforeTest', false);
    
    if (autoCompile) {
      // Step 1: Compile project (if enabled)
      log('[resolveMavenClasspath] Step 1: Compiling project (autoCompileBeforeTest=true)...', 'INFO');
      
      try {
        const compileResult = await execFileAsync(
          'mvn',
          ['compile', 'test-compile', '-q'],
          { cwd: projectRoot, maxBuffer: 10 * 1024 * 1024 }
        );
        
        if (compileResult.stderr && compileResult.stderr.trim().length > 0) {
          log(`[resolveMavenClasspath] Compile warnings: ${compileResult.stderr.substring(0, 200)}`, 'WARN');
        }
        
        log('[resolveMavenClasspath] ✓ Compilation successful', 'INFO');
      } catch (compileError: any) {
        log(`[resolveMavenClasspath] ⚠️ Compilation failed: ${compileError.message}`, 'WARN');
        log('[resolveMavenClasspath] Continuing with classpath resolution...', 'INFO');
        // Continue anyway - dependency resolution might still work
      }
    } else {
      log('[resolveMavenClasspath] ⏭️  Skipping compilation (autoCompileBeforeTest=false)', 'INFO');
      log('[resolveMavenClasspath] 💡 Enable "cucumberJavaEasyRunner.autoCompileBeforeTest" to auto-compile', 'DEBUG');
    }
    
    // Step 2 (or Step 1 if no compile): Resolve dependencies classpath
    const stepNum = autoCompile ? 2 : 1;
    log(`[resolveMavenClasspath] Step ${stepNum}: Resolving dependencies...`, 'INFO');
    
    const mvnArgs = [
      '-q',  // Quiet mode
      '-DincludeScope=test',  // Include test-scope dependencies
      'dependency:build-classpath',
      `-Dmdep.outputFile=${cpFile}`
    ];

    log(`[resolveMavenClasspath] Maven command: mvn ${mvnArgs.join(' ')}`, 'DEBUG');

    const classpathResult = await execFileAsync(
      'mvn',
      mvnArgs,
      { cwd: projectRoot, maxBuffer: 10 * 1024 * 1024 }
    );

    if (classpathResult.stderr && classpathResult.stderr.trim().length > 0) {
      log(`[resolveMavenClasspath] Maven stderr: ${classpathResult.stderr.substring(0, 200)}`, 'DEBUG');
    }

    // Step 3: Read and parse classpath file
    if (!fs.existsSync(cpFile)) {
      throw new Error(`Classpath file not created: ${cpFile}`);
    }

    const depsClasspathRaw = fs.readFileSync(cpFile, 'utf8').trim();
    log(`[resolveMavenClasspath] Read ${depsClasspathRaw.length} bytes from classpath file`, 'DEBUG');

    // Clean up temp file
    try {
      fs.unlinkSync(cpFile);
    } catch (e) {
      // Ignore cleanup errors
    }

    // Step 2: Build complete classpath array
    const delimiter = path.delimiter;  // ':' on Unix, ';' on Windows
    const testClasses = path.join(projectRoot, 'target', 'test-classes');
    const mainClasses = path.join(projectRoot, 'target', 'classes');

    const classpaths: string[] = [];

    // Add project classes first (order matters for Java classpath)
    classpaths.push(testClasses);
    classpaths.push(mainClasses);

    // Add Maven dependencies
    if (depsClasspathRaw && depsClasspathRaw.length > 0) {
      const depPaths = depsClasspathRaw.split(delimiter).filter(p => p.trim().length > 0);
      classpaths.push(...depPaths);
    }

    log(`[resolveMavenClasspath] ✓ Resolved ${classpaths.length} classpath entries`, 'INFO');
    log(`[resolveMavenClasspath] First 3 entries:`, 'DEBUG');
    classpaths.slice(0, 3).forEach((cp, idx) => {
      log(`  [${idx + 1}] ${cp}`, 'DEBUG');
    });

    // Validate critical paths exist
    const missingPaths: string[] = [];
    [testClasses, mainClasses].forEach(p => {
      if (!fs.existsSync(p)) {
        missingPaths.push(p);
      }
    });

    if (missingPaths.length > 0) {
      log(`[resolveMavenClasspath] ⚠️ Warning: Missing compiled classes:`, 'WARN');
      missingPaths.forEach(p => log(`  - ${p}`, 'WARN'));
      log(`[resolveMavenClasspath] Run 'mvn compile test-compile' to fix this`, 'WARN');
    }

    return classpaths;

  } catch (error: any) {
    log(`[resolveMavenClasspath] ❌ Error: ${error.message}`, 'ERROR');
    
    // Fallback: return minimal classpath
    log('[resolveMavenClasspath] Falling back to minimal classpath', 'WARN');
    const testClasses = path.join(projectRoot, 'target', 'test-classes');
    const mainClasses = path.join(projectRoot, 'target', 'classes');
    
    return [testClasses, mainClasses];
  }
}

/**
 * Extract glue package from test class file path
 * 
 * Converts: /path/to/src/test/java/com/example/steps/LoginSteps.java
 * To: com.example.steps
 * 
 * @param testClassPath - Absolute path to test class file
 * @param projectRoot - Project root directory
 * @returns Package name for Cucumber --glue parameter
 */
export function extractGluePackage(testClassPath: string, projectRoot: string): string {
  // Find src/test/java in the path
  const srcTestJava = path.join('src', 'test', 'java');
  const idx = testClassPath.indexOf(srcTestJava);
  
  if (idx === -1) {
    // Fallback: try to extract from relative path
    const relativePath = path.relative(projectRoot, testClassPath);
    const parts = relativePath.split(path.sep);
    
    // Find 'java' directory index
    const javaIdx = parts.indexOf('java');
    if (javaIdx !== -1 && javaIdx < parts.length - 1) {
      // Get package parts after 'java'
      const packageParts = parts.slice(javaIdx + 1, -1); // Exclude filename
      return packageParts.join('.');
    }
    
    // Last resort: return empty (Cucumber will scan all)
    return '';
  }
  
  // Extract package path after src/test/java
  const afterSrcTestJava = testClassPath.substring(idx + srcTestJava.length + 1);
  const packagePath = path.dirname(afterSrcTestJava);
  
  // Convert path separators to package separators
  return packagePath.split(path.sep).join('.');
}

/**
 * Build Cucumber CLI arguments for test execution
 * 
 * @param featurePath - Absolute path to .feature file
 * @param gluePackage - Package containing step definitions (from extractGluePackage)
 * @param lineNumber - Optional scenario line number
 * @param projectRoot - Project root for relative paths in reports
 * @returns Array of Cucumber CLI arguments
 * 
 * @example
 * buildCucumberArgs(
 *   '/project/src/test/resources/features/login.feature',
 *   'com.example.steps',
 *   25
 * )
 * // Returns: [
 * //   '--glue', 'com.example.steps',
 * //   '--plugin', 'pretty',
 * //   '--plugin', 'json:target/cucumber-report.json',
 * //   '/project/src/test/resources/features/login.feature:25'
 * // ]
 */
export function buildCucumberArgs(
  featurePath: string,
  gluePackage: string,
  lineNumber?: number,
  projectRoot?: string
): string[] {
  const args: string[] = [];

  // Add glue package
  if (gluePackage && gluePackage.trim().length > 0) {
    args.push('--glue', gluePackage);
  }

  // Add output plugins
  args.push('--plugin', 'pretty');
  args.push('--plugin', 'html:target/cucumber-reports/cucumber.html');
  args.push('--plugin', 'json:target/cucumber-reports/cucumber.json');

  // Add feature file with optional line number
  const featureArg = lineNumber ? `${featurePath}:${lineNumber}` : featurePath;
  args.push(featureArg);

  return args;
}

/**
 * Validate Maven project structure
 * 
 * @param projectRoot - Path to validate
 * @returns true if valid Maven project (has pom.xml)
 */
export function isValidMavenProject(projectRoot: string): boolean {
  const pomPath = path.join(projectRoot, 'pom.xml');
  return fs.existsSync(pomPath);
}
