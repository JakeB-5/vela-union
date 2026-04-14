// Test the Phase 5 feedback loop module
//
// Verifies:
//   - extractDecisionsFromOutput parses heuristic patterns
//   - recordDecisions writes per-goal + project log files
//   - findCrossProjectImplications detects related-project matches
//   - triggerGraphRefresh spawns the gateway (without blocking)

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// Derive companion paths without hardcoding user directories
const _scriptDir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT =
  process.env["VELA_REPO_ROOT"] ?? resolve(_scriptDir, "..");
const PAPERCLIP_ROOT =
  process.env["PAPERCLIP_ROOT"] ?? resolve(REPO_ROOT, "..", "paperclip");
import {
  extractDecisionsFromOutput,
  recordDecisions,
  findCrossProjectImplications,
  triggerGraphRefresh,
  readDecisions,
  listDecisionFiles,
  DECISIONS_DIR,
} from "../packages/shared/src/feedback.js";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\n[1] extractDecisionsFromOutput");
{
  const output = `
Looking at this task, I decided to use the existing dispatch handler.
After review, I chose to refactor the briefing pack module first.
Decided: ship the smallest possible MVP.
Rejected the option to rewrite the registry — it works as-is.
Tradeoff: faster build but more memory usage.
Assumption is that Claude CLI is available on PATH.
`;
  const decisions = extractDecisionsFromOutput(output);
  check("returns array", Array.isArray(decisions));
  check("finds at least 5 decisions", decisions.length >= 5, `count=${decisions.length}`);
  check(
    "captures decided trigger",
    decisions.some((d) => d.trigger === "decided"),
  );
  check(
    "captures rejected trigger",
    decisions.some((d) => d.trigger === "rejected"),
  );
  check(
    "captures tradeoff trigger",
    decisions.some((d) => d.trigger === "tradeoff"),
  );
  check(
    "deduplicates",
    new Set(decisions.map((d) => `${d.trigger}::${d.text.toLowerCase()}`)).size === decisions.length,
  );
}

console.log("\n[2] empty / invalid input");
{
  check("empty string returns []", extractDecisionsFromOutput("").length === 0);
  check(
    "non-matching string returns []",
    extractDecisionsFromOutput("hello world this is plain text").length === 0,
  );
}

console.log("\n[3] recordDecisions");
{
  const goalId = `test-${Date.now()}`;
  const projectName = "vela-union-test-project";
  const result = recordDecisions(
    goalId,
    projectName,
    [
      { trigger: "decided", text: "use SQLite for the registry" },
      { trigger: "rejected", text: "global cron daemon" },
    ],
    { goalDescription: "test goal", summary: "test summary" },
  );
  check("returns filePath", !!result.filePath);
  check("returns logPath", !!result.logPath);
  check("count matches", result.count === 2);
  check("file exists", existsSync(result.filePath));
  check("log exists", existsSync(result.logPath));

  const content = readFileSync(result.filePath, "utf-8");
  check("file contains goalId", content.includes(goalId));
  check("file contains decision text", content.includes("SQLite"));
  check("file contains trigger label", content.includes("[decided]"));

  const logContent = readFileSync(result.logPath, "utf-8");
  check("log contains short goal id", logContent.includes(goalId.slice(0, 8)));

  // readDecisions roundtrip
  const readBack = readDecisions(projectName, goalId);
  check("readDecisions returns content", readBack !== null);
  check("readDecisions matches written", readBack === content);

  // listDecisionFiles
  const files = listDecisionFiles(projectName);
  check("listDecisionFiles includes our file", files.includes(result.filePath));
}

console.log("\n[4] empty decisions still write file");
{
  const goalId = `test-empty-${Date.now()}`;
  const projectName = "vela-union-test-empty";
  const result = recordDecisions(goalId, projectName, [], {
    goalDescription: "no decisions extracted",
  });
  check("file written for empty list", existsSync(result.filePath));
  const content = readFileSync(result.filePath, "utf-8");
  check("placeholder text present", content.includes("No decisions extracted"));
}

console.log("\n[5] findCrossProjectImplications (no related projects)");
{
  const implications = findCrossProjectImplications("nonexistent-project", ["foo.ts"]);
  check("returns empty for nonexistent project", implications.length === 0);
}

console.log("\n[6] triggerGraphRefresh (fire-and-forget)");
{
  const outcome = triggerGraphRefresh("paperclip", PAPERCLIP_ROOT);
  check("returns spawned status", typeof outcome.spawned === "boolean");
  if (outcome.spawned) {
    check("returns pid", outcome.pid !== null && outcome.pid > 0);
    console.log(`    spawned with pid=${outcome.pid}`);
  } else {
    console.log(`    not spawned: ${outcome.reason}`);
  }
}

console.log("\n[7] DECISIONS_DIR exported");
{
  check("DECISIONS_DIR is string", typeof DECISIONS_DIR === "string");
  check("DECISIONS_DIR contains .vela", DECISIONS_DIR.includes(".vela"));
  check(
    "DECISIONS_DIR is under home",
    DECISIONS_DIR.startsWith(homedir()),
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
