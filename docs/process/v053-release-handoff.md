# v0.5.3 release handoff

Paste the section below into a fresh Claude Code session started in
`/home/akougkas/iowarp/clio-coder`. Everything it states was measured in the
session that produced the candidate; nothing in it is an estimate.

---

Finish cutting Clio Coder v0.5.3. The implementation is complete and every
branch is merged. What remains is qualification, the tag, and publication.

## State you are inheriting

Branch `v053`, HEAD `cb002563`, 46 commits past the `v0.5.2` tag, working tree
clean, nothing pushed. `package.json`, `assets/acp-registry/agent.json`, the
README install pin and the README headline all read 0.5.3. The `CHANGELOG.md`
0.5.3 section is written in full and dated 2026-09-22.

Measured on this candidate, all green:

- `pnpm run ci` exit 0: typecheck, biome over 1779 files, `check-hygiene` 17
  checks, build, contracts 1742/1743, maintenance 29/29, GUI lint over 305
  files, GUI tests 183/183.
- Contract suite after the last merge: 1758 tests, 1757 pass, 0 fail, 1 skipped.
- `pnpm run test:package` 3/3.
- `node scripts/check-release.mjs` ok, 2083 files, 11.23 MB tarball.

`node scripts/release-candidate.mjs qualify` was started against this exact
commit and had reached the GUI build phase when the session ended. Its result
was never observed, so treat it as unknown and run it again. Do not report a
qualification that you did not watch finish.

## What shipped

Three planned features and one unplanned.

1. Committed per-task eval baselines for Clio's own harness. `eval baseline
   record|check`, a suite-level `baseline: {file, pin}` declaration checked
   inline by `eval run`, the `bash` tool-bench suite, and five offline
   model-free machinery suites under `evals/machinery/`. 261 pinned scenarios
   total: 230 tool-bench across six tools and two splits, 31 machinery.
2. Diffusion model support. The `inception` runtime for Mercury, chat plus
   fill-in-the-middle through the existing `infill()` verb. Local diffusion was
   dropped from scope deliberately and nothing about it ships.
3. System One decision models, alpha. `decide()` on `RuntimeDescriptor`, the
   hidden `typesafe-jev` runtime, and `fleet.decisionProfiles` binding four
   sites: `routing`, `skills`, `memory`, `toolRisk`. Every site is off until
   bound, and an unbound site, a provider outage and an abstention all produce
   the behavior that existed before the site did.
4. Cached MCP discovery. `gateway(op="find")` no longer launches every trusted
   server before filtering, and describe no longer reaches `ensure()` for an
   undiscovered tool. Calls still validate against live-discovered schemas.

## Do this

1. Re-read `docs/process/release-cut-checklist.md` and follow it. It is the
   authority; this file only tells you where the candidate stands.
2. Run `node scripts/release-candidate.mjs qualify` on the clean commit and
   watch it finish. It invalidates the previous receipt before checking the
   source, so a dirty tree fails it.
3. If qualification fails, fix the cause on `v053` and qualify again. Do not
   work around a failure to reach a tag.
4. Stop before the tag and before any push. Tagging `v0.5.3`, pushing `v053` or
   `main`, and publishing to npm all need the operator to say so explicitly in
   that session. Approval given in the session that built this does not carry
   over.

## Things the operator should know, unprompted

- A TypeSafe API key was pasted into the previous session's transcript and used
  for live validation. It must be rotated. It is not in the repository; it was
  written only to that session's scratchpad.
- Five worktrees from this and the previous release are still on disk:
  `clio-coder-mcp-review`, `clio-coder-release-surface`,
  `clio-coder-systemone-sites`, `clio-coder-memory-selector`,
  `clio-coder-skills-harness`. The first three are fully merged into `v053` and
  are safe to remove with `git worktree remove`. The two `v052-*` ones predate
  this release; ask before touching them.
- `docs/process/mcp-proxy-sprint.md` is a delivered specification, not a plan.
  Its work is merged. It stays as the record of why the MCP change took the
  shape it did.

## Open judgment calls, none blocking

- `RELEVANCE_DECISION_TIMEOUT_MS` is 3s on the turn's critical path, roughly
  eleven times the 274ms measured against the live provider. It is deliberate
  headroom for a larger batch and only applies when a decision site is bound,
  but it is the number an operator would feel first if a target got slow.
- `MIN_CERTAINTY` is 0.2 in `relevance-pass.ts`. If real catalogs abstain more
  than the live runs did, that is the knob, not the slot-preservation rule.
- `buildSkillCatalogView` reports "Ordered by relevance" even when every row
  abstained. Unreachable in production because the pass only returns a ranking
  when at least one score exists, but a direct caller would see it.
