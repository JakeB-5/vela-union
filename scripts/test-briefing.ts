#!/usr/bin/env npx tsx
// Test script: verify briefing pack generation against real projects

import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateBriefingPack } from "../packages/paperclip-plugin/src/briefing.js";
import type { ProjectConfig } from "../packages/shared/src/index.js";

// Repo root (env override or infer from this script's location)
const REPO_ROOT =
  process.env["VELA_REPO_ROOT"] ??
  resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAPERCLIP_ROOT =
  process.env["PAPERCLIP_ROOT"] ?? resolve(REPO_ROOT, "..", "paperclip");
const PROJECTS_DIR =
  process.env["PROJECTS_DIR"] ?? join(homedir(), "projects");

function testProject(project: ProjectConfig): void {
  console.log(`\n=== Testing: ${project.name} ===`);
  console.log(`Path: ${project.path}\n`);

  const start = performance.now();
  const pack = generateBriefingPack(project);
  const elapsed = performance.now() - start;

  console.log(`Generation time: ${elapsed.toFixed(0)}ms\n`);

  console.log(`--- Recent Commits (${pack.recentCommits.length}) ---`);
  for (const c of pack.recentCommits.slice(0, 5)) {
    console.log(`  ${c}`);
  }
  if (pack.recentCommits.length > 5) {
    console.log(`  ... and ${pack.recentCommits.length - 5} more`);
  }

  console.log(`\n--- Directory Tree (first 15 lines) ---`);
  const treeLines = pack.directoryTree.split("\n");
  for (const line of treeLines.slice(0, 15)) {
    console.log(`  ${line}`);
  }
  if (treeLines.length > 15) {
    console.log(`  ... and ${treeLines.length - 15} more directories`);
  }

  console.log(`\n--- High Churn Files (${pack.highChurnFiles.length}) ---`);
  for (const f of pack.highChurnFiles.slice(0, 10)) {
    console.log(`  ${f}`);
  }

  console.log(`\n--- README: ${pack.readme ? `${pack.readme.length} chars` : "not found"}`);
  console.log(`--- CLAUDE.md: ${pack.claudeMd ? `${pack.claudeMd.length} chars` : "not found"}`);
  console.log(`--- Pinned files: ${pack.pinnedFiles.length}`);
  console.log(`--- Generated at: ${pack.generatedAt}`);
}

// Test 1: Paperclip (proper git repo)
testProject({
  name: "paperclip",
  path: PAPERCLIP_ROOT,
  type: "company",
  relatedProjects: ["vela-union"],
  description: "Agent hiring & org management platform",
});

// Test 2: sweditor-v2 sub-project (git repo)
testProject({
  name: "editor-product-strategy",
  path: join(PROJECTS_DIR, "sweditor-v2", "editor-product-strategy"),
  type: "company",
  relatedProjects: ["sweditor-v2"],
  description: "Editor product strategy module",
});

console.log("\n=== All Tests Complete ===");
