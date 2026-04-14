#!/usr/bin/env bash
# Register the Vela Union MCP gateway with Claude Code.
#
# Usage:
#   ./scripts/register-mcp.sh
#
# Prints the JSON snippet to add to ~/.claude/settings.json (or your project
# .claude/settings.json) and shows the resolved absolute server path. Does NOT
# modify any file — copy/paste the snippet yourself so you can merge it with
# any existing mcpServers entries.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_PATH="$REPO_ROOT/packages/mcp-gateway/dist/server.js"

cat <<EOF
=== Vela Union MCP Gateway — Claude Code registration helper ===

Repo root:  $REPO_ROOT
Server:     $SERVER_PATH

EOF

if [[ ! -f "$SERVER_PATH" ]]; then
  cat <<EOF
WARNING: $SERVER_PATH does not exist.

Build the gateway first:
  cd "$REPO_ROOT"
  npx tsc --build

EOF
fi

cat <<EOF
1) Open Claude Code's settings file:
     ~/.claude/settings.json
   (Or use a per-project .claude/settings.json — same shape.)

2) Add this server under "mcpServers" (merge with any existing entries):

{
  "mcpServers": {
    "vela-union": {
      "command": "node",
      "args": [
        "$SERVER_PATH"
      ]
    }
  }
}

3) Restart Claude Code so it re-reads settings.json. The gateway should
   appear with these tool namespaces:
     - doc.*    (PageIndex: index, get_structure, get_pages)
     - graph.*  (Graphify: build, query, get_neighbors, get_node, stats, refresh)
     - gstack.* (gstack adapter: execute_skill, dispatch_goal, list_goals, check_availability)
     - vela.*   (meta: list_projects)

4) Smoke test from a Claude Code session:
     /mcp           # should list 'vela-union'
     gstack.check_availability
     vela.list_projects
     graph.stats {"projectName": "sweditor-v2"}

EOF
