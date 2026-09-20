# Delivery order

> **Reference Design & Planning Blueprint**: This document is an architectural reference blueprint recovered from the deleted `apps/workbench` prototype. It specifies design doctrine, target parity, and inspection layouts for the early GUI preview (`apps/clio-coder-gui`), not verified runtime features of the core v0.5.0 terminal engine.

Extracted from `apps/workbench/HARNESS_COVERAGE.md`. Items 1-8 are historical record with their constraints intact; items 9 and 10 are live policy for the new app.

## The ten items (verbatim, with current status)

1. **Reported token record — implemented.** Preserve terminal usage in the shared projection, render it per outcome, aggregate only visible terminal records, and **say explicitly that the GUI does not infer price.**
   - *Live constraint:* "aggregate only visible terminal records" and "does not infer price" both still apply. Five exact fields, Clio's own cost with provenance, no rate-card multiplication.

2. **Effective Clio Coder map — implemented.** The GUI host adapts fixed, read-only `config inspect --json` output into bounded DTOs and visualizes loaded settings, context, prompts, rules, agents, skills, extensions, hooks, trust, precedence, reload timing, and context cost. It answers **"why is Clio Coder behaving this way?"** without asking the operator to read YAML or inspect directories, and without sending raw values to the browser.
   - *Live:* `/api/workspaces/:id/config-graph`. The question it answers is the right framing for the whole settings area; keep it as the page's stated purpose.

3. **Capability atlas — partially implemented.** Fixed read-only adapters project Agents, installed Skills, installed Extensions, and Library resources into **independently fallible, bounded collections** with search, provenance, trust, precedence, and budget facts. The Verifiers tab deliberately remains an interface-boundary explanation until Clio Coder publishes a typed listing; **the GUI does not scrape its formatted authoring preview.**
   - *Now:* the Library page opens on a Catalog of every package kind with both scopes per row, and install, update, enable, disable and remove run as plan, review, apply. See `cli-surface-routing.md`, "What the app ships".
   - *Status:* `verifiers inspect --json` landed, so the Verifiers tab can become real. "Independently fallible" is the property to preserve.

4. **Offline model and worker routing inventory — implemented.** Settings can explicitly inspect bounded model capabilities, token limits, reported residency, worker profiles, and agent bindings. **The three fixed JSON reads run in parallel and fail independently.** The GUI does not probe endpoints, expose provider configuration, or **treat cached/offline facts as health**; authoring and live routing still require typed operations and events.
   - *Live constraint:* offline residency is not health. Label it as reported/cached, with its age.

5. **Historical evidence and economics — Usage partially implemented.** A fixed project-filtered JSONL adapter powers the 30-day Usage record and discards the upstream report's global or raw rows. Evidence has no JSON listing, eval report lacks typed discovery, and trace runs are global and carry raw requests; **those boundaries remain visible in the GUI rather than being scraped around.** Never pass arbitrary CLI output to the browser.
   - *Status:* all three named gaps are resolved (`evidence inventory --json`, `eval inventory --json`, `trace inspect --json`). The habit — make a boundary visible rather than scrape around it — is the part to keep.

6. **Installation dispatch status — implemented.** A fixed `fleet status --json` adapter projects global admission, heartbeat counts, the reported retry count, and exact cumulative totals into a **separate installation-scoped view.** Raw durable rows and identities never cross, **the snapshot survives browser reload**, and no run, drain, or resume operation is exposed.
   - *Live constraint:* installation-scoped facts belong in their own view, not mixed into a project view. "Survives browser reload" is a real requirement for a GUI that wants to feel instant.

7. **Installation recovery check — implemented.** Settings can manually run the fixed machine-readable doctor and path commands. The host projects only severity counts, fixed categories, validated runtime versions, root-resolution count, timestamp, and whether the selected project supplied context. Raw findings and native identities stay host-side. **The GUI passes no `--fix` flag and exposes no repair control; it states that doctor may refresh durable fleet eligibility.**
   - *Live constraint:* the side-effect disclosure. Per-check name/section/verdict now crosses (parity item 6), so the counts-only limit is superseded; the `--fix` abstention and the disclosure are not.

8. **Expand the ACP event extension upstream. Dispatch lifecycle and agent attribution implemented.** The `clio-coder/event` allowlist carries the five dispatch lifecycle kinds alongside `safety.loopBlocked`, and `session/update` carries a `clio-coder/agent` attribution **additively** in `_meta`. **The remaining priorities are context activity/warning/pruned/recalled, tool budget, safety block, agent status, runtime notice, budget alert, and config-reload classification.** Version and sanitize each DTO; **do not expose raw `unknown` worker events or full settings snapshots.**
   - *Status:* allowlist is 7 kinds now (`accountability.evidenceReady` joined). The nine remaining priorities are unchanged and each has a typed payload waiting — see the event-bus artifact. The two "do not" clauses map to concrete hazards: `DispatchProgressPayload.event` is typed `unknown`, and `ConfigChangePayload.settings` is the whole credential-bearing snapshot.

9. **Expand safe settings upstream.** Add typed get/patch groups with **allowed values, effective source, apply timing, capability flags, and secret redaction. Build graphical forms only after each group is real.**
   - *Live and now largely satisfiable:* `SETTING_CONTROLS` supplies allowed values (`choices`), kind, and optionality; `settingsChangeKind()` supplies apply timing; `config inspect --json` supplies effective source. What remains genuinely missing is **capability flags** (is this control dead in an ACP session? — the `safety.review.*` case) and **secret redaction** for `targets[]`. Ship those two before the settings page claims completeness.

10. **Consequential operations.** Target authoring/auth, fleet run/drain/resume, memory approval, resource installation, verifier authoring, share import, doctor fix, and reset require **preview, scope, confirmation, progress, terminal result, and recovery semantics** before they enter the GUI.
   - *Live policy, and the single most quotable line in either document.* Treat those six stages as the acceptance checklist for every mutation the MVP ships. Note that `library`'s `--dry-run` plan already supplies preview + scope, and `/api/operations/:id` + `/cancel` already supplies progress + terminal result, so the pattern is mostly built — it needs applying uniformly.

## Coordination needed outside the GUI (verbatim)

> Two workstreams cannot be completed honestly inside `apps/workbench` alone:
>
> 1. A harness owner must continue extending the opt-in ACP event surface. **The dispatch lifecycle has landed; context, safety, agent status, runtime notice, budget, and config-reload facts have not.**
> 2. A harness owner must expand the safe settings/operation extensions for config groups and consequential commands; **the renderer must never receive credentials, raw environment values, arbitrary native paths, or unvalidated bus payloads.**

Both still stand. Item 1 is unchanged. Item 2 changes shape for the new app: the *server* may legitimately touch settings files directly, so the blocker is smaller than it was — but the four things the renderer must never receive are unchanged, and `integrations.externalAgents.entries[].env.*` plus `targets[]` credentials are exactly where that rule bites.

## The framing to carry forward

> Until those boundaries exist, the GUI can continue making substantial progress through public machine-readable interfaces.

That sentence is why both documents were worth the effort: they are an inventory of what can be built honestly *today*, separated from what needs someone else first. Any successor document should keep that separation as its organizing principle.
