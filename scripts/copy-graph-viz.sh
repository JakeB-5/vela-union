#!/usr/bin/env bash
# Copy pre-generated Graphify HTML files to the plugin's dist/ui/graphs/ directory
# and generate a manifest.json listing available graphs.
# Run from the vela-union repo root.
set -e

DEST="packages/paperclip-plugin/dist/ui/graphs"
mkdir -p "$DEST"

copied=0
for html in graphify-out/*.html; do
  [ -f "$html" ] || continue
  cp "$html" "$DEST/"
  echo "copied: $(basename "$html")"
  copied=$((copied + 1))
done

# Generate manifest.json listing available graph names (without .html extension)
find "$DEST" -maxdepth 1 -name "*.html" | xargs -I{} basename {} .html | sort | python3 -c "
import sys, json
names = [l.strip() for l in sys.stdin if l.strip()]
print(json.dumps(names))
" > "$DEST/manifest.json"

echo "manifest.json: $(cat "$DEST/manifest.json")"
echo "copy-graph-viz: $copied file(s) copied"
