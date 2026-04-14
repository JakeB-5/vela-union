// gstack adapter for Paperclip
// Enables Paperclip agents to execute gstack skills via Claude Code CLI

import { spawn, execSync } from "node:child_process";
import { homedir, userInfo } from "node:os";
import type { BriefingPack, DispatchResult } from "@vela-union/shared";

/**
 * Build the env to pass to Claude CLI subprocesses. Paperclip's
 * plugin-worker-manager.ts forks plugin workers with a curated env that
 * does NOT include HOME or USER (only NODE_ENV, TZ, NODE_CHANNEL_FD, etc).
 * When our adapter then spawns `claude -p` from inside that plugin worker,
 * the Claude CLI can't find `~/.claude/.credentials.json` and reports
 * "Not logged in · Please run /login".
 *
 * We fix that by explicitly injecting HOME + USER here. os.homedir() falls
 * back to libuv's passwd-database lookup when HOME is unset, so this is
 * robust even when the parent process gave us nothing.
 */
function claudeSpawnEnv(): NodeJS.ProcessEnv {
  const home = process.env["HOME"] || homedir();
  const user = process.env["USER"] || (() => {
    try {
      return userInfo().username;
    } catch {
      return "";
    }
  })();
  return {
    ...process.env,
    HOME: home,
    USER: user,
  };
}

/** Supported gstack skills */
export type GstackSkill = "qa" | "review" | "ship" | "investigate";

export const GSTACK_SKILLS: readonly GstackSkill[] = ["qa", "review", "ship", "investigate"] as const;

/**
 * Hook fired after a skill execution finishes (success or failure).
 * Errors thrown inside the hook are logged to stderr and never block the
 * adapter's main return path. Use this for side effects like graph refresh,
 * decision logging, telemetry, etc.
 */
export type SkillCompleteHook = (
  result: SkillExecutionResult,
) => void | Promise<void>;

/**
 * Hook fired after a goal execution finishes (success or failure).
 * Same fire-and-forget contract as SkillCompleteHook.
 */
export type GoalCompleteHook = (
  result: GoalExecutionResult,
) => void | Promise<void>;

/** Configuration for the gstack adapter */
export interface GstackAdapterConfig {
  /** Skills this adapter supports */
  skills: GstackSkill[];
  /** Path to the claude CLI binary (auto-detected if omitted) */
  claudePath?: string;
  /** Default timeout per execution in milliseconds (default: 300_000 = 5 minutes) */
  timeoutMs?: number;
  /** Browse daemon port for gstack QA (optional) */
  browsePort?: number;
  /** Fired after every executeSkill() call (fire-and-forget) */
  onSkillComplete?: SkillCompleteHook;
  /** Fired after every executeGoal() call (fire-and-forget) */
  onGoalComplete?: GoalCompleteHook;
}

/** Result of a single skill execution */
export interface SkillExecutionResult {
  success: boolean;
  skill: GstackSkill | string;
  output: string;
  durationMs: number;
  timedOut: boolean;
  exitCode: number | null;
}

/** Result of executing a goal via the adapter */
export interface GoalExecutionResult {
  goalId: string;
  success: boolean;
  summary: string;
  output: string;
  durationMs: number;
  timedOut: boolean;
  exitCode: number | null;
}

/** Check if the Claude Code CLI is available */
export function checkClaudeAvailability(claudePath?: string): { available: boolean; path: string | null; version: string | null } {
  const envBin = process.env["VELA_CLAUDE_CLI_BIN"];
  const paths = claudePath
    ? [claudePath]
    : [
        ...(envBin ? [envBin] : []),
        "claude",
        "/usr/local/bin/claude",
        "/usr/bin/claude",
      ];

  for (const p of paths) {
    try {
      const version = execSync(`${p} --version 2>/dev/null`, {
        encoding: "utf-8",
        timeout: 10_000,
      }).trim();
      return { available: true, path: p, version };
    } catch {
      // try next path
    }
  }

  return { available: false, path: null, version: null };
}

/**
 * Run a fire-and-forget completion hook. Errors are logged to stderr but
 * never propagated, so a broken hook can never block the adapter response.
 */
function runHook<T>(
  hookName: string,
  hook: ((result: T) => void | Promise<void>) | undefined,
  result: T,
): void {
  if (!hook) return;
  try {
    const ret = hook(result);
    if (ret && typeof (ret as Promise<void>).catch === "function") {
      (ret as Promise<void>).catch((err: unknown) => {
        process.stderr.write(
          `[gstack-adapter] ${hookName} hook rejected: ${(err as Error).message ?? String(err)}\n`,
        );
      });
    }
  } catch (err) {
    process.stderr.write(
      `[gstack-adapter] ${hookName} hook threw: ${(err as Error).message ?? String(err)}\n`,
    );
  }
}

/** Create a gstack adapter instance */
export function createGstackAdapter(config: GstackAdapterConfig) {
  const timeoutMs = config.timeoutMs ?? 300_000;
  const claudeCheck = checkClaudeAvailability(config.claudePath);

  return {
    adapterType: "gstack_local" as const,
    adapterConfig: config,
    claudeAvailable: claudeCheck.available,
    claudePath: claudeCheck.path,
    claudeVersion: claudeCheck.version,

    /** Check if Claude Code CLI is available */
    async checkAvailability(): Promise<{ available: boolean; path: string | null; version: string | null }> {
      return checkClaudeAvailability(config.claudePath);
    },

    /** Execute a gstack skill in a project */
    async executeSkill(
      skill: string,
      projectPath: string,
      args: string[] = [],
    ): Promise<SkillExecutionResult> {
      const check = checkClaudeAvailability(config.claudePath);
      if (!check.available || !check.path) {
        const failure: SkillExecutionResult = {
          success: false,
          skill,
          output: "Claude Code CLI not found. Install it or provide claudePath in config.",
          durationMs: 0,
          timedOut: false,
          exitCode: null,
        };
        runHook("onSkillComplete", config.onSkillComplete, failure);
        return failure;
      }

      const prompt = `/${skill}${args.length > 0 ? " " + args.join(" ") : ""}`;
      const startTime = Date.now();

      return new Promise<SkillExecutionResult>((resolve) => {
        const chunks: string[] = [];
        let timedOut = false;

        const proc = spawn(check.path!, ["-p", prompt], {
          cwd: projectPath,
          stdio: ["ignore", "pipe", "pipe"],
          env: claudeSpawnEnv(),
          timeout: timeoutMs,
        });

        const timer = setTimeout(() => {
          timedOut = true;
          proc.kill("SIGTERM");
          // Force kill after 10s grace
          setTimeout(() => proc.kill("SIGKILL"), 10_000);
        }, timeoutMs);

        proc.stdout.on("data", (data: Buffer) => {
          chunks.push(data.toString());
        });

        proc.stderr.on("data", (data: Buffer) => {
          chunks.push(data.toString());
        });

        proc.on("close", (exitCode) => {
          clearTimeout(timer);
          const output = chunks.join("");
          const result: SkillExecutionResult = {
            success: exitCode === 0 && !timedOut,
            skill,
            output,
            durationMs: Date.now() - startTime,
            timedOut,
            exitCode,
          };
          runHook("onSkillComplete", config.onSkillComplete, result);
          resolve(result);
        });

        proc.on("error", (err) => {
          clearTimeout(timer);
          const result: SkillExecutionResult = {
            success: false,
            skill,
            output: `Process error: ${err.message}`,
            durationMs: Date.now() - startTime,
            timedOut: false,
            exitCode: null,
          };
          runHook("onSkillComplete", config.onSkillComplete, result);
          resolve(result);
        });
      });
    },

    /** Execute a goal with a briefing pack via Claude Code */
    async executeGoal(
      goalId: string,
      projectPath: string,
      goal: string,
      briefingPrompt: string,
    ): Promise<GoalExecutionResult> {
      const check = checkClaudeAvailability(config.claudePath);
      if (!check.available || !check.path) {
        const failure: GoalExecutionResult = {
          goalId,
          success: false,
          summary: "Claude Code CLI not found",
          output: "Claude Code CLI not found. Install it or provide claudePath in config.",
          durationMs: 0,
          timedOut: false,
          exitCode: null,
        };
        runHook("onGoalComplete", config.onGoalComplete, failure);
        return failure;
      }

      const prompt = briefingPrompt;
      const startTime = Date.now();

      return new Promise<GoalExecutionResult>((resolve) => {
        const chunks: string[] = [];
        let timedOut = false;

        const proc = spawn(check.path!, ["-p", prompt], {
          cwd: projectPath,
          stdio: ["ignore", "pipe", "pipe"],
          env: claudeSpawnEnv(),
        });

        const timer = setTimeout(() => {
          timedOut = true;
          proc.kill("SIGTERM");
          setTimeout(() => proc.kill("SIGKILL"), 10_000);
        }, timeoutMs);

        proc.stdout.on("data", (data: Buffer) => {
          chunks.push(data.toString());
        });

        proc.stderr.on("data", (data: Buffer) => {
          chunks.push(data.toString());
        });

        proc.on("close", (exitCode) => {
          clearTimeout(timer);
          const output = chunks.join("");
          const summary = extractSummary(output, goal);
          const result: GoalExecutionResult = {
            goalId,
            success: exitCode === 0 && !timedOut,
            summary,
            output,
            durationMs: Date.now() - startTime,
            timedOut,
            exitCode,
          };
          runHook("onGoalComplete", config.onGoalComplete, result);
          resolve(result);
        });

        proc.on("error", (err) => {
          clearTimeout(timer);
          const result: GoalExecutionResult = {
            goalId,
            success: false,
            summary: `Process error: ${err.message}`,
            output: `Process error: ${err.message}`,
            durationMs: Date.now() - startTime,
            timedOut: false,
            exitCode: null,
          };
          runHook("onGoalComplete", config.onGoalComplete, result);
          resolve(result);
        });
      });
    },

    /** Dry-run: return what would be sent to Claude Code without executing */
    dryRun(
      projectPath: string,
      goal: string,
      briefingPrompt: string,
    ): { command: string; args: string[]; cwd: string; prompt: string; timeoutMs: number } {
      const check = checkClaudeAvailability(config.claudePath);
      return {
        command: check.path ?? "claude",
        args: ["-p", briefingPrompt],
        cwd: projectPath,
        prompt: briefingPrompt,
        timeoutMs,
      };
    },
  };
}

/** Extract a summary from Claude Code output */
function extractSummary(output: string, goal: string): string {
  if (!output.trim()) {
    return `Goal execution completed but produced no output: ${goal}`;
  }
  // Take last meaningful paragraph as summary
  const lines = output.trim().split("\n").filter((l) => l.trim().length > 0);
  if (lines.length <= 3) {
    return lines.join(" ");
  }
  // Return last 3 lines as summary
  return lines.slice(-3).join(" ");
}

export type GstackAdapter = ReturnType<typeof createGstackAdapter>;
