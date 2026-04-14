// Log reader utilities for the `vela logs` command.
//
// Reads JSONL entries from ~/.vela/logs/vela.jsonl (or any other sink),
// applies filters (component, cid, level, since/until, grep), and either
// returns all matches or streams new entries as they're appended.

import { existsSync, readFileSync, statSync, watch, openSync, readSync, closeSync } from "node:fs";
import { DEFAULT_SINK_PATH, type LogEntry, type LogLevel } from "./logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LogFilter {
  component?: string;
  componentPrefix?: string;
  cid?: string;
  level?: LogLevel;
  since?: Date;
  until?: Date;
  grep?: string;
  limit?: number;
}

export interface TailHandle {
  stop: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function parseLine(line: string): LogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as LogEntry;
    if (
      typeof parsed.ts === "string" &&
      typeof parsed.level === "string" &&
      typeof parsed.component === "string" &&
      typeof parsed.cid === "string" &&
      typeof parsed.msg === "string"
    ) {
      return parsed;
    }
    return null;
  } catch {
    // Malformed line — warn once on stderr, skip.
    try {
      process.stderr.write(
        `[vela-log-reader] skipping malformed line: ${trimmed.slice(0, 80)}\n`,
      );
    } catch {
      // ignore
    }
    return null;
  }
}

function matches(entry: LogEntry, filter: LogFilter): boolean {
  if (filter.cid && entry.cid !== filter.cid) return false;
  if (filter.component && !entry.component.includes(filter.component)) return false;
  if (filter.componentPrefix && !entry.component.startsWith(filter.componentPrefix))
    return false;
  if (filter.level && LEVEL_ORDER[entry.level] < LEVEL_ORDER[filter.level]) return false;

  if (filter.since || filter.until) {
    const t = Date.parse(entry.ts);
    if (Number.isNaN(t)) return false;
    if (filter.since && t < filter.since.getTime()) return false;
    if (filter.until && t > filter.until.getTime()) return false;
  }

  if (filter.grep) {
    const needle = filter.grep.toLowerCase();
    const hay = [
      entry.msg,
      entry.component,
      entry.data ? JSON.stringify(entry.data) : "",
      entry.err ? `${entry.err.name} ${entry.err.message}` : "",
    ]
      .join(" ")
      .toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// readLogs — one-shot read with filters
// ---------------------------------------------------------------------------

export function readLogs(filter: LogFilter, sinkPath?: string): LogEntry[] {
  const path = sinkPath ?? DEFAULT_SINK_PATH;
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const out: LogEntry[] = [];
  for (const line of raw.split("\n")) {
    const entry = parseLine(line);
    if (!entry) continue;
    if (!matches(entry, filter)) continue;
    out.push(entry);
  }
  if (filter.limit !== undefined && out.length > filter.limit) {
    return out.slice(out.length - filter.limit);
  }
  return out;
}

// ---------------------------------------------------------------------------
// tailLogs — follow-mode streaming
// ---------------------------------------------------------------------------

/**
 * Watch a sink file for appended lines and invoke onEntry for each matching
 * entry. Returns a handle with a stop() method that closes the watcher.
 *
 * Implementation: fs.watch fires on change events. We re-open the file and
 * seek to the last known byte offset, read the delta, and split on newlines.
 * A partial final line is buffered until the next tick.
 */
export function tailLogs(
  filter: LogFilter,
  onEntry: (e: LogEntry) => void,
  sinkPath?: string,
): TailHandle {
  const path = sinkPath ?? DEFAULT_SINK_PATH;

  // Seed offset from current file size so we only emit new lines.
  let offset = 0;
  try {
    if (existsSync(path)) {
      offset = statSync(path).size;
    }
  } catch {
    offset = 0;
  }

  let pending = "";
  let stopped = false;

  const drain = (): void => {
    if (stopped) return;
    if (!existsSync(path)) return;
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return;
    }
    if (size < offset) {
      // File was truncated or rotated — restart from the beginning.
      offset = 0;
      pending = "";
    }
    if (size === offset) return;

    const length = size - offset;
    const buf = Buffer.alloc(length);
    let fd: number | null = null;
    try {
      fd = openSync(path, "r");
      readSync(fd, buf, 0, length, offset);
    } catch {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
      }
      return;
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
      }
    }
    offset = size;

    const text = pending + buf.toString("utf-8");
    const lines = text.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const entry = parseLine(line);
      if (!entry) continue;
      if (!matches(entry, filter)) continue;
      try {
        onEntry(entry);
      } catch {
        // Never let a subscriber error crash the tail loop.
      }
    }
  };

  // Set up watcher. fs.watch can fire rapidly; drain coalesces them.
  let watcher: ReturnType<typeof watch> | null = null;
  try {
    // Watching a missing file throws — fall back to a polling interval.
    if (existsSync(path)) {
      watcher = watch(path, { persistent: true }, () => {
        drain();
      });
    }
  } catch {
    watcher = null;
  }

  // Always run a short polling interval as a safety net. fs.watch is
  // unreliable across filesystems and misses some changes.
  const pollTimer = setInterval(drain, 500);
  if (typeof pollTimer.unref === "function") pollTimer.unref();

  // Initial drain in case the file grew between seeding offset and watcher
  // registration.
  drain();

  return {
    stop: (): void => {
      stopped = true;
      if (watcher) {
        try {
          watcher.close();
        } catch {
          // ignore
        }
      }
      clearInterval(pollTimer);
    },
  };
}
