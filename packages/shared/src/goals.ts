// Goal Tracking — JSON-file-based goal store at ~/.vela/goals.json

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { AgentGoal, DispatchResult } from "./index.js";

const GOALS_DIR = join(homedir(), ".vela");
const GOALS_PATH = join(GOALS_DIR, "goals.json");

/** Stored goal with optional execution result */
export interface StoredGoal extends AgentGoal {
  result?: DispatchResult;
}

function ensureDir(): void {
  if (!existsSync(GOALS_DIR)) {
    mkdirSync(GOALS_DIR, { recursive: true });
  }
}

function readGoals(): StoredGoal[] {
  ensureDir();
  if (!existsSync(GOALS_PATH)) return [];
  try {
    const raw = readFileSync(GOALS_PATH, "utf-8");
    return JSON.parse(raw) as StoredGoal[];
  } catch {
    return [];
  }
}

function writeGoals(goals: StoredGoal[]): void {
  ensureDir();
  writeFileSync(GOALS_PATH, JSON.stringify(goals, null, 2), "utf-8");
}

/** Create a new goal and persist it */
export function createGoal(
  projectName: string,
  description: string,
): StoredGoal {
  const now = new Date().toISOString();
  const goal: StoredGoal = {
    id: randomUUID(),
    projectName,
    description,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  const goals = readGoals();
  goals.push(goal);
  writeGoals(goals);
  return goal;
}

/** Update an existing goal's status and/or result */
export function updateGoal(
  goalId: string,
  update: Partial<Pick<StoredGoal, "status" | "result">>,
): StoredGoal | undefined {
  const goals = readGoals();
  const idx = goals.findIndex((g) => g.id === goalId);
  if (idx < 0) return undefined;

  const goal = goals[idx]!;
  if (update.status !== undefined) {
    goal.status = update.status;
  }
  if (update.result !== undefined) {
    goal.result = update.result;
  }
  goal.updatedAt = new Date().toISOString();
  goals[idx] = goal;
  writeGoals(goals);
  return goal;
}

/** List all goals, optionally filtered by project name */
export function listGoals(projectName?: string): StoredGoal[] {
  const goals = readGoals();
  if (projectName) {
    return goals.filter((g) => g.projectName === projectName);
  }
  return goals;
}

/** Get a single goal by ID */
export function getGoal(goalId: string): StoredGoal | undefined {
  return readGoals().find((g) => g.id === goalId);
}

export { GOALS_PATH };
