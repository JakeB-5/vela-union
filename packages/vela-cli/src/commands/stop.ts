// vela stop — terminate background services.

import { existsSync, unlinkSync } from "node:fs";
import { isAlive, killPid, readPid } from "../util/proc.js";
import { PAPERCLIP_PID } from "../util/paths.js";
import { fail, info, ok } from "../util/log.js";
import type { CommandContext } from "../util/context.js";

export async function runStop(ctx: CommandContext): Promise<number> {
  const log = ctx.logger;
  log.info("stop begin");
  const pid = readPid(PAPERCLIP_PID);
  if (pid === null) {
    log.info("stop no pid file");
    info("no Paperclip pid file found");
    return 0;
  }
  if (!isAlive(pid)) {
    log.info("stop pid dead, cleanup", { pid });
    info(`pid ${pid} not alive — cleaning up pid file`);
    if (existsSync(PAPERCLIP_PID)) unlinkSync(PAPERCLIP_PID);
    return 0;
  }
  const killed = killPid(pid);
  if (!killed) {
    log.error("stop kill failed", undefined, { pid });
    fail(`failed to kill pid ${pid}`);
    return 1;
  }
  if (existsSync(PAPERCLIP_PID)) unlinkSync(PAPERCLIP_PID);
  log.info("stop complete", { pid });
  ok(`stopped Paperclip (pid ${pid})`);
  return 0;
}
