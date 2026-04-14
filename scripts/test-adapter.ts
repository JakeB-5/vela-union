#!/usr/bin/env npx tsx
// Test script: verify gstack adapter, goal tracking, and dispatch integration

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkClaudeAvailability, createGstackAdapter } from "../packages/gstack-adapter/src/adapter.js";

const REPO_ROOT =
  process.env["VELA_REPO_ROOT"] ??
  resolve(dirname(fileURLToPath(import.meta.url)), "..");
import { createGoal, updateGoal, listGoals, getGoal, GOALS_PATH } from "../packages/shared/src/goals.js";
import { addProject, getProject } from "../packages/shared/src/registry.js";
import { generateBriefingPack } from "../packages/paperclip-plugin/src/briefing.js";
import { assembleDispatchPrompt } from "../packages/paperclip-plugin/src/dispatch.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

// --- Test 1: Claude CLI availability check ---
console.log("\n=== Test 1: Claude CLI Availability ===\n");

const availability = checkClaudeAvailability();
console.log(`  Claude available: ${availability.available}`);
console.log(`  Claude path: ${availability.path}`);
console.log(`  Claude version: ${availability.version}`);
assert(typeof availability.available === "boolean", "availability.available is boolean");
assert(availability.path === null || typeof availability.path === "string", "availability.path is string or null");

// --- Test 2: Adapter creation ---
console.log("\n=== Test 2: Adapter Creation ===\n");

const adapter = createGstackAdapter({
  skills: ["qa", "review", "ship", "investigate"],
});
assert(adapter.adapterType === "gstack_local", "adapter type is gstack_local");
assert(typeof adapter.claudeAvailable === "boolean", "claudeAvailable is boolean");
assert(typeof adapter.executeSkill === "function", "executeSkill is a function");
assert(typeof adapter.executeGoal === "function", "executeGoal is a function");
assert(typeof adapter.dryRun === "function", "dryRun is a function");
assert(typeof adapter.checkAvailability === "function", "checkAvailability is a function");

// --- Test 3: Dry run dispatch ---
console.log("\n=== Test 3: Dry Run Dispatch ===\n");

// Ensure project exists in registry
addProject({
  name: "vela-union",
  path: REPO_ROOT,
  type: "company",
  relatedProjects: ["paperclip"],
  description: "4-system agent orchestration platform",
});

const project = getProject("vela-union");
assert(project !== undefined, "vela-union project found in registry");

if (project) {
  const pack = generateBriefingPack(project);
  const goal = "Review the gstack adapter implementation and verify it follows proper patterns.";
  const prompt = assembleDispatchPrompt(pack, goal);

  const dryResult = adapter.dryRun(project.path, goal, prompt);
  console.log(`  Command: ${dryResult.command}`);
  console.log(`  CWD: ${dryResult.cwd}`);
  console.log(`  Timeout: ${dryResult.timeoutMs}ms`);
  console.log(`  Prompt length: ${dryResult.prompt.length} chars`);

  assert(dryResult.cwd === project.path, "dry run CWD matches project path");
  assert(dryResult.timeoutMs === 300_000, "default timeout is 5 minutes");
  assert(dryResult.prompt.length > 0, "prompt is non-empty");
  assert(dryResult.args[0] === "-p", "first arg is -p");
}

// --- Test 4: Goal Tracking CRUD ---
console.log("\n=== Test 4: Goal Tracking CRUD ===\n");
console.log(`  Goals path: ${GOALS_PATH}`);

// Create
const goal1 = createGoal("vela-union", "Implement gstack adapter Phase 2");
assert(typeof goal1.id === "string" && goal1.id.length > 0, "goal1 has an ID");
assert(goal1.projectName === "vela-union", "goal1 project is vela-union");
assert(goal1.status === "pending", "goal1 status is pending");
assert(typeof goal1.createdAt === "string", "goal1 has createdAt");

const goal2 = createGoal("vela-union", "Write tests for adapter");
const goal3 = createGoal("paperclip", "Fix agent session cleanup");

// List all
const allGoals = listGoals();
assert(allGoals.length >= 3, "at least 3 goals exist");

// List by project
const velaGoals = listGoals("vela-union");
assert(velaGoals.length >= 2, "at least 2 vela-union goals");
assert(velaGoals.every((g) => g.projectName === "vela-union"), "all filtered goals belong to vela-union");

const pcGoals = listGoals("paperclip");
assert(pcGoals.length >= 1, "at least 1 paperclip goal");

// Get by ID
const fetched = getGoal(goal1.id);
assert(fetched !== undefined, "goal1 found by ID");
assert(fetched?.description === "Implement gstack adapter Phase 2", "goal1 description matches");

// Update status
const updated = updateGoal(goal1.id, { status: "executing" });
assert(updated !== undefined, "update returned the goal");
assert(updated?.status === "executing", "goal1 status updated to executing");

// Update with result
const withResult = updateGoal(goal1.id, {
  status: "done",
  result: {
    goalId: goal1.id,
    success: true,
    summary: "Phase 2 adapter implemented successfully",
    touchedFiles: ["packages/gstack-adapter/src/adapter.ts", "packages/shared/src/goals.ts"],
    decisionsMade: ["Used spawn instead of exec for streaming", "5-minute default timeout"],
    followUps: ["Add session persistence", "Implement cost tracking"],
    crossProjectImplications: ["Paperclip plugin now depends on gstack-adapter"],
  },
});
assert(withResult?.status === "done", "goal1 status is done");
assert(withResult?.result?.success === true, "goal1 result is successful");
assert(withResult?.result?.touchedFiles.length === 2, "goal1 touched 2 files");

// Get non-existent
const missing = getGoal("nonexistent-id");
assert(missing === undefined, "nonexistent goal returns undefined");

// Update non-existent
const badUpdate = updateGoal("nonexistent-id", { status: "failed" });
assert(badUpdate === undefined, "updating nonexistent goal returns undefined");

// --- Test 5: Adapter skill execution (only if Claude is available) ---
console.log("\n=== Test 5: Adapter Skill Execution ===\n");

if (!availability.available) {
  console.log("  SKIP: Claude CLI not available — skipping live execution tests");
  console.log("  (This is expected in CI or on machines without Claude Code installed)");
} else {
  console.log("  Claude CLI available — testing adapter would execute skills");
  console.log("  (Skipping actual execution to avoid side effects in test)");
  // We verify the adapter can construct a valid command via dryRun
  if (project) {
    const skillDry = adapter.dryRun(project.path, "test", "test prompt");
    assert(skillDry.command !== null, "skill dry run has a command");
    console.log(`  Would run: ${skillDry.command} ${skillDry.args.join(" ").slice(0, 50)}...`);
  }
}

// --- Summary ---
console.log("\n=== Test Summary ===\n");
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`  Total:  ${passed + failed}`);

if (failed > 0) {
  console.error("\nSome tests failed!");
  process.exit(1);
}

console.log("\nAll tests passed!");
