#!/usr/bin/env python3
"""Extract citation candidates from BibTeX, LaTeX or Markdown files, offline.

Reads each path, and prints one candidate per citation. A BibTeX entry gives
its key, title, year, DOI and arXiv ID, plus the raw entry text. In any other
text, each DOI and each arXiv ID it finds becomes its own candidate. Each
candidate carries the `identifier` to verify (a DOI, else `arxiv:<id>`, else
none) and the input that verify-citation accepts (the identifier, or the raw
BibTeX entry when there is no identifier). The script never contacts a
network service and never writes a file; verification happens in the
citation-check skill.

Exit codes: 0 candidates printed, 1 at least one candidate has neither an
identifier nor a title and can only be reported UNVERIFIABLE, 2 a path could
not be read or no candidates were found.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

DOI = re.compile(r"\b(10\.\d{4,9}/[^\s\"'<>{}\],;]+)", re.IGNORECASE)
ARXIV = re.compile(r"\b(?:arxiv:\s*|arxiv\.org/(?:abs|pdf)/)(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7})(v\d+)?", re.IGNORECASE)
ENTRY_START = re.compile(r"@(\w+)\s*\{\s*([^,\s]+)\s*,", re.IGNORECASE)


def clean_doi(text: str) -> str:
    return text.rstrip(".)").lower()


def bib_entries(text: str):
    """Yield (type, key, body, raw) for each BibTeX entry, honoring nested braces."""
    pos = 0
    while (match := ENTRY_START.search(text, pos)) is not None:
        depth, i = 1, text.index("{", match.start()) + 1
        while i < len(text) and depth > 0:
            depth += {"{": 1, "}": -1}.get(text[i], 0)
            i += 1
        kind = match.group(1).lower()
        if kind not in ("comment", "string", "preamble"):
            yield kind, match.group(2), text[match.end() : i - 1], text[match.start() : i]
        pos = i


def bib_fields(body: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    i = 0
    while (match := re.compile(r"\s*([A-Za-z_-]+)\s*=\s*").match(body, i)) is not None:
        name, i = match.group(1).lower(), match.end()
        if i < len(body) and body[i] in "{\"":
            close = "}" if body[i] == "{" else '"'
            depth, j = 1, i + 1
            while j < len(body) and depth > 0:
                if close == "}":
                    depth += {"{": 1, "}": -1}.get(body[j], 0)
                elif body[j] == '"':
                    depth = 0
                j += 1
            value, i = body[i + 1 : j - 1], j
        else:
            end = body.find(",", i)
            end = len(body) if end < 0 else end
            value, i = body[i:end], end
        fields[name] = re.sub(r"[{}]", "", " ".join(value.split()))
        comma = body.find(",", i)
        if comma < 0:
            break
        i = comma + 1
    return fields


def candidate(source: str, **values) -> dict:
    doi, arxiv = values.get("doi"), values.get("arxiv")
    identifier = doi or (f"arxiv:{arxiv}" if arxiv else None)
    item = {"source": source, **{k: v for k, v in values.items() if v}, "identifier": identifier}
    item["verify_input"] = identifier or values.get("bibtex") or values.get("title")
    return item


def from_bibtex(text: str, source: str) -> list[dict]:
    out = []
    for _kind, key, body, raw in bib_entries(text):
        fields = bib_fields(body)
        doi_match = DOI.search(fields.get("doi", ""))
        arxiv = None
        if fields.get("archiveprefix", "").lower() == "arxiv" and fields.get("eprint"):
            arxiv = fields["eprint"].split("v")[0] if re.match(r"\d{4}\.\d{4,5}", fields["eprint"]) else fields["eprint"]
        elif (m := ARXIV.search(" ".join(fields.get(k, "") for k in ("journal", "url", "note", "eprint")))) is not None:
            arxiv = m.group(1)
        out.append(
            candidate(
                source,
                key=key,
                title=fields.get("title"),
                year=fields.get("year"),
                doi=clean_doi(doi_match.group(1)) if doi_match else None,
                arxiv=arxiv,
                bibtex=raw,
            )
        )
    return out


def from_text(text: str, source: str) -> list[dict]:
    out, seen = [], set()
    for line_no, line in enumerate(text.splitlines(), 1):
        for m in DOI.finditer(line):
            doi = clean_doi(m.group(1))
            if doi not in seen:
                seen.add(doi)
                out.append(candidate(f"{source}:{line_no}", doi=doi))
        for m in ARXIV.finditer(line):
            if m.group(1) not in seen:
                seen.add(m.group(1))
                out.append(candidate(f"{source}:{line_no}", arxiv=m.group(1)))
    return out


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("paths", nargs="+", help=".bib, .tex or .md files")
    parser.add_argument("--json", action="store_true", help="print a JSON list instead of one line per candidate")
    args = parser.parse_args(argv)
    found: list[dict] = []
    unreadable = False
    for raw in args.paths:
        path = Path(raw)
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as error:
            print(f"extract_citations: cannot read {path}: {error}", file=sys.stderr)
            unreadable = True
            continue
        found += from_bibtex(text, str(path)) if path.suffix.lower() == ".bib" else from_text(text, str(path))
    if args.json:
        print(json.dumps(found, indent=1))
    else:
        for item in found:
            label = item.get("key") or item["source"]
            print(f"{label}\t{item['identifier'] or 'no identifier'}\t{item.get('year', '')}\t{item.get('title', '')}")
    if unreadable or not found:
        if not found:
            print("extract_citations: no citation candidates found", file=sys.stderr)
        return 2
    return 1 if any(not item["identifier"] and not item.get("title") for item in found) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
