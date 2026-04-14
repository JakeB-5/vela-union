// Paperclip bi-directional sync integration test — covers:
//
//   1. PaperclipClient.getProject() works against a known id
//   2. `vela register --paperclip-id=<uuid>` links without creating a dupe
//   3. `vela register --paperclip-id=<bogus-uuid>` fails with clear error
//   4. `vela sync-from-paperclip --dry-run` returns candidates without write
//   5. `vela sync-from-paperclip` imports new projects
//   6. Idempotency: second run imports nothing new
//   7. Name-strategy variations (auto vs workspace vs paperclip)
//
// Run: `npx tsx scripts/test-paperclip-sync.ts`
//
// Preconditions (same as test-paperclip-integration.ts):
//   - Paperclip running at http://127.0.0.1:3100
//   - ~/.vela/config.json populated with companyId + defaultAgentId
//   - packages built (`npx tsc --build`)

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  REGISTRY_PATH,
  PaperclipClient,
  PaperclipApiError,
  removeProject,
  resolvePaperclipConfig,
} from "../packages/shared/dist/index.js";
import type {
  PaperclipProject,
  ProjectConfig,
} from "../packages/shared/dist/index.js";

interface TestResult {
  name: string;
  ok: boolean;
  message: string;
  elapsedMs: number;
}

const results: TestResult[] = [];
const VELA_CLI = join(process.cwd(), "packages", "vela-cli", "dist", "cli.js");

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

function runCli(
  args: string[],
): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("node", [VELA_CLI, ...args], {
    encoding: "utf-8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? -1,
  };
}

// Snapshot + restore the registry so we never clobber the user's real file.
const REGISTRY_BACKUP = `${REGISTRY_PATH}.backup-sync-test`;

function backupRegistry(): void {
  if (existsSync(REGISTRY_PATH)) {
    copyFileSync(REGISTRY_PATH, REGISTRY_BACKUP);
  }
}

function restoreRegistry(): void {
  if (existsSync(REGISTRY_BACKUP)) {
    copyFileSync(REGISTRY_BACKUP, REGISTRY_PATH);
    try {
      rmSync(REGISTRY_BACKUP);
    } catch {
      // ignore
    }
  }
}

function readRegistryRaw(): ProjectConfig[] {
  if (!existsSync(REGISTRY_PATH)) return [];
  return JSON.parse(readFileSync(REGISTRY_PATH, "utf-8")) as ProjectConfig[];
}

const TEST_SUFFIX = randomUUID().slice(0, 8);
const TEST_LOCAL_NAME_REGISTER = `sync-test-reg-${TEST_SUFFIX}`;
const TEST_LOCAL_NAME_SYNC = `sync-test-sync-${TEST_SUFFIX}`;
const TEST_DIR_REGISTER = join(tmpdir(), `vela-${TEST_LOCAL_NAME_REGISTER}`);
const TEST_DIR_SYNC = join(tmpdir(), `vela-${TEST_LOCAL_NAME_SYNC}`);

const cleanup: {
  paperclipProjectIds: string[];
  localProjectNames: string[];
} = {
  paperclipProjectIds: [],
  localProjectNames: [],
};

async function main(): Promise<void> {
  console.log("Vela ↔ Paperclip bi-directional sync test\n");

  const cfg = resolvePaperclipConfig();
  if (!cfg) {
    console.log("ABORT: resolvePaperclipConfig() returned null\n");
    process.exit(1);
  }
  const client = new PaperclipClient(cfg);

  // Make sure vela CLI is built.
  if (!existsSync(VELA_CLI)) {
    console.log(`ABORT: vela CLI not built at ${VELA_CLI}\n`);
    console.log("Run: npx tsc --build");
    process.exit(1);
  }

  backupRegistry();

  // Create temp project dirs
  if (!existsSync(TEST_DIR_REGISTER)) mkdirSync(TEST_DIR_REGISTER, { recursive: true });
  writeFileSync(join(TEST_DIR_REGISTER, "README.md"), "# test register\n");
  if (!existsSync(TEST_DIR_SYNC)) mkdirSync(TEST_DIR_SYNC, { recursive: true });
  writeFileSync(join(TEST_DIR_SYNC, "README.md"), "# test sync\n");

  // -----------------------------------------------------------------
  // Test 1: getProject() returns a known project
  // -----------------------------------------------------------------
  let seedProject: PaperclipProject | null = null;
  await runTest("PaperclipClient.getProject returns known project", async () => {
    // Create a short-lived Paperclip project we can look up.
    const paperclipName = `[TEST] sync-seed-${TEST_SUFFIX}`;
    const created = await client.createProject({
      name: paperclipName,
      description: "sync test seed",
      workspace: {
        name: "seed",
        sourceType: "local_path",
        cwd: TEST_DIR_REGISTER,
        isPrimary: true,
      },
    });
    cleanup.paperclipProjectIds.push(created.id);
    seedProject = await client.getProject(created.id);
    if (!seedProject) throw new Error(`getProject returned null for ${created.id}`);
    if (seedProject.id !== created.id) {
      throw new Error(`id mismatch: ${seedProject.id} vs ${created.id}`);
    }
    if (!seedProject.workspaces || seedProject.workspaces.length === 0) {
      throw new Error(`workspaces array empty on getProject() response`);
    }
    return `id=${created.id.slice(0, 8)} workspaces=${seedProject.workspaces.length}`;
  });

  // -----------------------------------------------------------------
  // Test 2: getProject returns null for missing id
  // -----------------------------------------------------------------
  await runTest("PaperclipClient.getProject returns null for missing id", async () => {
    const bogus = "00000000-0000-4000-8000-000000000000";
    const result = await client.getProject(bogus);
    if (result !== null) throw new Error(`expected null, got ${JSON.stringify(result)}`);
    return "null as expected";
  });

  // -----------------------------------------------------------------
  // Test 3: `vela register --paperclip-id` links to existing project
  // -----------------------------------------------------------------
  await runTest("register --paperclip-id links existing project", async () => {
    if (!seedProject) throw new Error("no seed project");
    const before = await client.listProjects();
    const beforeCount = before.length;

    const result = runCli([
      "register",
      TEST_DIR_REGISTER,
      `--name=${TEST_LOCAL_NAME_REGISTER}`,
      "--type=experimental",
      "--description=sync-test-register",
      `--paperclip-id=${seedProject.id}`,
    ]);
    cleanup.localProjectNames.push(TEST_LOCAL_NAME_REGISTER);
    if (result.exitCode !== 0) {
      throw new Error(`exit=${result.exitCode} stdout=${result.stdout} stderr=${result.stderr}`);
    }

    const after = await client.listProjects();
    if (after.length !== beforeCount) {
      throw new Error(`project count changed: ${beforeCount} -> ${after.length} (dupe created?)`);
    }

    const registry = readRegistryRaw();
    const entry = registry.find((p) => p.name === TEST_LOCAL_NAME_REGISTER);
    if (!entry) throw new Error(`local entry ${TEST_LOCAL_NAME_REGISTER} missing`);
    if (entry.paperclipProjectId !== seedProject.id) {
      throw new Error(
        `paperclipProjectId mismatch: ${entry.paperclipProjectId} vs ${seedProject.id}`,
      );
    }
    return `linked name=${TEST_LOCAL_NAME_REGISTER} id=${seedProject.id.slice(0, 8)}`;
  });

  // -----------------------------------------------------------------
  // Test 4: register --paperclip-id with bogus id fails gracefully
  // -----------------------------------------------------------------
  await runTest("register --paperclip-id with bogus id fails", async () => {
    const bogus = "00000000-0000-4000-8000-000000000000";
    const result = runCli([
      "register",
      TEST_DIR_REGISTER,
      `--name=${TEST_LOCAL_NAME_REGISTER}-bogus`,
      "--type=experimental",
      `--paperclip-id=${bogus}`,
    ]);
    if (result.exitCode === 0) {
      throw new Error(`expected non-zero exit, got 0. stdout=${result.stdout}`);
    }
    const combined = `${result.stdout}${result.stderr}`;
    if (!combined.includes("not found")) {
      throw new Error(`expected 'not found' in output, got: ${combined.slice(0, 300)}`);
    }
    // Also: no local entry should exist.
    const registry = readRegistryRaw();
    const entry = registry.find((p) => p.name === `${TEST_LOCAL_NAME_REGISTER}-bogus`);
    if (entry) throw new Error(`bogus id still wrote a local entry: ${JSON.stringify(entry)}`);
    return `rejected as expected`;
  });

  // -----------------------------------------------------------------
  // Test 5: register --paperclip-id with malformed id fails fast
  // -----------------------------------------------------------------
  await runTest("register --paperclip-id with malformed id fails fast", async () => {
    const result = runCli([
      "register",
      TEST_DIR_REGISTER,
      `--name=${TEST_LOCAL_NAME_REGISTER}-bad`,
      "--paperclip-id=not-a-uuid",
    ]);
    if (result.exitCode === 0) {
      throw new Error(`expected non-zero exit, got 0`);
    }
    const combined = `${result.stdout}${result.stderr}`;
    if (!combined.includes("invalid --paperclip-id")) {
      throw new Error(`expected 'invalid --paperclip-id' in output, got: ${combined.slice(0, 300)}`);
    }
    return `rejected as expected`;
  });

  // -----------------------------------------------------------------
  // Test 6: sync-from-paperclip --dry-run does not modify registry
  // -----------------------------------------------------------------
  let paperclipForSync: PaperclipProject | null = null;
  await runTest("sync-from-paperclip --dry-run is read-only", async () => {
    // Seed: create a second Paperclip project that we have NOT locally
    // registered. The sync command should show it as an import candidate.
    const syncSeedName = `[SYNC-TEST] ${TEST_LOCAL_NAME_SYNC}`;
    paperclipForSync = await client.createProject({
      name: syncSeedName,
      description: "sync-test-sync seed",
      workspace: {
        name: "sync-ws",
        sourceType: "local_path",
        cwd: TEST_DIR_SYNC,
        isPrimary: true,
      },
    });
    cleanup.paperclipProjectIds.push(paperclipForSync.id);

    const beforeRegistry = readRegistryRaw();
    const beforeCount = beforeRegistry.length;

    const result = runCli(["sync-from-paperclip", "--dry-run"]);
    if (result.exitCode !== 0) {
      throw new Error(`exit=${result.exitCode} stderr=${result.stderr}`);
    }
    if (!result.stdout.includes(syncSeedName)) {
      throw new Error(`dry-run did not mention ${syncSeedName}`);
    }
    // Registry should be unchanged.
    const afterRegistry = readRegistryRaw();
    if (afterRegistry.length !== beforeCount) {
      throw new Error(
        `registry size changed during dry-run: ${beforeCount} -> ${afterRegistry.length}`,
      );
    }
    return `plan included ${syncSeedName}`;
  });

  // -----------------------------------------------------------------
  // Test 7: sync-from-paperclip actually imports
  // -----------------------------------------------------------------
  await runTest("sync-from-paperclip imports unlinked projects", async () => {
    if (!paperclipForSync) throw new Error("no paperclipForSync");
    const beforeRegistry = readRegistryRaw();
    const beforeCount = beforeRegistry.length;

    const result = runCli(["sync-from-paperclip", "--type=experimental"]);
    if (result.exitCode !== 0) {
      throw new Error(`exit=${result.exitCode} stderr=${result.stderr}`);
    }

    const afterRegistry = readRegistryRaw();
    if (afterRegistry.length <= beforeCount) {
      throw new Error(
        `registry did not grow: before=${beforeCount} after=${afterRegistry.length}`,
      );
    }

    // Track every newly-added entry so cleanup can remove them.
    for (const p of afterRegistry) {
      if (!beforeRegistry.find((b) => b.name === p.name)) {
        cleanup.localProjectNames.push(p.name);
      }
    }

    const imported = afterRegistry.find(
      (p) => p.paperclipProjectId === paperclipForSync!.id,
    );
    if (!imported) {
      throw new Error(
        `imported entry for ${paperclipForSync.id} not found in registry`,
      );
    }
    if (imported.path !== TEST_DIR_SYNC) {
      throw new Error(`imported path mismatch: ${imported.path} vs ${TEST_DIR_SYNC}`);
    }
    return `imported name=${imported.name} path=${imported.path}`;
  });

  // -----------------------------------------------------------------
  // Test 8: Idempotency — second run imports nothing
  // -----------------------------------------------------------------
  await runTest("sync-from-paperclip is idempotent", async () => {
    const beforeRegistry = readRegistryRaw();
    const result = runCli(["sync-from-paperclip"]);
    if (result.exitCode !== 0) {
      throw new Error(`exit=${result.exitCode} stderr=${result.stderr}`);
    }
    const afterRegistry = readRegistryRaw();
    if (afterRegistry.length !== beforeRegistry.length) {
      throw new Error(
        `idempotency broken: before=${beforeRegistry.length} after=${afterRegistry.length}`,
      );
    }
    // The output should say "0 import(s)"
    if (!result.stdout.includes("0 import(s)")) {
      throw new Error(`expected '0 import(s)' in output, got: ${result.stdout.slice(0, 300)}`);
    }
    return `no changes`;
  });

  // -----------------------------------------------------------------
  // Test 9: Name strategy "paperclip" preserves raw name (slugified)
  // -----------------------------------------------------------------
  await runTest("name-strategy=paperclip uses raw paperclip name", async () => {
    // Create a short-lived project and run dry-run with two strategies.
    const strategyName = `[TEST] strat-${TEST_SUFFIX}`;
    const strategyDir = join(tmpdir(), `vela-strat-${TEST_SUFFIX}`);
    if (!existsSync(strategyDir)) mkdirSync(strategyDir, { recursive: true });
    const created = await client.createProject({
      name: strategyName,
      workspace: {
        name: "strat-ws",
        sourceType: "local_path",
        cwd: strategyDir,
        isPrimary: true,
      },
    });
    cleanup.paperclipProjectIds.push(created.id);

    const autoResult = runCli([
      "sync-from-paperclip",
      "--dry-run",
      "--name-strategy",
      "auto",
    ]);
    if (autoResult.exitCode !== 0) {
      throw new Error(`auto exit=${autoResult.exitCode} stderr=${autoResult.stderr}`);
    }
    // "auto" strips [TEST] prefix -> "strat-<suffix>"
    if (!autoResult.stdout.includes(`strat-${TEST_SUFFIX}`)) {
      throw new Error(`auto did not derive expected name`);
    }

    const pcpResult = runCli([
      "sync-from-paperclip",
      "--dry-run",
      "--name-strategy",
      "paperclip",
    ]);
    if (pcpResult.exitCode !== 0) {
      throw new Error(`paperclip exit=${pcpResult.exitCode} stderr=${pcpResult.stderr}`);
    }
    // "paperclip" keeps [TEST] bracket and slugifies -> "test-strat-<suffix>"
    if (!pcpResult.stdout.includes(`test-strat-${TEST_SUFFIX}`)) {
      throw new Error(
        `paperclip did not derive expected slugified name. stdout: ${pcpResult.stdout.slice(0, 500)}`,
      );
    }

    try {
      rmSync(strategyDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    return `auto=stripped paperclip=slugified`;
  });

  // -----------------------------------------------------------------
  // Test 10: --prefix-filter narrows the candidate set
  // -----------------------------------------------------------------
  await runTest("--prefix-filter narrows candidates", async () => {
    const filterResult = runCli([
      "sync-from-paperclip",
      "--dry-run",
      "--prefix-filter",
      "[NONEXISTENT-PREFIX]",
    ]);
    if (filterResult.exitCode !== 0) {
      throw new Error(`exit=${filterResult.exitCode} stderr=${filterResult.stderr}`);
    }
    if (!filterResult.stdout.includes("0 import(s)")) {
      throw new Error(
        `expected 0 imports with nonexistent filter, got: ${filterResult.stdout.slice(0, 400)}`,
      );
    }
    return `filter correctly narrowed to 0`;
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
    if (existsSync(TEST_DIR_REGISTER)) {
      rmSync(TEST_DIR_REGISTER, { recursive: true, force: true });
    }
    if (existsSync(TEST_DIR_SYNC)) {
      rmSync(TEST_DIR_SYNC, { recursive: true, force: true });
    }
  } catch {
    // best-effort
  }

  // Restore the pre-test registry so we don't leak test artifacts even if
  // the individual removeProject() calls missed anything.
  restoreRegistry();

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
  console.error("sync integration test crashed:", err);
  restoreRegistry();
  process.exit(2);
});
