#!/usr/bin/env node
// vela — the Vela Union CLI.
// Tiny argv parser, no external deps.

import { runSetup } from "./commands/setup.js";
import { runStatus } from "./commands/status.js";
import { runStart } from "./commands/start.js";
import { runStop } from "./commands/stop.js";
import { runLogs } from "./commands/logs.js";
import { runRegister } from "./commands/register.js";
import { runUnregister } from "./commands/unregister.js";
import { runList } from "./commands/list.js";
import { runDispatch } from "./commands/dispatch.js";
import { runSyncFromPaperclip } from "./commands/sync-from-paperclip.js";
import { runIndex } from "./commands/index-docs.js";
import { runPrune } from "./commands/prune.js";
import { bold, cyan, dim } from "./util/log.js";
import { buildContext, parseGlobalFlags } from "./util/context.js";
import type { CommandContext } from "./util/context.js";

const USAGE = `
${bold(cyan("vela"))} — Vela Union CLI

${bold("Commands:")}
  ${bold("setup")}                       One-command bootstrap for all 4 systems
  ${bold("status")}                      Show status of all 4 systems
  ${bold("start")}                       Start background services (Paperclip)
  ${bold("stop")}                        Stop background services
  ${bold("logs")} [component-prefix]     Query the unified log sink
  ${bold("register")} <project-path>     Register a project in the registry
  ${bold("unregister")} <name>           Remove a project from the registry
  ${bold("prune")}                       Remove registry entries whose path no longer exists
  ${bold("sync-from-paperclip")}         Import paperclip projects into the registry
  ${bold("list")}                        List registered projects
  ${bold("dispatch")} <project> <goal>   Dispatch a goal to a project
  ${bold("index")} <path|project>        Index PDF/markdown docs via PageIndex cloud

${bold("Global flags (any subcommand):")}
  ${bold("--verbose, -v")}              Print structured logs to stderr while running
  ${bold("--debug")}                    Set log level to debug (implies --verbose)
  ${bold("--quiet, -q")}                Suppress stderr log output (sink still written)
  ${bold("--log-level <lvl>")}          Minimum log level: debug | info | warn | error
  ${bold("--cid <id>")}                 Override auto-generated correlation id
  ${bold("--sink <path>")}              Override the default sink path
  ${bold("--no-log")}                   Disable sink writes entirely

${bold("Examples:")}
  ${dim("$")} vela setup
  ${dim("$")} vela status
  ${dim("$")} vela register /Users/me/code/myapp
  ${dim("$")} vela unregister myapp
  ${dim("$")} vela prune --dry-run
  ${dim("$")} vela dispatch myapp "add login feature"
  ${dim("$")} vela --verbose dispatch myapp "fix bug"
  ${dim("$")} vela logs --tail
  ${dim("$")} vela logs --cid abc12345
`.trim();

type CommandRunner = (ctx: CommandContext) => Promise<number>;

const COMMANDS: Record<string, { component: string; run: CommandRunner }> = {
  setup: { component: "cli.setup", run: runSetup },
  status: { component: "cli.status", run: runStatus },
  start: { component: "cli.start", run: runStart },
  stop: { component: "cli.stop", run: runStop },
  logs: { component: "cli.logs", run: runLogs },
  register: { component: "cli.register", run: runRegister },
  unregister: { component: "cli.unregister", run: runUnregister },
  prune: { component: "cli.prune", run: runPrune },
  "sync-from-paperclip": {
    component: "cli.sync-from-paperclip",
    run: runSyncFromPaperclip,
  },
  list: { component: "cli.list", run: runList },
  dispatch: { component: "cli.dispatch", run: runDispatch },
  index: { component: "cli.index", run: runIndex },
};

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  const flags = parseGlobalFlags(rawArgv);
  const [command, ...rest] = flags.rest;

  if (!command || command === "-h" || command === "--help" || command === "help") {
    console.log(USAGE);
    process.exit(0);
  }

  const entry = COMMANDS[command];
  if (!entry) {
    console.error(`Unknown command: ${command}\n`);
    console.log(USAGE);
    process.exit(1);
  }

  const ctx = buildContext(entry.component, { ...flags, rest });
  ctx.logger.debug("command dispatch", { command, argv: rest });

  try {
    const exitCode = await entry.run(ctx);
    ctx.logger.debug("command exit", { command, exitCode });
    process.exit(exitCode);
  } catch (err) {
    ctx.logger.error("command crashed", err, { command });
    console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

await main();
