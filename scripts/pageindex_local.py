#!/usr/bin/env python
# pageindex_local.py — local (zero-cost) PageIndex runner.
#
# Monkeypatches the open-source PageIndex library (refs/PageIndex) so every
# LLM call is routed through `claude -p` via claude_cli_llm.py. Accepts a
# markdown or PDF input, emits a single JSON tree to --output.
#
# This script exists alongside pageindex_cloud.py so the TypeScript build
# queue can choose a backend per invocation:
#
#   - pageindex_cloud.py    → Vectify PageIndex cloud SDK (needs API key)
#   - pageindex_local.py    → OSS PageIndex + Claude CLI  (zero cost)
#
# I/O contract (mirrors pageindex_cloud.py so the wrapper code stays thin):
#
#   stdout (success):
#     { "ok": true, "treePath": "<path>", "nodeCount": N,
#       "treePreview": { ... }, "elapsedSec": 123 }
#
#   stdout (failure):
#     { "ok": false, "error": "<msg>", "kind": "<tag>" }
#
# The process exits 0 even on caller-visible failure — the wrapper parses
# the JSON body to distinguish success/error.
#
# Usage:
#   pageindex_local.py --md-path /path/to/file.md --output /path/out.json
#   pageindex_local.py --pdf-path /path/to/file.pdf --output /path/out.json

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any

# Resolve the OSS PageIndex repo (bundled under refs/PageIndex). Inserting
# this path at the FRONT of sys.path makes Python prefer the OSS version
# over the cloud SDK (same package name `pageindex`). We do this before any
# pageindex import so the OSS copy wins.
OSS_REPO = os.environ.get(
    "VELA_PAGEINDEX_OSS_REPO",
    str(Path(__file__).resolve().parent.parent / "refs" / "PageIndex"),
)
if OSS_REPO not in sys.path:
    sys.path.insert(0, OSS_REPO)

# Our own bridge lives next to this file.
sys.path.insert(0, str(Path(__file__).resolve().parent))


def _emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()


def _err(error: str, kind: str = "error") -> None:
    _emit({"ok": False, "error": error, "kind": kind})


def _count_nodes(obj: Any) -> int:
    """Walk a PageIndex tree/dict/list and return the total node count."""
    if isinstance(obj, dict):
        count = 1 if ("title" in obj or "node_id" in obj) else 0
        children = obj.get("nodes") or obj.get("structure") or []
        for child in children:
            count += _count_nodes(child)
        return count
    if isinstance(obj, list):
        return sum(_count_nodes(x) for x in obj)
    return 0


def _strip_text(obj: Any) -> Any:
    """Return a copy of the tree with `text` fields removed, for preview."""
    if isinstance(obj, dict):
        return {
            k: _strip_text(v)
            for k, v in obj.items()
            if k != "text"
        }
    if isinstance(obj, list):
        return [_strip_text(x) for x in obj]
    return obj


def main() -> int:
    parser = argparse.ArgumentParser(description="Local PageIndex runner (Claude CLI)")
    parser.add_argument("--md-path", type=str, default=None)
    parser.add_argument("--pdf-path", type=str, default=None)
    parser.add_argument("--output", type=str, required=True)
    parser.add_argument("--model", type=str, default="claude-cli")
    parser.add_argument(
        "--summary",
        type=str,
        default="yes",
        choices=["yes", "no"],
        help="Include per-node summaries (extra LLM calls)",
    )
    parser.add_argument("--summary-token-threshold", type=int, default=200)
    parser.add_argument(
        "--include-text",
        type=str,
        default="yes",
        choices=["yes", "no"],
        help="Include raw node text in the output tree",
    )
    args = parser.parse_args()

    if not args.md_path and not args.pdf_path:
        _err("either --md-path or --pdf-path is required", "usage")
        return 0

    src_path = args.md_path or args.pdf_path
    if not src_path or not os.path.isfile(src_path):
        _err(f"source file not found: {src_path}", "usage")
        return 0

    # Patch litellm BEFORE importing pageindex so tree-building routes
    # through the Claude CLI bridge. We catch import errors explicitly so
    # the wrapper gets a clean JSON error instead of a Python traceback.
    try:
        from claude_cli_llm import patch_litellm  # type: ignore
        patch_litellm()
    except Exception as exc:  # noqa: BLE001
        _err(f"failed to patch litellm: {exc}", "config")
        return 0

    try:
        # Prefer OSS over the installed cloud SDK — the sys.path.insert
        # above ensures this import resolves to refs/PageIndex.
        from pageindex.page_index_md import md_to_tree  # type: ignore
    except Exception as exc:  # noqa: BLE001
        tb = traceback.format_exc(limit=3)
        _err(f"failed to import OSS pageindex: {exc}\n{tb}", "config")
        return 0

    started = time.time()
    try:
        if args.md_path:
            result = asyncio.run(
                md_to_tree(
                    md_path=args.md_path,
                    if_thinning=False,
                    min_token_threshold=None,
                    if_add_node_summary=args.summary,
                    summary_token_threshold=args.summary_token_threshold,
                    model=args.model,
                    if_add_doc_description="no",
                    if_add_node_text=args.include_text,
                    if_add_node_id="yes",
                )
            )
        else:
            # PDF path — OSS repo provides page_index() in page_index.py
            from pageindex.page_index import page_index  # type: ignore
            result = page_index(
                doc=args.pdf_path,
                model=args.model,
                if_add_node_summary=args.summary,
                if_add_node_text=args.include_text,
                if_add_node_id="yes",
            )
    except Exception as exc:  # noqa: BLE001
        tb = traceback.format_exc(limit=5)
        _err(f"{type(exc).__name__}: {exc}\n{tb}", "exception")
        return 0

    elapsed = int(time.time() - started)

    # Write tree to --output (parent dirs auto-created).
    try:
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
    except Exception as exc:  # noqa: BLE001
        _err(f"failed to write output: {exc}", "io")
        return 0

    nodes = _count_nodes(result)
    preview = _strip_text(result)
    _emit(
        {
            "ok": True,
            "treePath": str(out_path),
            "nodeCount": nodes,
            "elapsedSec": elapsed,
            "tree": preview,
        }
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
