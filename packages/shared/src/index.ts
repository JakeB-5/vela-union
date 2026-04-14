// Vela Union shared types and utilities

export {
  createLogger,
  createNoSinkLogger,
  generateCid,
  parseLogLevel,
  DEFAULT_SINK_PATH,
} from "./logger.js";

export type { LogLevel, LogEntry, Logger, LoggerOptions } from "./logger.js";

export { readLogs, tailLogs } from "./log-reader.js";

export type { LogFilter, TailHandle } from "./log-reader.js";

export {
  listProjects,
  getProject,
  addProject,
  removeProject,
  discoverProjects,
  REGISTRY_PATH,
} from "./registry.js";

export {
  createGoal,
  updateGoal,
  listGoals,
  getGoal,
  GOALS_PATH,
} from "./goals.js";

export type { StoredGoal } from "./goals.js";

export {
  recordDecisions,
  extractDecisionsFromOutput,
  findCrossProjectImplications,
  triggerGraphRefresh,
  triggerGbrainSync,
  triggerPageIndexSync,
  triggerGraphifyBootstrap,
  triggerGbrainBootstrap,
  triggerPageIndexBootstrap,
  readDecisions,
  listDecisionFiles,
  DECISIONS_DIR,
} from "./feedback.js";

export type {
  DecisionEntry,
  RecordDecisionsResult,
  CrossProjectImplication,
  SubsystemStatus,
} from "./feedback.js";

export { getSubsystemStatuses } from "./feedback.js";

export {
  loadConfig,
  saveConfig,
  resolvePaperclipConfig,
  resolvePageIndexConfig,
  CONFIG_PATH,
  DEFAULT_PAPERCLIP_API_URL,
  DEFAULT_PROJECT_PREFIX,
} from "./config.js";

export type {
  VelaConfig,
  PaperclipConnectionConfig,
  PageIndexConnectionConfig,
  PageIndexProvider,
} from "./config.js";

export {
  PaperclipClient,
  PaperclipApiError,
  PaperclipUnreachableError,
  tryCreatePaperclipClient,
} from "./paperclip-client.js";

export {
  dispatchViaPaperclip,
  ensurePaperclipProjectLink,
} from "./issue-sync.js";

export type {
  DispatchViaPaperclipInput,
  DispatchViaPaperclipResult,
} from "./issue-sync.js";

export type {
  PaperclipCompany,
  PaperclipProject,
  PaperclipWorkspace,
  PaperclipAgent,
  PaperclipIssue,
  CreateProjectInput,
  CreateIssueInput,
} from "./paperclip-client.js";

export interface ProjectConfig {
  name: string;
  path: string;
  type: "company" | "personal" | "experimental";
  relatedProjects: string[];
  description?: string;
  /**
   * UUID of the corresponding Paperclip Project, if this Vela project has
   * been synced into Paperclip. Set during `vela register` when Paperclip
   * is reachable; otherwise undefined. Downstream tooling (execute-goal,
   * dispatch) uses this to create issues under the right Paperclip project.
   */
  paperclipProjectId?: string;
}

/** A single result from gbrain knowledge.search */
export interface GbrainSearchResult {
  slug: string;
  title: string;
  type: string;
  score: number;
  excerpt: string;
}

export interface BriefingPack {
  project: ProjectConfig;
  recentCommits: string[];
  directoryTree: string;
  highChurnFiles: string[];
  readme: string | null;
  claudeMd: string | null;
  pinnedFiles: string[];
  generatedAt: string;
  /** Top gbrain knowledge results for the goal, if available */
  gbrainContext?: GbrainSearchResult[];
}

export interface AgentGoal {
  id: string;
  projectName: string;
  description: string;
  status: "pending" | "planning" | "executing" | "done" | "failed";
  createdAt: string;
  updatedAt: string;
}

export interface DispatchResult {
  goalId: string;
  success: boolean;
  summary: string;
  touchedFiles: string[];
  decisionsMade: string[];
  followUps: string[];
  crossProjectImplications: string[];
}
