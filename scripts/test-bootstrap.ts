// scripts/test-bootstrap.ts — smoke test for the vela CLI detection layer.
//
// Runs the non-destructive paths: `vela status`, `vela list`, and exercises
// the preflight + detection helpers without actually reinstalling anything.
//
// Run with:
//   node --loader ts-node/esm scripts/test-bootstrap.ts
// or, after `npx tsc --build`:
//   node packages/vela-cli/dist/cli.js status
//
// This file intentionally uses only the built JS artifacts so it's runnable
// without a ts runtime dependency.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Derive repo root from this script's location (scripts/ → ..)
const REPO_ROOT =
  process.env["VELA_REPO_ROOT"] ??
  resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO_ROOT, "packages", "vela-cli", "dist", "cli.js");

function assert(cond: boolean, message: string): void {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`  ok: ${message}`);
}

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync("node", [CLI, ...args], { encoding: "utf-8" });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function main(): void {
  console.log("vela CLI bootstrap smoke test\n");

  // 0. Artifact must exist
  assert(existsSync(CLI), `CLI binary built at ${CLI}`);

  // 1. help
  const help = run(["--help"]);
  assert(help.code === 0, "vela --help exits 0");
  assert(help.stdout.includes("Vela Union CLI"), "help contains 'Vela Union CLI'");
  assert(help.stdout.includes("setup"), "help lists setup command");
  assert(help.stdout.includes("status"), "help lists status command");
  assert(help.stdout.includes("register"), "help lists register command");

  // 2. status — must run without throwing, exit 0 or 1
  const status = run(["status"]);
  assert([0, 1].includes(status.code), `vela status exit code is 0 or 1 (got ${status.code})`);
  assert(status.stdout.includes("Preflight"), "status shows Preflight section");
  assert(status.stdout.includes("Systems"), "status shows Systems section");
  assert(status.stdout.includes("Node.js"), "status probes Node.js");
  assert(status.stdout.includes("Paperclip"), "status probes Paperclip");
  assert(status.stdout.includes("gstack"), "status probes gstack");
  assert(status.stdout.includes("Graphify"), "status probes Graphify");
  assert(status.stdout.includes("PageIndex"), "status probes PageIndex");
  assert(status.stdout.includes("MCP Gateway"), "status probes MCP Gateway");

  // 3. list — reads registry
  const list = run(["list"]);
  assert(list.code === 0, "vela list exit 0");

  // 4. unknown command
  const bad = run(["not-a-command"]);
  assert(bad.code === 1, "unknown command exits 1");

  // 5. dispatch with missing args
  const dispatch = run(["dispatch"]);
  assert(dispatch.code === 1, "dispatch with no args exits 1");

  // 6. register with missing args
  const register = run(["register"]);
  assert(register.code === 1, "register with no args exits 1");

  // 7. unregister with missing args
  const unregister = run(["unregister"]);
  assert(unregister.code === 1, "unregister with no args exits 1");
  assert(unregister.stdout.includes("usage:"), "unregister prints usage hint");

  // 8. unregister with a name that is not in the registry
  const unregisterMissing = run(["unregister", "__vela_test_nonexistent_project__"]);
  assert(unregisterMissing.code === 1, "unregister unknown project exits 1");
  assert(
    unregisterMissing.stdout.includes("not found in registry"),
    "unregister unknown project prints 'not found in registry'",
  );

  // 9. prune --dry-run on a real registry (never destructive)
  const prune = run(["prune", "--dry-run"]);
  assert([0, 1].includes(prune.code), `vela prune --dry-run exit code is 0 or 1 (got ${prune.code})`);

  // 10. help contains new commands
  const help2 = run(["--help"]);
  assert(help2.stdout.includes("unregister"), "help lists unregister command");
  assert(help2.stdout.includes("prune"), "help lists prune command");

  // 11. index --list --project with unknown project name exits 1
  const listBadProject = run(["index", "--list", "--project", "__nonexistent_vela_project__"]);
  assert(listBadProject.code === 1, "vela index --list --project <unknown> exits 1");
  assert(
    listBadProject.stdout.includes("not found in pageindex storage"),
    "vela index --list --project <unknown> prints error message",
  );

  // 12. index --list --failed (VELA-25). Exit 0 whether or not there are
  // failures recorded in status.json on the current machine. We only assert
  // the command runs cleanly and either shows "no failed documents" or a
  // failure section header — never crashes.
  const listFailed = run(["index", "--list", "--failed"]);
  assert(listFailed.code === 0, "vela index --list --failed exits 0");
  const failedOut = listFailed.stdout;
  assert(
    failedOut.includes("no failed documents") ||
      failedOut.includes("failed document") ||
      failedOut.includes("no pageindex storage"),
    "vela index --list --failed output is recognized (empty or failure listing)",
  );

  // 13. index --list --backend <name> (VELA-25). Must exit 0 for known
  // backends. With pre-VELA-25 records lacking the backend field, explicit
  // filter returns zero matches — that is correct BC behavior and the test
  // asserts the command still exits cleanly.
  const listCloud = run(["index", "--list", "--backend", "vectify-cloud"]);
  assert(listCloud.code === 0, "vela index --list --backend vectify-cloud exits 0");
  const listLocalCli = run(["index", "--list", "--backend", "local-claude-cli"]);
  assert(
    listLocalCli.code === 0,
    "vela index --list --backend local-claude-cli exits 0",
  );

  // 14. index --help lists the new --failed flag (doc check — CTOs rely on
  // help text when deciding if a flag exists).
  const indexHelp = run(["index", "--help"]);
  assert(indexHelp.code === 0, "vela index --help exits 0");
  assert(indexHelp.stdout.includes("--failed"), "index --help lists --failed flag");
  assert(
    indexHelp.stdout.includes("--backend"),
    "index --help lists --backend flag",
  );

  // 15. backfill-pageindex-backend script (VELA-31). The script is idempotent —
  // running it against already-backfilled records must exit 0 with no updates.
  const backfillResult = spawnSync(
    "npx",
    ["tsx", "scripts/backfill-pageindex-backend.ts"],
    { encoding: "utf-8", cwd: resolve(dirname(fileURLToPath(import.meta.url)), "..") },
  );
  assert(
    (backfillResult.status ?? -1) === 0,
    "backfill-pageindex-backend.ts exits 0 (idempotent re-run)",
  );

  console.log("\nAll checks passed.");
}

main();
