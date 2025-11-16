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

/**
 * Find all source paths in a Maven project (supports multi-module projects)
 * 
 * Searches for all `src/test/java` and `src/main/java` directories recursively.
 * Useful for configuring debugger sourcePaths in multi-module projects.
 * 
 * @param projectRoot - Absolute path to project root (workspace root)
 * @param logFunction - Optional logging callback
 * @returns Array of absolute source paths
 * 
 * @example
 * const sourcePaths = await findAllSourcePaths('/workspace');
 * // Returns: [
 * //   '/workspace/src/test/java',
 * //   '/workspace/src/main/java',
 * //   '/workspace/module-a/src/test/java',
 * //   '/workspace/module-a/src/main/java',
 * //   '/workspace/module-b/src/test/java',
 * //   '/workspace/module-b/src/main/java'
 * // ]
 */
export async function findAllSourcePaths(
  projectRoot: string,
  logFunction?: (message: string, level?: string) => void
): Promise<string[]> {
  const log = (msg: string, level: string = 'INFO') => {
    if (logFunction) {
      logFunction(msg, level);
    }
  };

  log(`[findAllSourcePaths] Searching for source paths in: ${projectRoot}`, 'DEBUG');

  const sourcePaths: string[] = [];
  const excludeDirs = new Set(['node_modules', 'target', 'build', '.git', '.svn', 'dist', 'out']);

  /**
   * Recursively search for src/test/java and src/main/java directories
   */
  function searchDirectory(dir: string, depth: number = 0): void {
    // Limit recursion depth to avoid performance issues
    if (depth > 10) {
      return;
    }

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const fullPath = path.join(dir, entry.name);
        
        // Skip excluded directories
        if (excludeDirs.has(entry.name)) {
          continue;
        }

        // Check if this is a source directory
        const relativePath = path.relative(projectRoot, fullPath);
        
        // Match src/test/java or src/main/java patterns
        if (relativePath.endsWith(path.join('src', 'test', 'java')) ||
            relativePath.endsWith(path.join('src', 'main', 'java'))) {
          sourcePaths.push(fullPath);
          log(`[findAllSourcePaths] Found: ${relativePath}`, 'DEBUG');
          // Don't recurse into source directories
          continue;
        }

        // Recurse into subdirectories
        searchDirectory(fullPath, depth + 1);
      }
    } catch (error: any) {
      // Ignore permission errors and continue
      log(`[findAllSourcePaths] Warning: Cannot read directory ${dir}: ${error.message}`, 'DEBUG');
    }
  }

  // Start search from project root
  searchDirectory(projectRoot);

  // Sort paths by depth (deeper paths first - for multi-module priority)
  sourcePaths.sort((a, b) => {
    const depthA = a.split(path.sep).length;
    const depthB = b.split(path.sep).length;
    return depthB - depthA; // Descending order
  });

  log(`[findAllSourcePaths] Found ${sourcePaths.length} source paths`, 'INFO');

  return sourcePaths;
}

// Cache for source paths to avoid repeated filesystem scans
const sourcePathsCache = new Map<string, { paths: string[]; timestamp: number }>();
const CACHE_TTL = 60000; // 1 minute

/**
 * Find all source paths with caching support
 * 
 * Same as findAllSourcePaths but caches results for 1 minute
 * to avoid repeated filesystem scans during the same session.
 * 
 * @param projectRoot - Absolute path to project root
 * @param logFunction - Optional logging callback
 * @returns Array of absolute source paths
 */
export async function findAllSourcePathsCached(
  projectRoot: string,
  logFunction?: (message: string, level?: string) => void
): Promise<string[]> {
  const log = (msg: string, level: string = 'INFO') => {
    if (logFunction) {
      logFunction(msg, level);
    }
  };

  const now = Date.now();
  const cached = sourcePathsCache.get(projectRoot);

  // Check cache validity
  if (cached && (now - cached.timestamp) < CACHE_TTL) {
    log(`[findAllSourcePathsCached] Using cached source paths (${cached.paths.length} entries)`, 'DEBUG');
    return cached.paths;
  }

  // Cache miss or expired - do fresh search
  log(`[findAllSourcePathsCached] Cache miss - performing fresh search`, 'DEBUG');
  const paths = await findAllSourcePaths(projectRoot, logFunction);

  // Update cache
  sourcePathsCache.set(projectRoot, { paths, timestamp: now });

  return paths;
}

/**
 * Convert absolute source paths to VS Code ${workspaceFolder} relative paths
 * 
 * @param absolutePaths - Array of absolute source paths
 * @param workspaceRoot - Workspace root directory
 * @returns Array of ${workspaceFolder} relative paths
 * 
 * @example
 * convertToWorkspaceFolderPaths(
 *   ['/home/user/project/spring/datahunter-system/src/test/java'],
 *   '/home/user/project'
 * )
 * // Returns: ['${workspaceFolder}/spring/datahunter-system/src/test/java']
 */
export function convertToWorkspaceFolderPaths(
  absolutePaths: string[],
  workspaceRoot: string
): string[] {
  return absolutePaths.map(absolutePath => {
    const relativePath = path.relative(workspaceRoot, absolutePath);
    // Convert to forward slashes for consistency
    const normalizedPath = relativePath.split(path.sep).join('/');
    return `\${workspaceFolder}/${normalizedPath}`;
  });
}

/**
 * Build Maven debug command for Cucumber test execution
 * 
 * Generates Maven command with:
 * - Surefire debug mode (-Dmaven.surefire.debug)
 * - Module selection (-pl)
 * - Test class selection (-Dtest=)
 * - Cucumber feature file selection (-Dcucumber.features=)
 * 
 * @param moduleRelativePath - Relative path to module (e.g., 'spring/datahunter-system')
 * @param testClassName - Simple test class name (e.g., 'MktSegmentCriteriaUpdateTest')
 * @param featureRelativePath - Feature file path relative to module's resources
 * @param lineNumber - Optional scenario line number
 * @returns Maven command arguments array
 * 
 * @example
 * buildMavenDebugCommand(
 *   'spring/datahunter-system',
 *   'MktSegmentCriteriaUpdateTest',
 *   'feature/MKT05A06R01-mktSegment_CriteriaUpdate.feature',
 *   17
 * )
 * // Returns: [
 * //   'test',
 * //   '-Dcucumber.features=classpath:feature/MKT05A06R01-mktSegment_CriteriaUpdate.feature:17',
 * //   '-pl', 'spring/datahunter-system',
 * //   '-Dtest=MktSegmentCriteriaUpdateTest',
 * //   '-Dmaven.surefire.debug'
 * // ]
 */
export function buildMavenDebugCommand(
  moduleRelativePath: string,
  testClassName: string,
  featureRelativePath: string,
  lineNumber?: number
): string[] {
  const args: string[] = ['test'];

  // Build cucumber.features parameter
  const featureArg = lineNumber 
    ? `classpath:${featureRelativePath}:${lineNumber}`
    : `classpath:${featureRelativePath}`;
  args.push(`-Dcucumber.features=${featureArg}`);

  // Add module selection (if not root module)
  if (moduleRelativePath !== '.') {
    args.push('-pl', moduleRelativePath);
  }

  args.push('-Dcucumber.plugin=pretty');

  // Add test class selection
  args.push(`-Dtest=${testClassName}`);

  // Enable Surefire debug mode (will listen on port 5005 by default)
  args.push('-Dmaven.surefire.debug');

  // fix execuete twice
  args.push('-Dsurefire.includeJUnit5Engines=cucumber');

  return args;
}

/**
 * Extract feature file path relative to module's test resources
 * 
 * Converts absolute path to classpath-relative path for Maven
 * 
 * @param absoluteFeaturePath - Absolute path to feature file
 * @param moduleRoot - Absolute path to module root
 * @returns Relative path from test/resources (e.g., 'feature/test.feature')
 * 
 * @example
 * extractFeatureRelativePath(
 *   '/project/spring/datahunter-system/src/test/resources/feature/test.feature',
 *   '/project/spring/datahunter-system'
 * )
 * // Returns: 'feature/test.feature'
 */
export function extractFeatureRelativePath(
  absoluteFeaturePath: string,
  moduleRoot: string
): string {
  const resourcesPath = path.join(moduleRoot, 'src', 'test', 'resources');
  
  if (absoluteFeaturePath.startsWith(resourcesPath)) {
    const relativePath = path.relative(resourcesPath, absoluteFeaturePath);
    // Convert to forward slashes for classpath
    return relativePath.split(path.sep).join('/');
  }

  // Fallback: use filename only
  return path.basename(absoluteFeaturePath);
}

/**
 * Extract simple test class name from full path
 * 
 * @param testClassPath - Absolute path to test class file
 * @returns Simple class name without .java extension
 * 
 * @example
 * extractTestClassName('/path/to/MktSegmentCriteriaUpdateTest.java')
 * // Returns: 'MktSegmentCriteriaUpdateTest'
 */
export function extractTestClassName(testClassPath: string): string {
  const fileName = path.basename(testClassPath);
  return fileName.replace(/\.java$/, '');
}
