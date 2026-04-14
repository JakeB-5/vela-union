// vela dispatch <project> <goal...> — create a goal and dispatch it.
//
// Records the goal in ~/.vela/goals.json (for local history) AND — when
// Paperclip is reachable — creates a real Paperclip Issue in the linked
// project and assigns it to the configured default agent. Paperclip's
// own heartbeat system picks up the assigned issue and runs it via its
// agent adapter (typically Claude Code).
//
// Flags:
//   --no-paperclip   skip Paperclip sync (local only)
//   --project-id=<uuid>  override paperclipProjectId
//   --agent-id=<uuid>    override assignee agent

import {
  createGoal,
  getProject,
  updateGoal,
  dispatchViaPaperclip,
  tryCreatePaperclipClient,
  resolvePaperclipConfig,
  PaperclipApiError,
  PaperclipUnreachableError,
} from "@vela-union/shared";
import { fail, info, ok, warn } from "../util/log.js";
import type { CommandContext } from "../util/context.js";

export async function runDispatch(ctx: CommandContext): Promise<number> {
  const log = ctx.logger;
  const raw = ctx.argv;

  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (const arg of raw) {
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
  const [projectName, ...goalParts] = positional;
  log.info("dispatch start", {
    projectName: projectName ?? null,
    goalParts: goalParts.length,
    skipPaperclip: flags["no-paperclip"] === "true",
  });

  if (!projectName || goalParts.length === 0) {
    log.warn("dispatch missing args");
    fail('usage: vela dispatch <project-name> "<goal description>"');
    return 1;
  }
  const project = getProject(projectName);
  if (!project) {
    log.warn("dispatch project not found", { projectName });
    fail(`project not registered: ${projectName}. run 'vela register <path>' first.`);
    return 1;
  }
  const description = goalParts.join(" ");
  log.debug("dispatch resolving", { projectName, projectPath: project.path });
  const goal = createGoal(projectName, description);
  log.info("dispatch queued", {
    goalId: goal.id,
    projectName,
    description,
  });
  ok(`queued goal ${goal.id} for ${projectName}`);
  info(`description: ${description}`);

  // -----------------------------------------------------------------------
  // Paperclip sync (best-effort)
  // -----------------------------------------------------------------------
  const skipPaperclip = flags["no-paperclip"] === "true";
  if (!skipPaperclip) {
    const syncLog = log.child("paperclip");
    try {
      const cfg = resolvePaperclipConfig();
      const client = cfg ? await tryCreatePaperclipClient(syncLog) : null;
      if (!cfg || !client) {
        syncLog.info("paperclip config missing, skipping sync");
        warn("paperclip not configured — run 'vela setup' to enable dashboard sync");
      } else {
        const assigneeAgentId = flags["agent-id"];
        const result = await dispatchViaPaperclip(
          client,
          cfg,
          {
            project,
            goal: description,
            ...(assigneeAgentId ? { assigneeAgentId } : {}),
          },
          syncLog,
        );
        // Link the Vela goal to the Paperclip issue.
        updateGoal(goal.id, {
          status: "executing",
        });
        syncLog.info("paperclip issue created", {
          goalId: goal.id,
          paperclipIssueId: result.paperclipIssueId,
          paperclipProjectId: result.paperclipProjectId,
        });
        ok(`paperclip issue: ${result.paperclipIssueId}`);
        info(`view: ${result.issueUrl}`);
      }
    } catch (err) {
      if (err instanceof PaperclipUnreachableError) {
        syncLog.warn("paperclip unreachable", { error: err.message });
        warn(`paperclip unreachable — local queue only (${err.message})`);
      } else if (err instanceof PaperclipApiError) {
        syncLog.warn("paperclip api error", { status: err.status, error: err.message });
        warn(`paperclip api ${err.status}: ${err.message}`);
      } else {
        syncLog.error("paperclip dispatch sync failed", err);
        warn(`paperclip dispatch sync failed: ${(err as Error).message}`);
      }
    }
  }

  info("execute via Claude Code MCP: vela.list_goals / gstack.dispatch_goal");
  return 0;
}
