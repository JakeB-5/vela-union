#!/usr/bin/env python
# pageindex_cloud.py — thin wrapper around the Vectify PageIndex cloud SDK.
#
# This script reads a JSON command from stdin and writes a JSON result to
# stdout. It exists so the TypeScript side of Vela Union can call the cloud
# PageIndex client without depending on the Python SDK directly.
#
# Supported commands (all pass the API key explicitly — never via env):
#
#   { "cmd": "submit",      "apiKey": "...", "pdfPath": "..." }
#     -> { "ok": true, "docId": "<id>" }
#
#   { "cmd": "wait_ready",  "apiKey": "...", "docId": "...",
#     "timeoutSec": 300,   "pollIntervalSec": 2 }
#     -> { "ok": true, "ready": true, "waitedSec": N }
#
#   { "cmd": "get_tree",    "apiKey": "...", "docId": "...",
#     "nodeSummary": true,  "nodeText": true }
#     -> { "ok": true, "tree": { ... } }
#
#   { "cmd": "submit_and_fetch", "apiKey": "...", "pdfPath": "...",
#     "timeoutSec": 300, "pollIntervalSec": 2,
#     "nodeSummary": true, "nodeText": true }
#     -> { "ok": true, "docId": "...", "tree": {...}, "waitedSec": N }
#
#   { "cmd": "list", "apiKey": "..." }
#     -> { "ok": true, "documents": [...], "total": N }
#
#   { "cmd": "delete", "apiKey": "...", "docId": "..." }
#     -> { "ok": true }
#
# Errors are returned as { "ok": false, "error": "<msg>", "kind": "<tag>" }
# and the process still exits 0 — the caller parses the JSON to decide.
#
# We never print the API key or echo it in logs.

from __future__ import annotations

import json
import sys
import time
import traceback
from typing import Any


def _emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()


def _err(error: str, kind: str = "error") -> None:
    _emit({"ok": False, "error": error, "kind": kind})


def _load_client(api_key: str):  # noqa: ANN202 — pageindex client type is unstable
    try:
        from pageindex import PageIndexClient  # type: ignore
    except ModuleNotFoundError as err:
        raise RuntimeError(
            "pageindex python package not installed. "
            "Run: /Users/jin/projects/vela-union/.venv/bin/pip install pageindex"
        ) from err
    return PageIndexClient(api_key=api_key)


def _submit(client: Any, pdf_path: str) -> str:
    result = client.submit_document(pdf_path)
    if not isinstance(result, dict):
        raise RuntimeError(f"unexpected submit_document response: {result!r}")
    doc_id = result.get("doc_id")
    if not isinstance(doc_id, str) or not doc_id:
        raise RuntimeError(f"submit_document missing doc_id: {result!r}")
    return doc_id


def _wait_ready(client: Any, doc_id: str, timeout_sec: int, interval_sec: float) -> int:
    started = time.time()
    while True:
        try:
            ready = client.is_retrieval_ready(doc_id)
        except Exception as exc:  # noqa: BLE001 — passthrough
            raise RuntimeError(f"is_retrieval_ready failed: {exc}") from exc
        if ready:
            return int(time.time() - started)
        waited = time.time() - started
        if waited > timeout_sec:
            raise TimeoutError(
                f"document {doc_id} not ready after {timeout_sec}s"
            )
        time.sleep(interval_sec)


def _get_tree(
    client: Any,
    doc_id: str,
    node_summary: bool,
    node_text: bool,
) -> dict[str, Any]:
    kwargs: dict[str, Any] = {}
    # Pass flags individually so missing parameters in older SDKs don't crash.
    if node_summary:
        kwargs["node_summary"] = True
    if node_text:
        kwargs["node_text"] = True
    try:
        tree = client.get_tree(doc_id, **kwargs)
    except TypeError:
        # Fallback: older client signatures
        tree = client.get_tree(doc_id)
    if not isinstance(tree, dict):
        raise RuntimeError(f"unexpected get_tree response: {type(tree).__name__}")
    return tree


def main() -> int:
    raw = sys.stdin.read()
    if not raw.strip():
        _err("empty stdin payload", "usage")
        return 0
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        _err(f"invalid JSON: {exc}", "usage")
        return 0

    cmd = payload.get("cmd")
    api_key = payload.get("apiKey")
    if not isinstance(api_key, str) or not api_key:
        _err("missing apiKey", "config")
        return 0

    try:
        client = _load_client(api_key)
    except Exception as exc:  # noqa: BLE001
        _err(f"failed to init client: {exc}", "config")
        return 0

    try:
        if cmd == "submit":
            pdf_path = payload.get("pdfPath")
            if not isinstance(pdf_path, str) or not pdf_path:
                _err("missing pdfPath", "usage")
                return 0
            doc_id = _submit(client, pdf_path)
            _emit({"ok": True, "docId": doc_id})
            return 0

        if cmd == "wait_ready":
            doc_id = payload.get("docId")
            if not isinstance(doc_id, str) or not doc_id:
                _err("missing docId", "usage")
                return 0
            timeout_sec = int(payload.get("timeoutSec", 300))
            interval_sec = float(payload.get("pollIntervalSec", 2.0))
            waited = _wait_ready(client, doc_id, timeout_sec, interval_sec)
            _emit({"ok": True, "ready": True, "waitedSec": waited})
            return 0

        if cmd == "get_tree":
            doc_id = payload.get("docId")
            if not isinstance(doc_id, str) or not doc_id:
                _err("missing docId", "usage")
                return 0
            tree = _get_tree(
                client,
                doc_id,
                bool(payload.get("nodeSummary", True)),
                bool(payload.get("nodeText", True)),
            )
            _emit({"ok": True, "tree": tree})
            return 0

        if cmd == "list":
            docs = client.list_documents()
            _emit({"ok": True, **(docs if isinstance(docs, dict) else {"documents": docs})})
            return 0

        if cmd == "delete":
            doc_id = payload.get("docId")
            if not isinstance(doc_id, str) or not doc_id:
                _err("missing docId", "usage")
                return 0
            client.delete_document(doc_id)
            _emit({"ok": True})
            return 0

        if cmd == "submit_and_fetch":
            pdf_path = payload.get("pdfPath")
            if not isinstance(pdf_path, str) or not pdf_path:
                _err("missing pdfPath", "usage")
                return 0
            timeout_sec = int(payload.get("timeoutSec", 300))
            interval_sec = float(payload.get("pollIntervalSec", 2.0))
            doc_id = _submit(client, pdf_path)
            waited = _wait_ready(client, doc_id, timeout_sec, interval_sec)
            tree = _get_tree(
                client,
                doc_id,
                bool(payload.get("nodeSummary", True)),
                bool(payload.get("nodeText", True)),
            )
            _emit(
                {
                    "ok": True,
                    "docId": doc_id,
                    "waitedSec": waited,
                    "tree": tree,
                }
            )
            return 0

        _err(f"unknown cmd: {cmd!r}", "usage")
        return 0
    except TimeoutError as exc:
        _err(str(exc), "timeout")
        return 0
    except Exception as exc:  # noqa: BLE001 — report as JSON, never crash
        tb = traceback.format_exc(limit=3)
        _err(f"{type(exc).__name__}: {exc}\n{tb}", "exception")
        return 0


if __name__ == "__main__":
    sys.exit(main())
