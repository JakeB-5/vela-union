// Shared helper: dispatch a Vela goal by creating a Paperclip Issue.
//
// This is used by:
//   - The paperclip-plugin `execute-goal` tool — so agents using Vela from
//     inside Paperclip hit the same code path as humans using the CLI.
//   - The `vela dispatch` CLI command — so users can queue goals from the
//     terminal without launching Claude Code.
//
// The helper is intentionally thin: it takes a Vela project, a goal
// description, and an optional pre-generated briefing pack, and returns
// the created Paperclip issue's identifiers + URL. It does NOT run the
// agent — Paperclip's heartbeat system picks up the newly-assigned issue
// and dispatches it to the assignee automatically.

import type { Logger } from "./logger.js";
import {
  PaperclipClient,
  type PaperclipIssue,
  type PaperclipProject,
} from "./paperclip-client.js";
import type { PaperclipConnectionConfig } from "./config.js";
import type { ProjectConfig } from "./index.js";
import { addProject, getProject } from "./registry.js";

export interface DispatchViaPaperclipInput {
  /** Vela project to dispatch against. Must already be in the local registry. */
  project: ProjectConfig;
  /** Natural language goal description. Used as the issue title (truncated). */
  goal: string;
  /** Optional pre-rendered briefing pack — used as the issue description body. */
  briefing?: string;
  /** Override the assignee (defaults to config.defaultAgentId). */
  assigneeAgentId?: string;
  /** Override the project prefix used when auto-creating a missing Paperclip project. */
  projectPrefix?: string;
  /** Optional priority override (e.g. "urgent"). */
  priority?: string;
}

export interface DispatchViaPaperclipResult {
  paperclipIssueId: string;
  paperclipProjectId: string;
  issueUrl: string;
  projectUrl: string;
  title: string;
  issue: PaperclipIssue;
}

const MAX_TITLE_LENGTH = 120;

function truncateTitle(text: string, max = MAX_TITLE_LENGTH): string {
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length <= max) return single;
  return single.slice(0, max - 1) + "\u2026";
}

/**
 * Ensure the Vela project has a linked Paperclip project. If `paperclipProjectId`
 * is already set and still valid, it is reused. Otherwise we look up (or
 * create) a Paperclip project with the `{prefix} {name}` naming convention
 * and persist the id back into the local registry.
 */
export async function ensurePaperclipProjectLink(
  client: PaperclipClient,
  project: ProjectConfig,
  logger: Logger,
  opts: { prefix?: string } = {},
): Promise<PaperclipProject> {
  const prefix = opts.prefix ?? client.config.defaultProjectPrefix ?? "[VELA]";
  const expectedName = `${prefix} ${project.name}`.trim();

  // 1. If already linked, fetch by id directly. This handles the case where
  //    the Paperclip project was created out-of-band (e.g. via the Paperclip
  //    UI or `vela register --paperclip-id`) and therefore has a name that
  //    does NOT match the `{prefix} {name}` convention. Only fall through to
  //    the name-based lookup when the linked id is stale (404).
  if (project.paperclipProjectId) {
    try {
      const existing = await client.getProject(project.paperclipProjectId);
      if (existing) {
        logger.debug("paperclip project link verified by id", {
          paperclipProjectId: project.paperclipProjectId,
          paperclipName: existing.name,
        });
        return existing;
      }
      logger.warn("linked paperclip project id not found — will look up by name", {
        paperclipProjectId: project.paperclipProjectId,
      });
    } catch (err) {
      // Fall through — we'll try to find or create.
      logger.warn("paperclip link verify failed — falling back", {
        error: (err as Error).message,
      });
    }
  }

  // 2. Try to find by name first (avoid duplicates).
  const byName = await client.findProjectByName(expectedName);
  if (byName) {
    logger.info("paperclip project matched by name", { paperclipProjectId: byName.id });
    persistLink(project, byName.id);
    return byName;
  }

  // 3. Create a fresh one.
  logger.info("creating paperclip project", { name: expectedName });
  const created = await client.createProject({
    name: expectedName,
    description: project.description ?? `Vela Union project — ${project.name}`,
    workspace: {
      name: project.name,
      sourceType: "local_path",
      cwd: project.path,
      isPrimary: true,
    },
  });
  persistLink(project, created.id);
  return created;
}

function persistLink(project: ProjectConfig, paperclipProjectId: string): void {
  const current = getProject(project.name);
  if (!current) return;
  addProject({ ...current, paperclipProjectId });
  // Also mutate the in-memory reference so callers see the updated value.
  project.paperclipProjectId = paperclipProjectId;
}

/**
 * Create a Paperclip Issue from a Vela goal. The issue gets the goal as
 * its title (truncated), the briefing pack (when available) as its body,
 * and the configured agent as its assignee — triggering Paperclip's own
 * heartbeat dispatch loop.
 */
export async function dispatchViaPaperclip(
  client: PaperclipClient,
  config: PaperclipConnectionConfig,
  input: DispatchViaPaperclipInput,
  logger: Logger,
): Promise<DispatchViaPaperclipResult> {
  const pcpProject = await ensurePaperclipProjectLink(client, input.project, logger, {
    prefix: input.projectPrefix,
  });
  const title = truncateTitle(input.goal);
  const description = input.briefing
    ? `# Goal\n\n${input.goal}\n\n---\n\n## Briefing Pack\n\n${input.briefing}`
    : input.goal;

  const issue = await client.createIssue({
    projectId: pcpProject.id,
    title,
    description,
    priority: input.priority,
    assigneeAgentId: input.assigneeAgentId ?? config.defaultAgentId,
  });

  logger.info("paperclip issue created", {
    paperclipIssueId: issue.id,
    paperclipProjectId: pcpProject.id,
    title,
  });

  return {
    paperclipIssueId: issue.id,
    paperclipProjectId: pcpProject.id,
    issueUrl: client.issueUrl(issue.id),
    projectUrl: client.projectUrl(pcpProject.id),
    title,
    issue,
  };
}
