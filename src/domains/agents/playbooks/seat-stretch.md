---
version: 3
name: seat-stretch
description: "Stretch a subscription seat: scout, build, then an independent review with one revision, one worker at a time. The coordinator applies this playbook's default 20% reserve and a best-supported or cheapest-adequate choice from the budget facts before it starts. An example policy to copy and edit; it changes no harness default."
steps:
  - kind: agent
    id: scout
    agent: coder
    scope: readonly
    dependencies: []
  - kind: agent
    id: build
    agent: coder
    scope: worktree
    dependencies: [scout]
  - kind: loop
    id: review
    maxAttempts: 2
    dependencies: [build]
    check: {kind: agent, agent: verifier, scope: readonly}
    repair: {kind: agent, agent: coder, scope: worktree}
maxWorkers: 1
onFailure: stop
---

{{task}}

This is one chain with several authors. Do only the step you were given.

Workers: the coordinator has already decided to start this chain, and that
decision stands. Do only your step from the paragraphs below and skip the
coordinator section after them; that policy is the coordinator's alone. Do
not call `context(scope="budget")` and do not read or recheck the reserve,
the quota pool, the spend or the forecasts. Your envelope withholds the
budget on purpose; a withheld or missing budget reading is never a reason to
defer, stop or report your step not done.

Scout. Read only what the request touches and report the files, the current
behaviour and the checks that cover it. Change nothing.

Build. Implement the request from the scout's report. Then check the result
yourself against the whole workspace, not only the files you touched: `git
diff HEAD` shows every tracked change, staged or not, and `git status --short
--untracked-files=all` lists new files, which no diff shows, so read those
(a status without that flag shows an untracked directory as one entry; list
its files). When the request's own checks pass, report done; the review that
follows is independent and does not replace your checks.

Review. A separate read-only verifier inspects the workspace afterwards and
answers a typed pass/fail with per-check evidence. If it fails the build, the
builder receives its failed checks and gets exactly one revision. Close the
findings it reported and nothing else.

Coordinator only, before you start this chain. Workers skip this section.
This policy is the playbook's, not the harness's: copy the playbook and edit
these lines to change it.

- Reserve: 20% of every applicable quota window stays for foreground work.
  This is this playbook's default, not a harness rule; edit the number.
- Preference: cheapest-adequate. The alternative is best-supported.
- Width: one worker at a time (`maxWorkers: 1`).

Read the facts first. `context(scope="budget")` returns an `economics` view:
the session's `spend` (usd, basis, ceilingUsd, headroomUsd), the chat route's
quota `pool` (provider, access, overage, each window's usedPct and resetsAt,
observedAt, ageMs, fresh), and `forecasts`, the plan card's lines for every
dispatchable agent: each `runs` route first, then the `alternative` routes its
router weighs, each with cost and quota per accepted job, accepted attempts,
how many results carry a quality label, and `excluded=` when the router
excludes the route. A proposed dispatch's plan card shows the same `forecast:`
lines beside its routes. Cite the values you used, and report `overage:
permitted` and any unknown charge explicitly: a covered call may carry no
extra fee, but an overage call or an unknown charge is not free.

1. Freshness first. A pool that is not `fresh`, has `status: none`, or has a
   window whose `resetsAt` is earlier than `observedAt` plus `ageMs` (now) is
   no evidence either way: not unlimited, and not a denial even if it says
   `denied`. Do not start the chain on it. Name the missing fact, then do only
   a scoped read or answer `deferred until unknown`.
2. On a fresh pool, a pool or window whose `access` is `denied` binds every
   route that draws on it. Do not start; answer `deferred until <resetsAt>`,
   or `deferred until unknown` when no reset is reported. A window's `access:
   null` only means the provider gave no verdict for that window; the pool's
   `access` stands for it.
3. The pool is the chat route's: the target in settings `chat.target`. A
   forecast line names its route as `<target>/<model>`; a route whose target
   matches draws on this pool. For any other target this view holds no reading, so
   its reserve cannot be checked: rebind that role to the chat route's
   target, bring route-specific evidence, or defer.
4. `usedPct` is a percentage from 0 to 100: `1` means 1% used, not all of
   it. A window is at its line when its `usedPct` is at least 100 minus the
   Reserve above. A window with `unlimited: true` has no line. A pool with no
   windows, or a window whose `usedPct` is null, cannot be checked: defer and
   name it. A window at its line defers the whole chain until that window's
   `resetsAt`. Percent says nothing about one job's draw, so even with every
   window under its line, start only this one-worker chain.
5. Spend with `basis: unobserved` (`usd: null`) is unknown, never zero.
   Remove a candidate only when its forecast high cost per accepted job is
   known and exceeds the session's `headroomUsd`. An `unknown` or
   `insufficient` cost, or an `unbounded` high, removes nothing and holds
   nothing; never cite it as zero.
6. The bound routes are the default choice. A cold start has no forecast, so
   start on them rather than hold the chain for evidence it cannot have yet.
   Drop any candidate whose line carries `excluded=`. A `+N more candidates`
   line counts routes not shown; they are no evidence and never hold the
   chain. Accepted attempts and
   `quality labeled` counts say how much evidence a line rests on, not how
   good the route is: never rank by them. Cheapest-adequate takes the lowest
   forecast cost per accepted job among the remaining candidates, unless
   quality evidence you can cite apart from those counts rules it out;
   best-supported takes the candidate such evidence supports best. Without
   that evidence, or when the forecasts do not separate candidates, the
   answer is `undetermined`: keep the bound route and name the evidence that
   would decide. Do not invent a winner.
7. The routes come from `fleet.agentProfiles` bindings. Every step here runs
   `coder` or `verifier`, so those two bindings route the chain. Choose by
   binding or by a per-call target pin; never by changing settings mid-run.
8. A question that needs only a read goes to one ordinary `scout` dispatch on
   its bound route, not to this chain.

Only rules 1 to 4 defer. When none does, the answer is `start` on the routes
rule 6 leaves.
