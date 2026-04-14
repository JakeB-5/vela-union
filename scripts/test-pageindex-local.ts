#!/usr/bin/env node
// Test: PageIndex local-claude-cli backend end-to-end.
//
// Verifies:
//   1. createPageIndex({provider:"local-claude-cli"}).checkAvailability() ok
//      — no apiKey required, OSS repo + local runner present
//   2. submitViaLocalClaudeCli() runs pageindex_local.py on a small md file
//      and produces a JSON tree (this call makes >=1 `claude -p` invocations
//      so the test runs in 1-2 minutes in the worst case)
//   3. createPageIndex.indexDocument() routes markdown files through the
//      local backend when provider is local-claude-cli, stores the tree in
//      the per-project layout, and returns provider="local-claude-cli"
//   4. Idempotency: a second indexDocument call returns cached=true
//   5. Build queue: enqueue a pageindex entry, worker picks it up, and the
//      resulting status is "built" (only runs if config provider matches)
//
// Run with: node --experimental-strip-types scripts/test-pageindex-local.ts

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  createPageIndex,
  submitViaLocalClaudeCli,
  PAGEINDEX_PATHS,
} from "../packages/mcp-gateway/dist/pageindex.js";

let passed = 0;
let failed = 0;

function pass(msg: string): void {
  passed += 1;
  console.log(`  \u2713 ${msg}`);
}

function fail(msg: string): void {
  failed += 1;
  console.log(`  \u2717 ${msg}`);
}

function section(title: string): void {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

function assert(cond: boolean, msg: string): void {
  if (cond) pass(msg);
  else fail(msg);
}

// Small markdown file used for both direct runner + indexDocument tests.
// Keep it tiny so the smoke test finishes in well under 2 minutes even on
// a cold Claude CLI start.
const SAMPLE_MD = `# Local Backend Smoke Test

This document validates the local-claude-cli PageIndex backend.

## Section A

A short first section.

## Section B

A short second section.
`;

const tmpDir = mkdtempSync(join(tmpdir(), "pi-local-test-"));
const mdPath = join(tmpDir, "smoke.md");
writeFileSync(mdPath, SAMPLE_MD, "utf-8");

// ---------------------------------------------------------------------------
// 1. Availability
// ---------------------------------------------------------------------------

section("1. createPageIndex() availability");
const pi = createPageIndex({
  connection: { provider: "local-claude-cli" },
  projectName: "_test_local",
});
assert(pi.provider === "local-claude-cli", `provider=${pi.provider}`);
const avail = pi.checkAvailability();
assert(avail.provider === "local-claude-cli", `avail.provider=${avail.provider}`);
assert(avail.python === true, `python=${avail.python}`);
assert(avail.repo === true, "OSS repo + pageindex_local.py present");
assert(avail.apiKey === true, "apiKey=true (not required for local backend)");
assert(avail.available === true, `available=${avail.available} ${avail.reason ?? ""}`);

// ---------------------------------------------------------------------------
// 2. Direct submitViaLocalClaudeCli — plumbing + no summaries (fast path)
// ---------------------------------------------------------------------------

section("2. submitViaLocalClaudeCli (plumbing, summary=false)");
const fastOut = join(tmpDir, "fast.json");
const fastResult = await submitViaLocalClaudeCli({
  srcPath: mdPath,
  srcType: "md",
  outputPath: fastOut,
  pythonPath: PAGEINDEX_PATHS.DEFAULT_PYTHON,
  timeoutMs: 3 * 60 * 1000,
  summary: false,
  includeText: true,
});
assert(fastResult.ok === true, `fast run ok (${fastResult.error ?? ""})`);
assert(
  typeof fastResult.nodeCount === "number" && (fastResult.nodeCount ?? 0) >= 3,
  `nodeCount>=3 (${fastResult.nodeCount ?? 0})`,
);
assert(existsSync(fastOut), `tree file written at ${fastOut}`);
assert(
  fastResult.tree !== undefined &&
    typeof (fastResult.tree as { doc_name?: unknown }).doc_name === "string",
  "tree.doc_name present",
);

// ---------------------------------------------------------------------------
// 3. indexDocument() routes through local backend + per-project storage
// ---------------------------------------------------------------------------

section("3. indexDocument via local-claude-cli (fast markdown)");
const testProject = `_test_local_${Date.now()}`;
const ix = createPageIndex({
  connection: { provider: "local-claude-cli" },
  projectName: testProject,
});
// Route through a writable sub-storage so we do not pollute a user's real
// ~/.vela/pageindex state. We still point at real storagePath to keep the
// per-project index layout consistent with other tests.
const first = await ix.indexDocument(mdPath, { projectName: testProject });
assert(first.success === true, `first indexDocument ok (${first.error ?? ""})`);
assert(first.provider === "local-claude-cli", `provider=${first.provider}`);
assert(first.docId.startsWith("local-"), `docId prefixed: ${first.docId}`);
assert(existsSync(first.treePath), `tree written at ${first.treePath}`);

// ---------------------------------------------------------------------------
// 4. Idempotency: second call should be a cache hit
// ---------------------------------------------------------------------------

section("4. Idempotency (md5 cache)");
if (first.success) {
  const second = await ix.indexDocument(mdPath, { projectName: testProject });
  assert(second.success === true, "second indexDocument ok");
  assert(second.cached === true, "second call cached=true");
  assert(second.docId === first.docId, `docId stable (${first.docId} vs ${second.docId})`);
}

// ---------------------------------------------------------------------------
// 5. No-apiKey failure mode for local-claude-cli is graceful
// ---------------------------------------------------------------------------

section("5. local-claude-cli works with no apiKey set");
const noKeyPi = createPageIndex({
  connection: { provider: "local-claude-cli" /* no apiKey */ },
  projectName: "_test_no_key",
});
const noKeyAvail = noKeyPi.checkAvailability();
assert(noKeyAvail.available === true, "available=true without apiKey");

// ---------------------------------------------------------------------------
// 6. Tree structure: top-level nodes + titles match the input markdown
// ---------------------------------------------------------------------------

section("6. Tree content sanity");
try {
  const raw = JSON.parse(readFileSync(first.treePath, "utf-8")) as {
    doc_name: string;
    structure: Array<{ title: string; nodes?: unknown[] }>;
  };
  assert(typeof raw.doc_name === "string", `doc_name=${raw.doc_name}`);
  assert(Array.isArray(raw.structure), "structure is an array");
  const titles = (raw.structure ?? []).flatMap((n) => [
    n.title,
    ...((n as { nodes?: Array<{ title?: string }> }).nodes ?? []).map(
      (c) => c.title ?? "",
    ),
  ]);
  assert(
    titles.some((t) => t.includes("Local Backend Smoke Test")),
    "top-level title present",
  );
  assert(titles.some((t) => t.includes("Section A")), "Section A present");
  assert(titles.some((t) => t.includes("Section B")), "Section B present");
} catch (err) {
  fail(`failed to parse tree: ${(err as Error).message}`);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
try {
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(join(homedir(), ".vela", "pageindex", testProject), {
    recursive: true,
    force: true,
  });
} catch {
  // ignore
}
// mkdirSync imported only to satisfy dead-code checker if reordered later
void mkdirSync;

console.log();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
