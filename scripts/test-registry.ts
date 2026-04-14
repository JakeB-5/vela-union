#!/usr/bin/env npx tsx
// Test script: verify project registry CRUD operations

import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { addProject, getProject, listProjects, removeProject, discoverProjects, REGISTRY_PATH } from "../packages/shared/src/index.js";

// Repo root (env override or infer from this script's location)
const REPO_ROOT =
  process.env["VELA_REPO_ROOT"] ??
  resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Companion repos default to siblings of REPO_ROOT
const PAPERCLIP_ROOT =
  process.env["PAPERCLIP_ROOT"] ?? resolve(REPO_ROOT, "..", "paperclip");
const PROJECTS_DIR =
  process.env["PROJECTS_DIR"] ?? join(homedir(), "projects");

console.log("=== Project Registry Test ===\n");
console.log(`Registry path: ${REGISTRY_PATH}\n`);

// Add some projects
addProject({
  name: "paperclip",
  path: PAPERCLIP_ROOT,
  type: "company",
  relatedProjects: ["vela-union"],
  description: "Agent hiring & org management platform",
});

addProject({
  name: "vela-union",
  path: REPO_ROOT,
  type: "company",
  relatedProjects: ["paperclip"],
  description: "4-system agent orchestration platform",
});

addProject({
  name: "editor-product-strategy",
  path: join(PROJECTS_DIR, "sweditor-v2", "editor-product-strategy"),
  type: "company",
  relatedProjects: ["sweditor-v2"],
  description: "Editor product strategy module",
});

// List all
const all = listProjects();
console.log(`Registered projects: ${all.length}`);
for (const p of all) {
  console.log(`  - ${p.name} (${p.type}) @ ${p.path}`);
}

// Get one
const pc = getProject("paperclip");
console.log(`\nGet "paperclip": ${pc ? pc.name : "NOT FOUND"}`);

// Remove one
const removed = removeProject("editor-product-strategy");
console.log(`Remove "editor-product-strategy": ${removed}`);
console.log(`After removal: ${listProjects().length} projects`);

// Discover projects in ~/projects
console.log("\n--- Auto-discover in ~/projects ---");
const discovered = discoverProjects(PROJECTS_DIR);
console.log(`Found ${discovered.length} git repos:`);
for (const d of discovered.slice(0, 10)) {
  console.log(`  - ${d.name} @ ${d.path}`);
}
if (discovered.length > 10) {
  console.log(`  ... and ${discovered.length - 10} more`);
}

console.log("\n=== Registry Test Complete ===");
