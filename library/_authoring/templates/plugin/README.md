# Data Curation Plugin Template

This template demonstrates a valid composite **plugin** bundle for Clio Coder.

## Package Structure

```text
data-curation/
  README.md                                 # Documentation
  plugin.json                               # Manifest declaring bundle resources & components
  assets/
    curation-guide.md                       # Supporting reference asset (component:resource:guidelines)
  skills/
    dataset-curation/
      SKILL.md                              # Bound skill
      evals.md                              # Skill evaluation scenarios
  agents/
    data-curator.md                         # Agent binding dataset-curation skill
  prompts/
    inspect-dataset.md                      # Prompt requiring data-curator agent
```

## Manifest Declarations

- **Resources**: Declares ordinary `skills`, `agents`, and `prompts` directories under `extensions["ai.iowarp.clio"]`.
- **Components**:
  - `resource:guidelines` -> `assets/curation-guide.md`
  - `skill:dataset-curation` -> `skills/dataset-curation/SKILL.md` (requires `resource:guidelines`)
  - `agent:data-curator` -> `agents/data-curator.md` (requires `skill:dataset-curation`)
  - `prompt:inspect-dataset` -> `prompts/inspect-dataset.md` (requires `agent:data-curator`)
- **Acyclic References**: Component dependencies form a clean DAG.

## Validation

```bash
clio-coder library validate .
```
