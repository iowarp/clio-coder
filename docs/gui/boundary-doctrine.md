# GUI boundary doctrine

> **Reference Design & Planning Blueprint**: This document is an architectural reference blueprint recovered from the deleted `apps/workbench` prototype. It specifies design doctrine, target parity, and inspection layouts for the early GUI preview (`apps/clio-coder-gui`), not verified runtime features of the core v0.5.0 terminal engine.

These are the arguments the parity verdicts rest on. The protocol-v4 specifics below are historical; the reasoning is the artifact.

## 1. What the workbench boundary actually was (historical, for calibration)

GUI protocol v4 validated **36 client commands**:

`project.browse`, `project.open`, `project.select`, `project.forget`, `fs.refresh`, `fs.create-file`, `fs.create-folder`, `fs.move`, `fs.delete.prepare`, `fs.delete.confirm`, `session.new`, `session.load`, `session.close`, `session.list`, `session.label`, `session.delete`, `turn.start`, `turn.cancel`, `permission.resolve`, `settings.get`, `settings.patch`, `targets.list`, `targets.probe`, `autonomy.set`, `config.inspect`, `catalog.inspect`, `usage.inspect`, `routing.inspect`, `dispatch.inspect`, `fleet.inspect`, `toolchain.inspect`, `trace.inspect`, `evidence.inspect`, `evidence.read`, `fleet.verify`, `recovery.inspect`.

and **35 server event kinds**:

`connection.ready`, `project.browse.listing`, `project.opened`, `project.forgotten`, `project.snapshot`, `fs.changed`, `fs.delete.challenge`, `clio-coder.state`, `session.list`, `settings.state`, `targets.state`, `targets.probed`, `config.state`, `catalog.state`, `usage.state`, `routing.state`, `dispatch.state`, `fleet.inspection.state`, `toolchain.state`, `trace.state`, `evidence.state`, `evidence.detail.state`, `fleet.verification.state`, `recovery.state`, `turn.started`, `turn.text`, `turn.thought`, `turn.tool`, `turn.loop`, `turn.permission.requested`, `turn.permission.resolved`, `turn.terminal`, `fleet.activity`, `protocol.error`, `command.error`.

The bootstrap carried an optional `appVersion` string bounded to 64 bytes; a host that omitted it still produced a valid bootstrap, and the About record then said the version was not reported. **That pattern — an optional field whose absence is rendered as "not reported" rather than as a blank — is worth copying everywhere.**

The rule, verbatim: *"That closed set is an asset. New harness areas should enter as small typed DTO families, not as a generic 'run CLI' or 'render JSON' escape hatch."* The new app's `contracts/routes.ts` TypeBox table is the same asset in a different shape. Keep it closed.

## 2. The artifact allowlist — the browser may only point at what it was shown

The strongest idea in either document, and the one most worth porting.

**Thirty-four of the thirty-six client commands carried no artifact identity at all**, "which is the property that makes this boundary auditable: a host adapter with fixed argv cannot be steered anywhere by anything a frame says." The two exceptions were `evidence.read` and `fleet.verify`, and they went through one shared allowlist (`apps/workbench/artifact-allowlist.ts`) rather than each inventing a policy.

The rules, verbatim and each load-bearing:

- *"The browser never introduces an identifier. It may only echo one the host itself served, inside the snapshot the host is currently showing."*
- *"The window is replaced wholesale on each new snapshot rather than accumulated, so an artifact that has aged out stops being referenceable: the browser is asking about something the host no longer claims exists, and being told so is more truthful than a lookup."*
- *"A reference outside the window is refused rather than searched for, which is why it answers `refused` and not `not-found`."*
- *"Serving an id a projection could not have produced is treated as a host bug and refused outright, because an allowlist filled from a broken projection is worse than no allowlist at all."*
- *"The admitted value is the caller's only licence to build argv, and every consumer uses the return rather than its own input."*
- *"This is deliberately not a capability token, a session, or a cache. It is the smallest thing that makes 'the browser may only point at what it was shown' checkable in one place."*

**The consequence that reads like a bug and is not:** *"A run id printed inside the fleet-root step index is not thereby referenceable: the host serves the run window from the rows of `fleet.inspect`, and a step whose run has aged out of that window is shown but not served. **Being displayed and being served are different things, and the allowlist tracks the second.**"*

### Porting note

The new app is a REST server, so the equivalent is: **a path parameter is admitted only if the server can independently re-derive it from a current projection, and the handler builds its subprocess argv from the re-derived value, never from the raw param.** Refuse with 403-`refused` rather than 404-`not found` when the id is outside the window, because the distinction is information the operator wants. Put the check in one module so no route re-derives its own policy.

## 3. Exclusion is not redaction — "count instead"

Verbatim:

> Some payloads are not redaction decisions but exclusions. A trace event's `payload_json` and a process row's command line have no safe projection at any width: **truncating a command line still leaks the binary and the first argument, and a payload is arbitrary by construction.** So the rule for those is not "project less", it is **"count instead"**. The trace aggregates are computed in SQL precisely so the excluded columns are never loaded on the way to counting them, **which turns the boundary into a property of the query rather than a discipline in the projection.**

And the naming rule:

> The matrix marks this class `host-only-by-design`, separately from `deferred-by-design`, because **"we will not carry this" and "we have not built this yet" should not read the same to whoever picks the work up.**

**STATUS IN THE NEW APP: deliberately reversed for traces.** `apps/clio-coder-gui/contracts/traces.ts` carries `payload_json` and process `command` + `command_digest`. That is legitimate — the workbench shipped a browser talking over a protocol, the new app is a localhost server the operator started against their own machine — but three things from this section still apply:

1. **Keep the vocabulary.** `host-only-by-design` vs `deferred-by-design` is a distinction worth preserving in any new parity doc, whatever the verdicts become.
2. **Keep "the boundary is a property of the query."** Where a field genuinely must not cross, exclude it in SQL rather than trusting a projection to drop it. That is how it stays excluded when someone adds a new consumer.
3. **Keep saying so on screen.** The workbench's rule was that the panel names the exclusion "rather than leaving the absence to be inferred." Wherever the new app does still withhold something, name it.

## 4. Redaction is a decision about which field, not which record

Verbatim, on doctor findings:

> A doctor finding is the clearest case: its **detail** is free prose that routinely quotes native paths, endpoint URLs, socket paths, model ids, and session ids, and no version of it can safely cross. Its **name** is a fixed check label plus the subject the check ran against, which is a different kind of fact and is what separates **"one models check failed"** from **"model zbook failed"**. So the detail stays on the host and the name crosses, **subject to a structural shape rule rather than a fixed vocabulary, so that a harness renaming a check costs that check its name and nothing else costs the sweep.**

That last clause is the generalizable engineering lesson: **validate a crossing string by shape, not by enum, when the producer is allowed to evolve.** A closed vocabulary makes a harness rename break the whole surface; a shape rule makes it degrade exactly one row.

## 5. Separate durable stores get separate commands and an explicit `available` flag

Verbatim:

> Durable trace accounting is keyed by the same run ids the run journal already lists, which looks like the fleet-root case, but it is not: **the ledger and the trace database are separate durable stores with separate failure modes, and an installation that never enabled tracing has no trace database at all.** Folding that read into `fleet.inspect` would have made a missing trace file a failure of the run journal. It gets its own command, its own event, and an **explicit `available` flag**, because **"tracing was never on" and "the database holds no runs" are different answers and an operator is entitled to both.**

The new app honours this with `/api/traces/status`. Extend the same treatment to every store the GUI reads: evidence, evals, usage, the decision store. **Three states, always: unavailable / available-and-empty / available-with-rows.** Never collapse the first two into an empty list.

## 6. A new surface finds bugs — that is part of its value

Verbatim, on the evidence inventory:

> What makes it worth having is a field the store held and the reader dropped: **`redactionCount` was written to every bundle, declared on the overview type, and silently discarded by the parser that reads it back.** Adding a GUI surface is a good way to find that, **because a projection has to name every field it forwards.**

Keep the discipline that produced this: an explicit field-by-field projection, never a spread of the upstream object.

## 7. Widen a DTO rather than invent a command — and pay the price on both sides

Verbatim:

> A harness fact that is genuinely part of an existing family widens that family's DTO instead of claiming a new command kind. The fleet-root step index arrived that way: it is the parent of the durable runs `fleet.inspect` already reads, so it rides the same fixed read and the same `fleet.inspection.state` event **rather than paying for a second child process and a second global cache.** Widening a DTO is not free either, and the price is paid where it belongs: **the host projection and the browser validator both grew the new keys as required, so a snapshot from a build on either side of the change is rejected rather than partly believed.**

"Rejected rather than partly believed" is the rule. Make new DTO fields required on both sides in the same change.

## 8. Request isolation — why the GUI stays responsive

Verbatim, and directly relevant to the operator's speed goal:

> Config, catalog, Usage, routing, dispatch, and recovery inspection run through **a separate serialized request lane alongside ACP**: slow inspections cannot block turn cancellation or permission resolution, late results from a previously selected project are discarded, and **each multi-read inspector executes its fixed commands in parallel while failing independently.** Host integration tests cover that isolation.

Three properties to preserve in the new app:

1. **Inspection must never share a lane with turn control.** A hung `doctor` must not delay a cancel or an approval. In the new app that means the inspection routes and the ACP session routes must not contend on one subprocess queue.
2. **Late results from a superseded selection are discarded, not rendered.** React Query's `cancelRefetch` / per-workspace query keys give this if the keys include the workspace id; assert it in a test.
3. **Parallel and independently fallible.** A multi-read page renders the reads that succeeded and names the ones that failed, per read. Never fail a whole page because one of four adapters errored.

> Future command adapters should retain the same fixed-argv, bounded-output, typed-projection discipline **and disclose any diagnostic side effect.**

The live example of that last clause: the doctor sweep **may refresh durable fleet eligibility facts**, and the workbench said so on screen. A read that is not purely a read must announce it.
