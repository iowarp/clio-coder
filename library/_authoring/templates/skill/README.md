# Citation Check Skill Template

This template demonstrates a valid standalone **skill** package for Clio Coder.

## Package Structure

```text
citation-check/
  README.md         # Documentation (outside resource root)
  plugin.json       # Portable manifest declaring kind: skill
  SKILL.md          # Skill instructions and metadata
  evals.md          # Evaluation scenarios
```

## How to Use This Template

1. Copy this directory into your project or repository.
2. Rename the package in `plugin.json` and `SKILL.md`.
3. Update the description, triggers, and procedure in `SKILL.md`.
4. Add baseline/treatment scenarios in `evals.md`.
5. Validate your package:
   ```bash
   clio-coder library validate .
   ```
