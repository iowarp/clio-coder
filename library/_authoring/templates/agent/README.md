# Benchmark Scout Agent Template

This template demonstrates a valid standalone **agent** package for Clio Coder.

## Package Structure

```text
benchmark-scout/
  README.md                     # Documentation (outside resource root)
  plugin.json                   # Portable manifest declaring kind: agent
  agents/
    benchmark-scout.md          # Agent recipe (strict v1 format)
```

> **Important**: Place `README.md` at the package root, never inside the `agents/` resource root. Single-kind packages expose exactly one public candidate in their declared resource directory.

## Recipe Constraints

- Must use version 1 schema (`version: 1`).
- Standalone agents declare `skills: []` and cannot bind external package skills.
- Must declare `audience: custom` (only built-in recipes can use other audiences).
- Valid budget, tools (required and optional), capability class, category, and result contract.

## Validation

```bash
clio-coder library validate .
```
