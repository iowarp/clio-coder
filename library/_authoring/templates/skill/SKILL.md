---
name: citation-check
description: Verify citation keys, DOIs, and bibliography entries against source files in research software. Load when checking academic references, bibtex formatting, or paper citations.
version: 1.0.0
license: Apache-2.0
clio-coder:
  registry-id: citation-check
  source-url: https://github.com/iowarp/clio-coder/tree/main/library/_authoring/templates/skill
  provenance: designed
  eval-status: scenarios-recorded
triggers:
  - citation check
  - verify citations
  - check bibliography
  - validate doi
allowed-tools:
  - read
  - grep
  - find
---

# Citation Check

Verify citation keys, Digital Object Identifiers (DOIs), and bibliography entries in research codebases and papers.

## When to load this skill

Load when:
- Reviewing LaTeX documents, markdown papers, or documentation containing citation keys (e.g. `\cite{...}`, `[@key]`).
- Validating BibTeX `.bib` files for syntax errors, missing fields, or duplicate keys.
- Checking that cited DOIs resolve to expected formats.

## Procedure

1. **Locate citation files**: Search for `.bib` files and references in the workspace using `find`.
2. **Inspect citation keys**: Grep for citation markers in manuscript or documentation source files.
3. **Cross-reference**: Ensure every cited key exists in the corresponding `.bib` file. Report unreferenced bibliography entries as warnings and missing keys as errors.
4. **DOI Verification**: Verify DOIs match the standard format `10.XXXX/...` and link to valid literature sources.
5. **Report findings**: Output a structured summary containing verified keys, missing citations, and formatting issues.
