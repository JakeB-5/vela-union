#!/usr/bin/env bash
# Backfill: regenerate all graph.html files using the Cosmos WebGL renderer.
# Deletes existing graph.html + status.json for each project, then re-runs
# graphify_build.py so every project gets a fresh Cosmos-based visualization.
#
# Usage: bash scripts/backfill-cosmos.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GRAPHIFY_ROOT="$HOME/.vela/graphify"
PYTHON="$REPO_ROOT/.venv/bin/python3"
SCRIPT="$REPO_ROOT/scripts/graphify_build.py"
PLUGIN_GRAPHS_DIR="$REPO_ROOT/packages/paperclip-plugin/dist/ui/graphs"

if [[ ! -x "$PYTHON" ]]; then
  echo "[backfill] Python venv not found at $PYTHON" >&2
  exit 1
fi

if [[ ! -d "$GRAPHIFY_ROOT" ]]; then
  echo "[backfill] No graphify data at $GRAPHIFY_ROOT" >&2
  exit 0
fi

count=0
for project_dir in "$GRAPHIFY_ROOT"/*/; do
  project_name="$(basename "$project_dir")"
  graph_json="$project_dir/graph.json"

  if [[ ! -f "$graph_json" ]]; then
    echo "[backfill] Skipping $project_name — no graph.json"
    continue
  fi

  echo "[backfill] Regenerating HTML for $project_name ..."

  # Remove old HTML and status so the build script regenerates them
  rm -f "$project_dir/graph.html"
  rm -f "$project_dir/status.json"

  # Re-run build — it reads existing graph.json? No, it rebuilds from source.
  # Instead, just generate the HTML from existing graph.json using Python.
  "$PYTHON" -c "
import json, sys
sys.path.insert(0, '$REPO_ROOT/refs/graphify')
sys.path.insert(0, '$REPO_ROOT/scripts')
from pathlib import Path
from graphify_build import _generate_cosmos_html

graph_path = Path('$graph_json')
html_path = Path('${project_dir}graph.html')
data = json.loads(graph_path.read_text())
nodes = data.get('nodes', [])
edges = data.get('links', data.get('edges', []))
communities = set()
for n in nodes:
    communities.add(n.get('community', 0))

_generate_cosmos_html(graph_path, html_path, '$project_name', len(nodes), len(edges), len(communities))

# Update status.json
status_path = Path('${project_dir}status.json')
status = {}
if status_path.exists():
    try: status = json.loads(status_path.read_text())
    except: pass
status['html_state'] = 'html_generated'
status_path.write_text(json.dumps(status, indent=2))
print(f'[backfill] {html_path} written ({len(nodes)} nodes)')
" || echo "[backfill] FAILED for $project_name"

  # Copy to plugin graphs dir
  if [[ -f "${project_dir}graph.html" ]]; then
    mkdir -p "$PLUGIN_GRAPHS_DIR"
    cp "${project_dir}graph.html" "$PLUGIN_GRAPHS_DIR/${project_name}.html"
    count=$((count + 1))
  fi
done

# Regenerate manifest.json
if [[ -d "$PLUGIN_GRAPHS_DIR" ]]; then
  "$PYTHON" -c "
import json
from pathlib import Path
d = Path('$PLUGIN_GRAPHS_DIR')
names = sorted(p.stem for p in d.glob('*.html'))
(d / 'manifest.json').write_text(json.dumps(names))
print(f'[backfill] manifest.json updated: {names}')
"
fi

echo "[backfill] Done. Regenerated $count project(s)."
