// vela prune [--dry-run] [--no-paperclip]
//
// Removes projects from the local registry (~/.vela/projects.json) whose
// path no longer exists on disk. Useful after deleting or moving project
// directories.
//
// --dry-run    Print what would be removed without making any changes.
// --no-paperclip  Skip remote deletion even for projects that have a
//                 linked paperclipProjectId.
//
// Graceful degradation: if Paperclip is unreachable during a prune, the
// local entry is still removed and a per-project warning is printed.

import { existsSync } from "node:fs";
import {
  listProjects,
  removeProject,
  tryCreatePaperclipClient,
  resolvePaperclipConfig,
  PaperclipApiError,
  PaperclipUnreachableError,
} from "@vela-union/shared";
import type { ProjectConfig } from "@vela-union/shared";
import { info, ok, warn } from "../util/log.js";
import type { CommandContext } from "../util/context.js";

export async function runPrune(ctx: CommandContext): Promise<number> {
  const log = ctx.logger;
  const args = ctx.argv;
  log.info("prune start", { argv: args });

  const flags: Record<string, string> = {};
  for (const arg of args) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq === -1) {
        flags[arg.slice(2)] = "true";
      } else {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      }
    }
  }

  const dryRun = flags["dry-run"] === "true";
  const skipPaperclip = flags["no-paperclip"] === "true";

  const all = listProjects();
  const stale: ProjectConfig[] = all.filter((p) => !existsSync(p.path));

  log.info("prune scan", { total: all.length, stale: stale.length });

  if (stale.length === 0) {
    ok("nothing to prune — all registered paths still exist");
    return 0;
  }

  if (dryRun) {
    info(`would remove ${stale.length} project(s):`);
    for (const p of stale) {
      info(`  ${p.name}  ${p.path}`);
    }
    return 0;
  }

  // Build a shared Paperclip client once (best-effort) for batch deletes.
  let paperclipClient: Awaited<ReturnType<typeof tryCreatePaperclipClient>> = null;
  if (!skipPaperclip) {
    try {
      const cfg = resolvePaperclipConfig();
      if (cfg) {
        paperclipClient = await tryCreatePaperclipClient(log);
      }
    } catch {
      // Unexpected — tryCreatePaperclipClient is synchronous internally.
    }
  }

  let removed = 0;
  for (const project of stale) {
    // Attempt remote delete for projects with a Paperclip link.
    if (!skipPaperclip && project.paperclipProjectId && paperclipClient) {
      const syncLog = log.child("paperclip-sync");
      try {
        await paperclipClient.deleteProject(project.paperclipProjectId);
        syncLog.info("paperclip project deleted", {
          name: project.name,
          paperclipProjectId: project.paperclipProjectId,
        });
      } catch (err) {
        if (err instanceof PaperclipApiError && err.status === 404) {
          // Already gone on the remote side — proceed with local removal.
        } else if (err instanceof PaperclipUnreachableError) {
          warn(`paperclip unreachable for ${project.name} — removing locally only`);
        } else if (err instanceof PaperclipApiError) {
          warn(`paperclip error for ${project.name} (${err.status}) — removing locally only`);
        } else {
          warn(`paperclip delete failed for ${project.name} — removing locally only`);
        }
      }
    }

    removeProject(project.name);
    removed++;
    log.info("prune removed", { name: project.name, path: project.path });
    info(`removed ${project.name}  ${project.path}`);
  }

  ok(`pruned ${removed} project(s)`);
  info(`${all.length - removed} project(s) remaining in registry`);
  return 0;
}
