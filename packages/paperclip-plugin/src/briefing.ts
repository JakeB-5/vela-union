// Briefing Pack Generator
// Generates context bundles per project for agent consumption

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ProjectConfig, BriefingPack, GbrainSearchResult } from "@vela-union/shared";

function safeExec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", timeout: 10_000 }).trim();
  } catch {
    return "";
  }
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function getRecentCommits(projectPath: string, count = 50): string[] {
  const raw = safeExec(`git log --oneline -${count}`, projectPath);
  return raw ? raw.split("\n") : [];
}

function getDirectoryTree(projectPath: string, depth = 3): string {
  // Use find to get directory structure, excluding common noise
  return safeExec(
    `find . -maxdepth ${depth} -type d -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/.venv/*' | sort`,
    projectPath,
  );
}

function getHighChurnFiles(projectPath: string, days = 30, limit = 20): string[] {
  const raw = safeExec(
    `git log --since="${days} days ago" --name-only --pretty=format: | sort | uniq -c | sort -rn | head -${limit}`,
    projectPath,
  );
  return raw
    ? raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
}

function getPinnedFiles(projectPath: string): string[] {
  const pinsFile = join(projectPath, ".vela", "pins.txt");
  if (!existsSync(pinsFile)) return [];
  const content = readFileSync(pinsFile, "utf-8");
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// gbrain context — dynamic import to avoid static circular dependency
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
};

async function fetchGbrainContext(goal: string, limit = 5): Promise<GbrainSearchResult[]> {
  try {
    const gbrain = (await import(
      "@vela-union/mcp-gateway/dist/gbrain.js"
    )) as GbrainModule;
    const avail = gbrain.checkAvailability();
    if (!avail.available) return [];
    const res = await gbrain.knowledgeSearch(goal, limit);
    return res.success ? res.results : [];
  } catch {
    // gbrain not installed or brain not initialised — degrade silently
    return [];
  }
}

export async function generateBriefingPack(project: ProjectConfig, goal?: string): Promise<BriefingPack> {
  const { path: projectPath } = project;

  const gbrainContext = goal ? await fetchGbrainContext(goal) : [];

  return {
    project,
    recentCommits: getRecentCommits(projectPath),
    directoryTree: getDirectoryTree(projectPath),
    highChurnFiles: getHighChurnFiles(projectPath),
    readme: readFileOrNull(join(projectPath, "README.md")),
    claudeMd: readFileOrNull(join(projectPath, "CLAUDE.md")),
    pinnedFiles: getPinnedFiles(projectPath),
    generatedAt: new Date().toISOString(),
    ...(gbrainContext.length > 0 ? { gbrainContext } : {}),
  };
}
