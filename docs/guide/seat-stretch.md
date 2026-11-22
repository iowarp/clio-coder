# Stretching a subscription seat

`seat-stretch` is a shipped example playbook for a subscription seat such as
Codex or Copilot. Calls the plan covers may carry no extra fee, but every call
draws on a quota window, a provider that reports `overage: permitted` may
charge for calls past it, and a charge Clio cannot price reads unknown. The
policy reports overage and unknown charges explicitly. It is content, not a
harness feature: the reserve (20% is this playbook's default, which you edit;
the harness has no reserve rule), the one-worker width and the choice between
the best-supported and the cheapest-adequate route are lines of text in
[seat-stretch.md](../../src/domains/agents/playbooks/seat-stretch.md). It adds
no agent, no playbook syntax and no dispatch default, and a user who changes
the reserve, the bindings or the preference changes only content and settings.

## What it runs

The steps are static: a read-only `scout` step reports what the request
touches, a `coder` builds in a task worktree, then a read-only `verifier`
reviews the tree with one bounded revision (`maxAttempts: 2`). `maxWorkers: 1`
runs one worker at a time and `onFailure: stop` ends the chain at the first
failure. Neither is a provider limit. The scout step runs the `coder` recipe
with `scope: readonly`, the user-facing stand-in for the `scout` agent, which
is a shadow agent that a playbook step cannot name. The plan has no quota
conditional and no wake-up.

`fleet run` alone starts the steps without any coordinator applying the
policy: the body goes to the workers, which do only their own step. The
scout, build and repair steps each receive the whole body (the review's
verifier check gets its own rendered check task instead), so it opens with
the worker path: the coordinator's start decision stands, workers skip the
coordinator section, never read or recheck the budget, and never defer or
report a step not done on budget grounds. The builder checks its change
against the whole workspace (`git diff HEAD` for tracked changes, staged or
not; `git status --short --untracked-files=all` for new files, which it
reads) and reports done when the request's checks pass; the review step does
not replace that. Apply the policy first, in an
interactive session or headless, and start the chain only on a `start`
answer:

```bash
clio-coder playbook new my-stretch --from seat-stretch
clio-coder run "Act as coordinator for .clio-coder/playbooks/my-stretch.md: \
apply its coordinator section to context(scope=\"budget\") and answer start \
or deferred, with the routes and the facts you used. Do not dispatch."
clio-coder fleet run my-stretch --var task="Fix the off-by-one in pager.ts"
```

## The facts the coordinator reads

The body ends with a section addressed only to the coordinator, the session
that applies the policy before the chain starts. Workers see only their own
envelope, which withholds the budget, so the facts come from the
coordinator's view:

- `context(scope="budget")` returns an `economics` view. `spend` carries the
  session's usd, its basis, `ceilingUsd` and `headroomUsd`. `pool` carries the
  chat route's last quota reading: `access`, `overage`, each window's `usedPct`
  (a percent from 0 to 100: `1` is 1% used) and `resetsAt`, `observedAt`,
  `ageMs` and `fresh`. `forecasts` carries the
  plan card's lines for every dispatchable agent, the route each runs on first
  and then the alternatives its router weighs: cost and quota per accepted job,
  accepted attempts, how many results carry a quality label, and `excluded=`
  for a route the router excludes.
- Spend no telemetry observes reads `usd: null` with `basis: unobserved`:
  unknown, never zero.
- A proposed dispatch's plan card shows the same `forecast:` lines beside its
  routes.
- The pool reading carries its as-of time and source. When the shared poll
  cache is stale, a headless run's view falls back to the run's own newest
  stream-event quota reading, else a bounded quota poll that makes no inference
  call; a reading that is still stale or missing defers under rule 1 below.

Two shell reports are separate evidence, not this view:
`clio-coder usage report --json` aggregates recorded spend over a day and
repository window, and `clio-coder telemetry quota --json` prints the quota
readings this host journaled; it polls nothing and is not the route-scoped
cache the view reads.

The policy in the body then applies, in order:

1. Freshness first. A reading that is not `fresh`, is missing, or has a window
   whose reset has passed is neither unlimited nor a denial, even if it says
   `denied`. The coordinator names the missing fact and does only a scoped
   read or answers `deferred until unknown`; it never starts the chain on such
   a reading.
2. On a fresh reading, a pool or window the provider reports `access: denied`
   binds every route that draws on it: the answer is `deferred until
   <resetsAt>`. A window with `access: null` has no verdict of its own; the
   pool's stands.
3. The pool is the chat route's, settings `chat.target`. A route whose
   forecast line names that target (`<target>/<model>`) draws on it; a worker
   route on another target has no reading in this view, so its reserve
   cannot be checked: rebind it to the chat route's target, bring
   route-specific evidence, or defer.
4. A window is at its line when its `usedPct` is at least 100 minus the
   `Reserve` line: 80% with the default 20%. A pool with no windows, or a
   window with no `usedPct`, cannot be checked and defers. Percent says
   nothing about one job's draw, so with every window under its line the
   policy starts one worker, never a wider wave.
5. Unobserved spend is unknown. A candidate is out only when its forecast
   high cost per accepted job is known and exceeds `headroomUsd`. An
   `unknown` or `insufficient` cost, or an `unbounded` high, removes nothing,
   holds nothing and never reads as zero.
6. The bound routes are the default. A cold start has no forecast, so the
   chain starts on them. Excluded candidates drop out, and routes a
   `+N more candidates` line omits are no evidence. Accepted attempts and
   quality-label counts measure how much evidence a line rests on, not
   quality, so they never rank routes. `cheapest-adequate` takes the lowest
   forecast cost per accepted job unless independent quality evidence rules
   it out; `best-supported` takes the candidate such evidence supports best.
   Without that evidence, or when forecasts do not separate candidates, the
   answer is `undetermined`: keep the bound route and name the evidence that
   would decide.

Only rules 1 to 4 defer; when none does, the answer is `start`.

Fresh provider denials and the existing USD limits bind every composition,
this one included. With only percent windows there is no hard no-overage
guarantee unless the provider enforces a stop.

## Example bindings

The routes come from settings, not from the playbook. Each profile names one
of your own targets; the coordinator's choice moves with the bindings. Every
step in the chain runs `coder` or `verifier`, so those two bindings route it:
the scout step follows `coder`, and the `scout` binding routes only an
ordinary scout dispatch outside the chain. A conservative setup binds every
role to the cheaper route and keeps the playbook's
`Preference: cheapest-adequate`:

```yaml
fleet:
  profiles:
    frugal:  {target: codex, model: gpt-6-luna, thinkingLevel: low}
    careful: {target: codex, model: gpt-6-luna, thinkingLevel: high}
  agentProfiles:
    scout: frugal
    coder: frugal
    verifier: frugal
```

A quality-first setup gives the chain's coder and reviewer the deeper route,
so its scout step runs there too, keeps ordinary scout dispatches frugal, and
changes the playbook line to `Preference: best-supported`:

```yaml
fleet:
  agentProfiles:
    scout: frugal
    coder: careful
    verifier: careful
```

`clio-coder targets profile set` and `clio-coder targets profile bind` write the
same keys from the shell. A council across several seats names explicitly
approved, labelled members in `fleet.rosters`; a roster with one route is not
a choice, so do not create one for a single seat:

```yaml
fleet:
  rosters:
    seats:
      members:
        - {label: codex, target: codex, model: gpt-6-luna}
        - {label: copilot, target: copilot, model: gpt-6-luna}
```

See [Worker routing](fleet-dispatch.md#worker-routing-profiles-agent-bindings-and-per-call-pins)
for the order in which a route resolves and who may save these keys.

## Changing the policy

Copy the playbook and edit its text:

```bash
clio-coder playbook new my-stretch --from seat-stretch
```

The copy in `.clio-coder/playbooks/my-stretch.md` keeps the steps; change the
`Reserve`, `Preference` and `Width` lines, and `maxWorkers` with the width. A
playbook may add `budgetUsd`, which stays a priced preflight against the
session budget, not a cap on a seat's quota or a personal cash limit. A file
named `seat-stretch.md` in the project or user `playbooks/` directory shadows
the shipped one.
