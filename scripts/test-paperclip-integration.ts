// Paperclip integration test — exercises the full stack:
//
//   1. Config load/save
//   2. PaperclipClient connectivity + company/agent lookup
//   3. Project create/find/delete (cleanup after)
//   4. Issue create (cleanup skipped — issues are cheap and useful for
//      manual inspection in the dashboard)
//   5. Register sync: verify a temp Vela project gets a Paperclip id
//   6. execute-tool via API (proves the 502 bug is fixed)
//
// Run: `npx tsx scripts/test-paperclip-integration.ts`
//
// Preconditions:
//   - Paperclip running at http://127.0.0.1:3100
//   - ~/.vela/config.json populated with companyId + defaultAgentId
//   - Worker for vela-union plugin is active (status=running)

import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  loadConfig,
  saveConfig,
  resolvePaperclipConfig,
  PaperclipClient,
  PaperclipApiError,
  addProject,
  getProject,
  removeProject,
  dispatchViaPaperclip,
  createLogger,
} from "../packages/shared/dist/index.js";
import type {
  PaperclipProject,
  ProjectConfig,
  VelaConfig,
} from "../packages/shared/dist/index.js";

interface TestResult {
  name: string;
  ok: boolean;
  message: string;
  elapsedMs: number;
}

const results: TestResult[] = [];

async function runTest(name: string, fn: () => Promise<string>): Promise<void> {
  const started = Date.now();
  try {
    const message = await fn();
    const elapsedMs = Date.now() - started;
    results.push({ name, ok: true, message, elapsedMs });
    console.log(`  ok   ${name} — ${message} (${elapsedMs}ms)`);
  } catch (err) {
    const elapsedMs = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, message, elapsedMs });
    console.log(`  FAIL ${name} — ${message} (${elapsedMs}ms)`);
  }
}

const TEST_PROJECT_SUFFIX = randomUUID().slice(0, 8);
const TEST_PROJECT_NAME = `pcp-int-test-${TEST_PROJECT_SUFFIX}`;
const TEST_PROJECT_DIR = join(tmpdir(), `vela-${TEST_PROJECT_NAME}`);

// Track artifacts for cleanup
const cleanup: { paperclipProjectIds: string[]; localProjectNames: string[] } = {
  paperclipProjectIds: [],
  localProjectNames: [],
};

async function main(): Promise<void> {
  console.log("Vela Union × Paperclip — integration test\n");

  // -----------------------------------------------------------------
  // Test 1: Config load/save round-trip
  // -----------------------------------------------------------------
  await runTest("config load/save round-trip", async () => {
    const before = loadConfig();
    if (!before.paperclip) {
      throw new Error("~/.vela/config.json missing paperclip section. Run `vela setup` first.");
    }
    // Save a no-op patch and verify nothing was corrupted.
    saveConfig({ paperclip: before.paperclip });
    const after = loadConfig();
    if (after.paperclip?.companyId !== before.paperclip.companyId) {
      throw new Error("companyId mismatch after save round-trip");
    }
    return `companyId=${before.paperclip.companyId.slice(0, 8)}`;
  });

  // -----------------------------------------------------------------
  // Test 2: PaperclipClient ping + list companies
  // -----------------------------------------------------------------
  const cfg = resolvePaperclipConfig();
  if (!cfg) {
    console.log("\nABORT: resolvePaperclipConfig() returned null. Cannot continue.\n");
    process.exit(1);
  }
  const client = new PaperclipClient(cfg);
  await runTest("paperclip ping", async () => {
    await client.ping();
    return cfg.apiUrl;
  });

  await runTest("list companies", async () => {
    const companies = await client.listCompanies();
    if (companies.length === 0) throw new Error("zero companies found");
    const match = companies.find((c) => c.id === cfg.companyId);
    if (!match) {
      throw new Error(`company ${cfg.companyId} not found; got: ${companies.map((c) => c.id).join(", ")}`);
    }
    return `${companies.length} company(ies), configured="${match.name}"`;
  });

  // -----------------------------------------------------------------
  // Test 3: List agents — default assignee must exist
  // -----------------------------------------------------------------
  await runTest("list agents", async () => {
    const agents = await client.listAgents();
    if (agents.length === 0) throw new Error("zero agents in company");
    const match = agents.find((a) => a.id === cfg.defaultAgentId);
    if (!match) {
      throw new Error(`defaultAgentId ${cfg.defaultAgentId} not found`);
    }
    return `${agents.length} agent(s), default="${match.name}"`;
  });

  // -----------------------------------------------------------------
  // Test 4: Create temp local project directory for workspace
  // -----------------------------------------------------------------
  await runTest("prepare temp project dir", async () => {
    if (!existsSync(TEST_PROJECT_DIR)) {
      mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    }
    writeFileSync(
      join(TEST_PROJECT_DIR, "README.md"),
      `# ${TEST_PROJECT_NAME}\n\nIntegration test project — safe to delete.\n`,
      "utf-8",
    );
    return TEST_PROJECT_DIR;
  });

  // -----------------------------------------------------------------
  // Test 5: Create Paperclip project with [VELA] prefix
  // -----------------------------------------------------------------
  const paperclipName = `${cfg.defaultProjectPrefix ?? "[VELA]"} ${TEST_PROJECT_NAME}`;
  let createdProject: PaperclipProject | null = null;
  await runTest("paperclip create project", async () => {
    createdProject = await client.createProject({
      name: paperclipName,
      description: "integration-test",
      workspace: {
        name: TEST_PROJECT_NAME,
        sourceType: "local_path",
        cwd: TEST_PROJECT_DIR,
        isPrimary: true,
      },
    });
    cleanup.paperclipProjectIds.push(createdProject.id);
    return `id=${createdProject.id}`;
  });

  // -----------------------------------------------------------------
  // Test 6: Find project by name (read-after-write consistency)
  // -----------------------------------------------------------------
  await runTest("paperclip find project by name", async () => {
    const found = await client.findProjectByName(paperclipName);
    if (!found) throw new Error(`project "${paperclipName}" not found after create`);
    if (found.id !== createdProject?.id) {
      throw new Error(`id mismatch: expected ${createdProject?.id}, got ${found.id}`);
    }
    return `matched id=${found.id}`;
  });

  // -----------------------------------------------------------------
  // Test 7: Register a Vela project + verify paperclipProjectId sync
  // -----------------------------------------------------------------
  const velaProject: ProjectConfig = {
    name: TEST_PROJECT_NAME,
    path: TEST_PROJECT_DIR,
    type: "experimental",
    relatedProjects: [],
    description: "integration-test",
    paperclipProjectId: createdProject!.id,
  };
  await runTest("local registry round-trip with paperclipProjectId", async () => {
    addProject(velaProject);
    cleanup.localProjectNames.push(TEST_PROJECT_NAME);
    const readBack = getProject(TEST_PROJECT_NAME);
    if (!readBack) throw new Error("project not saved");
    if (readBack.paperclipProjectId !== createdProject!.id) {
      throw new Error(`paperclipProjectId missing — got ${readBack.paperclipProjectId}`);
    }
    return `paperclipProjectId=${readBack.paperclipProjectId}`;
  });

  // -----------------------------------------------------------------
  // Test 8: dispatchViaPaperclip — creates an issue
  // -----------------------------------------------------------------
  const dispatchLog = createLogger({
    component: "test.dispatch",
    cid: "test",
    level: "info",
    tty: false,
  });
  let dispatchedIssueId: string | null = null;
  await runTest("dispatchViaPaperclip creates issue", async () => {
    const result = await dispatchViaPaperclip(
      client,
      cfg,
      {
        project: velaProject,
        goal: "integration test — verify issue creation flow",
        briefing: "This is a tiny briefing pack used by the integration test.",
      },
      dispatchLog,
    );
    dispatchedIssueId = result.paperclipIssueId;
    return `issue=${result.paperclipIssueId.slice(0, 8)}`;
  });

  // -----------------------------------------------------------------
  // Test 9: getIssue confirms the issue landed
  // -----------------------------------------------------------------
  await runTest("paperclip getIssue", async () => {
    if (!dispatchedIssueId) throw new Error("no dispatched issue to look up");
    const issue = await client.getIssue(dispatchedIssueId);
    if (!issue) throw new Error("issue not found by id after create");
    if (issue.assigneeAgentId !== cfg.defaultAgentId) {
      console.log(`    note: assigneeAgentId mismatch (${issue.assigneeAgentId} vs ${cfg.defaultAgentId})`);
    }
    return `title="${issue.title}"`;
  });

  // -----------------------------------------------------------------
  // Test 10: POST /api/plugins/tools/execute (the 502 fix verification)
  // -----------------------------------------------------------------
  await runTest("plugin tool execute — project-status", async () => {
    const res = await fetch(`${cfg.apiUrl}/api/plugins/tools/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tool: "vela-union:project-status",
        parameters: {},
        runContext: {
          agentId: cfg.defaultAgentId,
          runId: `test-${Date.now()}`,
          companyId: cfg.companyId,
          projectId: createdProject!.id,
        },
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    const parsed = JSON.parse(text) as {
      pluginId?: string;
      toolName?: string;
      result?: { content?: string; data?: { count?: number } };
    };
    if (parsed.pluginId !== "vela-union" || parsed.toolName !== "project-status") {
      throw new Error(`unexpected response shape: ${text.slice(0, 200)}`);
    }
    const count = parsed.result?.data?.count ?? 0;
    return `pluginId=vela-union, count=${count}`;
  });

  // -----------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------
  console.log("\nCleanup:");
  for (const projectId of cleanup.paperclipProjectIds) {
    try {
      await client.deleteProject(projectId);
      console.log(`  deleted paperclip project ${projectId}`);
    } catch (err) {
      if (err instanceof PaperclipApiError) {
        console.log(`  skip delete ${projectId}: ${err.status} ${err.message}`);
      } else {
        console.log(`  skip delete ${projectId}: ${(err as Error).message}`);
      }
    }
  }
  for (const name of cleanup.localProjectNames) {
    removeProject(name);
    console.log(`  removed local project ${name}`);
  }
  try {
    if (existsSync(TEST_PROJECT_DIR)) {
      rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
      console.log(`  removed ${TEST_PROJECT_DIR}`);
    }
  } catch {
    // Best-effort
  }

  // -----------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nSummary: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`  FAIL ${r.name}: ${r.message}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("integration test crashed:", err);
  process.exit(2);
});
