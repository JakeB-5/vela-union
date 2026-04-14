// Dispatch prompt assembler
// Assembles structured prompts from briefing packs for Claude Code consumption

import type { BriefingPack } from "@vela-union/shared";

/**
 * Assemble a structured prompt from a briefing pack and goal description.
 * This is the output that would be fed to Claude Code in Phase 2.
 */
export function assembleDispatchPrompt(pack: BriefingPack, goal: string): string {
  const sections: string[] = [];

  sections.push(`# Goal\n\n${goal}`);
  sections.push(`# Project: ${pack.project.name}\n\nPath: ${pack.project.path}\nType: ${pack.project.type}`);

  if (pack.claudeMd) {
    sections.push(`# CLAUDE.md\n\n${pack.claudeMd}`);
  }

  if (pack.readme) {
    // Truncate long READMEs
    const truncated = pack.readme.length > 3000 ? pack.readme.slice(0, 3000) + "\n...(truncated)" : pack.readme;
    sections.push(`# README\n\n${truncated}`);
  }

  sections.push(`# Directory Structure\n\n\`\`\`\n${pack.directoryTree}\n\`\`\``);

  if (pack.recentCommits.length > 0) {
    sections.push(`# Recent Commits (last ${pack.recentCommits.length})\n\n${pack.recentCommits.slice(0, 20).join("\n")}`);
  }

  if (pack.highChurnFiles.length > 0) {
    sections.push(`# High-Churn Files\n\n${pack.highChurnFiles.join("\n")}`);
  }

  if (pack.pinnedFiles.length > 0) {
    sections.push(`# Pinned Files\n\n${pack.pinnedFiles.join("\n")}`);
  }

  if (pack.gbrainContext && pack.gbrainContext.length > 0) {
    const entries = pack.gbrainContext
      .map((r) => `### ${r.title} _(${r.type}, score: ${r.score.toFixed(3)})_\n\n${r.excerpt}`)
      .join("\n\n");
    sections.push(`# Knowledge Context (gbrain)\n\n${entries}`);
  }

  return sections.join("\n\n---\n\n");
}
