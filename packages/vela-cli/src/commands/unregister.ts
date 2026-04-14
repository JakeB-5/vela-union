// vela unregister <name> [--no-paperclip]
//
// Removes a project from the local Vela registry (~/.vela/projects.json).
// If the project has a linked paperclipProjectId and Paperclip is reachable,
// also deletes the corresponding Paperclip project via the API.
//
// Graceful degradation: if Paperclip is unreachable, the local entry is
// still removed and a warning is printed. Use --no-paperclip to skip
// the remote deletion entirely.

import {
  getProject,
  removeProject,
  listProjects,
  tryCreatePaperclipClient,
  resolvePaperclipConfig,
  PaperclipApiError,
  PaperclipUnreachableError,
} from "@vela-union/shared";
import { fail, info, ok, warn } from "../util/log.js";
import type { CommandContext } from "../util/context.js";

export async function runUnregister(ctx: CommandContext): Promise<number> {
  const log = ctx.logger;
  const args = ctx.argv;
  log.info("unregister start", { argv: args });

  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (const arg of args) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq === -1) {
        flags[arg.slice(2)] = "true";
      } else {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      }
    } else {
      positional.push(arg);
    }
  }

  const name = positional[0];
  if (!name) {
    log.warn("unregister missing name");
    fail("usage: vela unregister <name> [--no-paperclip]");
    return 1;
  }

  const project = getProject(name);
  if (!project) {
    log.warn("unregister project not found", { name });
    fail(`project not found in registry: ${name}`);
    return 1;
  }

  const skipPaperclip = flags["no-paperclip"] === "true";

  // Attempt remote delete before removing locally so a hard API failure is
  // visible to the caller before any local state changes.
  if (!skipPaperclip && project.paperclipProjectId) {
    const syncLog = log.child("paperclip-sync");
    try {
      const cfg = resolvePaperclipConfig();
      if (!cfg) {
        syncLog.info("paperclip config missing, skipping remote delete");
        warn("no paperclip config — skipping remote project deletion");
      } else {
        const client = await tryCreatePaperclipClient(syncLog);
        if (client) {
          await client.deleteProject(project.paperclipProjectId);
          syncLog.info("paperclip project deleted", {
            paperclipProjectId: project.paperclipProjectId,
          });
          info(`deleted paperclip project: ${project.paperclipProjectId}`);
        }
      }
    } catch (err) {
      if (err instanceof PaperclipUnreachableError) {
        syncLog.warn("paperclip unreachable", { error: err.message });
        warn(`paperclip unreachable — local registry entry will still be removed (${err.message})`);
      } else if (err instanceof PaperclipApiError && err.status === 404) {
        syncLog.info("paperclip project already gone", {
          paperclipProjectId: project.paperclipProjectId,
        });
        info("paperclip project was already deleted");
      } else if (err instanceof PaperclipApiError) {
        syncLog.warn("paperclip api error", { status: err.status, error: err.message });
        warn(`paperclip api error ${err.status} — ${err.message}`);
      } else {
        syncLog.error("paperclip delete failed", err);
        warn(`paperclip delete failed: ${(err as Error).message}`);
      }
    }
  }

  removeProject(name);
  const remaining = listProjects().length;
  log.info("unregister complete", { name, remaining });
  ok(`unregistered ${name}`);
  info(`${remaining} project(s) remaining in registry`);
  return 0;
}
