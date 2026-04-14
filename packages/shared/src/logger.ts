// Unified structured logger for Vela Union.
//
// Every package — CLI, plugin, gateway, worker — routes structured events
// through this module to a single append-only JSONL sink at
// ~/.vela/logs/vela.jsonl. Correlation ids flow through child loggers so a
// single command invocation can be traced end-to-end across processes.
//
// Design rules:
//   - Zero external deps. Node built-ins only.
//   - Never throw: a broken logger must not take down its caller.
//   - Append via fs.appendFileSync with a pre-serialized line. POSIX O_APPEND
//     is atomic for small writes which is enough for our line-based format.
//   - When tty=true also print a human-readable line to stderr (never stdout —
//     stdout may be used for JSON-RPC or CLI output).

import { appendFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  component: string;
  cid: string;
  msg: string;
  data?: Record<string, unknown>;
  duration_ms?: number;
  pid?: number;
  err?: { name: string; message: string; stack?: string };
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, err?: unknown, data?: Record<string, unknown>): void;
  child(subComponent: string, extraCid?: string): Logger;
  time<T>(
    label: string,
    fn: () => Promise<T> | T,
    data?: Record<string, unknown>,
  ): Promise<T>;
  readonly component: string;
  readonly cid: string;
}

export interface LoggerOptions {
  component: string;
  cid?: string;
  level?: LogLevel;
  tty?: boolean;
  sinkPath?: string;
}

// ---------------------------------------------------------------------------
// Constants & config
// ---------------------------------------------------------------------------

export const DEFAULT_SINK_PATH = join(homedir(), ".vela", "logs", "vela.jsonl");

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const MAX_DATA_SIZE_BYTES = 32 * 1024;

// ANSI color helpers (no-op when stderr is not a TTY).
const stderrIsTty = (): boolean => process.stderr.isTTY === true;

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function colorize(text: string, code: string): string {
  if (!stderrIsTty()) return text;
  return `${code}${text}${ANSI.reset}`;
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Short 8-char correlation id. */
export function generateCid(): string {
  return randomUUID().slice(0, 8);
}

/** Parse a LogLevel from user input with a safe fallback to "info". */
export function parseLogLevel(s: string | undefined): LogLevel {
  const v = (s ?? "").toLowerCase();
  if (v === "debug" || v === "info" || v === "warn" || v === "error") return v;
  return "info";
}

// ---------------------------------------------------------------------------
// Internal: sink write + truncation
// ---------------------------------------------------------------------------

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"<unserializable>"';
  }
}

/**
 * Serialize a data payload and truncate if it exceeds MAX_DATA_SIZE_BYTES.
 * Never throws.
 */
function serializeData(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data) return undefined;
  let raw: string;
  try {
    raw = JSON.stringify(data);
  } catch {
    return { _truncated: true, _reason: "unserializable" };
  }
  if (raw.length <= MAX_DATA_SIZE_BYTES) {
    try {
      // Round-trip to normalize and strip non-plain-JSON values.
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { _truncated: true, _reason: "parse-failed" };
    }
  }
  return { _truncated: true, originalSize: raw.length };
}

function ensureSinkDir(sinkPath: string): void {
  try {
    mkdirSync(dirname(sinkPath), { recursive: true });
  } catch {
    // Swallow — we never throw from the logger.
  }
}

function writeSink(sinkPath: string | undefined, line: string): void {
  if (!sinkPath) return;
  try {
    ensureSinkDir(sinkPath);
    appendFileSync(sinkPath, line + "\n", { encoding: "utf-8", flag: "a" });
  } catch {
    // Swallow — logging failures must never crash the caller.
  }
}

// ---------------------------------------------------------------------------
// Internal: TTY rendering
// ---------------------------------------------------------------------------

function levelLabel(level: LogLevel): string {
  const padded = level.toUpperCase().padEnd(5, " ");
  switch (level) {
    case "debug":
      return colorize(padded, ANSI.dim);
    case "info":
      return padded;
    case "warn":
      return colorize(padded, ANSI.yellow);
    case "error":
      return colorize(padded, ANSI.red);
  }
}

function timeLabel(iso: string): string {
  // Extract HH:MM:SS.mmm from the ISO timestamp.
  const m = /T(\d{2}:\d{2}:\d{2}\.\d{3})/.exec(iso);
  const hhmmssms = m ? m[1] : iso;
  return colorize(`[${hhmmssms}]`, ANSI.gray);
}

function cidLabel(cid: string): string {
  return colorize(`[${cid}]`, ANSI.cyan);
}

function componentLabel(component: string): string {
  const padded = component.padEnd(30, " ").slice(0, 30);
  return colorize(padded, ANSI.bold);
}

function formatTtyLine(entry: LogEntry): string {
  const parts: string[] = [
    timeLabel(entry.ts),
    levelLabel(entry.level),
    componentLabel(entry.component),
    cidLabel(entry.cid),
    entry.msg,
  ];
  if (entry.duration_ms !== undefined) {
    parts.push(colorize(`(${entry.duration_ms}ms)`, ANSI.dim));
  }
  if (entry.data && Object.keys(entry.data).length > 0) {
    parts.push(colorize(safeStringify(entry.data), ANSI.dim));
  }
  if (entry.err) {
    parts.push(colorize(`${entry.err.name}: ${entry.err.message}`, ANSI.red));
  }
  return parts.join(" ");
}

function writeTty(entry: LogEntry): void {
  try {
    process.stderr.write(formatTtyLine(entry) + "\n");
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Error normalization
// ---------------------------------------------------------------------------

function normalizeError(err: unknown): LogEntry["err"] {
  if (err === undefined || err === null) return undefined;
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      ...(err.stack ? { stack: err.stack } : {}),
    };
  }
  return { name: "NonError", message: safeStringify(err) };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

interface InternalLoggerState {
  component: string;
  cid: string;
  level: LogLevel;
  tty: boolean;
  sinkPath: string | undefined;
  pid: number;
}

function createLoggerFromState(state: InternalLoggerState): Logger {
  const emit = (
    level: LogLevel,
    msg: string,
    data?: Record<string, unknown>,
    err?: unknown,
    durationMs?: number,
  ): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[state.level]) return;

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      component: state.component,
      cid: state.cid,
      msg,
      pid: state.pid,
    };
    const serialized = serializeData(data);
    if (serialized) entry.data = serialized;
    if (durationMs !== undefined) entry.duration_ms = durationMs;
    const normalizedErr = normalizeError(err);
    if (normalizedErr) entry.err = normalizedErr;

    let line: string;
    try {
      line = JSON.stringify(entry);
    } catch {
      // Last-resort fallback — strip data/err and retry.
      const fallback: LogEntry = {
        ts: entry.ts,
        level: entry.level,
        component: entry.component,
        cid: entry.cid,
        msg: entry.msg,
        pid: entry.pid,
      };
      try {
        line = JSON.stringify(fallback);
      } catch {
        return;
      }
    }

    writeSink(state.sinkPath, line);
    if (state.tty) writeTty(entry);
  };

  const logger: Logger = {
    get component() {
      return state.component;
    },
    get cid() {
      return state.cid;
    },
    debug(msg, data) {
      emit("debug", msg, data);
    },
    info(msg, data) {
      emit("info", msg, data);
    },
    warn(msg, data) {
      emit("warn", msg, data);
    },
    error(msg, err, data) {
      emit("error", msg, data, err);
    },
    child(subComponent, extraCid) {
      const childComponent = subComponent.startsWith(state.component + ".")
        ? subComponent
        : subComponent.includes(".")
          ? subComponent
          : `${state.component}.${subComponent}`;
      return createLoggerFromState({
        ...state,
        component: childComponent,
        cid: extraCid ?? state.cid,
      });
    },
    async time<T>(
      label: string,
      fn: () => Promise<T> | T,
      data?: Record<string, unknown>,
    ): Promise<T> {
      const started = Date.now();
      emit("debug", `${label} start`, data);
      try {
        const result = await fn();
        const durationMs = Date.now() - started;
        emit("info", `${label} ok`, data, undefined, durationMs);
        return result;
      } catch (err) {
        const durationMs = Date.now() - started;
        emit("error", `${label} failed`, data, err, durationMs);
        throw err;
      }
    },
  };

  return logger;
}

export function createLogger(options: LoggerOptions): Logger {
  const state: InternalLoggerState = {
    component: options.component,
    cid: options.cid ?? generateCid(),
    level: options.level ?? "info",
    tty: options.tty === true,
    sinkPath: options.sinkPath === undefined ? DEFAULT_SINK_PATH : options.sinkPath,
    pid: process.pid,
  };
  return createLoggerFromState(state);
}

/**
 * Create a logger whose sink is disabled (no JSONL writes). Useful for tests
 * or --no-log mode. TTY output still respects the tty option.
 */
export function createNoSinkLogger(options: Omit<LoggerOptions, "sinkPath">): Logger {
  return createLogger({ ...options, sinkPath: "" });
}
