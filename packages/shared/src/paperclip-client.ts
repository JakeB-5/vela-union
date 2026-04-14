// Paperclip API client — talks to the Paperclip HTTP server from Vela Union.
//
// This is the bridge that lets Vela Union register projects, dispatch goals,
// and observe heartbeat runs inside Paperclip's native data model. It wraps
// only the endpoints Vela needs: companies, projects, issues, agents. All
// calls go through node's native fetch — no new deps.
//
// Graceful degradation is a first-class concern: the plugin and CLI call
// the client on hot paths, and Paperclip may not be running. Callers should
// catch thrown errors and decide whether to fail loudly or soft-skip.

import { createLogger, generateCid } from "./logger.js";
import type { Logger } from "./logger.js";
import type { PaperclipConnectionConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Types — lightweight mirrors of Paperclip's server shapes. We intentionally
// keep these minimal to avoid coupling to Paperclip internals.
// ---------------------------------------------------------------------------

export interface PaperclipCompany {
  id: string;
  name: string;
  slug?: string;
}

export interface PaperclipWorkspace {
  id: string;
  companyId: string;
  projectId: string;
  name: string;
  sourceType: "local_path" | "git_repo" | "remote_managed" | "non_git_path";
  cwd?: string | null;
  repoUrl?: string | null;
  repoRef?: string | null;
  defaultRef?: string | null;
  isPrimary?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface PaperclipProject {
  id: string;
  companyId: string;
  name: string;
  description?: string | null;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  /**
   * Populated by /api/projects/:id and /api/companies/:id/projects — the
   * Paperclip server returns workspaces inline in both list and get-by-id
   * responses. May be empty if the project has no workspace attached.
   */
  workspaces?: PaperclipWorkspace[];
  /** The primary workspace, if the server hydrated it (mirrors workspaces[isPrimary]). */
  primaryWorkspace?: PaperclipWorkspace | null;
}

export interface PaperclipAgent {
  id: string;
  companyId: string;
  name: string;
  role?: string | null;
  status?: string;
}

export interface PaperclipIssue {
  id: string;
  companyId: string;
  projectId?: string | null;
  title: string;
  description?: string | null;
  status: string;
  priority?: string | null;
  assigneeAgentId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  /**
   * Optional workspace (required when Paperclip policy wants every project to
   * have at least one workspace). If omitted Paperclip will accept the
   * project but it won't have a filesystem workspace attached.
   */
  workspace?: {
    name: string;
    sourceType: "local_path" | "git_repo" | "remote_managed" | "non_git_path";
    cwd?: string;
    isPrimary?: boolean;
  };
}

export interface CreateIssueInput {
  projectId?: string;
  title: string;
  description?: string;
  priority?: string;
  assigneeAgentId?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PaperclipApiError extends Error {
  override readonly name = "PaperclipApiError";
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(`Paperclip API ${status}: ${message}`);
    this.status = status;
    this.body = body;
  }
}

export class PaperclipUnreachableError extends Error {
  override readonly name = "PaperclipUnreachableError";
  constructor(message: string) {
    super(`Paperclip unreachable: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class PaperclipClient {
  readonly config: PaperclipConnectionConfig;
  private readonly logger: Logger;

  constructor(config: PaperclipConnectionConfig, logger?: Logger) {
    this.config = config;
    this.logger =
      logger ??
      createLogger({
        component: "paperclip-client",
        cid: generateCid(),
        level: "info",
        tty: false,
      });
  }

  // -----------------------------------------------------------------------
  // Internal: HTTP
  // -----------------------------------------------------------------------

  private buildUrl(path: string): string {
    const base = this.config.apiUrl.replace(/\/+$/, "");
    const suffix = path.startsWith("/") ? path : `/${path}`;
    return `${base}${suffix}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    init?: { timeoutMs?: number },
  ): Promise<T> {
    const url = this.buildUrl(path);
    const controller = new AbortController();
    const timeoutMs = init?.timeoutMs ?? 10_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      this.logger.debug("request start", { method, url });
      const res = await fetch(url, {
        method,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed: unknown = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      if (!res.ok) {
        const errBody = parsed as { error?: string } | null;
        const msg = errBody && typeof errBody === "object" && "error" in errBody
          ? String(errBody.error)
          : res.statusText;
        throw new PaperclipApiError(res.status, msg, parsed);
      }
      this.logger.debug("request ok", { method, url, status: res.status });
      return parsed as T;
    } catch (err) {
      if (err instanceof PaperclipApiError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      // Network errors (ECONNREFUSED, abort, DNS) become PaperclipUnreachableError
      throw new PaperclipUnreachableError(`${method} ${url} — ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }

  // -----------------------------------------------------------------------
  // Companies
  // -----------------------------------------------------------------------

  async listCompanies(): Promise<PaperclipCompany[]> {
    return this.request<PaperclipCompany[]>("GET", "/api/companies/");
  }

  async getCompany(companyId: string): Promise<PaperclipCompany | null> {
    try {
      return await this.request<PaperclipCompany>("GET", `/api/companies/${companyId}`);
    } catch (err) {
      if (err instanceof PaperclipApiError && err.status === 404) return null;
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // Projects
  // -----------------------------------------------------------------------

  async listProjects(): Promise<PaperclipProject[]> {
    return this.request<PaperclipProject[]>(
      "GET",
      `/api/companies/${this.config.companyId}/projects`,
    );
  }

  async findProjectByName(name: string): Promise<PaperclipProject | null> {
    const projects = await this.listProjects();
    return projects.find((p) => p.name === name) ?? null;
  }

  /**
   * Fetch a single project by id. Returns null on 404 so callers can
   * distinguish "not found" from "server error". The Paperclip server
   * hydrates `workspaces` inline on this endpoint.
   */
  async getProject(projectId: string): Promise<PaperclipProject | null> {
    try {
      return await this.request<PaperclipProject>("GET", `/api/projects/${projectId}`);
    } catch (err) {
      if (err instanceof PaperclipApiError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Fetch the workspaces for a project. Useful as a fallback when
   * listProjects()/getProject() responses omit the inline `workspaces`
   * array (should never happen against current Paperclip, but we defend
   * against schema drift).
   */
  async listProjectWorkspaces(projectId: string): Promise<PaperclipWorkspace[]> {
    return this.request<PaperclipWorkspace[]>(
      "GET",
      `/api/projects/${projectId}/workspaces`,
    );
  }

  async createProject(input: CreateProjectInput): Promise<PaperclipProject> {
    const payload: Record<string, unknown> = {
      name: input.name,
    };
    if (input.description) payload.description = input.description;
    if (input.workspace) {
      payload.workspace = {
        name: input.workspace.name,
        sourceType: input.workspace.sourceType,
        ...(input.workspace.cwd !== undefined ? { cwd: input.workspace.cwd } : {}),
        ...(input.workspace.isPrimary !== undefined
          ? { isPrimary: input.workspace.isPrimary }
          : {}),
      };
    }
    return this.request<PaperclipProject>(
      "POST",
      `/api/companies/${this.config.companyId}/projects`,
      payload,
    );
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.request<unknown>("DELETE", `/api/projects/${projectId}`);
  }

  // -----------------------------------------------------------------------
  // Issues
  // -----------------------------------------------------------------------

  async listIssues(projectId?: string): Promise<PaperclipIssue[]> {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    return this.request<PaperclipIssue[]>(
      "GET",
      `/api/companies/${this.config.companyId}/issues${qs}`,
    );
  }

  async getIssue(issueId: string): Promise<PaperclipIssue | null> {
    try {
      return await this.request<PaperclipIssue>("GET", `/api/issues/${issueId}`);
    } catch (err) {
      if (err instanceof PaperclipApiError && err.status === 404) return null;
      throw err;
    }
  }

  async createIssue(input: CreateIssueInput): Promise<PaperclipIssue> {
    const payload: Record<string, unknown> = {
      title: input.title,
    };
    if (input.projectId) payload.projectId = input.projectId;
    if (input.description !== undefined) payload.description = input.description;
    if (input.priority !== undefined) payload.priority = input.priority;
    if (input.assigneeAgentId !== undefined) payload.assigneeAgentId = input.assigneeAgentId;
    return this.request<PaperclipIssue>(
      "POST",
      `/api/companies/${this.config.companyId}/issues`,
      payload,
    );
  }

  async addIssueComment(issueId: string, body: string): Promise<unknown> {
    return this.request<unknown>(
      "POST",
      `/api/issues/${issueId}/comments`,
      { body },
    );
  }

  async updateIssueStatus(issueId: string, status: string): Promise<PaperclipIssue> {
    return this.request<PaperclipIssue>(
      "PATCH",
      `/api/issues/${issueId}`,
      { status },
    );
  }

  // -----------------------------------------------------------------------
  // Agents
  // -----------------------------------------------------------------------

  async listAgents(): Promise<PaperclipAgent[]> {
    return this.request<PaperclipAgent[]>(
      "GET",
      `/api/companies/${this.config.companyId}/agents`,
    );
  }

  // -----------------------------------------------------------------------
  // Ping — used by diagnostics and setup to check connectivity.
  // -----------------------------------------------------------------------

  async ping(): Promise<{ ok: true }> {
    await this.request<unknown>("GET", "/api/plugins");
    return { ok: true };
  }

  /**
   * Build a Paperclip UI URL for a given issue so users can click into it.
   */
  issueUrl(issueId: string): string {
    const base = this.config.apiUrl.replace(/\/+$/, "");
    return `${base}/companies/${this.config.companyId}/issues/${issueId}`;
  }

  /**
   * Build a Paperclip UI URL for a given project.
   */
  projectUrl(projectId: string): string {
    const base = this.config.apiUrl.replace(/\/+$/, "");
    return `${base}/companies/${this.config.companyId}/projects/${projectId}`;
  }
}

/**
 * Convenience factory: load config, return a ready client, or null when
 * the config is missing/incomplete. Callers can graceful-degrade on null.
 */
export async function tryCreatePaperclipClient(
  logger?: Logger,
): Promise<PaperclipClient | null> {
  const { resolvePaperclipConfig } = await import("./config.js");
  const cfg = resolvePaperclipConfig();
  if (!cfg) return null;
  return new PaperclipClient(cfg, logger);
}
