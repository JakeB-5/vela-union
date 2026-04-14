// vela list — list registered projects.

import { listProjects } from "@vela-union/shared";
import { bold, cyan, dim, info } from "../util/log.js";
import type { CommandContext } from "../util/context.js";

export async function runList(ctx: CommandContext): Promise<number> {
  const log = ctx.logger;
  log.info("list start");
  const projects = listProjects();
  log.info("list complete", { count: projects.length });
  if (projects.length === 0) {
    info("no projects registered. try: vela register /path/to/project");
    return 0;
  }
  console.log(`\n${bold(cyan(`${projects.length} registered project(s)`))}\n`);
  for (const p of projects) {
    console.log(`  ${bold(p.name)} ${dim(`(${p.type})`)}`);
    console.log(`    ${dim(p.path)}`);
    if (p.relatedProjects.length > 0) {
      console.log(`    ${dim(`related: ${p.relatedProjects.join(", ")}`)}`);
    }
  }
  console.log();
  return 0;
}
