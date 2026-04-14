// vela status — show state of all 4 Vela Union systems.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { listProjects } from "@vela-union/shared";
import {
  readAllStatuses,
  type BuildStatus,
} from "@vela-union/mcp-gateway/dist/build-queue.js";

import { checkPreflight, detectAll, type SystemStatus } from "../util/detect.js";
import { bold, cyan, dim, green, header, red, yellow } from "../util/log.js";
import type { CommandContext } from "../util/context.js";

function fmtStatus(s: SystemStatus): string {
  const icon =
    s.status === "ok" ? green("\u2713") : s.status === "degraded" ? yellow("~") : red("\u2717");
  const version = s.version ? dim(` v${s.version}`) : "";
  return `  ${icon} ${bold(s.name)}${version} ${dim("—")} ${s.detail}`;
}

const GRAPHIFY_DIR = join(homedir(), ".vela", "graphify");

function graphJsonExists(projectName: string): boolean {
  return existsSync(join(GRAPHIFY_DIR, projectName, "graph.json"));
}

function fmtDuration(ms: number | null): string {
  if (ms === null || ms <= 0) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtAgo(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const delta = Math.max(0, Date.now() - t);
  if (delta < 1000) return "just now";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
}

/**
 * Render the Graphs section — one line per registered project, cross-referenced
 * with ~/.vela/graphify/{project}/status.json written by the build-queue worker.
 */
function printGraphsSection(): void {
  console.log(`\n${bold("Graphs")}`);
  const projects = listProjects();
  if (projects.length === 0) {
    console.log(`  ${dim("(no projects registered — run 'vela register <path>')")}`);
    return;
  }

  const statusesByName = new Map<string, BuildStatus>();
  for (const s of readAllStatuses()) {
    statusesByName.set(s.projectName, s);
  }

  for (const project of projects) {
    const status = statusesByName.get(project.name);
    const hasGraph = graphJsonExists(project.name);

    let icon: string;
    let label: string;
    let detail = "";

    if (status?.state === "built" || (hasGraph && !status)) {
      icon = green("\u2713");
      label = "built";
      const parts: string[] = [];
      const dur = fmtDuration(status?.durationMs ?? null);
      if (dur) parts.push(dur);
      if (parts.length > 0) detail = `(${parts.join(", ")})`;
    } else if (status?.state === "building") {
      icon = yellow("~");
      label = "building";
      const ago = fmtAgo(status.lastAttemptAt);
      if (ago) detail = `(started ${ago})`;
    } else if (status?.state === "failed") {
      icon = red("\u2717");
      label = "failed";
      const err = status.lastError?.slice(0, 60) ?? "";
      detail = err
        ? `(${err}) — see ~/.vela/logs/graph-build.log`
        : `— see ~/.vela/logs/graph-build.log`;
    } else {
      icon = dim("-");
      label = "missing";
      detail = "(not queued)";
    }

    console.log(
      `  ${icon} ${bold(project.name)} ${dim("—")} ${label}${detail ? " " + dim(detail) : ""}`,
    );
  }
}

export async function runStatus(ctx: CommandContext): Promise<number> {
  const log = ctx.logger;
  log.info("status begin");
  header(cyan("Vela Union Status"));

  console.log(`\n${bold("Preflight")}`);
  const pre = checkPreflight();
  log.debug("preflight result", {
    node: pre.node.status,
    pnpm: pre.pnpm.status,
    python: pre.python.status,
    git: pre.git.status,
  });
  console.log(fmtStatus(pre.node));
  console.log(fmtStatus(pre.pnpm));
  console.log(fmtStatus(pre.python));
  console.log(fmtStatus(pre.git));

  console.log(`\n${bold("Systems")}`);
  const all = await log.time("detectAll", () => detectAll());
  log.info("systems detected", {
    paperclip: all.paperclip.status,
    gstack: all.gstack.status,
    graphify: all.graphify.status,
    pageindex: all.pageindex.status,
    mcpGateway: all.mcpGateway.status,
  });
  console.log(fmtStatus(all.paperclip));
  console.log(fmtStatus(all.gstack));
  console.log(fmtStatus(all.graphify));
  console.log(fmtStatus(all.pageindex));
  console.log(fmtStatus(all.mcpGateway));

  try {
    printGraphsSection();
  } catch (err) {
    log.error("graphs section failed", err);
    console.log(`  ${red("\u2717")} graphs section failed: ${(err as Error).message}`);
  }
  console.log();

  const problems = [
    ...Object.values(pre),
    all.paperclip,
    all.gstack,
    all.graphify,
    all.pageindex,
    all.mcpGateway,
  ].filter((s) => s.status !== "ok");

  if (problems.length === 0) {
    log.info("status complete", { issues: 0 });
    console.log(green("All systems nominal."));
    return 0;
  }
  log.warn("status complete with issues", { issues: problems.length });
  console.log(yellow(`${problems.length} issue(s). Run 'vela setup' to fix.`));
  return problems.length > 0 ? 1 : 0;
}
