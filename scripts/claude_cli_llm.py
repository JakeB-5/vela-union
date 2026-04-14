#!/usr/bin/env python
# claude_cli_llm.py — litellm-compatible shim that routes every LLM call
# through the local `claude -p` CLI.
#
# This exists so PageIndex OSS (refs/PageIndex/pageindex) can run entirely
# against the user's Claude subscription with zero API cost. Both the sync
# (`litellm.completion`) and async (`litellm.acompletion`) entry points are
# replaced at runtime — the OSS library never knows the difference.
#
# Shape notes:
#   - The response object mimics the subset of `litellm.ModelResponse` that
#     PageIndex's `llm_completion` / `llm_acompletion` actually read:
#     `.choices[0].message.content` and `.choices[0].finish_reason`.
#   - We also implement `__getitem__` because litellm sometimes serialises
#     responses as dicts; older PageIndex code uses the dict form.
#
# Claude CLI specifics:
#   - `claude -p <prompt>` is stateless: every call spawns a fresh process.
#   - The binary path is resolved at import time with an env override
#     (VELA_CLAUDE_CLI_BIN) falling back to `/Users/jin/.local/bin/claude`.
#     We deliberately pass absolute paths so cmux-style PATH wrappers are
#     bypassed — the wrapper's SessionEnd hook writes noise to stderr but
#     does not affect stdout, which is all we parse.
#   - We inherit the full environment (including HOME) so the CLI can read
#     `~/.claude/` for auth. Missing HOME => unauthenticated subprocess.

from __future__ import annotations

import asyncio
import os
import subprocess
from typing import Any, Optional

CLAUDE_BIN = os.environ.get(
    "VELA_CLAUDE_CLI_BIN",
    os.path.expanduser("~/.local/bin/claude"),
)
DEFAULT_TIMEOUT_SEC = int(os.environ.get("VELA_CLAUDE_CLI_TIMEOUT", "600"))

# Cap on concurrent `claude -p` subprocesses spawned via the async path.
# PageIndex OSS uses asyncio.gather() to fan out per-section summaries,
# which on a large document (30+ sections) would otherwise spawn 30+
# Claude CLI processes simultaneously. Each Claude CLI takes 300-500MB
# of RAM (bundled Node + model context), so an uncapped fan-out on a
# few big docs in parallel can blow past 100GB and crash the machine
# (confirmed in production). Default 3 keeps the worst-case around
# 1.5-2GB per document, which leaves headroom even when the build queue
# is processing back-to-back large files.
DEFAULT_CONCURRENCY = int(
    os.environ.get("VELA_CLAUDE_CLI_CONCURRENCY", "3")
)

# Lazy: asyncio.Semaphore must be created inside a running event loop
# (Python 3.10+ allows construction outside a loop but binds to the
# first loop that uses it — we want one semaphore per process, shared
# across all calls in that process's single event loop).
_async_semaphore: Optional[asyncio.Semaphore] = None


def _get_semaphore() -> asyncio.Semaphore:
    global _async_semaphore
    if _async_semaphore is None:
        _async_semaphore = asyncio.Semaphore(DEFAULT_CONCURRENCY)
    return _async_semaphore


def call_claude_cli(
    prompt: str,
    chat_history: Optional[list] = None,
    timeout: int = DEFAULT_TIMEOUT_SEC,
) -> str:
    """Spawn `claude -p <prompt>` and return the raw stdout string.

    chat_history is an optional list of {role, content} dicts. Because
    `claude -p` is stateless we flatten history into a single prompt.
    """
    if chat_history:
        parts: list[str] = []
        for turn in chat_history:
            role = str(turn.get("role", "user")).upper()
            content = str(turn.get("content", ""))
            parts.append(f"[{role}]\n{content}")
        parts.append(f"[USER]\n{prompt}")
        full_prompt = "\n\n".join(parts)
    else:
        full_prompt = prompt

    # Inherit HOME/PATH/etc so the CLI can pick up auth from ~/.claude.
    env = {**os.environ}

    try:
        result = subprocess.run(
            [CLAUDE_BIN, "-p", full_prompt],
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
            check=False,
        )
    except FileNotFoundError as err:
        raise RuntimeError(
            f"claude CLI not found at {CLAUDE_BIN} (set VELA_CLAUDE_CLI_BIN)"
        ) from err
    except subprocess.TimeoutExpired as err:
        raise RuntimeError(
            f"claude CLI timed out after {timeout}s"
        ) from err

    if result.returncode != 0:
        stderr_tail = (result.stderr or "").strip()[-500:]
        raise RuntimeError(f"claude CLI exit {result.returncode}: {stderr_tail}")
    return result.stdout.rstrip("\n")


# ---------------------------------------------------------------------------
# litellm-compatible response shim
# ---------------------------------------------------------------------------


class _FakeMessage:
    def __init__(self, content: str) -> None:
        self.content = content
        self.role = "assistant"


class _FakeChoice:
    def __init__(self, content: str) -> None:
        self.message = _FakeMessage(content)
        self.finish_reason = "stop"

    def __getitem__(self, key: str) -> Any:  # pragma: no cover — defensive
        if key == "message":
            return {"content": self.message.content, "role": self.message.role}
        if key == "finish_reason":
            return self.finish_reason
        raise KeyError(key)


class FakeLiteLLMResponse:
    """Mimics the subset of litellm.ModelResponse that PageIndex uses."""

    def __init__(self, content: str) -> None:
        self.choices = [_FakeChoice(content)]
        self._dict = {
            "choices": [
                {
                    "message": {"content": content, "role": "assistant"},
                    "finish_reason": "stop",
                }
            ]
        }

    def __getitem__(self, key: str) -> Any:
        return self._dict[key]


def _extract_prompt(messages: list[dict]) -> tuple[str, Optional[list[dict]]]:
    if not messages:
        raise ValueError("messages required")
    last = messages[-1]
    prompt = str(last.get("content", ""))
    history = list(messages[:-1]) if len(messages) > 1 else None
    return prompt, history


def fake_litellm_completion(
    model: Optional[str] = None,
    messages: Optional[list[dict]] = None,
    **kwargs: Any,
) -> FakeLiteLLMResponse:
    """Drop-in replacement for `litellm.completion`."""
    del model, kwargs  # unused — always routes to local claude CLI
    if messages is None:
        raise ValueError("messages required")
    prompt, history = _extract_prompt(messages)
    content = call_claude_cli(prompt, chat_history=history)
    return FakeLiteLLMResponse(content)


async def fake_litellm_acompletion(
    model: Optional[str] = None,
    messages: Optional[list[dict]] = None,
    **kwargs: Any,
) -> FakeLiteLLMResponse:
    """Async drop-in for `litellm.acompletion`.

    Claude CLI has no native async mode. We run the sync call in a thread
    so the event loop can still schedule other tasks while waiting.

    Acquires a module-level semaphore (DEFAULT_CONCURRENCY) before
    spawning so PageIndex OSS's asyncio.gather() fan-outs cannot spawn
    unbounded Claude CLI subprocesses. When the limit is N, at most N
    Claude CLI processes run at any given time — the rest queue at the
    semaphore. This is the safety net that prevents the memory blow-up
    observed when an uncapped fan-out spawned 50+ Claude CLI processes
    simultaneously on a single large markdown file.
    """
    del model, kwargs
    if messages is None:
        raise ValueError("messages required")
    prompt, history = _extract_prompt(messages)
    loop = asyncio.get_event_loop()
    sem = _get_semaphore()
    async with sem:
        content = await loop.run_in_executor(
            None, lambda: call_claude_cli(prompt, chat_history=history)
        )
    return FakeLiteLLMResponse(content)


def patch_litellm() -> None:
    """Monkeypatch `litellm.completion` and `litellm.acompletion` in-place.

    Must be called BEFORE pageindex is imported — pageindex captures
    `litellm.completion` by attribute lookup at call time (not import time),
    so patching the module attribute is sufficient.
    """
    import litellm  # noqa: PLC0415 — deferred import is intentional

    litellm.completion = fake_litellm_completion  # type: ignore[assignment]
    litellm.acompletion = fake_litellm_acompletion  # type: ignore[assignment]


if __name__ == "__main__":
    # Self-test: verify we can reach the Claude CLI and round-trip a prompt.
    import sys

    try:
        out = call_claude_cli("reply with exactly: PONG", timeout=60)
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        sys.exit(1)
    print(out)
