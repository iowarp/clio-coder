# Evals: dataset-curation

Evaluation scenarios for dataset curation skill.

## Scenario: missing-fair-metadata

### Baseline (without skill)
- Context: Dataset folder containing `data.csv` with no license or column description.
- Task: Check dataset for publication readiness.
- Outcome: General observations, omits structured FAIR criteria.

### Treatment (with skill)
- Prompt: `/skill dataset-curation Check dataset at data/ for FAIR compliance`
- Expected Evidence:
  - References FAIR criteria from `assets/curation-guide.md`.
  - Flags absence of license and schema documentation.
  - Identifies missing unit definitions in CSV headers.
