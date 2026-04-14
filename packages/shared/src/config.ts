// Vela Union config — ~/.vela/config.json
//
// Stores connection details for Paperclip (and any future external systems)
// so that the plugin, CLI, and gateway all read from a single source of
// truth instead of re-querying Paperclip every invocation.
//
// The file is created on first `vela setup` run, or manually. All reads are
// tolerant of a missing or malformed file — if we can't read a valid
// config, callers fall back to environment variables and ultimately to
// defaults.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PaperclipConnectionConfig {
  /** Base URL of the Paperclip server, e.g. "http://127.0.0.1:3100". */
  apiUrl: string;
  /** Company UUID that Vela projects will be created under. */
  companyId: string;
  /** Default agent UUID assigned to dispatched issues. */
  defaultAgentId: string;
  /** Prefix applied to Paperclip project names created by Vela. */
  defaultProjectPrefix?: string;
}

/**
 * Configuration for the PageIndex document reasoning provider.
 *
 * Three providers are supported:
 *   - "vectify-cloud"    → hosted Vectify PageIndex cloud API (PDF only).
 *     Requires `apiKey`. Used via a Python subprocess + pageindex SDK.
 *   - "local-claude-cli" → OSS PageIndex at refs/PageIndex driven by the
 *     local `claude -p` CLI. Zero API cost (uses Claude subscription),
 *     no apiKey required. Both .md and .pdf supported.
 *   - "local"            → OSS PageIndex driven by litellm + OpenAI or
 *     Anthropic API key in the environment (OPENAI_API_KEY / ANTHROPIC_API_KEY).
 */
export type PageIndexProvider = "vectify-cloud" | "local-claude-cli" | "local";

export interface PageIndexConnectionConfig {
  /** Cloud API key (for provider="vectify-cloud"). */
  apiKey?: string;
  /** Provider selector. Defaults to "local" when unset. */
  provider?: PageIndexProvider;
}

export interface VelaConfig {
  paperclip?: PaperclipConnectionConfig;
  pageindex?: PageIndexConnectionConfig;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CONFIG_DIR = join(homedir(), ".vela");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const DEFAULT_PAPERCLIP_API_URL = "http://127.0.0.1:3100";
export const DEFAULT_PROJECT_PREFIX = "[VELA]";

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

function ensureDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/**
 * Load the Vela config from disk. Returns an empty object if the file is
 * missing or unparseable — this function NEVER throws.
 */
export function loadConfig(): VelaConfig {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as VelaConfig;
  } catch {
    return {};
  }
}

/**
 * Persist a Vela config to disk, merging the provided patch into the
 * existing config. Creates ~/.vela if necessary. Never throws.
 *
 * @returns The fully-merged config that was written.
 */
export function saveConfig(patch: VelaConfig): VelaConfig {
  const current = loadConfig();
  const merged: VelaConfig = {
    ...current,
    ...patch,
    ...(patch.paperclip
      ? { paperclip: { ...current.paperclip, ...patch.paperclip } }
      : {}),
    ...(patch.pageindex
      ? { pageindex: { ...current.pageindex, ...patch.pageindex } }
      : {}),
  };
  try {
    ensureDir();
    const dir = dirname(CONFIG_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  } catch {
    // Never throw — callers check the config afterwards.
  }
  return merged;
}

/**
 * Return the resolved PageIndex connection config. Precedence:
 *   1. ~/.vela/config.json { pageindex: ... }
 *   2. Environment variables PAGEINDEX_API_KEY / VELA_PAGEINDEX_PROVIDER
 *   3. Defaults: provider="local", apiKey=undefined
 *
 * Never throws. Callers should check `.apiKey` before hitting the cloud.
 */
export function resolvePageIndexConfig(): PageIndexConnectionConfig {
  const cfg = loadConfig();
  const fromFile = cfg.pageindex ?? {};
  const envKey = process.env["PAGEINDEX_API_KEY"] ?? process.env["VELA_PAGEINDEX_API_KEY"];
  const envProvider = process.env["VELA_PAGEINDEX_PROVIDER"];
  const isValidProvider = (v: unknown): v is PageIndexProvider =>
    v === "vectify-cloud" || v === "local-claude-cli" || v === "local";
  const provider: PageIndexProvider =
    fromFile.provider ??
    (isValidProvider(envProvider) ? envProvider : undefined) ??
    "local";
  const apiKey = fromFile.apiKey ?? envKey;
  const resolved: PageIndexConnectionConfig = { provider };
  if (apiKey) resolved.apiKey = apiKey;
  return resolved;
}

/**
 * Return the resolved Paperclip connection config, prefering:
 *   1. ~/.vela/config.json { paperclip: ... }
 *   2. Environment variables VELA_PAPERCLIP_URL / VELA_COMPANY_ID / VELA_AGENT_ID
 *   3. Undefined if not enough information is available.
 */
export function resolvePaperclipConfig(): PaperclipConnectionConfig | null {
  const cfg = loadConfig();
  const fromFile = cfg.paperclip;
  const apiUrl =
    fromFile?.apiUrl ?? process.env.VELA_PAPERCLIP_URL ?? DEFAULT_PAPERCLIP_API_URL;
  const companyId = fromFile?.companyId ?? process.env.VELA_COMPANY_ID ?? "";
  const defaultAgentId = fromFile?.defaultAgentId ?? process.env.VELA_AGENT_ID ?? "";
  const defaultProjectPrefix =
    fromFile?.defaultProjectPrefix ?? process.env.VELA_PROJECT_PREFIX ?? DEFAULT_PROJECT_PREFIX;

  // companyId and defaultAgentId are REQUIRED — without them we cannot
  // create projects or assign issues.
  if (!companyId || !defaultAgentId) return null;

  return {
    apiUrl,
    companyId,
    defaultAgentId,
    defaultProjectPrefix,
  };
}
