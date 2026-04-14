// Plugin manifest for Vela Union Paperclip plugin

import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "vela-union";
export const PLUGIN_VERSION = "0.2.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Vela Union",
  description: "Agent orchestration platform — briefing packs, project registry, goal dispatch and execution for multi-project management.",
  author: "Vela Union",
  categories: ["automation"],
  capabilities: [
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "projects.read",
    "agents.read",
    "agent.tools.register",
    "ui.page.register",
    "ui.sidebar.register",
    "ui.detailTab.register",
  ],
  entrypoints: {
    worker: "./dist/plugin.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "page" as const,
        id: "graphify-viz",
        displayName: "Knowledge Graph",
        exportName: "GraphifyPage",
        routePath: "graph-viz",
      },
      {
        type: "detailTab" as const,
        id: "vela-subsystem-status",
        displayName: "Vela Status",
        exportName: "VelaStatusTab",
        entityTypes: ["project"],
      },
    ],
    launchers: [
      {
        id: "graphify-sidebar",
        displayName: "Knowledge Graph",
        placementZone: "sidebar" as const,
        action: {
          type: "navigate" as const,
          target: "graph-viz",
        },
      },
    ],
  },
  tools: [
    {
      name: "dispatch-goal",
      displayName: "Dispatch Goal",
      description: "Generate a briefing pack for a project and assemble a structured prompt for Claude Code.",
      parametersSchema: {
        type: "object",
        properties: {
          projectName: { type: "string", description: "Name of the registered project" },
          goal: { type: "string", description: "Goal description for the agent" },
        },
        required: ["projectName", "goal"],
      },
    },
    {
      name: "execute-goal",
      displayName: "Execute Goal",
      description: "Generate a briefing pack, assemble a prompt, and execute the goal via Claude Code CLI.",
      parametersSchema: {
        type: "object",
        properties: {
          projectName: { type: "string", description: "Name of the registered project" },
          goal: { type: "string", description: "Goal description for the agent" },
          dryRun: { type: "boolean", description: "If true, show what would be sent without executing (default: false)" },
        },
        required: ["projectName", "goal"],
      },
    },
    {
      name: "project-status",
      displayName: "Project Status",
      description: "List all registered projects and their current status.",
      parametersSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "goal-status",
      displayName: "Goal Status",
      description: "List tracked goals, optionally filtered by project.",
      parametersSchema: {
        type: "object",
        properties: {
          projectName: { type: "string", description: "Filter by project name (optional)" },
        },
      },
    },
    {
      name: "register-project",
      displayName: "Register Project",
      description: "Register a local project directory so agents can work on it. Required once per project before dispatching goals.",
      parametersSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Project name (e.g., 'my-app')" },
          path: { type: "string", description: "Absolute path to the local project directory (e.g., '/Users/jin/projects/my-app')" },
          type: { type: "string", enum: ["personal", "company", "experimental"], description: "Project type (default: personal)" },
        },
        required: ["name", "path"],
      },
    },
    {
      name: "assign-agent-project",
      displayName: "Assign Agent to Project",
      description: "Map an agent to a registered project so it auto-dispatches work when woken.",
      parametersSchema: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "Agent UUID" },
          projectName: { type: "string", description: "Name of the registered project" },
        },
        required: ["agentId", "projectName"],
      },
    },
  ],
};

export default manifest;
