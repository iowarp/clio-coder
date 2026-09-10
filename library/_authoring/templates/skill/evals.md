# Evals: citation-check

Scenarios recorded for the citation-check skill.

## Scenario: missing-citation-key

### Baseline (without skill)
- Context: Workspace with `paper.tex` citing `\cite{smith2024}` and `references.bib` containing only `doe2023`.
- Task: Verify citations in `paper.tex`.
- Outcome: General unstructured commentary, potential hallucination of reference existence.

### Treatment (with skill)
- Prompt: `/skill citation-check Check citations in paper.tex against references.bib`
- Expected Evidence:
  - Identifies missing citation key `smith2024` in `references.bib`.
  - Reports `doe2023` as an unreferenced entry.
  - Leaves workspace files unmodified.

## Scenario: doi-format-validation

### Baseline (without skill)
- Context: `references.bib` with invalid DOI string `doi = {https://dx.doi.org/invalid}`.
- Task: Validate DOI formatting in `references.bib`.
- Outcome: Misses malformed DOI format or accepts invalid prefix.

### Treatment (with skill)
- Prompt: `/skill citation-check Validate DOI formats in references.bib`
- Expected Evidence:
  - Flags invalid DOI prefix.
  - Recommends canonical DOI format `10.XXXX/...`.
