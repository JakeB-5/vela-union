// gstack proxy for the MCP gateway.
//
// Wraps @vela-union/gstack-adapter so the unified MCP server can expose
// gstack tools (execute_skill, dispatch_goal, list_goals, check_availability)
// to any MCP client. Project-name lookups go through the shared registry so
// callers only need to know the friendly project name, not its filesystem path.

import {
  createGstackAdapter,
  checkClaudeAvailability,
  GSTACK_SKILLS,
  type GstackSkill,
  type SkillExecutionResult,
  type GoalExecutionResult,
} from "@vela-union/gstack-adapter";
import {
  getProject,
  createGoal,
  updateGoal,
  listGoals,
  type StoredGoal,
} from "@vela-union/shared";
// Deep imports avoid pulling in @vela-union/paperclip-plugin's plugin.ts entry,
// which depends on @paperclipai/plugin-sdk (heavy and not needed for dispatch).
import { generateBriefingPack } from "@vela-union/paperclip-plugin/dist/briefing.js";
import { assembleDispatchPrompt } from "@vela-union/paperclip-plugin/dist/dispatch.js";

/** Result of a gstack proxy call (uniform shape across all proxy methods). */
export interface GstackProxyResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/** Lazily-constructed shared adapter so we don't probe the Claude CLI on import. */
let cachedAdapter: ReturnType<typeof createGstackAdapter> | undefined;

function getAdapter(): ReturnType<typeof createGstackAdapter> {
  if (!cachedAdapter) {
    cachedAdapter = createGstackAdapter({
      skills: [...GSTACK_SKILLS],
    });
  }
  return cachedAdapter;
}

/** Check if the Claude CLI is reachable from this gateway process. */
export function checkAvailability(): GstackProxyResult<{
  available: boolean;
  path: string | null;
  version: string | null;
}> {
  const result = checkClaudeAvailability();
  return { success: true, data: result };
}

/** Execute a gstack skill in a registered project by name. */
export async function executeSkill(
  projectName: string,
  skill: string,
  args: string[] = [],
): Promise<GstackProxyResult<SkillExecutionResult>> {
  const project = getProject(projectName);
  if (!project) {
    return {
      success: false,
      error: `Project '${projectName}' not found in registry (~/.vela/projects.json)`,
    };
  }
  if (!GSTACK_SKILLS.includes(skill as GstackSkill)) {
    return {
      success: false,
      error: `Unknown gstack skill '${skill}'. Supported: ${GSTACK_SKILLS.join(", ")}`,
    };
  }

  const adapter = getAdapter();
  const result = await adapter.executeSkill(skill, project.path, args);
  return { success: result.success, data: result };
}

/**
 * Dispatch a goal to a registered project: generate the briefing pack, assemble
 * the prompt, persist a StoredGoal, then execute it via the gstack adapter and
 * record the outcome on the goal.
 */
export async function dispatchGoal(
  projectName: string,
  goal: string,
): Promise<
  GstackProxyResult<{
    goal: StoredGoal;
    execution: GoalExecutionResult;
  }>
> {
  const project = getProject(projectName);
  if (!project) {
    return {
      success: false,
      error: `Project '${projectName}' not found in registry (~/.vela/projects.json)`,
    };
  }

  const stored = createGoal(projectName, goal);
  updateGoal(stored.id, { status: "executing" });

  const pack = generateBriefingPack(project);
  const prompt = assembleDispatchPrompt(pack, goal);

  const adapter = getAdapter();
  const execution = await adapter.executeGoal(
    stored.id,
    project.path,
    goal,
    prompt,
  );

  const finalGoal = updateGoal(stored.id, {
    status: execution.success ? "done" : "failed",
    result: {
      goalId: stored.id,
      success: execution.success,
      summary: execution.summary,
      touchedFiles: [],
      decisionsMade: [],
      followUps: [],
      crossProjectImplications: [],
    },
  });

  return {
    success: execution.success,
    data: {
      goal: finalGoal ?? stored,
      execution,
    },
  };
}

/** List tracked goals, optionally filtered by project name. */
export function listProxyGoals(
  projectName?: string,
): GstackProxyResult<StoredGoal[]> {
  const goals = listGoals(projectName);
  return { success: true, data: goals };
}
