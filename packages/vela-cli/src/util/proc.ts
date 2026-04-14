// Process + filesystem helpers (spawn, exec, pid files).

import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync } from "node:fs";
import { dirname } from "node:path";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command synchronously, capturing output. Never throws. */
export function exec(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): ExecResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: options.input,
    encoding: "utf-8",
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Run a command and stream its output live to the parent terminal. */
export function execLive(
  command: string,
  args: string[],
  options: SpawnOptions & { cwd?: string } = {},
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });
    child.on("exit", (code) => resolve(code ?? -1));
    child.on("error", () => resolve(-1));
  });
}

/** Check if a binary is available on PATH. Returns true if `cmd --version` works. */
export function which(cmd: string): string | null {
  const result = spawnSync("which", [cmd], { encoding: "utf-8" });
  if (result.status === 0 && result.stdout) {
    return result.stdout.trim();
  }
  return null;
}

export function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

export function writeFileEnsure(path: string, content: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, content, "utf-8");
}

export function readPid(pidFile: string): number | null {
  if (!existsSync(pidFile)) return null;
  try {
    const raw = readFileSync(pidFile, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/** Check if a pid is still alive by sending signal 0. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kill a pid gracefully (SIGTERM), fall back to SIGKILL. Returns whether it was alive. */
export function killPid(pid: number): boolean {
  if (!isAlive(pid)) return false;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }
  // Give it a moment to shut down (synchronous wait via busy loop is ugly,
  // but acceptable for a CLI stop command with a 1s budget).
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ignore
  }
  return true;
}

/**
 * Spawn a long-running background process detached from the parent.
 * Writes stdout+stderr to the given log file. Returns the pid.
 */
export function spawnDaemon(
  command: string,
  args: string[],
  options: { cwd: string; logFile: string; env?: NodeJS.ProcessEnv },
): number {
  ensureDir(dirname(options.logFile));
  const out = openSync(options.logFile, "a");
  const err = openSync(options.logFile, "a");
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: true,
    stdio: ["ignore", out, err],
  });
  child.unref();
  if (child.pid === undefined) {
    throw new Error(`Failed to spawn ${command}: no pid`);
  }
  return child.pid;
}
