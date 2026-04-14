// vela register <project-path> [--type=personal|company|experimental] [--name=...] [--description=...] [--paperclip-id=<uuid>]
//
// Registers a project in the local Vela registry AND (when Paperclip is
// reachable) creates a matching Paperclip Project so it appears in the
// Paperclip dashboard sidebar. The Paperclip project's UUID is persisted
// back into ~/.vela/projects.json so downstream tools (execute-goal,
// dispatch) can reference it.
//
// When `--paperclip-id=<uuid>` is passed, we SKIP creating a new Paperclip
// project — instead we verify the existing project is reachable via the
// Paperclip API and link to it. This is the "I already made the project
// in the Paperclip UI, just register it locally" workflow.
//
// Graceful degradation: if Paperclip is not running or config is missing,
// we still register locally and print a warning — the user can always
// re-sync by running `vela register` again after starting Paperclip.

import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  addProject,
  getProject,
  listProjects,
  tryCreatePaperclipClient,
  PaperclipApiError,
  PaperclipUnreachableError,
  resolvePaperclipConfig,
  DEFAULT_PROJECT_PREFIX,
} from "@vela-union/shared";
import type { ProjectConfig } from "@vela-union/shared";
import { fail, info, ok, warn } from "../util/log.js";
import type { CommandContext } from "../util/context.js";

export async function runRegister(ctx: CommandContext): Promise<number> {
  const log = ctx.logger;
  const args = ctx.argv;
  log.info("register start", { argv: args });

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
  const pathArg = positional[0];
  if (!pathArg) {
    log.warn("register missing path");
    fail("usage: vela register <project-path> [--type=personal] [--name=foo]");
    return 1;
  }
  const path = resolve(pathArg);
  if (!existsSync(path)) {
    log.warn("register path missing", { path });
    fail(`path does not exist: ${path}`);
    return 1;
  }
  const name = flags["name"] ?? basename(path);
  const typeArg = flags["type"] ?? "personal";
  if (typeArg !== "personal" && typeArg !== "company" && typeArg !== "experimental") {
    log.warn("register bad type", { typeArg });
    fail(`invalid --type: ${typeArg}. must be personal|company|experimental`);
    return 1;
  }
  const description = flags["description"];
  const skipPaperclip = flags["no-paperclip"] === "true";
  const explicitPaperclipId = flags["paperclip-id"];

  // Basic UUID shape validation — Paperclip's id normalization is stricter
  // on the server, but we want to fail fast on obvious typos before hitting
  // the network.
  if (explicitPaperclipId !== undefined) {
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test(explicitPaperclipId)) {
      log.warn("register bad paperclip-id", { explicitPaperclipId });
      fail(`invalid --paperclip-id: ${explicitPaperclipId} (expected UUID)`);
      return 1;
    }
  }

  // Preserve existing paperclipProjectId if this is a re-register
  const existing = getProject(name);

  const project: ProjectConfig = {
    name,
    path,
    type: typeArg,
    relatedProjects: [],
    ...(description ? { description } : {}),
    ...(existing?.paperclipProjectId ? { paperclipProjectId: existing.paperclipProjectId } : {}),
  };

  // -----------------------------------------------------------------------
  // Paperclip sync (best-effort unless --paperclip-id is set, in which case
  // a broken Paperclip connection is a hard error).
  // -----------------------------------------------------------------------
  if (!skipPaperclip) {
    const syncLog = log.child("paperclip-sync");
    try {
      const cfg = resolvePaperclipConfig();
      if (!cfg) {
        syncLog.info("paperclip config missing, skipping sync");
        if (explicitPaperclipId) {
          fail("--paperclip-id requires paperclip config — run 'vela setup' first");
          return 1;
        }
        warn("no paperclip config — run 'vela setup' to enable dashboard sync");
      } else {
        const client = await tryCreatePaperclipClient(syncLog);
        if (client) {
          const prefix = cfg.defaultProjectPrefix ?? DEFAULT_PROJECT_PREFIX;

          let paperclipProjectId: string | undefined;

          if (explicitPaperclipId) {
            // Link mode: verify the id exists, don't create anything.
            const fetched = await client.getProject(explicitPaperclipId);
            if (!fetched) {
              syncLog.warn("paperclip project not found", { explicitPaperclipId });
              fail(
                `paperclip project ${explicitPaperclipId} not found in company ${cfg.companyId.slice(0, 8)}`,
              );
              return 1;
            }
            if (fetched.companyId !== cfg.companyId) {
              syncLog.warn("paperclip project in wrong company", {
                explicitPaperclipId,
                projectCompanyId: fetched.companyId,
                configuredCompanyId: cfg.companyId,
              });
              fail(
                `paperclip project ${explicitPaperclipId} belongs to company ${fetched.companyId} (configured: ${cfg.companyId})`,
              );
              return 1;
            }
            paperclipProjectId = fetched.id;
            syncLog.info("paperclip project linked via --paperclip-id", {
              paperclipProjectId,
              paperclipName: fetched.name,
            });
            info(`linked to existing paperclip project: ${fetched.name} (${fetched.id})`);

            // Take description from the remote project if the user didn't
            // override it locally.
            if (!project.description && fetched.description) {
              project.description = fetched.description;
            }
          } else {
            // Create-or-reuse mode (legacy behavior)
            const paperclipName = `${prefix} ${name}`.trim();

            // If we already have an id from a previous register, trust it.
            paperclipProjectId = existing?.paperclipProjectId;

            if (!paperclipProjectId) {
              // Avoid duplicates by name
              const existingPcp = await client.findProjectByName(paperclipName);
              if (existingPcp) {
                paperclipProjectId = existingPcp.id;
                syncLog.info("paperclip project already exists", {
                  paperclipProjectId,
                  paperclipName,
                });
                info(`reusing existing paperclip project: ${paperclipName}`);
              } else {
                const created = await client.createProject({
                  name: paperclipName,
                  description: description ?? `Vela Union project — ${name}`,
                  workspace: {
                    name,
                    sourceType: "local_path",
                    cwd: path,
                    isPrimary: true,
                  },
                });
                paperclipProjectId = created.id;
                syncLog.info("paperclip project created", {
                  paperclipProjectId,
                  paperclipName,
                });
                info(`created paperclip project: ${paperclipName}`);
              }
            } else {
              syncLog.debug("paperclip project already linked", { paperclipProjectId });
            }
          }

          if (paperclipProjectId) {
            project.paperclipProjectId = paperclipProjectId;
          }
        } else if (explicitPaperclipId) {
          fail("--paperclip-id requires a reachable paperclip client");
          return 1;
        }
      }
    } catch (err) {
      if (err instanceof PaperclipUnreachableError) {
        syncLog.warn("paperclip unreachable", { error: err.message });
        if (explicitPaperclipId) {
          fail(`paperclip unreachable — cannot verify --paperclip-id (${err.message})`);
          return 1;
        }
        warn(`paperclip unreachable — local registration only (${err.message})`);
      } else if (err instanceof PaperclipApiError) {
        syncLog.warn("paperclip api error", { status: err.status, error: err.message });
        if (explicitPaperclipId) {
          fail(`paperclip api error ${err.status} — ${err.message}`);
          return 1;
        }
        warn(`paperclip api error ${err.status} — ${err.message}`);
      } else {
        syncLog.error("paperclip sync failed", err);
        if (explicitPaperclipId) {
          fail(`paperclip sync failed: ${(err as Error).message}`);
          return 1;
        }
        warn(`paperclip sync failed: ${(err as Error).message}`);
      }
    }
  }

  addProject(project);
  const registrySize = listProjects().length;
  log.info("register complete", {
    name,
    path,
    type: typeArg,
    registrySize,
    hasDescription: !!description,
    paperclipProjectId: project.paperclipProjectId ?? null,
  });
  ok(`registered ${name} -> ${path}`);
  if (project.paperclipProjectId) {
    info(`paperclip project id: ${project.paperclipProjectId}`);
  }

  // Auto-activation: enqueue a Graphify build for the new project. Fire-and-forget.
  // The background build worker inside Paperclip will pick it up on its next poll.
  try {
    const queueSpecifier = "@vela-union/mcp-gateway/dist/build-queue.js";
    const queue = (await import(queueSpecifier)) as {
      enqueue: (entry: { kind: "graphify"; projectName: string; projectPath: string }) => unknown;
      isQueued: (projectName: string, kind: "graphify") => boolean;
    };
    if (!queue.isQueued(name, "graphify")) {
      queue.enqueue({ kind: "graphify", projectName: name, projectPath: path });
      log.info("register enqueued graph build", { projectName: name });
      info(`enqueued background graph build for ${name}`);
    } else {
      log.debug("register graph already queued", { projectName: name });
    }
  } catch (err) {
    log.warn("register could not enqueue graph build", { error: (err as Error).message });
    warn(`could not enqueue graph build: ${(err as Error).message}`);
  }

  info(`next: vela dispatch ${name} "your goal"`);
  return 0;
}
