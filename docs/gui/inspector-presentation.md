# Inspector presentation atlas

> **Reference Design & Planning Blueprint**: This document is an architectural reference blueprint recovered from the deleted `apps/workbench` prototype. It specifies design doctrine, target parity, and inspection layouts for the early GUI preview (`apps/clio-coder-gui`), not verified runtime features of the core v0.5.0 terminal engine.

What each of the retired workbench's thirteen inspectors showed, in what order, and
which route in `apps/clio-coder-gui` now carries the same data. The data is
reproduced; the presentation decisions recorded here are what the new GUI still owes.

**Verification of the audit's data claim, per inspector → new route:**

| Inspector | Data reproduced by | Verdict |
| --- | --- | --- |
| catalog (26K) | `contracts/library.ts` | yes, with agents/skills/verifiers/extensions collapsed into one `Library` shape |
| config (16K) | `contracts/settings.ts` + `settings-safe.ts` | yes: `ConfigEntry.contextCostTokens` and `reloadClass` are on the wire |
| decisions (12K) | `contracts/evidence.ts` (`gate`) | yes, but shape is opaque (`JSON.stringify(gate)` at evidence.tsx:226) |
| dispatch (8K) | `contracts/fleet.ts` | yes |
| evidence (17K) | `contracts/evidence.ts` | yes |
| fleet (25K) | `contracts/fleet.ts` + `fleet-events.ts` | yes |
| interop (11K) | `contracts/system.ts` | yes: `wiring`, `decisionStale` and `decidedAt` are on the wire, derived by the core's own `interopProposals` |
| recovery (10K) | `contracts/system.ts` | yes |
| routing (12K) | `contracts/targets.ts` | yes |
| toolchain (9K) | `contracts/toolchain.ts` | yes |
| trace (15K) | `contracts/traces.ts` | yes |
| usage (16K) | `contracts/reports.ts` | yes: the token fields and the origin split are read out of `facts[].values` by `client/pages/usage-model.ts` |

**The empty-state grammar — the most reusable thing here.** Every panel distinguished four states and used different words for each. Reproduce this everywhere:
1. *Not read in this session* — `"The durable evidence inventory has not been read in this session."` / `"No diagnostic sweep has run in this desktop session. Nothing is inferred from a successful conversation."`
2. *Store missing* — `"This installation has never built evidence, so it has no evidence store at all. That is a missing store, not an empty one."` A dash in a figure means the store was not found: `"A dash means Clio Coder could not find that local history store. It does not mean zero activity."`
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
- **recovery**, **evidence**, **fleet**, **decisions** → see their own artifacts.

**Shared idioms worth extracting into `client/design/`:**
- `<StatusMark tone label>` — a glyph + label pair with tones `success | warning | error | neutral | info | action`. Used by every panel; there is no other status primitive.
- A `PanelHeading` with `eyebrow` (all-caps, wide-tracked), `title`, optional action slot. Every panel opens with an eyebrow that names the data's *scope and mutability*: `EVIDENCE BUNDLES · INSTALLATION-WIDE`, `DURABLE ACCOUNTING · TRACE DATABASE`, `INSTALLATION · REDACTED DIAGNOSTICS`, `MODELS · WORKER ROUTING`, `GATE DECISIONS · SEALED COORDINATOR VERDICTS`, `COUNCIL TOPOLOGY · SEATED VOICES AND ROUNDS`, `APPROVAL NEEDED · ONE USE`.
- A closing **boundary paragraph** on every panel naming exactly what stays on the host. These are not boilerplate; each one is specific and each should survive.
- Formatters: `formatTokens(v) = v === null ? "not recorded" : v.toLocaleString("en-US")`; `formatCostUsd(v) = v === null ? "not recorded" : "$" + v.toFixed(v > 0 && v < 0.01 ? 4 : 2)` — **exactly zero prints as `$0.00`, not "free", because a local runtime that prices at zero and a run whose cost was never recorded are different facts and only the second is null**. `client/api/clock.ts` already has `formatCost` and `formatTokens` matching this; keep them.

**Status against this atlas.** Every claim above is either built or listed here as a deliberate difference.

| Inspector | Where it lives now | Pure model and test |
| --- | --- | --- |
| config | `/settings/why` (four figures, influence path, inventory by category) and `/settings/effective` (settings grouped by family) | `client/pages/config-map-model.ts`, `tests/config-map-model.test.ts` |
| catalog | `/library`: a `tablist` with arrow, Home and End keys; agent cards in the fact order above; skill cards led by the reach sentence; free text across every string field | `client/pages/library-model.ts`, `tests/library-model.test.ts` |
| interop | `/system/interop`: summary, one card per kind with the wiring sentence | `client/pages/interop-model.ts`, `tests/interop-model.test.ts`, `tests/system-http.test.ts` |
| dispatch | `/fleet`, which carries the installation-wide sentence as `DISPATCH_SCOPE` | `client/design/panel-model.ts` |
| usage, trace, toolchain, routing, evidence, decisions | unchanged since the previous sprint | `usage-model.ts`, `trace-model.ts`, `toolchain-model.ts` |

Every page now opens with a `PanelHeading` from the `PANELS` registry and closes with its own `Boundary`. An eyebrow ends in one word from `MUTABILITIES`, and `tests/panel-model.test.ts` holds the registry to that list.

Deliberate differences from the retired workbench:

- **The interop read probes versions only when asked.** Opening `/system/interop` reads files and runs nothing, as the workbench did, and shows the last version Clio Coder recorded. The "Detect again and probe versions" button sends `?probe=versions`, which runs one bounded `<bin> --version` per installed agent inside a scratch home. Each version says which of the two it is (`versionSource`), and `tests/system-http.test.ts` holds both halves.
- **Wiring has a fifth and a sixth word.** Besides configured, not-ACP, proposed and decided, the wire carries `not-offered` (an ACP kind with no executable to wire and no standing answer) and `unknown` (the settings that decide wiring could not be read). Neither may collapse into one of the four.
- **Two skill footer flags are not on the wire.** "Has an upstream" is derived from `origin.kind === "remote"`. "Installed by a dispatched worker" has no counterpart in `LibraryResource` and is not shown.
- **The entry source line shows the path as the wire gives it.** `ConfigEntry.sourcePath` is absolute in this application, which is local by construction, so there is no project-relative form to prefer. The `"project root"` and `` `${scope} scope` `` rules hold.
- **Wire vocabulary reads as words.** `scalarText` humanizes a lowercase wire token only under a vocabulary key (`kind`, `state`, `status`, `reason`, `outcome`, `verdict`, `level`, `tier`, `mode`, `phase`, `class`, `category`, alone or as a camel-case or snake-case suffix). The key decides, never the value, so an id, name or model is never rewritten.
