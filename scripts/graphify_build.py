#!/usr/bin/env python3
"""Build a graphify knowledge graph (AST-only) for a project.

Usage:
  python graphify_build.py <project_path> <output_dir> [plugin_graphs_dir]

Outputs graph.json and graph.html (Cosmos WebGL renderer) to <output_dir>/.
AST-only mode — no LLM key needed. Uses graphify.extract + build_from_json +
cluster + to_json from the graphify Python package.

If plugin_graphs_dir is provided, the generated graph.html is copied there as
<project_name>.html and manifest.json is regenerated from all *.html files.
"""
from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path

TEMPLATE_PATH = Path(__file__).parent / "graphify_html_template.html"


def _update_manifest(graphs_dir: Path) -> None:
    """Regenerate manifest.json listing all *.html names (without extension)."""
    names = sorted(p.stem for p in graphs_dir.glob("*.html"))
    (graphs_dir / "manifest.json").write_text(json.dumps(names), encoding="utf-8")
    print(f"[graphify] manifest.json updated: {names}", flush=True)


def _generate_cosmos_html(graph_json_path: Path, html_path: Path, title: str, node_count: int, edge_count: int, community_count: int) -> None:
    """Generate a self-contained Cosmos WebGL HTML visualization from graph.json."""
    template = TEMPLATE_PATH.read_text(encoding="utf-8")
    graph_data = graph_json_path.read_text(encoding="utf-8")
    stats_str = f"{node_count} nodes &middot; {edge_count} edges &middot; {community_count} communities"

    html = template.replace("{{GRAPH_DATA}}", graph_data)
    html = html.replace("{{TITLE}}", title)
    html = html.replace("{{STATS}}", stats_str)
    html_path.write_text(html, encoding="utf-8")


def build(project_path: Path, output_dir: Path, plugin_graphs_dir: Path | None = None) -> dict:
    from graphify.extract import extract, collect_files
    from graphify.build import build_from_json
    from graphify.cluster import cluster
    from graphify.export import to_json

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

    # Generate Cosmos WebGL HTML visualization (no node-count limit).
    html_generated = False
    html_state = "html_failed"
    try:
        project_name = output_dir.name
        _generate_cosmos_html(
            graph_path, html_path, project_name,
            G.number_of_nodes(), G.number_of_edges(), len(communities),
        )
        print(f"[graphify] Cosmos HTML visualization written to {html_path}", flush=True)
        html_generated = True
        html_state = "html_generated"
    except Exception as exc:
        print(f"[graphify] Warning: HTML generation failed: {exc}", flush=True)
        html_state = "html_failed"

    # Persist html_state into status.json so the UI can surface it.
    status_path = output_dir / "status.json"
    status_data: dict = {}
    if status_path.exists():
        try:
            status_data = json.loads(status_path.read_text(encoding="utf-8"))
        except Exception:
            pass
    status_data["html_state"] = html_state
    status_path.write_text(json.dumps(status_data, indent=2), encoding="utf-8")

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
