// vela logs [options] [component-prefix] — query the unified log sink.
//
// Primary debugging interface. Reads entries from ~/.vela/logs/vela.jsonl,
// applies filters, and either prints a batch or follows the file live.

import {
  readLogs,
  tailLogs,
  parseLogLevel,
  DEFAULT_SINK_PATH,
  type LogEntry,
  type LogFilter,
  type LogLevel,
} from "@vela-union/shared";
import { bold, cyan, dim, red, yellow } from "../util/log.js";
import type { CommandContext } from "../util/context.js";

interface ParsedLogsArgs {
  tail: boolean;
  raw: boolean;
  filter: LogFilter;
  sinkPath: string | undefined;
  helpRequested: boolean;
}

const USAGE = `
${bold("vela logs")} [options] [component-prefix]

${bold("Options:")}
  --cid <id>          Filter by correlation id
  --level <level>     Minimum log level (debug|info|warn|error)
  --since <time>      Filter by time (e.g. "10m", "2h", "3d", ISO datetime)
  --until <time>      Filter by time upper bound
  --grep <pattern>    Substring search across msg, data, component, error
  --limit <n>         Max entries (default: 100, unlimited in --tail)
  --tail, -f          Follow mode — stream new entries as they appear
  --raw               Print raw JSON (default: pretty human format)
  --sink <path>       Read from a non-default sink
  --help, -h          Show this help

${bold("Examples:")}
  vela logs
  vela logs cli.setup
  vela logs cli. --limit 50
  vela logs --cid abc12345
  vela logs --level error --since 24h
  vela logs --tail
  vela logs gateway.tool. --tail
  vela logs --grep graphify
`.trim();

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseTime(value: string, now: Date = new Date()): Date | undefined {
  const m = /^(\d+)([smhd])$/.exec(value);
  if (m) {
    const n = parseInt(m[1] ?? "0", 10);
    const unit = m[2];
    const msMap: Record<string, number> = {
      s: 1000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
    };
    const ms = msMap[unit ?? ""] ?? 0;
    return new Date(now.getTime() - n * ms);
  }
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) return new Date(parsed);
  return undefined;
}

function parseArgs(argv: string[]): ParsedLogsArgs {
  const filter: LogFilter = {};
  let tail = false;
  let raw = false;
  let sinkPath: string | undefined;
  let helpRequested = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === "--help" || arg === "-h") {
      helpRequested = true;
      continue;
    }
    if (arg === "--tail" || arg === "-f") {
      tail = true;
      continue;
    }
    if (arg === "--raw") {
      raw = true;
      continue;
    }
    if (arg === "--cid" || arg.startsWith("--cid=")) {
      filter.cid = arg.includes("=") ? arg.slice("--cid=".length) : argv[++i];
      continue;
    }
    if (arg === "--level" || arg.startsWith("--level=")) {
      const val = arg.includes("=") ? arg.slice("--level=".length) : argv[++i];
      filter.level = parseLogLevel(val);
      continue;
    }
    if (arg === "--since" || arg.startsWith("--since=")) {
      const val = arg.includes("=") ? arg.slice("--since=".length) : argv[++i];
      if (val) filter.since = parseTime(val);
      continue;
    }
    if (arg === "--until" || arg.startsWith("--until=")) {
      const val = arg.includes("=") ? arg.slice("--until=".length) : argv[++i];
      if (val) filter.until = parseTime(val);
      continue;
    }
    if (arg === "--grep" || arg.startsWith("--grep=")) {
      filter.grep = arg.includes("=") ? arg.slice("--grep=".length) : argv[++i];
      continue;
    }
    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const val = arg.includes("=") ? arg.slice("--limit=".length) : argv[++i];
      const n = parseInt(val ?? "", 10);
      if (Number.isFinite(n) && n > 0) filter.limit = n;
      continue;
    }
    if (arg === "--sink" || arg.startsWith("--sink=")) {
      sinkPath = arg.includes("=") ? arg.slice("--sink=".length) : argv[++i];
      continue;
    }
    if (arg.startsWith("--")) {
      // Unknown long flag — swallow to avoid accidentally parsing as component.
      continue;
    }
    // First positional = component prefix or exact substring.
    // If it ends with '.', treat as prefix; otherwise substring.
    if (!filter.componentPrefix && !filter.component) {
      if (arg.endsWith(".")) filter.componentPrefix = arg;
      else filter.component = arg;
    }
  }

  if (!tail && filter.limit === undefined) filter.limit = 100;

  return { tail, raw, filter, sinkPath, helpRequested };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fmtLevel(level: LogLevel): string {
  const padded = level.toUpperCase().padEnd(5, " ");
  switch (level) {
    case "debug":
      return dim(padded);
    case "info":
      return padded;
    case "warn":
      return yellow(padded);
    case "error":
      return red(padded);
  }
}

function fmtTime(iso: string): string {
  const m = /T(\d{2}:\d{2}:\d{2}\.\d{3})/.exec(iso);
  return dim(`[${m ? m[1] : iso}]`);
}

function fmtEntry(entry: LogEntry): string {
  const parts: string[] = [
    fmtTime(entry.ts),
    fmtLevel(entry.level),
    bold(entry.component.padEnd(30, " ").slice(0, 30)),
    cyan(`[${entry.cid}]`),
    entry.msg,
  ];
  if (entry.duration_ms !== undefined) {
    parts.push(dim(`(${entry.duration_ms}ms)`));
  }
  if (entry.data && Object.keys(entry.data).length > 0) {
    try {
      parts.push(dim(JSON.stringify(entry.data)));
    } catch {
      // ignore
    }
  }
  if (entry.err) {
    parts.push(red(`${entry.err.name}: ${entry.err.message}`));
  }
  return parts.join(" ");
}

function printEntry(entry: LogEntry, raw: boolean): void {
  if (raw) {
    try {
      process.stdout.write(JSON.stringify(entry) + "\n");
    } catch {
      // ignore
    }
    return;
  }
  try {
    process.stdout.write(fmtEntry(entry) + "\n");
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function runLogs(ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(ctx.argv);
  if (parsed.helpRequested) {
    console.log(USAGE);
    return 0;
  }

  // Sink resolution order: logs-local --sink > global --sink > default.
  const effectiveSink = parsed.sinkPath ?? ctx.sinkPath;

  ctx.logger.debug("logs query", {
    tail: parsed.tail,
    raw: parsed.raw,
    filter: parsed.filter as Record<string, unknown>,
    sink: effectiveSink ?? DEFAULT_SINK_PATH,
  });

  if (parsed.tail) {
    const handle = tailLogs(
      parsed.filter,
      (e) => printEntry(e, parsed.raw),
      effectiveSink,
    );
    // Keep the process alive indefinitely. Respond to SIGINT cleanly.
    return new Promise<number>((resolve) => {
      const shutdown = (): void => {
        handle.stop();
        resolve(0);
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
  }

  const entries = readLogs(parsed.filter, effectiveSink);
  if (entries.length === 0) {
    const sink = effectiveSink ?? DEFAULT_SINK_PATH;
    console.log(dim(`no matching entries in ${sink}`));
    return 0;
  }
  for (const entry of entries) {
    printEntry(entry, parsed.raw);
  }
  return 0;
}
