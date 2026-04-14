// Project Registry — JSON-file-based project store at ~/.vela/projects.json

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { ProjectConfig } from "./index.js";

const REGISTRY_DIR = join(homedir(), ".vela");
const REGISTRY_PATH = join(REGISTRY_DIR, "projects.json");

function ensureDir(): void {
  if (!existsSync(REGISTRY_DIR)) {
    mkdirSync(REGISTRY_DIR, { recursive: true });
  }
}

function readRegistry(): ProjectConfig[] {
  ensureDir();
  if (!existsSync(REGISTRY_PATH)) return [];
  try {
    const raw = readFileSync(REGISTRY_PATH, "utf-8");
    return JSON.parse(raw) as ProjectConfig[];
  } catch {
    return [];
  }
}

function writeRegistry(projects: ProjectConfig[]): void {
  ensureDir();
  writeFileSync(REGISTRY_PATH, JSON.stringify(projects, null, 2), "utf-8");
}

export function listProjects(): ProjectConfig[] {
  return readRegistry();
}

export function getProject(name: string): ProjectConfig | undefined {
  return readRegistry().find((p) => p.name === name);
}

export function addProject(project: ProjectConfig): void {
  const projects = readRegistry();
  const idx = projects.findIndex((p) => p.name === project.name);
  if (idx >= 0) {
    projects[idx] = project;
  } else {
    projects.push(project);
  }
  writeRegistry(projects);
}

export function removeProject(name: string): boolean {
  const projects = readRegistry();
  const filtered = projects.filter((p) => p.name !== name);
  if (filtered.length === projects.length) return false;
  writeRegistry(filtered);
  return true;
}

/**
 * Scan a directory for git repos and return suggested ProjectConfig entries.
 * Only scans one level deep (immediate subdirectories).
 */
export function discoverProjects(
  parentDir: string,
  type: ProjectConfig["type"] = "personal",
): ProjectConfig[] {
  const discovered: ProjectConfig[] = [];
  if (!existsSync(parentDir)) return discovered;

  const entries = readdirSync(parentDir);
  for (const entry of entries) {
    const fullPath = join(parentDir, entry);
    try {
      const stat = statSync(fullPath);
      if (!stat.isDirectory()) continue;
      // Check if it's a git repo
      if (existsSync(join(fullPath, ".git"))) {
        discovered.push({
          name: entry,
          path: fullPath,
          type,
          relatedProjects: [],
        });
      }
    } catch {
      // Skip entries we can't stat
    }
  }
  return discovered;
}

export { REGISTRY_PATH };
