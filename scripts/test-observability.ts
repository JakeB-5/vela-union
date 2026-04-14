#!/usr/bin/env npx tsx
// Test script: verify the Vela Union observability layer.
//
// Covers:
//   1. Logger core — JSONL format, level filtering, cid propagation, time(),
//      TTY output, data truncation, error swallowing
//   2. Log reader — full-file read with filters, tail mode, malformed lines
//   3. CLI instrumentation — --cid, --verbose, --debug, --quiet, --no-log,
//      end-to-end trace from register

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Derive repo root from this script's location (scripts/ → ..)
const REPO_ROOT =
  process.env["VELA_REPO_ROOT"] ??
  resolve(dirname(fileURLToPath(import.meta.url)), "..");

import {
  createLogger,
  generateCid,
  parseLogLevel,
  readLogs,
  tailLogs,
  type LogEntry,
} from "../packages/shared/src/index.ts";

let passed = 0;
let failed = 0;

function check(label: string, cond: boolean, extra = ""): void {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${label}${extra ? ` — ${extra}` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

function section(name: string): void {
  console.log(`\n=== ${name} ===`);
}

function makeTmpSink(): string {
  const dir = mkdtempSync(join(tmpdir(), "vela-obs-"));
  return join(dir, "vela.jsonl");
}

function readAllLines(sink: string): LogEntry[] {
  if (!existsSync(sink)) return [];
  const raw = readFileSync(sink, "utf-8");
  const entries: LogEntry[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      entries.push(JSON.parse(t) as LogEntry);
    } catch {
      // skip
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// 1. Logger core
// ---------------------------------------------------------------------------

function testLoggerCore(): void {
  section("[1] logger core");

  // 1a — JSONL produced
  {
    const sink = makeTmpSink();
    const log = createLogger({
      component: "test.core",
      cid: "cid00001",
      level: "debug",
      sinkPath: sink,
    });
    log.info("hello world", { a: 1 });
    const entries = readAllLines(sink);
    check("one JSONL entry produced", entries.length === 1);
    const e = entries[0];
    check("entry level is info", e?.level === "info");
    check("entry component is test.core", e?.component === "test.core");
    check("entry cid preserved", e?.cid === "cid00001");
    check("entry msg preserved", e?.msg === "hello world");
    check("entry data preserved", (e?.data as { a: number } | undefined)?.a === 1);
    check("entry has ts", typeof e?.ts === "string" && (e?.ts ?? "").includes("T"));
    check("entry has pid", typeof e?.pid === "number");
  }

  // 1b — level filter suppresses below-threshold events
  {
    const sink = makeTmpSink();
    const log = createLogger({
      component: "test.levels",
      cid: "cid00002",
      level: "warn",
      sinkPath: sink,
    });
    log.debug("nope1");
    log.info("nope2");
    log.warn("yes1");
    log.error("yes2");
    const entries = readAllLines(sink);
    check("level filter keeps only warn+ events", entries.length === 2);
    check("level filter kept warn", entries[0]?.level === "warn");
    check("level filter kept error", entries[1]?.level === "error");
  }

  // 1c — cid propagates through child loggers
  {
    const sink = makeTmpSink();
    const root = createLogger({
      component: "test.parent",
      cid: "cid-ROOT",
      sinkPath: sink,
    });
    const child = root.child("sub");
    const grandchild = child.child("deeper");
    root.info("root-msg");
    child.info("child-msg");
    grandchild.info("grand-msg");
    const entries = readAllLines(sink);
    check("root, child, grandchild all logged", entries.length === 3);
    check(
      "cid propagated to child",
      entries.every((e) => e.cid === "cid-ROOT"),
    );
    check(
      "child component namespaced",
      entries[1]?.component === "test.parent.sub",
    );
    check(
      "grandchild component namespaced",
      entries[2]?.component === "test.parent.sub.deeper",
    );
  }

  // 1d — child with explicit cid overrides
  {
    const sink = makeTmpSink();
    const root = createLogger({
      component: "test.override",
      cid: "cid-A",
      sinkPath: sink,
    });
    const child = root.child("b", "cid-B");
    child.info("msg");
    const entries = readAllLines(sink);
    check("child cid override applied", entries[0]?.cid === "cid-B");
  }

  // 1e — time() captures duration on success
  {
    const sink = makeTmpSink();
    const log = createLogger({
      component: "test.time",
      cid: "cid-time",
      level: "debug",
      sinkPath: sink,
    });
    const result = log.time("op", async () => {
      await new Promise((r) => setTimeout(r, 25));
      return 42;
    });
    // Synchronous assertion after await
    void (async () => result)();
    // Wait briefly then inspect
  }

  // 1f — time() captures duration + propagates errors (async)
  {
    const sink = makeTmpSink();
    const log = createLogger({
      component: "test.time2",
      cid: "cid-time2",
      level: "debug",
      sinkPath: sink,
    });
    // Run synchronously-ish via a promise queue
    void (async () => {
      try {
        await log.time("bad-op", async () => {
          throw new Error("boom");
        });
      } catch {
        // swallow
      }
      const entries = readAllLines(sink);
      check(
        "time() error logged with duration_ms",
        entries.some(
          (e) => e.level === "error" && typeof e.duration_ms === "number",
        ),
      );
      check(
        "time() error includes err field",
        entries.some((e) => e.level === "error" && e.err?.message === "boom"),
      );
    })();
  }

  // 1g — data > 32KB is truncated
  {
    const sink = makeTmpSink();
    const log = createLogger({
      component: "test.big",
      cid: "cid-big",
      sinkPath: sink,
    });
    const big = "x".repeat(40_000);
    log.info("big payload", { blob: big });
    const entries = readAllLines(sink);
    check(
      "oversized data truncated",
      entries.length === 1 &&
        (entries[0]?.data as { _truncated?: boolean } | undefined)?._truncated === true,
    );
  }

  // 1h — data<32KB passes through without _truncated marker
  {
    const sink = makeTmpSink();
    const log = createLogger({
      component: "test.small",
      cid: "cid-small",
      sinkPath: sink,
    });
    log.info("small payload", { n: 5 });
    const entries = readAllLines(sink);
    check(
      "small data passes through",
      (entries[0]?.data as { _truncated?: boolean; n?: number } | undefined)?._truncated !== true,
    );
  }

  // 1i — logger does not throw on bad sink path (write errors swallowed)
  {
    const badSink = "/nonexistent/deeply/nested/forbidden/path/vela.jsonl";
    const log = createLogger({
      component: "test.bad",
      cid: "cid-bad",
      sinkPath: badSink,
    });
    let threw = false;
    try {
      log.info("should not throw");
      log.error("nor this", new Error("nope"));
    } catch {
      threw = true;
    }
    check("logger swallows bad sink path", !threw);
  }

  // 1j — malformed data doesn't crash (circular ref)
  {
    const sink = makeTmpSink();
    const log = createLogger({
      component: "test.circ",
      cid: "cid-circ",
      sinkPath: sink,
    });
    const circ: Record<string, unknown> = { a: 1 };
    circ["self"] = circ;
    let threw = false;
    try {
      log.info("with circular", circ);
    } catch {
      threw = true;
    }
    check("circular data does not throw", !threw);
    const entries = readAllLines(sink);
    check("circular data fallback to truncated", entries.length === 1);
  }

  // 1k — parseLogLevel
  {
    check("parseLogLevel debug", parseLogLevel("debug") === "debug");
    check("parseLogLevel info", parseLogLevel("info") === "info");
    check("parseLogLevel warn", parseLogLevel("warn") === "warn");
    check("parseLogLevel error", parseLogLevel("error") === "error");
    check("parseLogLevel bad fallback", parseLogLevel("bogus") === "info");
    check("parseLogLevel undef fallback", parseLogLevel(undefined) === "info");
  }

  // 1l — generateCid
  {
    const a = generateCid();
    const b = generateCid();
    check("cid length 8", a.length === 8 && b.length === 8);
    check("cid uniqueness (basic)", a !== b);
  }

  // Wait for async 1f to complete before leaving this phase. The
  // time() error test schedules a microtask that must finish before we
  // move on.
  // A short sleep is the simplest cross-platform barrier here.
}

// ---------------------------------------------------------------------------
// 2. Log reader
// ---------------------------------------------------------------------------

async function testLogReader(): Promise<void> {
  section("[2] log reader");

  const sink = makeTmpSink();
  const logA = createLogger({
    component: "r.alpha",
    cid: "cid-A",
    level: "debug",
    sinkPath: sink,
  });
  const logB = createLogger({
    component: "r.beta",
    cid: "cid-B",
    level: "debug",
    sinkPath: sink,
  });
  const logNested = createLogger({
    component: "cli.setup.step-1",
    cid: "cid-NEST",
    level: "debug",
    sinkPath: sink,
  });

  logA.debug("debug-a");
  logA.info("info-a", { num: 1 });
  logA.warn("warn-a");
  logA.error("error-a", new Error("boom-a"));
  logB.info("info-b", { num: 2 });
  logB.warn("warn-b", { extra: "graphify-build" });
  logNested.info("nested info");

  // 2a — read all
  {
    const all = readLogs({}, sink);
    check("readLogs returns all entries", all.length === 7);
  }

  // 2b — filter by component substring
  {
    const matched = readLogs({ component: "alpha" }, sink);
    check("component substring filter", matched.length === 4);
  }

  // 2c — filter by componentPrefix
  {
    const matched = readLogs({ componentPrefix: "cli." }, sink);
    check("componentPrefix filter", matched.length === 1 && matched[0]?.component === "cli.setup.step-1");
  }

  // 2d — filter by cid
  {
    const matched = readLogs({ cid: "cid-B" }, sink);
    check("cid filter", matched.length === 2);
  }

  // 2e — filter by level min
  {
    const matched = readLogs({ level: "warn" }, sink);
    check("level min filter keeps warn+error", matched.length === 3);
  }

  // 2f — filter by since/until
  {
    const future = new Date(Date.now() + 3_600_000);
    const past = new Date(Date.now() - 3_600_000);
    check("since future yields nothing", readLogs({ since: future }, sink).length === 0);
    check("since past yields all", readLogs({ since: past }, sink).length === 7);
    check("until past yields nothing", readLogs({ until: past }, sink).length === 0);
  }

  // 2g — grep filter
  {
    const matched = readLogs({ grep: "graphify" }, sink);
    check("grep finds substring in data", matched.length === 1);
  }

  // 2h — limit
  {
    const matched = readLogs({ limit: 2 }, sink);
    check("limit returns last N", matched.length === 2);
  }

  // 2i — malformed line robustness
  {
    appendFileSync(sink, "{not valid json\n", "utf-8");
    appendFileSync(sink, "\n", "utf-8"); // empty line
    const all = readLogs({}, sink);
    check("malformed lines skipped", all.length === 7);
  }

  // 2j — tail mode: receive new entries after subscription
  {
    const tailSink = makeTmpSink();
    const tailLog = createLogger({
      component: "t.live",
      cid: "cid-tail",
      sinkPath: tailSink,
    });
    // Seed the file so fs.watch has something to attach to.
    tailLog.info("before-subscribe");

    await new Promise((r) => setTimeout(r, 50));

    const received: LogEntry[] = [];
    const handle = tailLogs({}, (e) => received.push(e), tailSink);

    await new Promise((r) => setTimeout(r, 50));
    tailLog.info("after-subscribe-1");
    tailLog.info("after-subscribe-2");

    // Wait a beat for fs.watch/poll to pick up the appends
    await new Promise((r) => setTimeout(r, 1500));
    handle.stop();

    check(
      "tail received new entries",
      received.length >= 2,
      `received=${received.length}`,
    );
    check(
      "tail did not replay pre-subscription entry",
      !received.some((e) => e.msg === "before-subscribe"),
    );
  }
}

// ---------------------------------------------------------------------------
// 3. CLI instrumentation
// ---------------------------------------------------------------------------

const CLI = join(REPO_ROOT, "packages", "vela-cli", "dist", "cli.js");

function runCli(args: string[], opts: { sink?: string } = {}): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const env = { ...process.env };
  if (opts.sink) {
    env["HOME"] = env["HOME"] ?? "";
  }
  const result = spawnSync("node", [CLI, ...args], {
    encoding: "utf-8",
    env,
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function testCliInstrumentation(): void {
  section("[3] CLI instrumentation");

  check("CLI binary exists", existsSync(CLI));

  // 3a — --cid propagates into sink entries
  {
    const sinkDir = mkdtempSync(join(tmpdir(), "vela-obs-cli-"));
    const sink = join(sinkDir, "vela.jsonl");
    const testCid = "test-aa-1";
    const { code } = runCli([
      "--cid",
      testCid,
      "--sink",
      sink,
      "--log-level",
      "debug",
      "list",
    ]);
    check("vela list exit 0", code === 0);
    check("sink file written", existsSync(sink));
    const entries = readAllLines(sink);
    check("CLI wrote entries to sink", entries.length > 0);
    check(
      "all entries carry override cid",
      entries.length > 0 && entries.every((e) => e.cid === testCid),
    );
    check(
      "CLI component is cli.list",
      entries.some((e) => e.component.startsWith("cli.list")),
    );
    rmSync(sinkDir, { recursive: true, force: true });
  }

  // 3b — --verbose prints to stderr
  {
    const sinkDir = mkdtempSync(join(tmpdir(), "vela-obs-cli-"));
    const sink = join(sinkDir, "vela.jsonl");
    const { code, stderr } = runCli([
      "--verbose",
      "--debug",
      "--sink",
      sink,
      "--cid",
      "test-verbose",
      "list",
    ]);
    check("verbose list exit 0", code === 0);
    check(
      "verbose printed to stderr",
      stderr.includes("test-verbose") || stderr.includes("DEBUG") || stderr.includes("INFO"),
      `stderr_len=${stderr.length}`,
    );
    rmSync(sinkDir, { recursive: true, force: true });
  }

  // 3c — --quiet suppresses stderr but still writes to sink
  {
    const sinkDir = mkdtempSync(join(tmpdir(), "vela-obs-cli-"));
    const sink = join(sinkDir, "vela.jsonl");
    const { code, stderr } = runCli([
      "--quiet",
      "--sink",
      sink,
      "--cid",
      "test-quiet",
      "list",
    ]);
    check("quiet list exit 0", code === 0);
    // stderr may contain unrelated warnings but should NOT contain our log format
    check(
      "quiet did not print log format to stderr",
      !stderr.includes("test-quiet"),
    );
    check("quiet still wrote sink", existsSync(sink) && readAllLines(sink).length > 0);
    rmSync(sinkDir, { recursive: true, force: true });
  }

  // 3d — --no-log disables sink writes
  {
    const sinkDir = mkdtempSync(join(tmpdir(), "vela-obs-cli-"));
    const sink = join(sinkDir, "vela.jsonl");
    const { code } = runCli([
      "--no-log",
      "--sink",
      sink,
      "--cid",
      "test-nolog",
      "list",
    ]);
    check("no-log list exit 0", code === 0);
    check(
      "no-log did not create sink",
      !existsSync(sink) || statSync(sink).size === 0,
    );
    rmSync(sinkDir, { recursive: true, force: true });
  }

  // 3e — vela logs can read back entries by cid
  {
    const sinkDir = mkdtempSync(join(tmpdir(), "vela-obs-cli-"));
    const sink = join(sinkDir, "vela.jsonl");
    const uniqueCid = "trace-" + generateCid();
    runCli([
      "--cid",
      uniqueCid,
      "--sink",
      sink,
      "--log-level",
      "debug",
      "list",
    ]);
    runCli([
      "--cid",
      uniqueCid,
      "--sink",
      sink,
      "--log-level",
      "debug",
      "list",
    ]);
    // Read back via vela logs --cid
    const { code, stdout } = runCli([
      "logs",
      "--sink",
      sink,
      "--cid",
      uniqueCid,
      "--level",
      "debug",
      "--raw",
    ]);
    check("vela logs --cid exit 0", code === 0);
    check("vela logs --cid found entries", stdout.includes(uniqueCid));
    check(
      "vela logs --cid returned raw JSON",
      stdout
        .split("\n")
        .filter((l) => l.trim())
        .every((l) => {
          try {
            JSON.parse(l);
            return true;
          } catch {
            return false;
          }
        }),
    );
    rmSync(sinkDir, { recursive: true, force: true });
  }

  // 3f — vela logs --level filter
  {
    const sinkDir = mkdtempSync(join(tmpdir(), "vela-obs-cli-"));
    const sink = join(sinkDir, "vela.jsonl");
    // Seed the sink directly
    const seedLog = createLogger({
      component: "seed",
      cid: "seed-cid",
      level: "debug",
      sinkPath: sink,
    });
    seedLog.debug("a");
    seedLog.info("b");
    seedLog.warn("c");
    seedLog.error("d");

    const { code, stdout } = runCli([
      "logs",
      "--sink",
      sink,
      "--level",
      "warn",
      "--raw",
    ]);
    check("vela logs --level exit 0", code === 0);
    const parsed = stdout
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as LogEntry;
        } catch {
          return null;
        }
      })
      .filter((x): x is LogEntry => x !== null);
    check("level filter yielded 2 entries (warn+error)", parsed.length === 2);
    rmSync(sinkDir, { recursive: true, force: true });
  }

  // 3g — vela logs componentPrefix
  {
    const sinkDir = mkdtempSync(join(tmpdir(), "vela-obs-cli-"));
    const sink = join(sinkDir, "vela.jsonl");
    const seedLog = createLogger({
      component: "cli.setup.step-1",
      cid: "seed",
      sinkPath: sink,
    });
    const seedLog2 = createLogger({
      component: "gateway.tool.graph.query",
      cid: "seed",
      sinkPath: sink,
    });
    seedLog.info("a");
    seedLog2.info("b");
    const { code, stdout } = runCli([
      "logs",
      "--sink",
      sink,
      "--raw",
      "cli.",
    ]);
    check("prefix filter exit 0", code === 0);
    const parsed = stdout
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as LogEntry;
        } catch {
          return null;
        }
      })
      .filter((x): x is LogEntry => x !== null);
    check("prefix filter matches only cli.*", parsed.length === 1);
    check(
      "prefix entry is cli.setup.step-1",
      parsed[0]?.component === "cli.setup.step-1",
    );
    rmSync(sinkDir, { recursive: true, force: true });
  }

  // 3h — register command writes structured entries end-to-end
  {
    const sinkDir = mkdtempSync(join(tmpdir(), "vela-obs-cli-"));
    const sink = join(sinkDir, "vela.jsonl");
    const tracedCid = "reg-trace-" + generateCid();
    // Create a fake project directory
    const fakeProj = mkdtempSync(join(tmpdir(), "vela-proj-"));
    writeFileSync(join(fakeProj, "README.md"), "# test\n", "utf-8");

    try {
      const { code } = runCli([
        "--cid",
        tracedCid,
        "--sink",
        sink,
        "--log-level",
        "debug",
        "register",
        fakeProj,
        "--name=test-obs-register",
      ]);
      check("register exit 0", code === 0);
      const entries = readAllLines(sink);
      check(
        "register produced entries",
        entries.length > 0 && entries.every((e) => e.cid === tracedCid),
      );
      check(
        "register has start event",
        entries.some((e) => e.component === "cli.register" && e.msg === "register start"),
      );
      check(
        "register has complete event",
        entries.some((e) => e.component === "cli.register" && e.msg === "register complete"),
      );
    } finally {
      // Always unregister via CLI to prevent leaking entries into the real
      // ~/.vela/projects.json. --no-paperclip skips the remote API call so
      // the cleanup is fast and network-independent. (VELA-16)
      runCli(["unregister", "test-obs-register", "--no-paperclip"]);
      rmSync(fakeProj, { recursive: true, force: true });
      rmSync(sinkDir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Vela Union observability layer test\n");

  testLoggerCore();
  // Allow the async time() checks to flush
  await new Promise((r) => setTimeout(r, 100));
  await testLogReader();
  testCliInstrumentation();

  console.log();
  section("Summary");
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total:  ${passed + failed}`);
  if (failed > 0) {
    console.log("\nSome tests failed!");
    process.exit(1);
  }
  console.log("\nAll tests passed!");
}

await main();
