# Pipeline Review Fleet Template

This template demonstrates a valid standalone **fleet** package for Clio Coder.

## Package Structure

```text
pipeline-review/
  README.md                     # Documentation (outside resource root)
  plugin.json                   # Portable manifest declaring kind: fleet
  fleets/
    pipeline-review.md          # Multi-agent coordination contract
```

> **Important**: Place `README.md` at the package root, never inside the `fleets/` resource root. Single-kind packages expose exactly one public candidate in their declared resource directory.

## Graph and Step Semantics

- **Version**: Version 1 or higher (v4 introduces strict write boundaries).
- **Steps**: Each step specifies `id`, `agent`, `scope`, and `dependencies`.
- **Graph Validity**: Steps must form a directed acyclic graph (DAG) without cycles or unknown dependencies.
- **Prompt Body**: Uses strict `{{var}}` interpolation; all variables must be supplied at invocation (e.g. `--var pipeline=configs/pipeline.yaml`).
- **Prerequisites**: Fleets that reference core built-in agents (e.g., `scout`, `verifier`) should clearly document these dependencies in their body.

## Validation

```bash
clio-coder library validate .
```
