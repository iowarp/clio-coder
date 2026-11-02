# Worked Example

Session: the user fetched a CSV export, normalized column names with a small
script, and verified row counts against the source, three sessions in a row.

1. Reconstruct: `bash curl ...` (ran), `write normalize.py` + `bash python3
   normalize.py` (ran), `bash wc -l` comparison (ran). User also mentions "and
   I always spot-check five rows". Not visible this session, tagged
   assumption.
2. Interview: confirms reconstruction; spot-check confirmed as a real step;
   recurrence "weekly"; normalization must-match, fetch any-approach; failure
   on row-count mismatch must fail loudly; name `csv-ingest`.
3. Overlap: the `context(scope="skills")` listing shows no fetch or CSV skill
   installed; no references.
4. Gate: summary presented; user approves after tightening the description.
5. Create: write `draft-skills/csv-ingest/SKILL.md`, placeholders for the
   export URL and column map; frontmatter contract confirmed by reading the
   file back (no `bash`, so no `clio-coder library validate` this turn).
6. Validate: scenario "ingest this month's export" must show fetch,
   normalize, count-verify, spot-check in that order; recorded in the body.
