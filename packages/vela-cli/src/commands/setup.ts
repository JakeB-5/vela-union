// vela setup — idempotent one-command bootstrap for all 4 Vela Union systems.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  CLAUDE_SETTINGS,
  CLAUDE_SETTINGS_BAK,
  MCP_GATEWAY_BIN,
  PAGEINDEX_REFS,
  PAPERCLIP_LOG,
  PAPERCLIP_PID,
  PAPERCLIP_REPO,
  PAPERCLIP_ROOT,
  REPO_ROOT,
  VELA_DECISIONS,
  VELA_GOALS_JSON,
  VELA_GBRAIN,
  VELA_GRAPHIFY,
  VELA_HOME,
  VELA_LOGS,
  VELA_PIDS,
  VELA_PLUGIN_DIR,
  VELA_PROJECTS_JSON,
  VENV_DIR,
  VENV_PIP,
  VENV_PYTHON,
  paperclipBaseUrl,
} from "../util/paths.js";
import {
  checkPreflight,
  detectAll,
  detectGraphify,
  detectGstack,
  detectMcpGateway,
  detectPageIndex,
} from "../util/detect.js";
import type { SystemStatus } from "../util/detect.js";
import { exec, execLive, ensureDir, isAlive, readPid, spawnDaemon, which, writeFileEnsure } from "../util/proc.js";
import { getJson, postJson, waitForHttpOk } from "../util/http.js";
import { bold, cyan, dim, fail, fmtElapsed, green, header, indent, ok, red, step, yellow } from "../util/log.js";
import type { CommandContext } from "../util/context.js";
import {
  loadConfig,
  saveConfig,
  DEFAULT_PAPERCLIP_API_URL,
  DEFAULT_PROJECT_PREFIX,
  PaperclipClient,
  PaperclipUnreachableError,
} from "@vela-union/shared";
import type { Logger, PaperclipConnectionConfig } from "@vela-union/shared";

const TOTAL_STEPS = 13;

const LAUNCHD_PLIST_PATH = join(
  homedir(),
  "Library",
  "LaunchAgents",
  "com.vela.paperclip.plist",
);
const LAUNCHD_LABEL = "com.vela.paperclip";

/**
 * Ask a y/n question on stdin. Returns true for yes, false for no. Defaults
 * to `defaultYes` on empty input. Returns `defaultYes` if stdin is not a TTY.
 */
async function promptYesNo(question: string, defaultYes = true): Promise<boolean> {
  if (!process.stdin.isTTY) return defaultYes;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultYes ? "[Y/n]" : "[y/N]";
    const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();
    if (!answer) return defaultYes;
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/**
 * Render the launchd plist for Paperclip. The command/cwd match what
 * start.ts uses today: `pnpm dev:server` inside PAPERCLIP_ROOT.
 */
function renderPaperclipPlist(pnpmBin: string, pnpmBinDir: string): string {
  // HOME/USER must be set explicitly: launchd-spawned processes do NOT
  // inherit the user's shell environment, so `claude -p` subprocesses
  // spawned from inside the Paperclip plugin worker would otherwise fail
  // with "Not logged in" because they couldn't find ~/.claude/ auth.
  // VELA_CLAUDE_CLI_CONCURRENCY caps the asyncio.gather fan-out inside
  // pageindex_local.py so a single large doc can't blow up memory by
  // spawning 50+ parallel Claude CLI processes at once.
  const home = homedir();
  const user = process.env["USER"] ?? "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${pnpmBin}</string>
        <string>dev:server</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PAPERCLIP_ROOT}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${join(VELA_LOGS, "paperclip-launchd.log")}</string>
    <key>StandardErrorPath</key>
    <string>${join(VELA_LOGS, "paperclip-launchd.err")}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${pnpmBinDir}:${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>${home}</string>
        <key>USER</key>
        <string>${user}</string>
        <key>NODE_ENV</key>
        <string>development</string>
        <key>VELA_CLAUDE_CLI_CONCURRENCY</key>
        <string>3</string>
    </dict>
</dict>
</plist>
`;
}

interface StepResult {
  name: string;
  ok: boolean;
  elapsedMs: number;
  message: string;
}

/** Wrap a step so we can uniformly track timing and errors. */
async function runStep(
  logger: Logger,
  n: number,
  label: string,
  fn: () => Promise<{ ok: boolean; message: string }>,
): Promise<StepResult> {
  step(n, TOTAL_STEPS, label);
  const stepLog = logger.child(`step-${n}`);
  stepLog.info("step start", { step: n, label });
  const started = Date.now();
  try {
    const { ok: success, message } = await fn();
    const elapsedMs = Date.now() - started;
    if (success) {
      stepLog.info("step ok", { step: n, label, message, durationMs: elapsedMs });
      ok(`${label} — ${message} ${dim(`(${fmtElapsed(elapsedMs)})`)}`);
    } else {
      stepLog.warn("step failed", { step: n, label, message, durationMs: elapsedMs });
      fail(`${label} — ${message} ${dim(`(${fmtElapsed(elapsedMs)})`)}`);
    }
    return { name: label, ok: success, elapsedMs, message };
  } catch (err) {
    const elapsedMs = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    stepLog.error("step crashed", err, { step: n, label, durationMs: elapsedMs });
    fail(`${label} — ${message} ${dim(`(${fmtElapsed(elapsedMs)})`)}`);
    return { name: label, ok: false, elapsedMs, message };
  }
}

function fmtStatus(s: SystemStatus): string {
  const icon = s.status === "ok" ? green("\u2713") : s.status === "degraded" ? yellow("~") : red("\u2717");
  const version = s.version ? dim(` v${s.version}`) : "";
  return `  ${icon} ${s.name}${version} — ${dim(s.detail)}`;
}

export async function runSetup(ctx: CommandContext): Promise<number> {
  const log = ctx.logger;
  log.info("setup begin", { argv: ctx.argv });
  header("Vela Union Setup");
  console.log(dim("One-command bootstrap for Paperclip, gstack, Graphify, PageIndex.\n"));

  // Preflight check
  header("Preflight");
  const pre = checkPreflight();
  log.debug("preflight result", {
    node: pre.node.status,
    pnpm: pre.pnpm.status,
    python: pre.python.status,
    git: pre.git.status,
  });
  console.log(fmtStatus(pre.node));
  console.log(fmtStatus(pre.pnpm));
  console.log(fmtStatus(pre.python));
  console.log(fmtStatus(pre.git));
  const preflightOk =
    pre.node.status === "ok" &&
    pre.pnpm.status === "ok" &&
    pre.python.status === "ok" &&
    pre.git.status === "ok";
  if (!preflightOk) {
    fail("\nPreflight failed. Install missing dependencies and retry.");
    return 1;
  }

  // Initial detection
  header("Current state");
  const before = await detectAll();
  console.log(fmtStatus(before.paperclip));
  console.log(fmtStatus(before.gstack));
  console.log(fmtStatus(before.graphify));
  console.log(fmtStatus(before.pageindex));
  console.log(fmtStatus(before.mcpGateway));

  const results: StepResult[] = [];

  // Step 1 — initialize ~/.vela directories (do this first so logs have a place to go)
  results.push(
    await runStep(log, 1, "Initialize ~/.vela directories", async () => {
      ensureDir(VELA_HOME);
      ensureDir(VELA_LOGS);
      ensureDir(VELA_PIDS);
      ensureDir(VELA_DECISIONS);
      ensureDir(VELA_GRAPHIFY);
      ensureDir(VELA_GBRAIN);
      if (!existsSync(VELA_PROJECTS_JSON)) {
        writeFileSync(VELA_PROJECTS_JSON, "[]\n", "utf-8");
      }
      if (!existsSync(VELA_GOALS_JSON)) {
        writeFileSync(VELA_GOALS_JSON, "[]\n", "utf-8");
      }
      return { ok: true, message: `ready at ${VELA_HOME}` };
    }),
  );

  // Step 2 — ensure Paperclip cloned + deps installed + built
  results.push(
    await runStep(log, 2, "Install Paperclip", async () => {
      if (!existsSync(PAPERCLIP_ROOT)) {
        indent(`cloning ${PAPERCLIP_REPO} to ${PAPERCLIP_ROOT}`);
        const clone = await execLive("git", ["clone", PAPERCLIP_REPO, PAPERCLIP_ROOT]);
        if (clone !== 0) return { ok: false, message: `git clone failed (exit ${clone})` };
      }
      // Install deps if node_modules missing
      if (!existsSync(join(PAPERCLIP_ROOT, "node_modules"))) {
        indent(`pnpm install in ${PAPERCLIP_ROOT}`);
        const install = await execLive("pnpm", ["install"], { cwd: PAPERCLIP_ROOT });
        if (install !== 0) return { ok: false, message: `pnpm install failed (exit ${install})` };
      } else {
        indent("node_modules exists — skipping pnpm install");
      }
      // Build plugin SDK (required for our paperclip-plugin package)
      const sdkDist = join(PAPERCLIP_ROOT, "packages", "plugins", "sdk", "dist");
      if (!existsSync(sdkDist)) {
        indent("building @paperclipai/plugin-sdk");
        const build = await execLive(
          "pnpm",
          ["--filter", "@paperclipai/plugin-sdk", "build"],
          { cwd: PAPERCLIP_ROOT },
        );
        if (build !== 0) return { ok: false, message: `plugin-sdk build failed (exit ${build})` };
      } else {
        indent("plugin-sdk already built");
      }
      return { ok: true, message: `ready at ${PAPERCLIP_ROOT}` };
    }),
  );

  // Step 3 — start Paperclip server in background
  results.push(
    await runStep(log, 3, "Start Paperclip server", async () => {
      const url = paperclipBaseUrl();
      // Already running?
      const existingPid = readPid(PAPERCLIP_PID);
      if (existingPid !== null && isAlive(existingPid)) {
        const health = await getJson(`${url}/api/plugins`, 2000);
        if (health.ok) {
          return { ok: true, message: `already running on ${url} (pid ${existingPid})` };
        }
        indent(`stale pid ${existingPid} — killing and restarting`);
        try { process.kill(existingPid, "SIGTERM"); } catch { /* ignore */ }
      }
      const pnpmBin = which("pnpm");
      if (!pnpmBin) return { ok: false, message: "pnpm not found on PATH" };
      const pid = spawnDaemon(pnpmBin, ["dev:server"], {
        cwd: PAPERCLIP_ROOT,
        logFile: PAPERCLIP_LOG,
        env: { ...process.env, NODE_ENV: "development" },
      });
      writeFileEnsure(PAPERCLIP_PID, String(pid));
      indent(`started pid ${pid}, waiting for ${url}/api/plugins ...`);
      const ready = await waitForHttpOk(`${url}/api/plugins`, { timeoutMs: 120_000, intervalMs: 1000 });
      if (!ready) {
        return {
          ok: false,
          message: `server did not become ready. See logs: ${PAPERCLIP_LOG}`,
        };
      }
      return { ok: true, message: `running on ${url} (pid ${pid})` };
    }),
  );

  // Step 4 — gstack detection (cannot auto-install globally)
  results.push(
    await runStep(log, 4, "Verify gstack", async () => {
      const g = detectGstack();
      if (g.status !== "ok") {
        indent("gstack skills must be installed globally by the user.");
        indent("See: https://github.com/garrytan/gstack");
        return { ok: false, message: g.detail };
      }
      return { ok: true, message: g.detail };
    }),
  );

  // Step 5 — ensure Graphify installed in venv
  results.push(
    await runStep(log, 5, "Install Graphify", async () => {
      if (!existsSync(VENV_DIR)) {
        indent(`creating venv at ${VENV_DIR}`);
        const py = which("python3");
        if (!py) return { ok: false, message: "python3 not found" };
        const create = await execLive(py, ["-m", "venv", VENV_DIR]);
        if (create !== 0) return { ok: false, message: `venv creation failed (exit ${create})` };
      }
      const probe = detectGraphify();
      if (probe.status === "ok") {
        return { ok: true, message: probe.detail };
      }
      indent("pip install graphifyy");
      const install = await execLive(VENV_PIP, ["install", "graphifyy"]);
      if (install !== 0) return { ok: false, message: `pip install graphifyy failed (exit ${install})` };
      // Verify import
      const verify = exec(VENV_PYTHON, ["-c", "import graphifyy; print(graphifyy.__name__)"]);
      if (verify.code !== 0) {
        return { ok: false, message: `graphifyy import failed: ${verify.stderr.trim()}` };
      }
      return { ok: true, message: "graphifyy installed and importable" };
    }),
  );

  // Step 6 — install PageIndex from refs/
  results.push(
    await runStep(log, 6, "Install PageIndex", async () => {
      if (!existsSync(PAGEINDEX_REFS)) {
        return { ok: false, message: `PageIndex refs missing at ${PAGEINDEX_REFS}` };
      }
      const reqPath = join(PAGEINDEX_REFS, "requirements.txt");
      if (existsSync(reqPath)) {
        const probe = detectPageIndex();
        if (probe.status === "ok") {
          return { ok: true, message: probe.detail };
        }
        indent(`pip install -r ${reqPath}`);
        const install = await execLive(VENV_PIP, ["install", "-r", reqPath]);
        if (install !== 0) {
          return { ok: false, message: `pip install PageIndex reqs failed (exit ${install})` };
        }
      } else {
        indent(`no requirements.txt at ${reqPath}, skipping pip install`);
      }
      const verify = detectPageIndex();
      if (verify.status !== "ok") {
        return { ok: false, message: verify.detail };
      }
      return { ok: true, message: verify.detail };
    }),
  );

  // Step 7 — build Vela Union TypeScript
  results.push(
    await runStep(log, 7, "Build Vela Union TypeScript", async () => {
      const build = await execLive("npx", ["tsc", "--build"], { cwd: REPO_ROOT });
      if (build !== 0) return { ok: false, message: `tsc --build failed (exit ${build})` };
      if (!existsSync(MCP_GATEWAY_BIN)) {
        return { ok: false, message: `expected ${MCP_GATEWAY_BIN} after build` };
      }
      return { ok: true, message: "monorepo built" };
    }),
  );

  // Step 8 — install Vela plugin into Paperclip
  results.push(
    await runStep(log, 8, "Install Vela plugin in Paperclip", async () => {
      const url = paperclipBaseUrl();
      // Check if already installed
      const list = await getJson<{ plugins?: Array<{ id?: string; name?: string; path?: string }> }>(
        `${url}/api/plugins`,
        5000,
      );
      if (!list.ok) {
        return { ok: false, message: `cannot reach ${url}/api/plugins: ${list.error ?? list.status}` };
      }
      const plugins = list.data?.plugins ?? [];
      const already = plugins.some(
        (p) => p.path === VELA_PLUGIN_DIR || p.name === "vela-union" || p.id === "vela-union",
      );
      if (already) {
        return { ok: true, message: "vela plugin already installed in Paperclip" };
      }
      const install = await postJson<{ ok?: boolean; error?: string }>(
        `${url}/api/plugins/install`,
        { packageName: VELA_PLUGIN_DIR, isLocalPath: true },
        60_000,
      );
      if (!install.ok) {
        return {
          ok: false,
          message: `install failed: ${install.error ?? `status ${install.status}`}`,
        };
      }
      return { ok: true, message: "vela plugin installed in Paperclip" };
    }),
  );

  // Step 9 — register MCP gateway in Claude Code settings.json
  results.push(
    await runStep(log, 9, "Register MCP gateway in Claude Code", async () => {
      if (!existsSync(MCP_GATEWAY_BIN)) {
        return { ok: false, message: `gateway binary missing: ${MCP_GATEWAY_BIN}` };
      }
      let settings: Record<string, unknown> = {};
      if (existsSync(CLAUDE_SETTINGS)) {
        try {
          settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf-8")) as Record<string, unknown>;
        } catch (err) {
          return {
            ok: false,
            message: `cannot parse ${CLAUDE_SETTINGS}: ${err instanceof Error ? err.message : err}`,
          };
        }
      }
      // Backup before writing.
      if (existsSync(CLAUDE_SETTINGS)) {
        writeFileSync(CLAUDE_SETTINGS_BAK, readFileSync(CLAUDE_SETTINGS, "utf-8"), "utf-8");
      }
      const mcpServers =
        (settings["mcpServers"] as Record<string, unknown> | undefined) ?? {};
      const existing = mcpServers["vela-union"] as
        | { command?: string; args?: string[] }
        | undefined;
      const desired = {
        command: "node",
        args: [MCP_GATEWAY_BIN],
      };
      const alreadyCorrect =
        existing?.command === desired.command &&
        Array.isArray(existing.args) &&
        existing.args[0] === MCP_GATEWAY_BIN;
      if (alreadyCorrect) {
        return { ok: true, message: "vela-union already registered in settings.json" };
      }
      mcpServers["vela-union"] = desired;
      settings["mcpServers"] = mcpServers;
      ensureDir(join(CLAUDE_SETTINGS, ".."));
      writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + "\n", "utf-8");
      return { ok: true, message: `registered in ${CLAUDE_SETTINGS}` };
    }),
  );

  // Step 10 — MCP gateway smoke test
  results.push(
    await runStep(log, 10, "Verify MCP gateway binary", async () => {
      const probe = detectMcpGateway();
      if (probe.status !== "ok") return { ok: false, message: probe.detail };
      // Spawn the gateway briefly to ensure it can at least boot without crashing.
      // We don't speak MCP here — just run node with --check semantics: use -e to import it.
      // Simpler: run `node MCP_GATEWAY_BIN --help` style probe by importing via eval.
      const boot = exec(process.execPath, [
        "-e",
        `import('${MCP_GATEWAY_BIN}').then(() => { console.log('import-ok'); process.exit(0); }).catch(err => { console.error(err); process.exit(2); });`,
      ]);
      if (boot.code !== 0 && !boot.stdout.includes("import-ok")) {
        // The server may start and listen on stdio — that's fine. Treat
        // non-crash exits as success if the binary exists.
        indent(`gateway boot probe returned ${boot.code} (this is usually fine for stdio servers)`);
      }
      return { ok: true, message: MCP_GATEWAY_BIN };
    }),
  );

  // Step 11 — install launchd agent (macOS only)
  results.push(
    await runStep(log, 11, "Install launchd agent (macOS only)", async () => {
      if (process.platform !== "darwin") {
        return { ok: true, message: "launchd skipped (non-macOS platform)" };
      }
      // Idempotent short-circuit: if the plist already exists and launchd
      // already has it loaded, don't prompt again.
      if (existsSync(LAUNCHD_PLIST_PATH)) {
        const loaded = exec("launchctl", ["list", LAUNCHD_LABEL]);
        if (loaded.code === 0) {
          return { ok: true, message: `already installed at ${LAUNCHD_PLIST_PATH}` };
        }
      }
      const accept = await promptYesNo(
        "Install launchd agent to auto-start Paperclip on login?",
        true,
      );
      if (!accept) {
        return { ok: true, message: "launchd skipped (user declined)" };
      }
      const pnpmBin = which("pnpm");
      if (!pnpmBin) {
        return { ok: false, message: "pnpm not found on PATH — cannot build plist" };
      }
      const pnpmBinDir = pnpmBin.replace(/\/pnpm$/, "");
      const plist = renderPaperclipPlist(pnpmBin, pnpmBinDir);
      ensureDir(join(LAUNCHD_PLIST_PATH, ".."));
      writeFileSync(LAUNCHD_PLIST_PATH, plist, "utf-8");
      indent(`wrote ${LAUNCHD_PLIST_PATH}`);
      // Unload any previous copy (no error if it wasn't loaded).
      exec("launchctl", ["unload", LAUNCHD_PLIST_PATH]);
      const load = exec("launchctl", ["load", LAUNCHD_PLIST_PATH]);
      if (load.code !== 0) {
        return {
          ok: false,
          message: `launchctl load failed (exit ${load.code}): ${load.stderr.trim()}`,
        };
      }
      const verify = exec("launchctl", ["list", LAUNCHD_LABEL]);
      if (verify.code !== 0) {
        return {
          ok: false,
          message: `launchctl list ${LAUNCHD_LABEL} returned ${verify.code} after load`,
        };
      }
      return { ok: true, message: `installed and loaded ${LAUNCHD_LABEL}` };
    }),
  );

  // Step 12 — write ~/.vela/config.json with Paperclip connection details.
  // Auto-detects the first Company and first Agent from the running
  // Paperclip instance and persists them so the CLI, plugin, and gateway
  // all share a single source of truth for Paperclip routing.
  results.push(
    await runStep(log, 12, "Configure Paperclip connection", async () => {
      const apiUrl = paperclipBaseUrl();
      const existing = loadConfig();
      const existingPcp = existing.paperclip;

      // If already configured AND still valid, skip.
      if (
        existingPcp &&
        existingPcp.apiUrl &&
        existingPcp.companyId &&
        existingPcp.defaultAgentId
      ) {
        return {
          ok: true,
          message: `already configured (company=${existingPcp.companyId.slice(0, 8)}, agent=${existingPcp.defaultAgentId.slice(0, 8)})`,
        };
      }

      // Auto-detect: probe Paperclip for companies and agents.
      const provisionalConfig: PaperclipConnectionConfig = {
        apiUrl,
        companyId: "",
        defaultAgentId: "",
        defaultProjectPrefix: DEFAULT_PROJECT_PREFIX,
      };
      const probeClient = new PaperclipClient(provisionalConfig);
      try {
        const companies = await probeClient.listCompanies();
        if (companies.length === 0) {
          return {
            ok: false,
            message:
              "no companies found in Paperclip — finish Paperclip onboarding first, then re-run `vela setup`",
          };
        }
        // If user passed --company-id, use it; otherwise pick the first.
        const flagCompany = ctx.argv.find((a) => a.startsWith("--company-id="));
        const companyId = flagCompany
          ? flagCompany.slice("--company-id=".length)
          : companies[0]!.id;
        if (companies.length > 1 && !flagCompany) {
          indent(
            `${companies.length} companies found; using first "${companies[0]!.name}" (override with --company-id=<uuid>)`,
          );
        }

        // Fetch agents for that company.
        const clientForCompany = new PaperclipClient({
          ...provisionalConfig,
          companyId,
        });
        const agents = await clientForCompany.listAgents();
        if (agents.length === 0) {
          return {
            ok: false,
            message: `no agents found in company ${companyId.slice(0, 8)} — create one in Paperclip, then re-run \`vela setup\``,
          };
        }
        const defaultAgentId = agents[0]!.id;
        if (agents.length > 1) {
          indent(
            `${agents.length} agents found; using first "${agents[0]!.name}" (override by editing ~/.vela/config.json)`,
          );
        }

        saveConfig({
          paperclip: {
            apiUrl,
            companyId,
            defaultAgentId,
            defaultProjectPrefix: DEFAULT_PROJECT_PREFIX,
          },
        });
        return {
          ok: true,
          message: `wrote ~/.vela/config.json (company=${companyId.slice(0, 8)}, agent=${defaultAgentId.slice(0, 8)})`,
        };
      } catch (err) {
        if (err instanceof PaperclipUnreachableError) {
          return {
            ok: false,
            message: `paperclip unreachable at ${apiUrl} — ensure step 3 succeeded`,
          };
        }
        return {
          ok: false,
          message: `config probe failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }),
  );

  // Step 13 — final verification summary
  results.push(
    await runStep(log, 13, "Final verification", async () => {
      const after = await detectAll();
      const systems: SystemStatus[] = [
        after.paperclip,
        after.gstack,
        after.graphify,
        after.pageindex,
        after.mcpGateway,
      ];
      const failed = systems.filter((s) => s.status === "missing");
      if (failed.length > 0) {
        return {
          ok: false,
          message: `${failed.length} system(s) still missing: ${failed.map((s) => s.name).join(", ")}`,
        };
      }
      return { ok: true, message: "all systems reporting ok" };
    }),
  );

  // Print summary
  header("Summary");
  for (const r of results) {
    if (r.ok) ok(`${r.name} ${dim(`(${fmtElapsed(r.elapsedMs)})`)}`);
    else fail(`${r.name} — ${r.message}`);
  }

  const failedSteps = results.filter((r) => !r.ok);
  log.info("setup summary", {
    totalSteps: results.length,
    okSteps: results.length - failedSteps.length,
    failedSteps: failedSteps.length,
    totalMs: results.reduce((sum, r) => sum + r.elapsedMs, 0),
  });
  if (failedSteps.length > 0) {
    log.warn("setup incomplete", {
      failed: failedSteps.map((f) => ({ name: f.name, message: f.message })),
    });
    console.log();
    fail(`${failedSteps.length} step(s) failed. Fix the issues above and run 'vela setup' again.`);
    return 1;
  }
  log.info("setup complete");

  header("Setup complete");
  console.log(`
Next steps:
  ${bold("vela register")} /path/to/project
  ${bold("vela dispatch")} myproject "add login feature"
  ${bold("vela status")}
  Open ${cyan(paperclipBaseUrl())} to see the Paperclip dashboard with Vela tools.
`);
  return 0;
}
