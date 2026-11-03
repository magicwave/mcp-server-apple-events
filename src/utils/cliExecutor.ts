/**
 * @fileoverview Swift CLI execution and JSON response parsing
 * @module utils/cliExecutor
 * @description Executes the EventKitCLI binary for native macOS EventKit operations
 */

import type { ExecFileException } from 'node:child_process';
import { execFile } from 'node:child_process';
import path from 'node:path';
import {
  findSecureBinaryPath,
  getEnvironmentBinaryConfig,
} from './binaryValidator.js';
import { FILE_SYSTEM } from './constants.js';
import { CliUserError } from './errorHandling.js';
import { bufferToString } from './helpers.js';
import { findProjectRoot } from './projectUtils.js';

/**
 * Cached binary path after successful validation
 * Eliminates repeated validation overhead (~1-3ms per call)
 */
let cachedBinaryPath: string | null = null;

/**
 * Maximum wall-clock time EventKitCLI may run before the child is killed
 * (default 30 s, overridable via `EVENTKIT_CLI_TIMEOUT_MS`). `execFile`'s default
 * timeout is 0, "wait forever", which hangs the MCP request and leaks a child when
 * the CLI blocks on an EventKit permission prompt that can never be displayed
 * (headless/launchd context; upstream issue #113). SIGKILL ensures the child
 * cannot ignore the timeout.
 */
const DEFAULT_CLI_TIMEOUT_MS = 30_000;

// Node's timer clamps at 2^31 - 1 ms; larger values would fire immediately.
const MAX_CLI_TIMEOUT_MS = 2_147_483_647;

function resolveCliTimeoutMs(): number {
  const raw = process.env.EVENTKIT_CLI_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_CLI_TIMEOUT_MS;
  const digits = raw.trim().replace(/_/g, '');
  if (!/^\d+$/.test(digits)) return DEFAULT_CLI_TIMEOUT_MS;
  const parsed = Number(digits);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    return DEFAULT_CLI_TIMEOUT_MS;
  return Math.min(parsed, MAX_CLI_TIMEOUT_MS);
}

/**
 * Clears the cached binary path (for testing)
 */
export function clearBinaryPathCache(): void {
  cachedBinaryPath = null;
}

const execFilePromise = (
  cliPath: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; timeoutMs: number }> =>
  new Promise((resolve, reject) => {
    const timeoutMs = resolveCliTimeoutMs();
    execFile(
      cliPath,
      args,
      { timeout: timeoutMs, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error) {
          const execError = error as ExecFileException & {
            stdout?: string | Buffer;
            stderr?: string | Buffer;
            timeoutMs?: number;
          };
          execError.stdout = stdout;
          execError.stderr = stderr;
          execError.timeoutMs = timeoutMs;
          reject(execError);
          return;
        }
        resolve({ stdout, stderr, timeoutMs });
      },
    );
  });

interface CliSuccessResponse<T> {
  status: 'success';
  result: T;
}

interface CliErrorResponse {
  status: 'error';
  message: string;
}

type CliResponse<T> = CliSuccessResponse<T> | CliErrorResponse;

export type PermissionDomain = 'reminders' | 'calendars';

/**
 * Permission error patterns from the Swift CLI
 */
const PERMISSION_ERROR_PATTERNS: Record<PermissionDomain, RegExp[]> = {
  reminders: [
    /reminder permission denied/i,
    /reminders access denied/i,
    /not authorized.*reminders/i,
    /reminder permission is write-only/i,
  ],
  calendars: [
    /calendar permission denied/i,
    /calendar access denied/i,
    /not authorized.*calendar/i,
    /calendar permission is write-only/i,
  ],
};

/**
 * Detects if an error message indicates a permission issue
 * @param message - Error message to check
 * @returns The permission domain if detected, null otherwise
 */
function detectPermissionError(message: string): PermissionDomain | null {
  for (const [domain, patterns] of Object.entries(PERMISSION_ERROR_PATTERNS)) {
    if (patterns.some((pattern) => pattern.test(message))) {
      return domain as PermissionDomain;
    }
  }
  return null;
}

/**
 * Custom error class for permission-related failures
 */
export class CliPermissionError extends Error {
  constructor(
    message: string,
    public readonly domain: PermissionDomain,
  ) {
    super(message);
    this.name = 'CliPermissionError';
  }
}

/**
 * Parses JSON output from CLI
 */
const parseCliOutput = <T>(output: string): T => {
  let parsed: CliResponse<T>;
  try {
    parsed = JSON.parse(output) as CliResponse<T>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `EventKitCLI execution failed: Invalid CLI output - ${detail}`,
    );
  }

  if (parsed.status === 'success') {
    return parsed.result;
  }

  const permissionDomain = detectPermissionError(parsed.message);
  if (permissionDomain) {
    throw new CliPermissionError(parsed.message, permissionDomain);
  }

  throw new CliUserError(parsed.message);
};

const runCli = async <T>(cliPath: string, args: string[]): Promise<T> => {
  try {
    const { stdout } = await execFilePromise(cliPath, args);
    const normalized = bufferToString(stdout);
    if (!normalized) {
      throw new Error('EventKitCLI execution failed: Empty CLI output');
    }
    return parseCliOutput(normalized);
  } catch (error) {
    if (error instanceof CliPermissionError || error instanceof CliUserError) {
      throw error;
    }
    const execError = error as ExecFileException & {
      stdout?: string | Buffer;
      timeoutMs?: number;
    };
    const normalized = bufferToString(execError?.stdout);
    if (normalized) {
      return parseCliOutput(normalized);
    }
    if (execError?.killed && execError.signal === 'SIGKILL') {
      throw new Error(
        `EventKitCLI timed out after ${execError.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS} ms and was killed. ` +
          'Possible causes: an EventKit permission prompt that cannot be displayed ' +
          '(headless/launchd context), a slow operation, or a stalled system. Grant ' +
          'access in System Settings > Privacy & Security if a prompt was expected; ' +
          'otherwise raise EVENTKIT_CLI_TIMEOUT_MS. A write may have completed ' +
          'despite this error; verify before retrying.',
      );
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`EventKitCLI execution failed: ${errorMessage}`);
  }
};

/**
 * Executes the EventKitCLI binary for native macOS EventKit operations
 * @template T - Expected return type from the Swift CLI
 * @param {string[]} args - Array of arguments to pass to the CLI
 * @returns {Promise<T>} Parsed JSON result from the CLI
 * @throws {Error} If binary not found, validation fails, or CLI execution fails
 * @description
 * - Locates binary using secure path validation
 * - Parses JSON response from Swift CLI
 *
 * @security
 * This function prevents shell injection through argument separation:
 *
 * 1. **Uses `execFile()` instead of `exec()`**: The Node.js `child_process.execFile()`
 *    function spawns the process directly without invoking a shell interpreter. This
 *    means shell metacharacters like `;`, `|`, `&`, `$`, `()`, and backticks are
 *    treated as literal text, not as command operators.
 *
 * 2. **Arguments passed as separate array**: Arguments are passed as an array of
 *    discrete strings to the binary, not concatenated into a command string. The
 *    operating system passes each argument directly to the spawned process via
 *    `execve()`, preventing injection through argument boundaries.
 *
 * 3. **Swift CLI ArgumentParser**: The Swift binary uses Swift's ArgumentParser
 *    library, which provides type-safe argument parsing and additional validation
 *    at the native layer.
 *
 * Example of safe handling with malicious input:
 * ```typescript
 * // Even with malicious title containing shell metacharacters
 * await executeCli(['--title', 'test; rm -rf /']);
 * // The semicolon is passed as a literal string to the binary,
 * // NOT interpreted as a command separator
 * ```
 *
 * @example
 * const result = await executeCli<Reminder[]>(['--action', 'read', '--showCompleted', 'true']);
 */
export async function executeCli<T>(args: string[]): Promise<T> {
  // Use cached binary path if available
  if (cachedBinaryPath) {
    return await runCli<T>(cachedBinaryPath, args);
  }

  const projectRoot = findProjectRoot();
  const binaryName = FILE_SYSTEM.SWIFT_BINARY_NAME;
  const possiblePaths = [path.join(projectRoot, 'bin', binaryName)];

  const config = {
    ...getEnvironmentBinaryConfig(),
    allowedPaths: [
      '/bin/EventKitCLI',
      '/dist/swift/bin/',
      '/src/swift/bin/',
      '/swift/bin/',
    ],
  };

  const { path: cliPath } = findSecureBinaryPath(possiblePaths, config);

  if (!cliPath) {
    throw new Error(
      `EventKitCLI binary not found. When installed via npx, the Swift binary must be built manually:

1. Find the npx cache location:
   pnpm store path

2. Navigate to the package and build:
   cd $(pnpm store path)/.pnpm/mcp-server-apple-events@*
   pnpm run build

Alternatively, clone the repository and build locally:
   git clone https://github.com/fradser/mcp-server-apple-events.git
   cd mcp-server-apple-events
   pnpm install
   pnpm build

Then use the local path in your Claude Desktop config:
   "command": "node",
   "args": ["/absolute/path/to/mcp-server-apple-events/bin/run.cjs"]`,
    );
  }

  // Cache the validated path for subsequent calls
  cachedBinaryPath = cliPath;

  return await runCli<T>(cliPath, args);
}
