#!/usr/bin/env bash
# Vela Union — install post-commit hook for auto graph refresh
#
# Usage: ./scripts/install-git-hook.sh <project-path>
#
# Installs a post-commit hook that triggers graph.refresh via the MCP gateway
# whenever a commit is made. The hook is fire-and-forget — it does not block
# the commit, and failures are silenced to /dev/null.

set -euo pipefail

PROJECT_PATH="${1:-}"
if [[ -z "$PROJECT_PATH" ]]; then
  echo "Usage: $0 <project-path>" >&2
  echo "  Installs a post-commit git hook that refreshes the Vela Union" >&2
  echo "  knowledge graph for the project after each commit." >&2
  exit 1
fi

if [[ ! -d "$PROJECT_PATH" ]]; then
  echo "Error: $PROJECT_PATH is not a directory" >&2
  exit 1
fi

PROJECT_PATH="$(cd "$PROJECT_PATH" && pwd)"
GIT_DIR="$PROJECT_PATH/.git"

if [[ ! -d "$GIT_DIR" ]]; then
  echo "Error: $PROJECT_PATH is not a git repository (no .git directory)" >&2
  exit 1
fi

HOOKS_DIR="$GIT_DIR/hooks"
HOOK_FILE="$HOOKS_DIR/post-commit"
GATEWAY_PATH="/Users/jin/projects/vela-union/packages/mcp-gateway/dist/server.js"
PROJECT_NAME="$(basename "$PROJECT_PATH")"

mkdir -p "$HOOKS_DIR"

# Backup existing hook if present and not already a Vela hook.
if [[ -f "$HOOK_FILE" ]]; then
  if grep -q "VELA_UNION_HOOK" "$HOOK_FILE" 2>/dev/null; then
    echo "Vela Union hook already installed at $HOOK_FILE"
    exit 0
  fi
  BACKUP="$HOOK_FILE.bak.$(date +%s)"
  cp "$HOOK_FILE" "$BACKUP"
  echo "Existing hook backed up to $BACKUP"
fi

cat > "$HOOK_FILE" <<HOOK_EOF
#!/usr/bin/env bash
# VELA_UNION_HOOK — auto-trigger graph.refresh on commit
# Installed by: vela-union/scripts/install-git-hook.sh
GATEWAY="$GATEWAY_PATH"
PROJECT_NAME="$PROJECT_NAME"
PROJECT_PATH="$PROJECT_PATH"

if [[ ! -f "\$GATEWAY" ]]; then
  exit 0
fi

# Fire-and-forget: spawn the gateway, send init + tools/call, detach.
(
  {
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"vela-git-hook","version":"0.1.0"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
    printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"graph.refresh","arguments":{"projectName":"'"\$PROJECT_NAME"'","projectPath":"'"\$PROJECT_PATH"'"}}}'
  } | node "\$GATEWAY" >/dev/null 2>&1
) &
disown 2>/dev/null || true

exit 0
HOOK_EOF

chmod +x "$HOOK_FILE"
echo "Installed Vela Union post-commit hook at $HOOK_FILE"
echo "  Project: $PROJECT_NAME"
echo "  Gateway: $GATEWAY_PATH"
