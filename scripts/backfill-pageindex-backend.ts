#!/usr/bin/env tsx
// scripts/backfill-pageindex-backend.ts
//
// One-shot backfill: add `backend` field to pre-VELA-25 pageindex records
// that were written before the backend field was introduced.
//
// Inference rules (deterministic, confirmed by prefix count):
//   docId starts with "pi-"    → backend = "vectify-cloud"
//   docId starts with "local-" → backend = "local-claude-cli"
//
// Idempotent: records already having `backend` set are skipped.
// Records with a docId that does not match either prefix are reported as
// "ambiguous" and skipped — never guessed.
//
// Files patched per project:
//   ~/.vela/pageindex/<project>/index.json   (CloudIndexEntry map)
//   ~/.vela/pageindex/<project>/status.json  (CloudStatusFile.docs map)
//
// Usage:
//   npx tsx scripts/backfill-pageindex-backend.ts
//   npx tsx scripts/backfill-pageindex-backend.ts --dry-run

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STORAGE_ROOT = join(homedir(), ".vela", "pageindex");
const DRY_RUN = process.argv.includes("--dry-run");

// ---------------------------------------------------------------------------
// Types (minimal — only what we need for the backfill)
// ---------------------------------------------------------------------------

type BackendValue = "vectify-cloud" | "local-claude-cli";

interface CloudIndexEntry {
  originalPath: string;
  md5: string;
  docId: string;
  treePath: string;
  indexedAt: string;
  converted: boolean;
  convertedPdfPath?: string;
  backend?: BackendValue;
}

interface CloudStatusDocEntry {
  docId: string | null;
  state: "pending" | "indexing" | "indexed" | "failed";
  lastAttemptAt: string | null;
  error: string | null;
  backend?: BackendValue;
}

interface CloudStatusFile {
  projectName: string;
  updatedAt: string;
  docs: Record<string, CloudStatusDocEntry>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Atomic write: tmp + rename — same pattern as pageindex.ts atomicWrite(). */
function atomicWrite(targetPath: string, body: string): void {
  const dir = dirname(targetPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(targetPath)}.tmp-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, body, "utf-8");
  renameSync(tmp, targetPath);
}

/**
 * Infer backend from docId prefix.
 * Returns null if the prefix is ambiguous (neither "pi-" nor "local-").
 */
function inferBackend(docId: string | null): BackendValue | null {
  if (!docId) return null;
  if (docId.startsWith("pi-")) return "vectify-cloud";
  if (docId.startsWith("local-")) return "local-claude-cli";
  return null;
}

// ---------------------------------------------------------------------------
// Per-project backfill
// ---------------------------------------------------------------------------

interface ProjectStats {
  project: string;
  indexScanned: number;
  indexUpdated: number;
  indexSkippedAlreadySet: number;
  indexSkippedAmbiguous: number;
  statusScanned: number;
  statusUpdated: number;
  statusSkippedAlreadySet: number;
  statusSkippedAmbiguous: number;
}

function backfillProject(project: string, projectDir: string): ProjectStats {
  const stats: ProjectStats = {
    project,
    indexScanned: 0,
    indexUpdated: 0,
    indexSkippedAlreadySet: 0,
    indexSkippedAmbiguous: 0,
    statusScanned: 0,
    statusUpdated: 0,
    statusSkippedAlreadySet: 0,
    statusSkippedAmbiguous: 0,
  };

  // ── index.json ──────────────────────────────────────────────────────────

  const indexPath = join(projectDir, "index.json");
  if (existsSync(indexPath)) {
    let index: Record<string, CloudIndexEntry>;
    try {
      index = JSON.parse(readFileSync(indexPath, "utf-8")) as Record<
        string,
        CloudIndexEntry
      >;
    } catch {
      console.warn(`  [WARN] Could not parse ${indexPath}, skipping`);
      index = {};
    }

    let indexDirty = false;
    for (const [key, entry] of Object.entries(index)) {
      stats.indexScanned++;
      if (entry.backend !== undefined) {
        stats.indexSkippedAlreadySet++;
        continue;
      }
      const inferred = inferBackend(entry.docId);
      if (inferred === null) {
        stats.indexSkippedAmbiguous++;
        console.warn(
          `  [SKIP] index ambiguous docId="${entry.docId}" key="${key}"`,
        );
        continue;
      }
      index[key] = { ...entry, backend: inferred };
      stats.indexUpdated++;
      indexDirty = true;
    }

    if (indexDirty) {
      if (!DRY_RUN) {
        atomicWrite(indexPath, JSON.stringify(index, null, 2) + "\n");
      }
      console.log(
        `  ${DRY_RUN ? "[DRY] " : ""}index.json: updated ${stats.indexUpdated} record(s)`,
      );
    } else {
      console.log(`  index.json: no changes needed`);
    }
  }

  // ── status.json ─────────────────────────────────────────────────────────

  const statusPath = join(projectDir, "status.json");
  if (existsSync(statusPath)) {
    let statusFile: CloudStatusFile;
    try {
      statusFile = JSON.parse(readFileSync(statusPath, "utf-8")) as CloudStatusFile;
    } catch {
      console.warn(`  [WARN] Could not parse ${statusPath}, skipping`);
      return stats;
    }

    let statusDirty = false;
    for (const [key, entry] of Object.entries(statusFile.docs)) {
      stats.statusScanned++;
      if (entry.backend !== undefined) {
        stats.statusSkippedAlreadySet++;
        continue;
      }
      const inferred = inferBackend(entry.docId);
      if (inferred === null) {
        // null docId (pending/indexing state) or truly ambiguous prefix
        if (entry.docId !== null) {
          stats.statusSkippedAmbiguous++;
          console.warn(
            `  [SKIP] status ambiguous docId="${entry.docId}" key="${key}"`,
          );
        }
        // null docId records silently skipped — no backend can be inferred
        continue;
      }
      statusFile.docs[key] = { ...entry, backend: inferred };
      stats.statusUpdated++;
      statusDirty = true;
    }

    if (statusDirty) {
      if (!DRY_RUN) {
        statusFile.updatedAt = new Date().toISOString();
        atomicWrite(statusPath, JSON.stringify(statusFile, null, 2) + "\n");
      }
      console.log(
        `  ${DRY_RUN ? "[DRY] " : ""}status.json: updated ${stats.statusUpdated} record(s)`,
      );
    } else {
      console.log(`  status.json: no changes needed`);
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  if (DRY_RUN) {
    console.log("=== DRY RUN — no files will be written ===\n");
  }

  if (!existsSync(STORAGE_ROOT)) {
    console.log(`No pageindex storage found at ${STORAGE_ROOT}. Nothing to backfill.`);
    process.exit(0);
  }

  // Enumerate project directories (each subdirectory is a project)
  const entries = readdirSync(STORAGE_ROOT);
  const projects = entries.filter((name) => {
    const fullPath = join(STORAGE_ROOT, name);
    return statSync(fullPath).isDirectory();
  });

  if (projects.length === 0) {
    console.log("No project directories found. Nothing to backfill.");
    process.exit(0);
  }

  const allStats: ProjectStats[] = [];

  for (const project of projects) {
    const projectDir = join(STORAGE_ROOT, project);
    console.log(`\nProject: ${project}`);
    const stats = backfillProject(project, projectDir);
    allStats.push(stats);
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  const totalIndexScanned = allStats.reduce((s, p) => s + p.indexScanned, 0);
  const totalIndexUpdated = allStats.reduce((s, p) => s + p.indexUpdated, 0);
  const totalIndexAmbiguous = allStats.reduce(
    (s, p) => s + p.indexSkippedAmbiguous,
    0,
  );
  const totalStatusScanned = allStats.reduce((s, p) => s + p.statusScanned, 0);
  const totalStatusUpdated = allStats.reduce((s, p) => s + p.statusUpdated, 0);
  const totalStatusAmbiguous = allStats.reduce(
    (s, p) => s + p.statusSkippedAmbiguous,
    0,
  );

  console.log("\n=== Backfill Summary ===");
  console.log(`Projects processed : ${allStats.length}`);
  console.log(`index.json         : scanned=${totalIndexScanned}, updated=${totalIndexUpdated}, ambiguous_skipped=${totalIndexAmbiguous}`);
  console.log(`status.json        : scanned=${totalStatusScanned}, updated=${totalStatusUpdated}, ambiguous_skipped=${totalStatusAmbiguous}`);

  if (totalIndexAmbiguous > 0 || totalStatusAmbiguous > 0) {
    console.warn(
      "\n[WARN] Some records had unrecognized docId prefixes and were skipped.",
    );
    console.warn(
      "       Review the SKIP lines above and add inference rules if needed.",
    );
  }

  if (DRY_RUN) {
    console.log("\n(Dry run — no files changed)");
  }

  process.exit(0);
}

main();
