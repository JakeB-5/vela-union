// Canonical filesystem paths used by the vela CLI.

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve repo root: VELA_REPO_ROOT env overrides; otherwise infer from this
// file's location (packages/vela-cli/src/util/paths.ts → 4 levels up).
const _fileDir = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT =
  process.env["VELA_REPO_ROOT"] ?? resolve(_fileDir, "../../../..");

// Paperclip companion repo: PAPERCLIP_ROOT env overrides; fall back to a
// sibling of REPO_ROOT so it works on any machine without config.
export const PAPERCLIP_ROOT =
  process.env["PAPERCLIP_ROOT"] ??
  resolve(REPO_ROOT, "..", "paperclip");
export const PAPERCLIP_REPO = "https://github.com/paperclipai/paperclip";

export const VENV_DIR = join(REPO_ROOT, ".venv");
export const VENV_PYTHON = join(VENV_DIR, "bin", "python");
export const VENV_PIP = join(VENV_DIR, "bin", "pip");

export const VELA_HOME = join(homedir(), ".vela");
export const VELA_LOGS = join(VELA_HOME, "logs");
export const VELA_PIDS = join(VELA_HOME, "pids");
export const VELA_DECISIONS = join(VELA_HOME, "decisions");
export const VELA_GRAPHIFY = join(VELA_HOME, "graphify");
export const VELA_GBRAIN = join(VELA_HOME, "gbrain");
export const VELA_PROJECTS_JSON = join(VELA_HOME, "projects.json");
export const VELA_GOALS_JSON = join(VELA_HOME, "goals.json");

export const PAPERCLIP_PID = join(VELA_PIDS, "paperclip.pid");
export const PAPERCLIP_LOG = join(VELA_LOGS, "paperclip.log");

export const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");
export const CLAUDE_SETTINGS_BAK = join(homedir(), ".claude", "settings.json.bak");
export const GSTACK_SKILLS = join(homedir(), ".claude", "skills", "gstack");

export const MCP_GATEWAY_BIN = join(
  REPO_ROOT,
  "packages",
  "mcp-gateway",
  "dist",
  "server.js",
);

export const VELA_PLUGIN_DIR = join(REPO_ROOT, "packages", "paperclip-plugin");

export const PAGEINDEX_REFS = join(REPO_ROOT, "refs", "PageIndex");

export const DEFAULT_PAPERCLIP_HOST = "127.0.0.1";
export const DEFAULT_PAPERCLIP_PORT = 3100;
export const paperclipBaseUrl = (): string =>
  `http://${DEFAULT_PAPERCLIP_HOST}:${DEFAULT_PAPERCLIP_PORT}`;
