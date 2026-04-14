#!/usr/bin/env python
# md_to_pdf.py — Markdown -> PDF converter for Vela Union PageIndex integration.
#
# Called from the TypeScript side (mcp-gateway/build-queue) to convert .md
# files into PDFs that can be uploaded to the Vectify/PageIndex cloud API,
# which currently only accepts PDFs.
#
# Usage:
#   python md_to_pdf.py <input.md> <output.pdf> [--title "Doc Title"]
#
# Exits non-zero on failure with a short diagnostic on stderr.

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def convert(md_path: Path, pdf_path: Path, title: str | None) -> None:
    try:
        from markdown_pdf import MarkdownPdf, Section  # type: ignore
    except ModuleNotFoundError as err:
        sys.stderr.write(
            "markdown_pdf not installed. Run: "
            "/Users/jin/projects/vela-union/.venv/bin/pip install markdown-pdf\n"
        )
        raise SystemExit(2) from err

    if not md_path.exists():
        sys.stderr.write(f"md file not found: {md_path}\n")
        raise SystemExit(1)

    source = md_path.read_text(encoding="utf-8", errors="replace")
    if not source.strip():
        sys.stderr.write(f"md file is empty: {md_path}\n")
        raise SystemExit(1)

    # Prepend a title heading if the document lacks a top-level heading, so
    # the resulting PDF has a reasonable TOC entry.
    heading = title or md_path.stem
    has_h1 = any(line.lstrip().startswith("# ") for line in source.splitlines()[:20])
    if not has_h1:
        source = f"# {heading}\n\n{source}"

    pdf_path.parent.mkdir(parents=True, exist_ok=True)
    pdf = MarkdownPdf(toc_level=3)
    pdf.meta["title"] = heading
    # Single section keeps the document simple; code blocks + lists render fine.
    pdf.add_section(Section(source, toc=True))
    pdf.save(str(pdf_path))
    print(str(pdf_path))


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert a markdown file to PDF.")
    parser.add_argument("input", help="Input markdown file")
    parser.add_argument("output", help="Output PDF path")
    parser.add_argument("--title", help="Optional PDF/document title", default=None)
    args = parser.parse_args()

    convert(Path(args.input), Path(args.output), args.title)
    return 0


if __name__ == "__main__":
    sys.exit(main())
