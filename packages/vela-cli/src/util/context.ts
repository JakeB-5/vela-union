// CommandContext — shared state threaded through every vela subcommand.
//
// Parses the global flags (--verbose, --debug, --quiet, --log-level,
// --cid, --no-log, --sink) out of argv BEFORE the subcommand dispatcher
// sees them and constructs a pre-configured logger.

import { createLogger, generateCid, parseLogLevel } from "@vela-union/shared";
import type { Logger, LogLevel } from "@vela-union/shared";

export interface CommandContext {
  logger: Logger;
  cid: string;
  verbose: boolean;
  quiet: boolean;
  logLevel: LogLevel;
  argv: string[];
  /**
   * Sink path actually used by this command (undefined = default). Exposed
   * so commands like `vela logs` can read back from the same file the
   * upstream logger is writing to.
   */
  sinkPath: string | undefined;
  /** True if --no-log was set (no sink writes at all). */
  noLog: boolean;
}

export interface ParsedGlobalFlags {
  verbose: boolean;
  debug: boolean;
  quiet: boolean;
  logLevel: LogLevel | undefined;
  cid: string | undefined;
  noLog: boolean;
  sinkPath: string | undefined;
  rest: string[];
}

/**
 * Parse global flags from argv. Global flags may appear in any position —
 * we filter them out and return the non-flag argv in `rest`.
 *
 * Supported forms:
 *   --verbose | -v
 *   --debug
 *   --quiet  | -q
 *   --log-level=<level>  OR  --log-level <level>
 *   --cid=<id>           OR  --cid <id>
 *   --sink=<path>        OR  --sink <path>
 *   --no-log
 */
export function parseGlobalFlags(argv: string[]): ParsedGlobalFlags {
  const rest: string[] = [];
  let verbose = false;
  let debug = false;
  let quiet = false;
  let logLevel: LogLevel | undefined;
  let cid: string | undefined;
  let noLog = false;
  let sinkPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === "--verbose" || arg === "-v") {
      verbose = true;
      continue;
    }
    if (arg === "--debug") {
      debug = true;
      continue;
    }
    if (arg === "--quiet" || arg === "-q") {
      quiet = true;
      continue;
    }
    if (arg === "--no-log") {
      noLog = true;
      continue;
    }
    if (arg.startsWith("--log-level=")) {
      logLevel = parseLogLevel(arg.slice("--log-level=".length));
      continue;
    }
    if (arg === "--log-level") {
      const next = argv[i + 1];
      if (next !== undefined) {
        logLevel = parseLogLevel(next);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--cid=")) {
      cid = arg.slice("--cid=".length);
      continue;
    }
    if (arg === "--cid") {
      const next = argv[i + 1];
      if (next !== undefined) {
        cid = next;
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--sink=")) {
      sinkPath = arg.slice("--sink=".length);
      continue;
    }
    if (arg === "--sink") {
      const next = argv[i + 1];
      if (next !== undefined) {
        sinkPath = next;
        i += 1;
      }
      continue;
    }
    rest.push(arg);
  }

  return { verbose, debug, quiet, logLevel, cid, noLog, sinkPath, rest };
}

/**
 * Build a CommandContext from parsed global flags. The logger's component
 * namespace is passed in by the subcommand (e.g. "cli.setup").
 *
 * Resolution rules for tty and level:
 *   --debug  => level=debug, tty=true
 *   --verbose => tty=true, level=flagLevel ?? info
 *   --quiet  => tty=false
 *   --log-level=X => explicit min level
 *   --no-log => sinkPath = "" (disables sink writes)
 */
export function buildContext(
  component: string,
  flags: ParsedGlobalFlags,
): CommandContext {
  const cid = flags.cid ?? generateCid();
  let level: LogLevel;
  if (flags.debug) level = "debug";
  else if (flags.logLevel) level = flags.logLevel;
  else level = "info";

  const tty = flags.quiet ? false : flags.verbose || flags.debug;

  const logger = createLogger({
    component,
    cid,
    level,
    tty,
    sinkPath: flags.noLog ? "" : flags.sinkPath,
  });

  return {
    logger,
    cid,
    verbose: tty,
    quiet: flags.quiet,
    logLevel: level,
    argv: flags.rest,
    sinkPath: flags.sinkPath,
    noLog: flags.noLog,
  };
}
