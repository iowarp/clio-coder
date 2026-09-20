# Inspector presentation atlas

What each of the retired workbench's thirteen inspectors showed, in what order, and
which route in `apps/clio-coder-gui` now carries the same data. The data is
reproduced; the presentation decisions recorded here are what the new GUI still owes.

**Verification of the audit's data claim, per inspector → new route:**

| Inspector | Data reproduced by | Verdict |
| --- | --- | --- |
| catalog (26K) | `contracts/library.ts` | yes, with agents/skills/verifiers/extensions collapsed into one `Library` shape |
| config (16K) | `contracts/settings.ts` + `settings-safe.ts` | partial: `WireCustomizationEntry.contextCostTokens` and `reloadClass` have no counterpart — add them |
| decisions (12K) | `contracts/evidence.ts` (`gate`) | yes, but shape is opaque (`JSON.stringify(gate)` at evidence.tsx:226) |
| dispatch (8K) | `contracts/fleet.ts` | yes |
| eval (24K) | `contracts/reports.ts` | yes |
| evidence (17K) | `contracts/evidence.ts` | yes |
| fleet (25K) | `contracts/fleet.ts` + `fleet-events.ts` | yes |
| interop (11K) | `contracts/targets.ts` + `targets-cli.ts` | partial: the four wiring states (configured / not-ACP / proposed / decided) are not modelled |
| recovery (10K) | `contracts/system.ts` | yes |
| routing (12K) | `contracts/targets.ts` | yes |
| toolchain (9K) | `contracts/toolchain.ts` | yes |
| trace (15K) | `contracts/traces.ts` | yes |
| usage (16K) | `contracts/reports.ts` | partial: the 5-field token split + origin split (turns/sideQuestions/handoffs) is not modelled |

**The empty-state grammar — the most reusable thing here.** Every panel distinguished four states and used different words for each. Reproduce this everywhere:
1. *Not read in this session* — `"The durable evidence inventory has not been read in this session."` / `"No diagnostic sweep has run in this desktop session. Nothing is inferred from a successful conversation."`
2. *Store missing* — `"This installation has never run an evaluation, so it has no eval store at all. That is a missing store, not an empty one."` A dash in a figure means the store was not found: `"A dash means Clio Coder could not find that local history store. It does not mean zero activity."`
3. *Store present, nothing in it* — `"Clio Coder has built no evidence bundles on this installation. This is an empty record, not a health claim."`
4. *Record predates the schema* — `"This bundle predates the canonical trust projection, so it records no axes to open."`

And a fifth, for every bounded list: `"Older evidence bundles are outside this bounded window."` / `"Later phases are outside this bounded index."` / `"rarer kinds not shown"`. Every truncation flag on the wire gets a sentence; none is silently dropped.

**Per-inspector fact order and grouping.**

- **config** → *Effective Clio Map*. Four summary figures first: effective setting facts, customization surfaces, estimated context cost (`~` + locale-formatted sum of `contextCostTokens`), needs-a-restart count. Then a three-stage "influence path" diagram: **01 Sources** (scope + setting-source counts, merged into one map, sorted by count descending then name, top 8) → **02 Loaded layers** (categories in `CUSTOMIZATION_CATEGORY_ORDER`, shown as a 3-4 letter code plus label) → **03 Behavior**. Then settings grouped by *family* (`key.split(/[.[]/, 1)[0]`), families sorted alphabetically. Entry source line: the project-relative path, or `"project root"` when the path is `/`, or `` `${scope} scope` `` when no path.
- **catalog** → tabbed (Agents / Skills / Verifiers / Library / Extensions) with arrow-key tab navigation. Agent card facts in order: capability, project context tier, tool-call budget (`min–max` or bare `min`), read reserve; bound skills as chips; declared tool surfaces behind `<details>` with the count on the summary; footer = result contract + `"Text synthesis at boundary"` / `"Stops at boundary"`. Skill card leads with the *reach sentence* — `"The model can load this by name"` / `"Its root is not trusted, so the model never sees it"` / `"Its frontmatter reserves it for you"` — then precedence, root trust, model invocation; footer counts issues and flags `installed by a dispatched worker` / `has an upstream`. Free-text query filters across all string fields, case-folded with `toLocaleLowerCase("en-US")`.
- **usage** → 30-day window, stated as `from … through …`. Summary: total tokens (+ API calls), Clio-reported cost (`"Recorded cost, never a GUI estimate"`), sessions, dispatch runs. Then token composition as five comparative bars — **`"Bars compare token fields with one another; they are not additive percentages. Provider accounting can overlap cache and reasoning fields."`** Then origin split (turns / side questions / handoffs), models sorted by tokens, skills split into activated vs dormant.
- **trace** → per run: status mark, four totals (tokens, cost, wall time, runtime), then an ordered phase list with name / `kind · owner` / `tokens · cost · duration · N retries` / status, then event-kind and process-kind histograms. Boundary line: `"Event payloads, event names, and process command lines stay on the host by design. What crosses is how many of each kind there were."`
- **toolchain** → one resolution label per item, with a deliberate three-way split: `!supported → "Platform unsupported"/neutral`; `source === "path" → "Using PATH"/success`; `source === "vendored" → "Using pinned copy"/success`; otherwise `"Not available"/warning`.
- **interop** → summary (detected of known kinds, wired as peers, would be offered, detected-at), then one row per agent with the wiring sentence. Boundary: detection reads files only, starts no agent, and the version shown is the last one Clio recorded — `"opening this panel cannot become 'execute every coding agent installed on this machine'"`.
- **routing** → target selector (targets derived client-side from the model rows, deduped and `localeCompare`-sorted), then a filtered model grid. Filter is a `useDeferredValue` over the lowercased query, matched against `[modelId, runtimeId, residency, ...capabilities]`. Zero values render `"Not reported"`, never `0`.
- **dispatch** → installation-wide, explicitly not project-scoped and not a live stream: `"This is global installation state, not a fact about the selected project and not a live event stream."`
- **recovery**, **evidence**, **fleet**, **eval**, **decisions** → see their own artifacts.

**Shared idioms worth extracting into `client/design/`:**
- `<StatusMark tone label>` — a glyph + label pair with tones `success | warning | error | neutral | info | action`. Used by every panel; there is no other status primitive.
- A `PanelHeading` with `eyebrow` (all-caps, wide-tracked), `title`, optional action slot. Every panel opens with an eyebrow that names the data's *scope and mutability*: `EVIDENCE BUNDLES · INSTALLATION-WIDE`, `DURABLE ACCOUNTING · TRACE DATABASE`, `EVAL REPORTS · INSTALLATION-WIDE · READ ONLY`, `INSTALLATION · REDACTED DIAGNOSTICS`, `MODELS · WORKER ROUTING`, `GATE DECISIONS · SEALED COORDINATOR VERDICTS`, `COUNCIL TOPOLOGY · SEATED VOICES AND ROUNDS`, `APPROVAL NEEDED · ONE USE`.
- A closing **boundary paragraph** on every panel naming exactly what stays on the host. These are not boilerplate; each one is specific and each should survive.
- Formatters: `formatTokens(v) = v === null ? "not recorded" : v.toLocaleString("en-US")`; `formatCostUsd(v) = v === null ? "not recorded" : "$" + v.toFixed(v > 0 && v < 0.01 ? 4 : 2)` — **exactly zero prints as `$0.00`, not "free", because a local runtime that prices at zero and a run whose cost was never recorded are different facts and only the second is null**. `client/api/clock.ts` already has `formatCost` and `formatTokens` matching this; keep them.
