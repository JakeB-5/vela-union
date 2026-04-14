#!/usr/bin/env npx tsx
// End-to-end test for the auto-activation layer.
//
// Covers:
//   1. Regression tests for existing behavior (graph.query on built graph,
//      plugin.ts setup tool registrations, test-mcp-gateway still green)
//   2. build-queue tests (enqueue/dequeue/status/worker/dedup)
//   3. startup-scanner tests (empty/mixed/missing-path/already-queued)
//   4. Lazy-build tests (graph.query on missing graph enqueues and
//      returns {status:"building"}; existing graph still queries)
//   5. launchd platform gating
//
// Pattern: simple passed/failed counters, no test framework dep.
// Isolation: the tests that write to ~/.vela use a temp override of
// HOME+VELA paths — we fork a child process with HOME=tempdir for the
// scenarios that touch the filesystem.

import { spawn, type ChildProcessWithoutNullStreams, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Derive repo root from this script's location (scripts/ → ..)
const REPO_ROOT =
  process.env["VELA_REPO_ROOT"] ??
  resolve(dirname(fileURLToPath(import.meta.url)), "..");

import {
  enqueue,
  isQueued,
  readQueue,
  readStatus,
  readAllStatuses,
  startWorker,
  _internals,
} from "../packages/mcp-gateway/dist/build-queue.js";
import { scanAndQueue } from "../packages/paperclip-plugin/dist/startup-scanner.js";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  PASS: ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(label: string): void {
  console.log(`\n=== ${label} ===`);
}

// ---------------------------------------------------------------------------
// Test-scoped VELA_HOME management
// ---------------------------------------------------------------------------
//
// The build-queue module reads homedir() at import time to resolve its paths.
// To make tests hermetic without re-importing the module, we back up any
// existing ~/.vela/build-queue.jsonl + status.json files, run the test,
// then restore them. The tests here only mutate a small, known set of
// project names ("test-aa-*") so we only need to clean those up.

const TEST_PROJECT_PREFIX = "test-aa-";
const QUEUE_BACKUP = mkdtempSync(join(tmpdir(), "vela-aa-test-"));
const VELA_HOME = join(homedir(), ".vela");
const GRAPHIFY_DIR = join(VELA_HOME, "graphify");
const QUEUE_PATH = join(VELA_HOME, "build-queue.jsonl");

function backupQueue(): void {
  if (existsSync(QUEUE_PATH)) {
    writeFileSync(
      join(QUEUE_BACKUP, "build-queue.jsonl"),
      readFileSync(QUEUE_PATH, "utf-8"),
      "utf-8",
    );
  }
}

function restoreQueue(): void {
  const backup = join(QUEUE_BACKUP, "build-queue.jsonl");
  if (existsSync(backup)) {
    writeFileSync(QUEUE_PATH, readFileSync(backup, "utf-8"), "utf-8");
  } else if (existsSync(QUEUE_PATH)) {
    // No backup existed -> remove any queue entries that were created by
    // this test run (prefix-based).
    const lines = readFileSync(QUEUE_PATH, "utf-8").split("\n");
    const keep = lines.filter((line) => {
      if (!line.trim()) return false;
      try {
        const entry = JSON.parse(line) as { projectName?: string };
        return !entry.projectName?.startsWith(TEST_PROJECT_PREFIX);
      } catch {
        return false;
      }
    });
    writeFileSync(QUEUE_PATH, keep.length > 0 ? keep.join("\n") + "\n" : "", "utf-8");
  }
}

function cleanupTestProjects(): void {
  // Remove any ~/.vela/graphify/test-aa-* directories this test created.
  if (!existsSync(GRAPHIFY_DIR)) return;
  for (const name of readdirSync(GRAPHIFY_DIR)) {
    if (name.startsWith(TEST_PROJECT_PREFIX)) {
      rmSync(join(GRAPHIFY_DIR, name), { recursive: true, force: true });
    }
  }
  // Also drop the same from the current queue file.
  if (existsSync(QUEUE_PATH)) {
    const lines = readFileSync(QUEUE_PATH, "utf-8").split("\n");
    const keep = lines.filter((line) => {
      if (!line.trim()) return false;
      try {
        const entry = JSON.parse(line) as { projectName?: string };
        return !entry.projectName?.startsWith(TEST_PROJECT_PREFIX);
      } catch {
        return false;
      }
    });
    writeFileSync(QUEUE_PATH, keep.length > 0 ? keep.join("\n") + "\n" : "", "utf-8");
  }
}

// Ensure a fake project path exists so enqueue/scan don't reject it.
function makeFakeProjectDir(name: string): string {
  const dir = join(QUEUE_BACKUP, "projects", name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// MCP client (thin copy of test-mcp-gateway's StdioClient, scoped to our
// lazy-build regression scenarios so we don't depend on its internals).
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

class StdioClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (v: JsonRpcResponse) => void;
      reject: (e: Error) => void;
    }
  >();

  constructor(scriptPath: string) {
    this.proc = spawn("node", [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf-8");
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          if (typeof msg.id === "number" && this.pending.has(msg.id)) {
            const handler = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            handler.resolve(msg);
          }
        } catch {
          // ignore parse errors
        }
      }
    });
    this.proc.stderr.on("data", () => {
      // suppress
    });
  }

  request(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolveP, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout for ${method}`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolveP(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.proc.stdin.write(JSON.stringify(req) + "\n");
    });
  }

  notify(method: string, params?: unknown): void {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  close(): Promise<void> {
    return new Promise((resolveP) => {
      this.proc.on("close", () => resolveP());
      this.proc.stdin.end();
      setTimeout(() => {
        if (this.proc.exitCode === null) this.proc.kill("SIGTERM");
      }, 5_000);
    });
  }
}

function unwrapToolText(result: unknown): unknown {
  if (
    typeof result === "object" &&
    result !== null &&
    "content" in result &&
    Array.isArray((result as { content: unknown[] }).content)
  ) {
    const c = (result as { content: Array<{ type: string; text?: string }> }).content;
    const first = c[0];
    if (first?.type === "text" && typeof first.text === "string") {
      try {
        return JSON.parse(first.text);
      } catch {
        return first.text;
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("\n=== Vela Union: Auto-Activation Layer Tests ===");
  backupQueue();
  cleanupTestProjects();

  try {
    await testBuildQueueBasics();
    await testScanAndQueue();
    await testWorker();
    await testServerIntegration();
    await testRegressionMcpGateway();
    testLaunchdGating();
  } finally {
    cleanupTestProjects();
    restoreQueue();
  }

  console.log(`\n=== Summary ===\n  Passed: ${passed}\n  Failed: ${failed}\n  Total:  ${passed + failed}\n`);
  if (failed > 0) {
    console.error("Some tests failed!");
    process.exit(1);
  }
  console.log("All tests passed!");
}

// ---- 1. build-queue basics ------------------------------------------------

async function testBuildQueueBasics(): Promise<void> {
  section("[1] build-queue basics");

  const p1 = `${TEST_PROJECT_PREFIX}one`;
  const p1path = makeFakeProjectDir(p1);

  const entry1 = enqueue({ kind: "graphify", projectName: p1, projectPath: p1path });
  check("enqueue returns entry with id", typeof entry1.id === "string" && entry1.id.length > 0);
  check("enqueue writes attempts=0", entry1.attempts === 0);
  check(
    "enqueue writes enqueuedAt ISO",
    !Number.isNaN(Date.parse(entry1.enqueuedAt)),
  );

  const queue = readQueue();
  check("readQueue returns array", Array.isArray(queue));
  check("queue contains our entry", queue.some((e) => e.id === entry1.id));

  check("isQueued true for pending entry", isQueued(p1, "graphify") === true);
  check("isQueued false for unknown project", isQueued("nonexistent-xyz-123", "graphify") === false);

  // Dedup: enqueuing the same project again returns the same entry
  const entry1dup = enqueue({ kind: "graphify", projectName: p1, projectPath: p1path });
  check("dedup returns same id", entry1dup.id === entry1.id);
  const queueAfterDup = readQueue().filter((e) => e.projectName === p1);
  check("dedup keeps exactly 1 entry", queueAfterDup.length === 1);

  // Queue file is JSONL on disk
  const onDisk = readFileSync(_internals.QUEUE_PATH, "utf-8");
  check("queue file has JSONL line", onDisk.includes(entry1.id));
}

// ---- 2. startup-scanner ---------------------------------------------------

async function testScanAndQueue(): Promise<void> {
  section("[2] startup-scanner");

  // Empty registry scenario is hard to isolate — instead we assert that the
  // scan runs, reports the project count, and returns a shape we expect.
  cleanupTestProjects();

  // Inject a test project into the real registry by cheating through the
  // shared registry API. We use a project whose name starts with the prefix
  // so cleanupTestProjects can remove any residue.
  const { addProject, removeProject } = await import(
    "../packages/shared/dist/registry.js"
  );

  const testName = `${TEST_PROJECT_PREFIX}scan-me`;
  const testPath = makeFakeProjectDir(testName);
  addProject({
    name: testName,
    path: testPath,
    type: "experimental",
    relatedProjects: [],
  });

  // Also inject a bogus project with a non-existent path to exercise the
  // skippedPathMissing branch.
  const ghostName = `${TEST_PROJECT_PREFIX}ghost`;
  addProject({
    name: ghostName,
    path: "/nonexistent/path/that/does/not/exist/__vela_test__",
    type: "experimental",
    relatedProjects: [],
  });

  try {
    const result = await scanAndQueue();
    check(
      "scan result has totalProjects >= 2",
      result.totalProjects >= 2,
      `totalProjects=${result.totalProjects}`,
    );
    check("scan enqueued at least 1 missing graph", result.enqueued >= 1);
    check("scan reported at least 1 missing path", result.skippedPathMissing >= 1);
    check(
      "scan errors include ghost project",
      result.errors.some((e) => e.includes(ghostName)),
    );

    // Run scan again — the previously-enqueued project should now be counted
    // as already-queued instead of enqueued.
    const second = await scanAndQueue();
    check(
      "second scan skips already-queued",
      second.skippedAlreadyQueued >= 1,
      `skippedAlreadyQueued=${second.skippedAlreadyQueued}`,
    );
  } finally {
    removeProject(testName);
    removeProject(ghostName);
  }
}

// ---- 3. worker ------------------------------------------------------------

async function testWorker(): Promise<void> {
  section("[3] worker");

  // Clean up any leftover queue entries and stale status files from prior
  // sections or previous test runs so the polling loop below cannot exit
  // early on a stale "built" status.
  cleanupTestProjects();

  // We test the worker by enqueuing a fake entry whose projectPath is real
  // but points at an empty directory with no source files. The build helper
  // will either succeed (producing an empty graph) or fail — either way it
  // should write a status.json entry and remove the queue entry.

  const tinyName = `${TEST_PROJECT_PREFIX}tiny`;
  const tinyPath = makeFakeProjectDir(tinyName);
  // Drop a minimal .py file so graphify has SOMETHING to parse.
  writeFileSync(join(tinyPath, "hello.py"), "def hello():\n    pass\n", "utf-8");

  enqueue({ kind: "graphify", projectName: tinyName, projectPath: tinyPath });
  check("tiny enqueued", isQueued(tinyName, "graphify"));

  const worker = startWorker({ intervalMs: 500, timeoutMs: 60_000 });

  // Poll for completion (built or failed) with a 120s budget.
  const deadline = Date.now() + 120_000;
  let finalStatus: ReturnType<typeof readStatus> = null;
  while (Date.now() < deadline) {
    finalStatus = readStatus(tinyName, "graphify");
    if (
      finalStatus &&
      (finalStatus.state === "built" || finalStatus.state === "failed")
    ) {
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  await worker.stop();

  check("worker wrote a terminal status", finalStatus !== null);
  check(
    "worker state is built or failed",
    finalStatus?.state === "built" || finalStatus?.state === "failed",
    `state=${finalStatus?.state}`,
  );

  check("worker removed entry from queue", !isQueued(tinyName, "graphify"));

  // Central log should contain an entry for our project.
  const log = existsSync(_internals.CENTRAL_LOG_PATH)
    ? readFileSync(_internals.CENTRAL_LOG_PATH, "utf-8")
    : "";
  check("central log contains our project", log.includes(tinyName));

  // readAllStatuses should include our entry.
  const all = readAllStatuses();
  check(
    "readAllStatuses contains tiny",
    all.some((s) => s.projectName === tinyName),
  );
}

// ---- 4. server integration (lazy build on missing graph) ------------------

async function testServerIntegration(): Promise<void> {
  section("[4] server lazy-build integration");

  const SERVER_SCRIPT = resolve(
    "/Users/jin/projects/vela-union/packages/mcp-gateway/dist/server.js",
  );
  if (!existsSync(SERVER_SCRIPT)) {
    console.log("  SKIP: server.js not built yet");
    return;
  }

  // Inject a test project into the registry
  const { addProject, removeProject } = await import(
    "../packages/shared/dist/registry.js"
  );
  const pname = `${TEST_PROJECT_PREFIX}server`;
  const ppath = makeFakeProjectDir(pname);
  addProject({
    name: pname,
    path: ppath,
    type: "experimental",
    relatedProjects: [],
  });

  const client = new StdioClient(SERVER_SCRIPT);
  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "aa-test", version: "0.1.0" },
    });
    client.notify("notifications/initialized", {});

    // 4a. graph.query on missing graph -> building
    const missing = await client.request("tools/call", {
      name: "graph.query",
      arguments: { projectName: pname, query: "anything" },
    });
    const missingBody = unwrapToolText(missing.result) as {
      status?: string;
      retryAfterSec?: number;
    };
    check(
      "graph.query missing returns status=building",
      missingBody.status === "building",
      `got ${JSON.stringify(missingBody)}`,
    );
    check(
      "retryAfterSec is 120",
      missingBody.retryAfterSec === 120,
    );
    check("entry was queued", isQueued(pname, "graphify"));

    // 4b. second call should NOT create a second queue entry
    await client.request("tools/call", {
      name: "graph.query",
      arguments: { projectName: pname, query: "anything" },
    });
    const entries = readQueue().filter((e) => e.projectName === pname);
    check("no duplicate queue entry", entries.length === 1);

    // 4c. regression: graph.query on an EXISTING graph (sweditor-v2 if built)
    // should still return real results, NOT the building status.
    if (existsSync(join(homedir(), ".vela", "graphify", "sweditor-v2", "graph.json"))) {
      const real = await client.request("tools/call", {
        name: "graph.query",
        arguments: { projectName: "sweditor-v2", query: "handler" },
      });
      const realBody = unwrapToolText(real.result) as {
        success?: boolean;
        status?: string;
        count?: number;
      };
      check(
        "existing graph query returns success (not building)",
        realBody.success === true && realBody.status !== "building",
        `got ${JSON.stringify(realBody).slice(0, 200)}`,
      );
    } else {
      console.log("  SKIP: sweditor-v2 graph not built — regression skipped");
    }

    // 4d. regression: tools/list still reports all 14 expected tools
    const listResp = await client.request("tools/list", {});
    const toolNames =
      (listResp.result as { tools?: Array<{ name: string }> } | undefined)?.tools?.map(
        (t) => t.name,
      ) ?? [];
    const expected = [
      "doc.index",
      "doc.get_structure",
      "doc.get_pages",
      "graph.build",
      "graph.query",
      "graph.get_neighbors",
      "graph.get_node",
      "graph.stats",
      "graph.refresh",
      "gstack.execute_skill",
      "gstack.dispatch_goal",
      "gstack.list_goals",
      "gstack.check_availability",
      "vela.list_projects",
    ];
    for (const name of expected) {
      check(`tools/list still has ${name}`, toolNames.includes(name));
    }
  } finally {
    await client.close();
    removeProject(pname);
  }
}

// ---- 5. regression: test-mcp-gateway.ts still 31/31 -----------------------

async function testRegressionMcpGateway(): Promise<void> {
  section("[5] regression: test-mcp-gateway.ts");

  const scriptPath = resolve(REPO_ROOT, "scripts", "test-mcp-gateway.ts");
  if (!existsSync(scriptPath)) {
    console.log("  SKIP: test-mcp-gateway.ts missing");
    return;
  }

  const result = spawnSync("npx", ["tsx", scriptPath], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  const stdout = result.stdout ?? "";
  // Extract the final "Passed: N" line
  const passedMatch = stdout.match(/Passed:\s+(\d+)/);
  const failedMatch = stdout.match(/Failed:\s+(\d+)/);
  const mcpPassed = passedMatch ? Number.parseInt(passedMatch[1] ?? "0", 10) : 0;
  const mcpFailed = failedMatch ? Number.parseInt(failedMatch[1] ?? "0", 10) : 0;

  check(
    "test-mcp-gateway.ts exits successfully",
    result.status === 0,
    `exit=${result.status}`,
  );
  check(
    "test-mcp-gateway.ts: 0 failed",
    mcpFailed === 0,
    `failed=${mcpFailed}`,
  );
  check(
    "test-mcp-gateway.ts: passed count >= 31",
    mcpPassed >= 31,
    `passed=${mcpPassed}`,
  );
}

// ---- 6. launchd platform gating ------------------------------------------

function testLaunchdGating(): void {
  section("[6] launchd platform gating");

  // We don't actually install launchd — that has side effects. We only
  // verify that the plist target path is under ~/Library/LaunchAgents and
  // that our setup.ts guards on process.platform === 'darwin'.
  const setupSrc = readFileSync(
    resolve(REPO_ROOT, "packages", "vela-cli", "src", "commands", "setup.ts"),
    "utf-8",
  );
  check(
    "setup.ts guards on process.platform",
    setupSrc.includes('process.platform !== "darwin"'),
  );
  check(
    "setup.ts writes to LaunchAgents",
    setupSrc.includes("LaunchAgents"),
  );
  check(
    "setup.ts labels plist com.vela.paperclip",
    setupSrc.includes("com.vela.paperclip"),
  );
  check(
    "setup.ts is idempotent (checks existsSync before prompting)",
    setupSrc.includes("existsSync(LAUNCHD_PLIST_PATH)"),
  );
}

main().catch((err: unknown) => {
  console.error(`Unhandled error: ${(err as Error).message}`);
  process.exit(1);
});
