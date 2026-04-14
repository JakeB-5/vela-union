// vela start — start background services (currently just Paperclip server).

import { readPid, isAlive, spawnDaemon, which, writeFileEnsure } from "../util/proc.js";
import { getJson, waitForHttpOk } from "../util/http.js";
import { PAPERCLIP_LOG, PAPERCLIP_PID, PAPERCLIP_ROOT, paperclipBaseUrl } from "../util/paths.js";
import { fail, info, ok } from "../util/log.js";
import { existsSync } from "node:fs";
import type { CommandContext } from "../util/context.js";

export async function runStart(ctx: CommandContext): Promise<number> {
  const log = ctx.logger;
  log.info("start begin");
  const url = paperclipBaseUrl();
  const existing = readPid(PAPERCLIP_PID);
  if (existing !== null && isAlive(existing)) {
    log.debug("start existing pid alive", { pid: existing });
    const health = await getJson(`${url}/api/plugins`, 2000);
    if (health.ok) {
      log.info("start already running", { pid: existing, url });
      ok(`Paperclip already running on ${url} (pid ${existing})`);
      return 0;
    }
    log.warn("start unhealthy existing pid", { pid: existing });
    info(`pid ${existing} alive but not healthy — restarting`);
    try { process.kill(existing, "SIGTERM"); } catch { /* ignore */ }
  }
  if (!existsSync(PAPERCLIP_ROOT)) {
    log.error("start paperclip missing", undefined, { path: PAPERCLIP_ROOT });
    fail(`Paperclip not installed at ${PAPERCLIP_ROOT}. Run 'vela setup' first.`);
    return 1;
  }
  const pnpm = which("pnpm");
  if (!pnpm) {
    log.error("start pnpm missing");
    fail("pnpm not found on PATH");
    return 1;
  }
  const pid = spawnDaemon(pnpm, ["dev:server"], {
    cwd: PAPERCLIP_ROOT,
    logFile: PAPERCLIP_LOG,
    env: { ...process.env, NODE_ENV: "development" },
  });
  writeFileEnsure(PAPERCLIP_PID, String(pid));
  log.info("start spawned", { pid, url });
  info(`started Paperclip pid ${pid}, waiting for ${url}/api/plugins ...`);
  const ready = await waitForHttpOk(`${url}/api/plugins`, { timeoutMs: 120_000, intervalMs: 1000 });
  if (!ready) {
    log.error("start not ready", undefined, { pid, url, logFile: PAPERCLIP_LOG });
    fail(`Paperclip did not become ready. See logs: ${PAPERCLIP_LOG}`);
    return 1;
  }
  log.info("start ready", { pid, url });
  ok(`Paperclip running on ${url} (pid ${pid})`);
  return 0;
}
