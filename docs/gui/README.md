# GUI reference

Working documents for `apps/clio-coder-gui`. Every file here was recovered from the
retired `apps/workbench` reference application before it was deleted, and re-verified
against the current `src/` where the original had gone stale.

| Document | What it is |
| --- | --- |
| [`parity/01-cli-surface.md`](parity/01-cli-surface.md) | Command-line surface parity, 32 rows |
| [`parity/02-slash-and-surfaces.md`](parity/02-slash-and-surfaces.md) | Slash-command families and interactive surfaces, 63 rows |
| [`parity/03-domains-and-plan.md`](parity/03-domains-and-plan.md) | Runtime domain roster and the ordered implementation plan |
| [`settings-write-surface.md`](settings-write-surface.md) | The settings coverage table, ported to schema v2. Gates what the GUI may write |
| [`event-bus-coverage.md`](event-bus-coverage.md) | Canonical event families and which cross the ACP boundary |
| [`workflow-coverage.md`](workflow-coverage.md) | Human workflow coverage, 33 rows |
| [`cli-surface-routing.md`](cli-surface-routing.md) | Every registered command and where it is routed in the GUI |
| [`boundary-doctrine.md`](boundary-doctrine.md) | Why the parity verdicts land where they do |
| [`delivery-order.md`](delivery-order.md) | Delivery sequence and the work that cannot be done inside the GUI |
| [`performance-baseline.md`](performance-baseline.md) | Measured rendering evidence and the v0.5.0 regression budgets |
| [`inspector-presentation.md`](inspector-presentation.md) | What the retired inspectors showed and in what order |
| [`chat-rendering-spec.md`](chat-rendering-spec.md) | The conversation view and inspector blueprint, 17 artifacts with destination paths |

The settings table is the load-bearing one. It records that the workbench's original
table named 27 v1 keys that schema v2 retired, and that `SETTING_CONTROLS` in
`src/core/settings-controls.ts` already machine-generates the leaf registry, so the
GUI derives its form from the schema rather than transcribing paths by hand.

The chat specification is the implementation blueprint for the conversation view.
It carries the turn-grouping model, the per-tool-kind card taxonomy, diff and
approval rendering, and the closed label vocabularies the inspectors need, each
artifact addressed to the file it belongs in.
