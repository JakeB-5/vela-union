// Vela Union gstack Adapter
// Phase 2: Paperclip <-> gstack integration

export {
  createGstackAdapter,
  checkClaudeAvailability,
  GSTACK_SKILLS,
} from "./adapter.js";

export type {
  GstackAdapterConfig,
  GstackSkill,
  SkillExecutionResult,
  GoalExecutionResult,
  GstackAdapter,
  SkillCompleteHook,
  GoalCompleteHook,
} from "./adapter.js";
