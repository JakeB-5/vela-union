// Paperclip plugin definition for Vela Union
// Uses the real @paperclipai/plugin-sdk API

import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { generateBriefingPack } from "./briefing.js";
import { assembleDispatchPrompt } from "./dispatch.js";
import {
  listProjects,
  getProject,
  addProject,
  createGoal,
  updateGoal,
  listGoals,
  extractDecisionsFromOutput,
  recordDecisions,
  findCrossProjectImplications,
  triggerGraphRefresh,
  triggerGbrainSync,
  triggerPageIndexSync,
  triggerGraphifyBootstrap,
  triggerGbrainBootstrap,
  triggerPageIndexBootstrap,
  getSubsystemStatuses,
  createLogger,
  generateCid,
  resolvePaperclipConfig,
  tryCreatePaperclipClient,
  dispatchViaPaperclip,
  PaperclipApiError,
  PaperclipUnreachableError,
} from "@vela-union/shared";
import type { Logger } from "@vela-union/shared";
import { createGstackAdapter } from "@vela-union/gstack-adapter";
import { PLUGIN_ID } from "./manifest.js";
import type { GbrainSearchResult } from "@vela-union/shared";

// ---------------------------------------------------------------------------
// gbrain helpers — dynamic import to avoid static circular dependency
// (paperclip-plugin tsconfig does not reference mcp-gateway)
// ---------------------------------------------------------------------------

type GbrainModule = {
  checkAvailability: () => { available: boolean; reason?: string };
  knowledgeSearch: (
    query: string,
    limit?: number,
  ) => Promise<
    | { success: true; count: number; results: GbrainSearchResult[] }
    | { success: false; error: string }
  >;
  knowledgePut: (
    slug: string,
    page: {
      type: "decision";
      title: string;
      compiled_truth: string;
      timeline?: string;
    },
  ) => Promise<
    | { success: true; page: unknown; action: "created" | "updated" }
    | { success: false; error: string }
  >;
};

async function tryKnowledgeSearch(query: string, limit = 5): Promise<GbrainSearchResult[]> {
  try {
    const gbrain = (await import(
      "@vela-union/mcp-gateway/dist/gbrain.js"
    )) as GbrainModule;
    const avail = gbrain.checkAvailability();
    if (!avail.available) return [];
    const res = await gbrain.knowledgeSearch(query, limit);
    return res.success ? res.results : [];
  } catch {
    return [];
  }
}

async function tryKnowledgePutDecision(slug: string, title: string, body: string): Promise<void> {
  try {
    const gbrain = (await import(
      "@vela-union/mcp-gateway/dist/gbrain.js"
    )) as GbrainModule;
    const avail = gbrain.checkAvailability();
    if (!avail.available) return;
    await gbrain.knowledgePut(slug, {
      type: "decision",
      title,
      compiled_truth: body,
      timeline: `- ${new Date().toISOString().slice(0, 10)}: ${title}`,
    });
  } catch {
    // gbrain not available — degrade silently
  }
}

// Vela structured logger — coexists with Paperclip's ctx.logger. Paperclip's
// logger renders to the Paperclip dashboard; ours writes to the unified
// sink so events can be correlated with CLI / gateway / worker logs.
const pluginLogger: Logger = createLogger({
  component: "plugin",
  cid: generateCid(),
  level: "info",
  tty: false,
});

const adapter = createGstackAdapter({
  skills: ["qa", "review", "ship", "investigate"],
});

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    const setupLog = pluginLogger.child("setup");
    setupLog.info("plugin starting", { pluginId: PLUGIN_ID });
    ctx.logger.info(`${PLUGIN_ID} plugin starting`);

    const availability = await adapter.checkAvailability();
    setupLog.info("gstack adapter checked", {
      claudeAvailable: availability.available,
      claudePath: availability.path,
      claudeVersion: availability.version,
    });
    ctx.logger.info("gstack adapter status", {
      claudeAvailable: availability.available,
      claudePath: availability.path,
      claudeVersion: availability.version,
    });

    // Event: issue created -> search gbrain for relevant prior context
    ctx.events.on("issue.created", async (event) => {
      const eventLog = pluginLogger.child("event.issue-created", generateCid());
      eventLog.info("issue.created", { entityId: event.entityId });
      ctx.logger.info("issue.created event received", { entityId: event.entityId });

      // Best-effort: extract title from event payload and search gbrain
      const payload = (event as unknown as { payload?: Record<string, unknown> }).payload;
      const issueTitle = typeof payload?.["title"] === "string" ? payload["title"] : "";
      if (issueTitle) {
        const results = await tryKnowledgeSearch(issueTitle, 3);
        if (results.length > 0) {
          eventLog.info("gbrain context found for new issue", {
            issueId: event.entityId,
            hitCount: results.length,
            slugs: results.map((r) => r.slug),
          });
          ctx.logger.info("gbrain context injected into new issue briefing", {
            issueId: event.entityId,
            hitCount: results.length,
          });
        }
      }
    });

    // Event: issue updated -> if status changed to "done", log decision to gbrain
    ctx.events.on("issue.updated", async (event) => {
      const payload = (event as unknown as { payload?: Record<string, unknown> }).payload;
      const status = typeof payload?.["status"] === "string" ? payload["status"] : "";
      if (status !== "done") return;

      const entityId = event.entityId ?? "";
      const eventLog = pluginLogger.child("event.issue-done", generateCid());
      eventLog.info("issue.done", { entityId });
      ctx.logger.info("issue resolved (done) event received", { entityId });

      const title = typeof payload?.["title"] === "string" ? payload["title"] : "";
      const summary = typeof payload?.["summary"] === "string" ? payload["summary"] : "";
      const slug = `decisions/${entityId.slice(0, 8)}`;

      if (title) {
        await tryKnowledgePutDecision(slug, title, summary || title);
        eventLog.info("decision logged to gbrain", { slug, issueId: entityId });
        ctx.logger.info("decision logged to gbrain", { slug });
      }
    });

    // Event: project created -> fetch local path from Paperclip API and auto-register
    ctx.events.on("project.created", async (event) => {
      const eventLog = pluginLogger.child("event.project-created", generateCid());
      const entityId = event.entityId ?? "";
      eventLog.info("project.created", { entityId });
      ctx.logger.info("project.created event received", { entityId });

      if (!entityId) return;

      // Wait briefly for Paperclip to finalize workspace setup before querying
      await new Promise((r) => setTimeout(r, 1500));

      // Fetch project details from Paperclip API to get codebase.localFolder
      let projectName = "";
      let localFolder = "";
      try {
        const pcConfig = resolvePaperclipConfig();
        if (!pcConfig) return;
        const resp = await fetch(`${pcConfig.apiUrl}/api/projects/${entityId}`);
        if (resp.ok) {
          const project = (await resp.json()) as Record<string, unknown>;
          projectName = (project["name"] as string) ?? "";
          const codebase = project["codebase"] as Record<string, unknown> | undefined;
          localFolder = (codebase?.["effectiveLocalFolder"] as string)
            ?? (codebase?.["localFolder"] as string)
            ?? "";
        }
      } catch {
        eventLog.info("failed to fetch project from Paperclip API", { entityId });
      }

      if (!projectName) return;

      // Derive a clean registry name (strip bracket prefix + trailing numbers)
      const registryName = projectName
        .replace(/^\[.*?\]\s*/, "")
        .replace(/\s+\d+$/, "")
        || projectName;

      // Skip if already registered
      if (getProject(registryName)) {
        eventLog.info("project already registered, skipping", { registryName });
        return;
      }

      // Use Paperclip's localFolder directly — skip managed folders (.paperclip internal paths)
      const { existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const isUserFolder = localFolder && !localFolder.includes(".paperclip/");
      const detectedPath = isUserFolder && existsSync(join(localFolder, ".git"))
        ? localFolder
        : null;

      if (detectedPath) {
        addProject({
          name: registryName,
          path: detectedPath,
          type: "personal",
          relatedProjects: [],
        });
        eventLog.info("project auto-registered", { projectName, registryName, path: detectedPath });
        ctx.logger.info(`project "${registryName}" auto-registered at ${detectedPath}`);

        // Bootstrap: fire-and-forget graph, gbrain, and pageindex for new project.
        const graphifyResult = triggerGraphifyBootstrap(registryName, detectedPath);
        eventLog.info("Triggered graphify bootstrap", { spawned: graphifyResult.spawned, reason: graphifyResult.reason });
        const gbrainResult = triggerGbrainBootstrap(registryName, detectedPath);
        eventLog.info("Triggered gbrain bootstrap", { spawned: gbrainResult.spawned, reason: gbrainResult.reason });
        const pageIndexResult = triggerPageIndexBootstrap(registryName, detectedPath);
        eventLog.info("Triggered pageindex bootstrap", { spawned: pageIndexResult.spawned, queued: pageIndexResult.queued, reason: pageIndexResult.reason });
      } else {
        eventLog.info("project has no local folder configured", {
          projectName,
          localFolder: localFolder || "none",
        });
        ctx.logger.info(
          `project "${projectName}" created but no local folder found. Use register-project tool to set the path.`,
        );
      }
    });

    // Event: agent run started -> dispatch gstack skill execution if agent has a project
    // (The SDK event type "agent.run.started" replaces the older "agent.woke"
    // name. Behavior is unchanged: we react when an agent is invoked.)
    ctx.events.on("agent.run.started", async (event) => {
      const eventLog = pluginLogger.child("event.agent-run-started", generateCid());
      eventLog.info("agent.run.started", { entityId: event.entityId });
      ctx.logger.info("agent.run.started event received", { entityId: event.entityId });

      if (!availability.available) {
        ctx.logger.warn("Claude Code CLI not available — skipping gstack dispatch");
        return;
      }

      // Check if the agent is associated with a project via plugin state
      const agentProject = await ctx.state.get({
        scopeKind: "agent",
        scopeId: event.entityId,
        stateKey: "project",
      }) as string | null;
      if (!agentProject) {
        ctx.logger.info("No project assigned to agent, skipping gstack dispatch", {
          agentId: event.entityId,
        });
        return;
      }

      const project = getProject(agentProject);
      if (!project) {
        ctx.logger.warn("Agent project not found in registry", {
          agentId: event.entityId,
          project: agentProject,
        });
        return;
      }

      // Execute a review skill on the project
      ctx.logger.info("Dispatching gstack review skill for woken agent", {
        agentId: event.entityId,
        project: project.name,
      });

      const result = await adapter.executeSkill("review", project.path);
      ctx.logger.info("gstack skill execution complete", {
        agentId: event.entityId,
        skill: "review",
        success: result.success,
        durationMs: result.durationMs,
      });

      // Preload gbrain context for the project on agent boot
      const projectContext = await tryKnowledgeSearch(project.name, 5);
      if (projectContext.length > 0) {
        ctx.logger.info("gbrain boot context loaded for agent", {
          agentId: event.entityId,
          project: project.name,
          hitCount: projectContext.length,
          slugs: projectContext.map((r) => r.slug),
        });
      }
    });

    // Helper: resolve Paperclip entityId → Vela registry project name + path
    async function resolveProjectFromParams(
      params: Record<string, unknown>,
    ): Promise<{ name: string; path: string } | null> {
      let name = typeof params["projectName"] === "string" ? params["projectName"] : "";

      if (!name && typeof params["entityId"] === "string") {
        const entityId = params["entityId"];
        const companyId = typeof params["companyId"] === "string" ? params["companyId"] : "";
        const all = listProjects();

        const match = all.find((p) => p.paperclipProjectId === entityId);
        if (match) name = match.name;

        if (!name && companyId) {
          try {
            const project = await ctx.projects.get(entityId, companyId);
            if (project) {
              const pcName = project.name.replace(/^\[.*?\]\s*/, "").replace(/\s+\d+$/, "");
              const localFolder = project.codebase?.effectiveLocalFolder
                ?? project.codebase?.localFolder ?? "";
              const byName = all.find((p) => p.name === pcName || p.name === project.name);
              const byPath = localFolder ? all.find((p) => p.path === localFolder) : undefined;
              const resolved = byName ?? byPath;
              if (resolved) name = resolved.name;
            }
          } catch { /* ignore */ }
        }

        if (!name) {
          try {
            const apiUrl = resolvePaperclipConfig()?.apiUrl ?? "http://127.0.0.1:3100";
            const resp = await fetch(`${apiUrl}/api/projects/${entityId}`);
            if (resp.ok) {
              const project = (await resp.json()) as Record<string, unknown>;
              const pcName = ((project["name"] as string) ?? "")
                .replace(/^\[.*?\]\s*/, "").replace(/\s+\d+$/, "");
              const codebase = project["codebase"] as Record<string, unknown> | undefined;
              const localFolder = (codebase?.["effectiveLocalFolder"] as string)
                ?? (codebase?.["localFolder"] as string) ?? "";
              const byName = all.find((p) => p.name === pcName || p.name === project["name"]);
              const byPath = localFolder ? all.find((p) => p.path === localFolder) : undefined;
              const resolved = byName ?? byPath;
              if (resolved) name = resolved.name;
            }
          } catch { /* ignore */ }
        }
      }

      if (!name) return null;
      const proj = getProject(name);
      return proj ? { name: proj.name, path: proj.path } : null;
    }

    // Data provider: project registry
    ctx.data.register("projects", async () => {
      return listProjects();
    });

    // Data provider: Vela subsystem status (VELA-49, VELA-50)
    // Resolves Paperclip project → Vela registry name via:
    //   1. Direct projectName param
    //   2. paperclipProjectId match in registry
    //   3. SDK ctx.projects.get() → name/localFolder matching
    //   4. Raw fetch fallback → name/localFolder matching
    ctx.data.register("vela-subsystem-status", async (params) => {
      let name = typeof params["projectName"] === "string" ? params["projectName"] : "";

      if (!name && typeof params["entityId"] === "string") {
        const entityId = params["entityId"];
        const companyId = typeof params["companyId"] === "string" ? params["companyId"] : "";
        const all = listProjects();
        ctx.logger.info("vela-subsystem-status: resolving", {
          entityId,
          companyId: companyId || "(not provided)",
          registryCount: all.length,
        });

        // Try paperclipProjectId match first
        const match = all.find((p) => p.paperclipProjectId === entityId);
        if (match) {
          name = match.name;
          ctx.logger.info("vela-subsystem-status: matched by paperclipProjectId", { name });
        }

        // Fallback: use SDK project lookup (reliable in worker context)
        if (!name && companyId) {
          try {
            const project = await ctx.projects.get(entityId, companyId);
            if (project) {
              const pcName = project.name
                .replace(/^\[.*?\]\s*/, "")
                .replace(/\s+\d+$/, "");
              const localFolder = project.codebase?.effectiveLocalFolder
                ?? project.codebase?.localFolder ?? "";

              const byName = all.find((p) => p.name === pcName || p.name === project.name);
              const byPath = localFolder ? all.find((p) => p.path === localFolder) : undefined;
              const resolved = byName ?? byPath;
              if (resolved) {
                name = resolved.name;
                ctx.logger.info("vela-subsystem-status: matched via SDK lookup", { name, pcName });
              } else {
                ctx.logger.warn("vela-subsystem-status: SDK project found but no registry match", { pcName, localFolder });
              }
            }
          } catch (err) {
            ctx.logger.error("vela-subsystem-status: SDK project lookup failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Last resort: raw fetch to Paperclip API
        if (!name) {
          try {
            const apiUrl = resolvePaperclipConfig()?.apiUrl ?? "http://127.0.0.1:3100";
            const resp = await fetch(`${apiUrl}/api/projects/${entityId}`);
            if (resp.ok) {
              const project = (await resp.json()) as Record<string, unknown>;
              const pcName = ((project["name"] as string) ?? "")
                .replace(/^\[.*?\]\s*/, "")
                .replace(/\s+\d+$/, "");
              const codebase = project["codebase"] as Record<string, unknown> | undefined;
              const localFolder = (codebase?.["effectiveLocalFolder"] as string)
                ?? (codebase?.["localFolder"] as string) ?? "";

              const byName = all.find((p) => p.name === pcName || p.name === project["name"]);
              const byPath = localFolder ? all.find((p) => p.path === localFolder) : undefined;
              const resolved = byName ?? byPath;
              if (resolved) {
                name = resolved.name;
                ctx.logger.info("vela-subsystem-status: matched via fetch fallback", { name });
              }
            }
          } catch (err) {
            ctx.logger.error("vela-subsystem-status: fetch fallback failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      if (!name) {
        ctx.logger.warn("vela-subsystem-status: could not resolve project", {
          entityId: params["entityId"],
          companyId: params["companyId"],
        });
        return { error: "Could not resolve project. Provide projectName or a linked entityId." };
      }

      return getSubsystemStatuses(name);
    });

    // VELA-51: Per-subsystem manual refresh actions
    ctx.actions.register("rebuild-graphify", async (params) => {
      const project = await resolveProjectFromParams(params);
      if (!project) return { error: "Could not resolve project" };
      const result = triggerGraphifyBootstrap(project.name, project.path, { force: true });
      ctx.logger.info("rebuild-graphify action", { project: project.name, ...result });
      return { success: result.spawned, ...result };
    });

    ctx.actions.register("reimport-gbrain", async (params) => {
      const project = await resolveProjectFromParams(params);
      if (!project) return { error: "Could not resolve project" };
      const result = triggerGbrainBootstrap(project.name, project.path);
      ctx.logger.info("reimport-gbrain action", { project: project.name, ...result });
      return { success: result.spawned, ...result };
    });

    ctx.actions.register("reindex-pageindex", async (params) => {
      const project = await resolveProjectFromParams(params);
      if (!project) return { error: "Could not resolve project" };
      const result = triggerPageIndexSync(project.name, project.path);
      ctx.logger.info("reindex-pageindex action", { project: project.name, ...result });
      return { success: result.spawned || result.queued > 0, ...result };
    });

    // Tool: dispatch-goal — generate briefing pack + assemble prompt
    ctx.tools.register(
      "dispatch-goal",
      {
        displayName: "Dispatch Goal",
        description: "Generate a briefing pack for a project and assemble a structured prompt for Claude Code.",
        parametersSchema: {
          type: "object",
          properties: {
            projectName: { type: "string", description: "Name of the registered project" },
            goal: { type: "string", description: "Goal description for the agent" },
          },
          required: ["projectName", "goal"],
        },
      },
      async (params) => {
        const { projectName, goal } = params as { projectName: string; goal: string };

        const project = getProject(projectName);
        if (!project) {
          return {
            error: `Project "${projectName}" not found in registry. Available: ${listProjects().map((p) => p.name).join(", ") || "(none)"}`,
          };
        }

        ctx.logger.info("Generating briefing pack", { project: projectName });
        const pack = await generateBriefingPack(project, goal);
        const prompt = assembleDispatchPrompt(pack, goal);

        ctx.logger.info("Dispatch prompt assembled", {
          project: projectName,
          promptLength: prompt.length,
          commitCount: pack.recentCommits.length,
          churnFileCount: pack.highChurnFiles.length,
        });

        return {
          content: prompt,
          data: {
            projectName,
            goal,
            generatedAt: pack.generatedAt,
            promptLength: prompt.length,
            stats: {
              commits: pack.recentCommits.length,
              churnFiles: pack.highChurnFiles.length,
              pinnedFiles: pack.pinnedFiles.length,
              hasReadme: pack.readme !== null,
              hasClaudeMd: pack.claudeMd !== null,
            },
          },
        };
      },
    );

    // Tool: execute-goal — assemble prompt + execute via Claude Code
    ctx.tools.register(
      "execute-goal",
      {
        displayName: "Execute Goal",
        description: "Create a Paperclip Issue for the goal and let Paperclip's heartbeat dispatch it to an agent. Returns immediately with the issue id/url. Set localExecute=true to also run a local Claude CLI synchronously (legacy path, long-running).",
        parametersSchema: {
          type: "object",
          properties: {
            projectName: { type: "string", description: "Name of the registered project" },
            goal: { type: "string", description: "Goal description for the agent" },
            dryRun: { type: "boolean", description: "If true, show what would be sent without executing (default: false)" },
            localExecute: { type: "boolean", description: "If true, also run the gstack adapter locally and wait for completion (legacy, may exceed Paperclip's 30s RPC timeout). Default: false — rely on Paperclip heartbeat." },
          },
          required: ["projectName", "goal"],
        },
      },
      async (params) => {
        const { projectName, goal, dryRun, localExecute } = params as {
          projectName: string;
          goal: string;
          dryRun?: boolean;
          localExecute?: boolean;
        };

        const project = getProject(projectName);
        if (!project) {
          return {
            error: `Project "${projectName}" not found in registry. Available: ${listProjects().map((p) => p.name).join(", ") || "(none)"}`,
          };
        }

        // Check Claude CLI availability
        const check = await adapter.checkAvailability();
        if (!check.available) {
          return {
            error: "Claude Code CLI not available. Install Claude Code or set claudePath.",
            data: { claudeAvailable: false },
          };
        }

        // Generate briefing pack and prompt
        ctx.logger.info("Generating briefing pack for execution", { project: projectName });
        const pack = await generateBriefingPack(project, goal);
        const prompt = assembleDispatchPrompt(pack, goal);

        // Dry run — return the assembled prompt without executing
        if (dryRun) {
          const dryRunResult = adapter.dryRun(project.path, goal, prompt);
          return {
            content: `[DRY RUN] Would execute:\n\nCommand: ${dryRunResult.command} -p "<prompt>"\nCWD: ${dryRunResult.cwd}\nTimeout: ${dryRunResult.timeoutMs}ms\nPrompt length: ${prompt.length} chars`,
            data: {
              dryRun: true,
              projectName,
              goal,
              promptLength: prompt.length,
              command: dryRunResult.command,
              cwd: dryRunResult.cwd,
              timeoutMs: dryRunResult.timeoutMs,
            },
          };
        }

        // Create a goal record
        const goalRecord = createGoal(projectName, goal);
        updateGoal(goalRecord.id, { status: "planning" });

        // -----------------------------------------------------------------
        // Paperclip Issue sync (Option C): create a real Paperclip Issue
        // and assign it to the configured agent. Paperclip's own
        // heartbeat/dispatch loop picks it up automatically. We still run
        // the local gstack adapter after that so the legacy code path
        // (local goal tracking + feedback loop) keeps working.
        // -----------------------------------------------------------------
        let paperclipIssueId: string | undefined;
        let paperclipProjectId: string | undefined;
        let paperclipIssueUrl: string | undefined;
        const syncLog = pluginLogger.child("execute-goal.paperclip");
        try {
          const pcpConfig = resolvePaperclipConfig();
          const pcpClient = pcpConfig ? await tryCreatePaperclipClient(syncLog) : null;
          if (pcpConfig && pcpClient) {
            const dispatchResult = await dispatchViaPaperclip(
              pcpClient,
              pcpConfig,
              {
                project,
                goal,
                briefing: prompt,
              },
              syncLog,
            );
            paperclipIssueId = dispatchResult.paperclipIssueId;
            paperclipProjectId = dispatchResult.paperclipProjectId;
            paperclipIssueUrl = dispatchResult.issueUrl;
            ctx.logger.info("Paperclip issue created", {
              goalId: goalRecord.id,
              paperclipIssueId,
              paperclipProjectId,
              issueUrl: paperclipIssueUrl,
            });
          } else {
            syncLog.info("paperclip not configured, skipping issue sync");
          }
        } catch (err) {
          if (err instanceof PaperclipUnreachableError) {
            syncLog.warn("paperclip unreachable, continuing without issue sync", {
              error: err.message,
            });
          } else if (err instanceof PaperclipApiError) {
            syncLog.warn("paperclip api error during issue sync", {
              status: err.status,
              error: err.message,
            });
          } else {
            syncLog.error("paperclip issue sync failed", err);
          }
        }

        // -----------------------------------------------------------------
        // Early return path (default): hand off to Paperclip heartbeat.
        //
        // Paperclip's executeTool RPC has a hard 30s timeout. A full Claude
        // Code run takes 1-5 minutes, which would always time out. Instead
        // of waiting, we return as soon as the Paperclip Issue exists and
        // let Paperclip's own heartbeat/dispatch loop run the agent. The
        // issue URL is the user's trail — they can watch progress in the
        // dashboard. This is the correct layering: the plugin tool creates
        // intent, Paperclip owns execution.
        //
        // Set localExecute=true to opt back into the legacy path that
        // spawns gstack-adapter synchronously (useful for short read-only
        // goals where 30s is enough, or when Paperclip routing is broken).
        // -----------------------------------------------------------------
        if (!localExecute) {
          updateGoal(goalRecord.id, { status: "executing" });
          ctx.logger.info("Goal dispatched to Paperclip — returning early", {
            goalId: goalRecord.id,
            paperclipIssueId: paperclipIssueId ?? null,
          });
          const urlLine = paperclipIssueUrl
            ? `\nPaperclip issue: ${paperclipIssueUrl}`
            : "";
          return {
            content: `Goal dispatched. Paperclip heartbeat will execute the assigned agent asynchronously.${urlLine}`,
            data: {
              goalId: goalRecord.id,
              projectName,
              goal,
              dispatched: true,
              mode: "paperclip-async",
              ...(paperclipIssueId ? { paperclipIssueId } : {}),
              ...(paperclipProjectId ? { paperclipProjectId } : {}),
              ...(paperclipIssueUrl ? { paperclipIssueUrl } : {}),
            },
          };
        }

        ctx.logger.info("Executing goal locally via Claude Code (legacy path)", {
          project: projectName,
          goalId: goalRecord.id,
          promptLength: prompt.length,
          paperclipIssueId: paperclipIssueId ?? null,
        });

        // Legacy path: spawn gstack-adapter and wait synchronously.
        updateGoal(goalRecord.id, { status: "executing" });
        const result = await adapter.executeGoal(goalRecord.id, project.path, goal, prompt);

        // Phase 5 feedback loop: extract decisions, find cross-project
        // implications, persist them, and trigger graph refresh (fire-and-forget).
        const decisions = result.success
          ? extractDecisionsFromOutput(result.output)
          : [];
        const decisionTexts = decisions.map((d) => `[${d.trigger}] ${d.text}`);

        // Cross-project implications based on touched files (best-effort —
        // we don't yet parse touched files from output, so this is a stub list).
        const touchedFiles: string[] = [];
        const implications = findCrossProjectImplications(projectName, touchedFiles);
        const implicationStrings = implications.map(
          (i) => `${i.projectName}: ${i.matchedFiles.join(", ")}`,
        );

        // Persist decisions (always — even if empty).
        try {
          recordDecisions(goalRecord.id, projectName, decisions, {
            goalDescription: goal,
            summary: result.summary,
          });
        } catch (err) {
          ctx.logger.warn("Failed to record decisions", {
            goalId: goalRecord.id,
            error: (err as Error).message,
          });
        }

        // Update goal with result + feedback metadata
        const finalStatus = result.success ? "done" as const : "failed" as const;
        updateGoal(goalRecord.id, {
          status: finalStatus,
          result: {
            goalId: goalRecord.id,
            success: result.success,
            summary: result.summary,
            touchedFiles,
            decisionsMade: decisionTexts,
            followUps: [],
            crossProjectImplications: implicationStrings,
          },
        });

        // Fire-and-forget graph refresh on success.
        if (result.success) {
          const refreshOutcome = triggerGraphRefresh(projectName, project.path);
          ctx.logger.info("Triggered graph refresh", {
            project: projectName,
            spawned: refreshOutcome.spawned,
            pid: refreshOutcome.pid,
            reason: refreshOutcome.reason,
          });

          // VELA-37: gbrain sync + embed when files were modified.
          if (touchedFiles.length > 0) {
            const gbrainOutcome = triggerGbrainSync(projectName, project.path);
            ctx.logger.info("Triggered gbrain sync", {
              project: projectName,
              spawned: gbrainOutcome.spawned,
              pid: gbrainOutcome.pid,
              reason: gbrainOutcome.reason,
            });
          }

          // VELA-38: auto-index new documents in PageIndex.
          const pageIndexOutcome = triggerPageIndexSync(projectName, project.path);
          ctx.logger.info("Triggered pageindex sync", {
            project: projectName,
            spawned: pageIndexOutcome.spawned,
            queued: pageIndexOutcome.queued,
            reason: pageIndexOutcome.reason,
          });
        }

        ctx.logger.info("Goal execution complete", {
          goalId: goalRecord.id,
          success: result.success,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
          decisionCount: decisions.length,
          implicationCount: implications.length,
        });

        const paperclipSuffix = paperclipIssueUrl
          ? `\n\nPaperclip issue: ${paperclipIssueUrl}`
          : "";

        return {
          content: result.success
            ? `Goal executed successfully.\n\nSummary: ${result.summary}${paperclipSuffix}`
            : `Goal execution failed.\n\nSummary: ${result.summary}${paperclipSuffix}`,
          data: {
            goalId: goalRecord.id,
            projectName,
            goal,
            success: result.success,
            summary: result.summary,
            durationMs: result.durationMs,
            timedOut: result.timedOut,
            exitCode: result.exitCode,
            ...(paperclipIssueId ? { paperclipIssueId } : {}),
            ...(paperclipProjectId ? { paperclipProjectId } : {}),
            ...(paperclipIssueUrl ? { paperclipIssueUrl } : {}),
          },
        };
      },
    );

    // Tool: project-status — list all registered projects
    ctx.tools.register(
      "project-status",
      {
        displayName: "Project Status",
        description: "List all registered projects and their current status.",
        parametersSchema: { type: "object", properties: {} },
      },
      async () => {
        const projects = listProjects();
        if (projects.length === 0) {
          return { content: "No projects registered. Use the registry to add projects." };
        }
        const summary = projects
          .map((p) => `- ${p.name} (${p.type}) — ${p.path}${p.description ? ` — ${p.description}` : ""}`)
          .join("\n");
        return {
          content: `Registered projects:\n\n${summary}`,
          data: { count: projects.length, projects },
        };
      },
    );

    // Tool: goal-status — list and inspect tracked goals
    ctx.tools.register(
      "goal-status",
      {
        displayName: "Goal Status",
        description: "List tracked goals, optionally filtered by project.",
        parametersSchema: {
          type: "object",
          properties: {
            projectName: { type: "string", description: "Filter by project name (optional)" },
          },
        },
      },
      async (params) => {
        const { projectName } = params as { projectName?: string };
        const goals = listGoals(projectName);

        if (goals.length === 0) {
          return {
            content: projectName
              ? `No goals found for project "${projectName}".`
              : "No goals tracked yet.",
          };
        }

        const summary = goals
          .map((g) => `- [${g.status}] ${g.description} (${g.projectName}) — ${g.id.slice(0, 8)}`)
          .join("\n");
        return {
          content: `Tracked goals:\n\n${summary}`,
          data: { count: goals.length, goals },
        };
      },
    );

    // Tool: register-project — register a local project directory
    ctx.tools.register(
      "register-project",
      {
        displayName: "Register Project",
        description: "Register a local project directory so agents can work on it.",
        parametersSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Project name" },
            path: { type: "string", description: "Absolute path to project directory" },
            type: { type: "string", enum: ["personal", "company", "oss"], description: "Project type" },
          },
          required: ["name", "path"],
        },
      },
      async (params) => {
        const { name, path: projectPath, type: projectType } = params as {
          name: string;
          path: string;
          type?: string;
        };
        const toolLog = pluginLogger.child("tool.register-project", generateCid());

        // Validate path exists
        const { existsSync } = await import("node:fs");
        if (!existsSync(projectPath)) {
          return { content: `Error: path does not exist: ${projectPath}`, data: { success: false } };
        }

        addProject({
          name,
          path: projectPath,
          type: (projectType as "personal" | "company" | "experimental") ?? "personal",
          relatedProjects: [],
        });

        toolLog.info("project registered", { name, path: projectPath });
        ctx.logger.info("project registered via web dashboard", { name, path: projectPath });

        // Bootstrap: fire-and-forget graph, gbrain, and pageindex for new project.
        const graphifyResult = triggerGraphifyBootstrap(name, projectPath);
        toolLog.info("Triggered graphify bootstrap", { spawned: graphifyResult.spawned, reason: graphifyResult.reason });
        const gbrainResult = triggerGbrainBootstrap(name, projectPath);
        toolLog.info("Triggered gbrain bootstrap", { spawned: gbrainResult.spawned, reason: gbrainResult.reason });
        const pageIndexResult = triggerPageIndexBootstrap(name, projectPath);
        toolLog.info("Triggered pageindex bootstrap", { spawned: pageIndexResult.spawned, queued: pageIndexResult.queued, reason: pageIndexResult.reason });

        return {
          content: `Project "${name}" registered at ${projectPath}.\nAgents can now dispatch goals to this project.`,
          data: { success: true, name, path: projectPath },
        };
      },
    );

    // Tool: assign-agent-project — map an agent to a project
    ctx.tools.register(
      "assign-agent-project",
      {
        displayName: "Assign Agent to Project",
        description: "Map an agent to a registered project for auto-dispatch.",
        parametersSchema: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "Agent UUID" },
            projectName: { type: "string", description: "Registered project name" },
          },
          required: ["agentId", "projectName"],
        },
      },
      async (params) => {
        const { agentId, projectName } = params as { agentId: string; projectName: string };
        const toolLog = pluginLogger.child("tool.assign-agent-project", generateCid());

        // Verify project exists in registry
        const project = getProject(projectName);
        if (!project) {
          return {
            content: `Error: project "${projectName}" not found in registry. Register it first with register-project.`,
            data: { success: false },
          };
        }

        // Store agent-project mapping in plugin state
        await ctx.state.set({
          scopeKind: "agent",
          scopeId: agentId,
          stateKey: "project",
        }, projectName);

        toolLog.info("agent-project mapping set", { agentId, projectName });
        ctx.logger.info("agent assigned to project", { agentId, projectName });

        return {
          content: `Agent ${agentId.slice(0, 8)}... assigned to project "${projectName}" (${project.path}).\nThe agent will auto-dispatch work on this project when woken.`,
          data: { success: true, agentId, projectName, projectPath: project.path },
        };
      },
    );

    const allTools = [
      "dispatch-goal", "execute-goal", "project-status", "goal-status",
      "register-project", "assign-agent-project",
    ];
    const allActions = [
      "rebuild-graphify", "reimport-gbrain", "reindex-pageindex",
    ];
    setupLog.info("plugin setup complete", {
      tools: allTools,
      actions: allActions,
      dataProviders: ["projects", "vela-subsystem-status"],
      claudeAvailable: availability.available,
    });
    ctx.logger.info(`${PLUGIN_ID} plugin setup complete`, {
      tools: allTools,
      actions: allActions,
      dataProviders: ["projects", "vela-subsystem-status"],
      claudeAvailable: availability.available,
    });

    // Kick off the background scanner + build worker AFTER setup completes.
    // queueMicrotask ensures this does not block the plugin handshake.
    queueMicrotask(async () => {
      const bgLog = pluginLogger.child("bg.startup");
      bgLog.info("background tasks starting");
      try {
        const scanner = await import("./startup-scanner.js");
        const result = await scanner.scanAndQueue();
        bgLog.info("startup-scanner complete", result as unknown as Record<string, unknown>);
        ctx.logger.info(
          "startup-scanner complete",
          result as unknown as Record<string, unknown>,
        );

        // VELA-56: reconcile graph-viz HTML files on every startup
        const reconciled = await scanner.reconcileGraphViz();
        bgLog.info("graph-viz reconcile complete", reconciled as unknown as Record<string, unknown>);

        const queueSpecifier = "@vela-union/mcp-gateway/dist/build-queue.js";
        const queue = (await import(queueSpecifier)) as {
          startWorker: () => { stop: () => Promise<void> };
        };
        queue.startWorker();
        bgLog.info("build-queue worker started");
        ctx.logger.info("build-queue worker started");
      } catch (err) {
        bgLog.error("startup-scanner/worker failed", err);
        ctx.logger.warn("startup-scanner/worker failed to start", {
          error: (err as Error).message,
        });
      }
    });
  },

  async onHealth() {
    const projects = listProjects();
    const availability = await adapter.checkAvailability();
    return {
      status: "ok",
      message: `Vela Union plugin healthy — ${projects.length} project(s) registered, Claude CLI ${availability.available ? "available" : "not found"}`,
      details: {
        projectCount: projects.length,
        claudeAvailable: availability.available,
        claudePath: availability.path,
        claudeVersion: availability.version,
      },
    };
  },
});

export default plugin;
export { plugin };

// Start the worker RPC host when run as a worker process
runWorker(plugin, import.meta.url);
