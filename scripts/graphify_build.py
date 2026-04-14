#!/usr/bin/env python3
"""Build a graphify knowledge graph (AST-only) for a project.

Usage:
  python graphify_build.py <project_path> <output_dir> [plugin_graphs_dir]

Outputs graph.json (and graph.html if node count is within the viz limit) to
<output_dir>/. AST-only mode — no LLM key needed. Uses graphify.extract +
build_from_json + cluster + to_json + to_html from the graphifyy Python package.

If plugin_graphs_dir is provided, the generated graph.html is copied there as
<project_name>.html and manifest.json is regenerated from all *.html files.
"""
from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path

# Maximum nodes graphify's to_html supports (mirrors graphify.export constant).
MAX_NODES_FOR_VIZ = 5_000


def _update_manifest(graphs_dir: Path) -> None:
    """Regenerate manifest.json listing all *.html names (without extension)."""
    names = sorted(p.stem for p in graphs_dir.glob("*.html"))
    (graphs_dir / "manifest.json").write_text(json.dumps(names), encoding="utf-8")
    print(f"[graphify] manifest.json updated: {names}", flush=True)


def build(project_path: Path, output_dir: Path, plugin_graphs_dir: Path | None = None) -> dict:
    from graphify.extract import extract, collect_files
    from graphify.build import build_from_json
    from graphify.cluster import cluster
    from graphify.export import to_json, to_html

    output_dir.mkdir(parents=True, exist_ok=True)
    graph_path = output_dir / "graph.json"
    html_path = output_dir / "graph.html"

    t0 = time.monotonic()

    code_files = collect_files(project_path)
    if not code_files:
        raise SystemExit(f"No code files found in {project_path}")

    print(f"[graphify] Extracting from {len(code_files)} files in {project_path}", flush=True)

    extraction = extract(code_files)

    G = build_from_json(extraction)
    print(
        f"[graphify] Built graph: {G.number_of_nodes()} nodes, "
        f"{G.number_of_edges()} edges",
        flush=True,
    )

    communities = cluster(G)
    print(f"[graphify] Clustered into {len(communities)} communities", flush=True)

    to_json(G, communities, str(graph_path))

    # Generate HTML visualization if graph is within the supported size limit.
    html_generated = False
    if G.number_of_nodes() <= MAX_NODES_FOR_VIZ:
        try:
            to_html(G, communities, str(html_path))
            print(f"[graphify] HTML visualization written to {html_path}", flush=True)
            html_generated = True
        except Exception as exc:
            print(f"[graphify] Warning: HTML generation skipped: {exc}", flush=True)
    else:
        print(
            f"[graphify] Warning: graph too large for HTML viz "
            f"({G.number_of_nodes()} > {MAX_NODES_FOR_VIZ}), skipping.",
            flush=True,
        )

    # Copy HTML to plugin graphs dir and update manifest.json if requested.
    if html_generated and plugin_graphs_dir is not None:
        plugin_graphs_dir = Path(plugin_graphs_dir)
        plugin_graphs_dir.mkdir(parents=True, exist_ok=True)
        project_name = output_dir.name
        dest_html = plugin_graphs_dir / f"{project_name}.html"
        shutil.copy2(html_path, dest_html)
        print(f"[graphify] Copied {html_path.name} → {dest_html}", flush=True)
        _update_manifest(plugin_graphs_dir)

    elapsed = time.monotonic() - t0

    stats = {
        "project_path": str(project_path),
        "graph_path": str(graph_path),
        "html_path": str(html_path) if html_generated else None,
        "files": len(code_files),
        "nodes": G.number_of_nodes(),
        "edges": G.number_of_edges(),
        "communities": len(communities),
        "elapsed_seconds": round(elapsed, 2),
    }

    print(f"[graphify] Done in {elapsed:.2f}s")
    print(json.dumps(stats, indent=2))
    return stats


def main() -> int:
    if len(sys.argv) < 3 or len(sys.argv) > 4:
        print("usage: graphify_build.py <project_path> <output_dir> [plugin_graphs_dir]", file=sys.stderr)
        return 2
    project_path = Path(sys.argv[1]).expanduser().resolve()
    output_dir = Path(sys.argv[2]).expanduser().resolve()
    plugin_graphs_dir = Path(sys.argv[3]).expanduser().resolve() if len(sys.argv) == 4 else None

    if not project_path.is_dir():
        print(f"error: project path is not a directory: {project_path}", file=sys.stderr)
        return 1

    try:
        build(project_path, output_dir, plugin_graphs_dir)
    except SystemExit as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
