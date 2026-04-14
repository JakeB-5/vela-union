#!/usr/bin/env npx tsx
// Test script: verify dispatch-goal prompt assembly

import { generateBriefingPack } from "../packages/paperclip-plugin/src/briefing.js";
import { assembleDispatchPrompt } from "../packages/paperclip-plugin/src/dispatch.js";
import { getProject } from "../packages/shared/src/index.js";

console.log("=== Dispatch Goal Test ===\n");

const project = getProject("paperclip");
if (!project) {
  console.error("paperclip not in registry — run test-registry.ts first");
  process.exit(1);
}

const goal = "Fix the agent session cleanup logic that leaves orphaned sessions after timeout. The cleanup job should properly close sessions and emit agent.session.ended events.";

console.log(`Project: ${project.name}`);
console.log(`Goal: ${goal}\n`);

const start = performance.now();
const pack = generateBriefingPack(project);
const prompt = assembleDispatchPrompt(pack, goal);
const elapsed = performance.now() - start;

console.log(`Generation time: ${elapsed.toFixed(0)}ms`);
console.log(`Prompt length: ${prompt.length} chars`);
console.log(`Sections: ${prompt.split("---").length}\n`);

// Show first 1500 chars of the prompt
console.log("--- Prompt Preview (first 1500 chars) ---");
console.log(prompt.slice(0, 1500));
console.log("...\n");

console.log("=== Dispatch Test Complete ===");
