# Pipeline Review Playbook Template

This template demonstrates a valid standalone **playbook** package for Clio Coder. A playbook is what the fleet runs.

## Package Structure

```text
pipeline-review/
  README.md                     # Documentation (outside resource root)
  plugin.json                   # Portable manifest declaring kind: playbook
  playbooks/
    pipeline-review.md          # Multi-agent coordination playbook
```

> **Important**: Place `README.md` at the package root, never inside the `playbooks/` resource root. Single-kind packages expose exactly one public candidate in their declared resource directory.

## Graph and Step Semantics

- **Version**: Version 1 or higher (v4 introduces strict write boundaries).
- **Steps**: Each step specifies `id`, `agent`, `scope`, and `dependencies`.
- **Graph Validity**: Steps must form a directed acyclic graph (DAG) without cycles or unknown dependencies.
- **Prompt Body**: Uses strict `{{var}}` interpolation; all variables must be supplied at invocation (e.g. `--var pipeline=configs/pipeline.yaml`).
- **Prerequisites**: Playbooks that reference core built-in agents (e.g., `scout`, `verifier`) should clearly document these dependencies in their body.

## Validation

```bash
clio-coder library validate .
```
