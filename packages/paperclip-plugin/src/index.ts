// Vela Union Paperclip Plugin
// Phase 1: Event handlers + data providers + briefing pack generator

export { plugin } from "./plugin.js";
export { default as plugin_default } from "./plugin.js";
export { default as manifest } from "./manifest.js";
export { PLUGIN_ID, PLUGIN_VERSION } from "./manifest.js";
export { generateBriefingPack } from "./briefing.js";
export { assembleDispatchPrompt } from "./dispatch.js";
