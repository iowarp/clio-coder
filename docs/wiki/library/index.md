# library

> **Audit at `3aae1044`:** top-level library structure and `library/README.md` were checked. Materio is one package, not the library.

## Current structure

- `library/skills/` is the curated skill tree, with `registry.yaml` and `skill-marketplace.json`.
- `library/plugins/` contains `hoare`, `hpc`, `life-science`, `literature`, `materio`, and `science-data`.
- `library/extensions/` contains the standalone runtime packages `local-status` and `materio`.
- `library/agents/`, `library/playbooks/`, and `library/prompts/` are active package roots (README-backed at this commit); product-owned built-ins remain under `src/domains/agents/`.
- `library/_authoring/templates/` contains skill, agent, prompt, playbook and plugin templates.
- `library/registry.yaml` is the full-tree distribution index; `library/skills/registry.yaml` separately records skill-body provenance.

Plugins are portable content packages. Extensions are separately manifested Clio runtime code.

## Sections

- [extensions/](extensions/index.md)
- [plugins/](plugins/index.md)
