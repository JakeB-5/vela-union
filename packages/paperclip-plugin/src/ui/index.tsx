// All UI components are inlined in this single file because the Paperclip plugin
// runtime cannot resolve relative ESM imports in tsc-compiled output. (VELA-52)
import type { PluginPageProps, PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";
import { usePluginData, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { useState, useEffect, useCallback } from "react";

const ACTION_CONFIG: Record<string, { actionKey: string; label: string; activeLabel: string }> = {
  graphify: { actionKey: "rebuild-graphify", label: "Rebuild", activeLabel: "Rebuilding…" },
  gbrain: { actionKey: "reimport-gbrain", label: "Import & Embed", activeLabel: "Importing…" },
  pageindex: { actionKey: "reindex-pageindex", label: "Index All", activeLabel: "Indexing…" },
};

function ActionButton({ system, running, onAction }: { system: string; running: boolean; onAction: () => void }) {
  const config = ACTION_CONFIG[system];
  if (!config) return null;
  return (
    <button
      onClick={onAction}
      disabled={running}
      style={{
        padding: "3px 10px",
        fontSize: 11,
        border: "1px solid var(--color-border, #333)",
        borderRadius: 4,
        background: running ? "var(--color-surface, #1a1a1a)" : "transparent",
        color: running ? "var(--color-text-secondary, #9ca3af)" : "#3b82f6",
        cursor: running ? "default" : "pointer",
        fontWeight: 500,
      }}
    >
      {running ? config.activeLabel : config.label}
    </button>
  );
}

// ============================================================
// GraphifyPage — Knowledge Graph visualization
// ============================================================

const GRAPHS_BASE = "/_plugins/vela-union/ui/graphs";

export function GraphifyPage({ context }: PluginPageProps) {
  const [projects, setProjects] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${GRAPHS_BASE}/manifest.json`)
      .then((r) => r.json())
      .then((list: string[]) => setProjects(list))
      .catch(() => setProjects([]));
  }, []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "calc(100vh - 48px)",
        minHeight: 0,
      }}
    >
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid #e5e7eb",
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexShrink: 0,
        }}
      >
        <strong>Knowledge Graph</strong>
        <select
          value={selected ?? ""}
          onChange={(e) => setSelected(e.target.value || null)}
          style={{ marginLeft: 8, padding: "4px 8px" }}
        >
          <option value="">Select project...</option>
          {projects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        {/* Suppress unused variable warning for context — available for future use */}
        <span style={{ display: "none" }}>{context.companyId}</span>
      </div>
      {selected ? (
        <iframe
          src={`${GRAPHS_BASE}/${selected}.html`}
          style={{
            flex: 1,
            border: "none",
            width: "100%",
            minHeight: 0,
          }}
          title={`Graph: ${selected}`}
        />
      ) : (
        <div style={{ padding: 24, color: "#6b7280" }}>
          Select a project to view its Graphify knowledge graph.
          {projects.length === 0 && (
            <p style={{ marginTop: 8 }}>
              No graph HTML files generated yet.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// VelaStatusTab — Subsystem status detail tab (VELA-49)
// ============================================================

interface SubsystemStatus {
  system: "graphify" | "gbrain" | "pageindex";
  initialized: boolean;
  label: string;
  stats: Record<string, number | string | null>;
  lastModified: string | null;
  dataPath: string;
}

const SYSTEM_LABELS: Record<string, { title: string; icon: string }> = {
  graphify: { title: "Graphify", icon: "\u{1F578}\uFE0F" },
  gbrain: { title: "gbrain", icon: "\u{1F9E0}" },
  pageindex: { title: "PageIndex", icon: "\u{1F4C4}" },
};

function StatusBadge({ initialized, label }: { initialized: boolean; label: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 12,
        fontWeight: 500,
        background: initialized ? "rgba(34, 197, 94, 0.15)" : "rgba(251, 191, 36, 0.15)",
        color: initialized ? "#4ade80" : "#fbbf24",
      }}
    >
      {label}
    </span>
  );
}

function StatRow({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
      <span style={{ color: "var(--color-text-secondary, #9ca3af)", fontSize: 13 }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 500 }}>{value ?? "\u2014"}</span>
    </div>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return "\u2014";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

const STAT_LABELS: Record<string, string> = {
  nodeCount: "Nodes",
  edgeCount: "Edges",
  pageCount: "Pages",
  chunkCount: "Chunks",
  embeddedCount: "Embedded",
  documentCount: "Documents",
  htmlState: "HTML Viz",
};

const HTML_STATE_DISPLAY: Record<string, { label: string; color: string }> = {
  html_generated: { label: "Available", color: "#4ade80" },
  html_skipped_too_large: { label: "Skipped (too many nodes)", color: "#fbbf24" },
  html_failed: { label: "Failed", color: "#f87171" },
};

function SubsystemCard({ status, running, onAction }: { status: SubsystemStatus; running: boolean; onAction: () => void }) {
  const meta = SYSTEM_LABELS[status.system] ?? { title: status.system, icon: "" };
  return (
    <div
      style={{
        border: "1px solid var(--color-border, #333)",
        borderRadius: 8,
        padding: 16,
        marginBottom: 12,
        background: "var(--color-surface, #1a1a1a)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <strong style={{ fontSize: 14 }}>
          {meta.icon} {meta.title}
        </strong>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ActionButton system={status.system} running={running} onAction={onAction} />
          <StatusBadge initialized={status.initialized} label={status.label} />
        </div>
      </div>
      {Object.entries(status.stats).map(([key, val]) => {
        if (key === "htmlState" && typeof val === "string" && HTML_STATE_DISPLAY[val]) {
          const display = HTML_STATE_DISPLAY[val];
          return (
            <div key={key} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
              <span style={{ color: "var(--color-text-secondary, #9ca3af)", fontSize: 13 }}>
                {STAT_LABELS[key]}
              </span>
              <span style={{ fontSize: 13, fontWeight: 500, color: display.color }}>
                {display.label}
              </span>
            </div>
          );
        }
        if (key === "htmlState") return null;
        return <StatRow key={key} label={STAT_LABELS[key] ?? key} value={val} />;
      })}
      <StatRow label="Last modified" value={formatDate(status.lastModified)} />
      <div style={{ marginTop: 4, fontSize: 11, color: "var(--color-text-tertiary, #6b7280)", wordBreak: "break-all" }}>
        {status.dataPath}
      </div>
    </div>
  );
}

export function VelaStatusTab({ context }: PluginDetailTabProps) {
  const entityId = context.entityId;
  const { data, loading, error, refresh } = usePluginData<SubsystemStatus[]>(
    "vela-subsystem-status",
    { entityId, companyId: context.companyId },
  );
  const [refreshing, setRefreshing] = useState(false);
  const [runningActions, setRunningActions] = useState<Record<string, boolean>>({});

  const rebuildGraphify = usePluginAction("rebuild-graphify");
  const reimportGbrain = usePluginAction("reimport-gbrain");
  const reindexPageindex = usePluginAction("reindex-pageindex");

  const actionMap: Record<string, (params?: Record<string, unknown>) => Promise<unknown>> = {
    graphify: rebuildGraphify,
    gbrain: reimportGbrain,
    pageindex: reindexPageindex,
  };

  const handleAction = useCallback(
    async (system: string) => {
      const fn = actionMap[system];
      if (!fn) return;
      setRunningActions((prev) => ({ ...prev, [system]: true }));
      try {
        await fn({ entityId, companyId: context.companyId });
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        refresh();
        setRunningActions((prev) => ({ ...prev, [system]: false }));
      }, 2000);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entityId, context.companyId, refresh],
  );

  const handleRefresh = () => {
    setRefreshing(true);
    refresh();
    setTimeout(() => setRefreshing(false), 600);
  };

  if (loading) {
    return (
      <div style={{ padding: 24, color: "#6b7280" }}>
        Loading Vela subsystem status...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 24, color: "#dc2626" }}>
        <p style={{ fontWeight: 500 }}>Failed to load status</p>
        <p style={{ fontSize: 13, marginTop: 4 }}>{error.message}</p>
      </div>
    );
  }

  const statuses = Array.isArray(data) ? data : null;
  const dataError = data && !Array.isArray(data) && typeof data === "object"
    ? (data as Record<string, unknown>)["error"]
    : null;

  if (dataError) {
    return (
      <div style={{ padding: 24, color: "#fbbf24", background: "rgba(251, 191, 36, 0.1)", borderRadius: 8 }}>
        <p style={{ fontWeight: 500 }}>Project not linked</p>
        <p style={{ fontSize: 13, marginTop: 4 }}>
          This Paperclip project is not linked to a Vela registry entry.
          Register the project with <code>vela register</code> first.
        </p>
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Vela Subsystem Status</h3>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          style={{
            padding: "4px 12px",
            fontSize: 12,
            border: "1px solid var(--color-border, #333)",
            borderRadius: 4,
            background: refreshing ? "var(--color-surface, #1a1a1a)" : "transparent",
            cursor: refreshing ? "default" : "pointer",
          }}
        >
          {refreshing ? "Refreshing..." : "Refresh"}
        </button>
      </div>
      {statuses && statuses.length > 0 ? (
        statuses.map((s) => (
          <SubsystemCard
            key={s.system}
            status={s}
            running={!!runningActions[s.system]}
            onAction={() => handleAction(s.system)}
          />
        ))
      ) : (
        <div style={{ color: "var(--color-text-secondary, #9ca3af)", fontSize: 13 }}>
          No subsystem data available for this project.
        </div>
      )}
    </div>
  );
}
