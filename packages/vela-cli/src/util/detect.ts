// Detection helpers — inspect the filesystem/processes to determine the
// current state of each of the 4 Vela Union subsystems.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { exec, isAlive, readPid, which } from "./proc.js";
import {
  GSTACK_SKILLS,
  MCP_GATEWAY_BIN,
  PAGEINDEX_REFS,
  PAPERCLIP_PID,
  PAPERCLIP_ROOT,
  VENV_DIR,
  VENV_PIP,
  VENV_PYTHON,
  paperclipBaseUrl,
} from "./paths.js";
import { getJson } from "./http.js";

export type Status = "ok" | "missing" | "degraded";

export interface SystemStatus {
  name: string;
  status: Status;
  version: string | null;
  detail: string;
}

export interface PreflightStatus {
  node: SystemStatus;
  pnpm: SystemStatus;
  python: SystemStatus;
  git: SystemStatus;
}

function parseVersion(output: string): string | null {
  const match = output.match(/(\d+\.\d+\.\d+)/);
  return match ? (match[1] ?? null) : null;
}

export function checkPreflight(): PreflightStatus {
  const nodeVersion = process.version.replace(/^v/, "");
  const nodeMajor = Number.parseInt(nodeVersion.split(".")[0] ?? "0", 10);
  const node: SystemStatus = {
    name: "Node.js",
    status: nodeMajor >= 22 ? "ok" : "degraded",
    version: nodeVersion,
    detail: nodeMajor >= 22 ? `>= 22 (${nodeVersion})` : `need >= 22, got ${nodeVersion}`,
  };

  const pnpmBin = which("pnpm");
  let pnpmVersion: string | null = null;
  if (pnpmBin) {
    const result = exec("pnpm", ["--version"]);
    pnpmVersion = result.code === 0 ? result.stdout.trim() : null;
  }
  const pnpm: SystemStatus = {
    name: "pnpm",
    status: pnpmBin ? "ok" : "missing",
    version: pnpmVersion,
    detail: pnpmBin ? `${pnpmBin} (${pnpmVersion ?? "unknown"})` : "install: https://pnpm.io/installation",
  };

  // Prefer the project venv python if present, else system python3.
  let pythonPath = existsSync(VENV_PYTHON) ? VENV_PYTHON : which("python3");
  let pythonVersion: string | null = null;
  if (pythonPath) {
    const result = exec(pythonPath, ["--version"]);
    pythonVersion = parseVersion(result.stdout + result.stderr);
  }
  const pyMajorMinor = pythonVersion ? pythonVersion.split(".").slice(0, 2).map(Number) : [0, 0];
  const pyOk = (pyMajorMinor[0] ?? 0) >= 3 && (pyMajorMinor[1] ?? 0) >= 10;
  const python: SystemStatus = {
    name: "Python",
    status: pythonPath && pyOk ? "ok" : "missing",
    version: pythonVersion,
    detail: pythonPath ? `${pythonPath} (${pythonVersion ?? "unknown"})` : "install Python 3.10+",
  };

  const gitBin = which("git");
  let gitVersion: string | null = null;
  if (gitBin) {
    const result = exec("git", ["--version"]);
    gitVersion = parseVersion(result.stdout);
  }
  const git: SystemStatus = {
    name: "git",
    status: gitBin ? "ok" : "missing",
    version: gitVersion,
    detail: gitBin ? `${gitBin} (${gitVersion ?? "unknown"})` : "install git",
  };

  return { node, pnpm, python, git };
}

export interface PaperclipStatus extends SystemStatus {
  installed: boolean;
  running: boolean;
  pid: number | null;
  url: string;
}

export async function detectPaperclip(): Promise<PaperclipStatus> {
  const installed = existsSync(PAPERCLIP_ROOT) && existsSync(join(PAPERCLIP_ROOT, "package.json"));
  const pid = readPid(PAPERCLIP_PID);
  const pidAlive = pid !== null && isAlive(pid);
  const url = paperclipBaseUrl();
  const health = await getJson<{ status?: string }>(`${url}/api/plugins`, 2000);
  const running = pidAlive && health.ok;

  let version: string | null = null;
  if (installed) {
    try {
      const pkg = JSON.parse(readFileSync(join(PAPERCLIP_ROOT, "package.json"), "utf-8")) as {
        version?: string;
      };
      version = pkg.version ?? null;
    } catch {
      version = null;
    }
  }

  let status: Status;
  let detail: string;
  if (!installed) {
    status = "missing";
    detail = `not cloned at ${PAPERCLIP_ROOT}`;
  } else if (!running) {
    status = "degraded";
    detail = pidAlive
      ? `pid ${pid} alive but health check failed at ${url}/api/plugins`
      : `installed but server not running`;
  } else {
    status = "ok";
    detail = `running at ${url} (pid ${pid})`;
  }

  return {
    name: "Paperclip",
    status,
    version,
    detail,
    installed,
    running,
    pid,
    url,
  };
}

export function detectGstack(): SystemStatus {
  const installed = existsSync(GSTACK_SKILLS);
  return {
    name: "gstack",
    status: installed ? "ok" : "missing",
    version: null,
    detail: installed
      ? `skills found at ${GSTACK_SKILLS}`
      : `install gstack skills to ${GSTACK_SKILLS}`,
  };
}

export function detectGraphify(): SystemStatus {
  if (!existsSync(VENV_PIP)) {
    return {
      name: "Graphify",
      status: "missing",
      version: null,
      detail: `venv not present at ${VENV_DIR}`,
    };
  }
  const result = exec(VENV_PIP, ["show", "graphifyy"]);
  if (result.code !== 0) {
    return {
      name: "Graphify",
      status: "missing",
      version: null,
      detail: "graphifyy not installed in venv",
    };
  }
  const versionMatch = result.stdout.match(/^Version:\s*(.+)$/m);
  return {
    name: "Graphify",
    status: "ok",
    version: versionMatch?.[1]?.trim() ?? null,
    detail: `installed in ${VENV_DIR}`,
  };
}

export function detectPageIndex(): SystemStatus {
  if (!existsSync(VENV_PYTHON)) {
    return {
      name: "PageIndex",
      status: "missing",
      version: null,
      detail: `venv not present at ${VENV_DIR}`,
    };
  }
  // PageIndex is loaded from refs/ — check by importing via the venv python.
  const check = exec(VENV_PYTHON, [
    "-c",
    "import sys; sys.path.insert(0, '" + PAGEINDEX_REFS + "'); import pageindex; print('ok')",
  ]);
  if (check.code !== 0) {
    return {
      name: "PageIndex",
      status: "missing",
      version: null,
      detail: `cannot import pageindex from ${PAGEINDEX_REFS}`,
    };
  }
  return {
    name: "PageIndex",
    status: "ok",
    version: null,
    detail: `importable from ${PAGEINDEX_REFS}`,
  };
}

export function detectMcpGateway(): SystemStatus {
  const built = existsSync(MCP_GATEWAY_BIN);
  return {
    name: "MCP Gateway",
    status: built ? "ok" : "missing",
    version: null,
    detail: built ? MCP_GATEWAY_BIN : `build with: npx tsc --build`,
  };
}

export interface AllSystemsStatus {
  preflight: PreflightStatus;
  paperclip: PaperclipStatus;
  gstack: SystemStatus;
  graphify: SystemStatus;
  pageindex: SystemStatus;
  mcpGateway: SystemStatus;
}

export async function detectAll(): Promise<AllSystemsStatus> {
  const preflight = checkPreflight();
  const [paperclip] = await Promise.all([detectPaperclip()]);
  return {
    preflight,
    paperclip,
    gstack: detectGstack(),
    graphify: detectGraphify(),
    pageindex: detectPageIndex(),
    mcpGateway: detectMcpGateway(),
  };
}
