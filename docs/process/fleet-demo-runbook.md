# Fleet Demo Runbook

A repeatable multi-node demonstration: one orchestrator drives a real
CMake/C++ fix through a reviewer-gated dispatch across SSH nodes, and every
worker's receipt (including the remote ones) verifies afterward. The steps
are executable in order; this document doubles as the recording script.
Background and reference: [fleet-dispatch.md](../guide/fleet-dispatch.md).

## Reference fabric

| Role | Machine | Notes |
| --- | --- | --- |
| Orchestrator | `local` | Runs the interactive Clio session. |
| SSH node | `node-a` | General worker capacity. |
| SSH node | `node-b` | Serves the operator's resident models on its GPU; residency stays observe. |
| SSH node | `node-c` | General worker capacity. |

All four machines share the filesystem, so the project root resolves to the
same absolute path everywhere. The demo project is any CMake/C++ repository
with a known failing build or test; a one-line compile error in a `.cpp` file
works well on camera.

## 1. Declare the fleet (local)

Add the nodes to `settings.yaml` (see `clio-coder paths` for its location):

```yaml
fleet:
  nodes:
    - id: node-a
      host: node-a.example.net
      maxWorkers: 2
    - id: node-b
      host: node-b.example.net
      maxWorkers: 1
      residency: observe
    - id: node-c
      host: node-c.example.net
      maxWorkers: 2
```

The implicit `local` node (the orchestrator host itself) is never declared. `residency:
observe` is the default and is written here only to make the demo point
explicit: workers on node-b must never evict its resident models.

## 2. Preflight the nodes

```
clio-coder doctor
```

Doctor probes each node over its real SSH channel: reachability, a
version-matched `clio-coder` on the remote path, path parity for the project root,
and a writable remote state dir. Those rows are read-only diagnostics: the
current command does not create or refresh `fleet-preflight.json`, so it does
not make a passing node dispatch-eligible. Placement can still consume an
existing preflight record, but admission fails closed when that record is
missing or stale after a host, project, or version change. There is currently
no mutating doctor command that refreshes it.

Confirm the durable view:

```
clio-coder fleet status
```

## 3. Open the session and the fleet views

```
clio-coder
```

In the session:

- `/fleet` opens Settings → Fleet; its node rows show node-a, node-b, and node-c
  online with their capacity.
- Alt+W toggles the dispatch board, which will fill with per-run cards once
  work starts.

## 4. Dispatch the gated fix across nodes

Give the orchestrator a concrete instruction that names the topology and the
placement. Example prompt for the chat input:

```
Dispatch the fix for the failing CMake build as a reviewed task: builder on
node node-a, reviewer on node node-c, at most 2 review cycles. The task is:
"Fix the compile error in src/mesh/loader.cpp so `cmake --build build` and
`ctest --test-dir build` both pass. Keep the change minimal."
```

The model calls the dispatch tool with `review: {max_cycles: 2, node:
"node-c"}` and `node: "node-a"` on the task. Because a remote placement is
plan-scale, supervised autonomy parks the call and shows the plan artifact
(topology, per-task agent, model, node); one approval launches the whole
plan. Full-auto skips the stop and seals the plan hash into the receipts
instead.

What to watch:

- The board card for the builder shows `node node-a`, live tool activity, and
  the per-worker context meter.
- The reviewer card shows `node node-c` and `gate reviewer c1`; the reviewer
  runs read-only and ends with a `VERDICT:` line.
- On a revise verdict, a second builder card appears with `gate builder c2`;
  the reviewer's findings were threaded to it as input data.
- The `Alt+W` Fleet Runs board carries the node column for both runs.

If a node dies mid-run (for the demo: stop sshd on node-a), the run finalizes
as stalled, the node is classified dead after consecutive channel failures,
and the bounded retry reroutes to a survivor with the hop recorded on the new
receipt.

## 5. Collect the results

The dispatch tool returns the gate verdict, the run ids, and the receipt
paths. The monitor tool answers follow-ups inside the session (`mode=list`,
`mode=status`, `mode=receipt`). For asynchronous work the same flow applies
with `detach: true` plus `monitor mode="collect"`; the demo keeps the gate
attached so the verdict lands in one message.

Verify the fix like any local change:

```
cmake --build build && ctest --test-dir build
```

## 6. Verify every receipt, including the remote ones

```
clio-coder fleet status --json
clio-coder evidence build --run <builderRunId>
clio-coder evidence build --run <reviewerRunId>
clio-coder evidence list
clio-coder evidence inspect <evidenceId>
```

`clio-coder evidence build` recomputes the receipt's integrity digest against the
run ledger; a tampered or mismatched receipt fails the build with the field
that diverged. The receipts of the remote runs verify on the orchestrator host because the
ledger and receipts live on the shared filesystem. Current receipts use strict
v20 and authenticate every current receipt and reconstructed-ledger field.
Lower versions are reported as retired and are never read as evidence or
migrated; malformed and future shapes fail verification.

## Provenance walkthrough: what a PI can verify from receipts alone

Each run's receipt is a JSON file under `<state>/receipts/<runId>.json`
(`clio-coder paths` shows the state dir; the monitor tool prints the exact path per
run). From the receipts alone, with no session transcript, a PI can
reconstruct:

1. What ran and where. `agentId`, `task`, `targetId`, `wireModelId`,
   `runtimeKind`, and `node` name the agent, model, and machine. `identity`
   anchors the host, user, and any HPC scheduler allocation. `reroutes` lists
   every dead-node failover hop the run survived.
2. Against which code. `reproducibility.git` records branch, commit, dirty
   state, and a status hash of the working tree at run start; `cwd` is the
   workspace.
3. Under which authority. `autonomyEnforcement` seals the autonomy level and
   how the runtime enforced it. `safety` counts allowed, blocked, and
   permission-requested tool calls and lists blocked attempts.
   `plan` proves the dispatch was operator-approved (or full-auto logged)
   and hashes the exact plan artifact.
4. Through which gate. `gate` on the reviewer receipt references the builder
   run id and its receipt digest; a revise builder references the reviewer
   that sent it back, with the verdict. Following `gate.subjects` digests
   backward reconstructs the whole review chain, and any edit to an earlier
   receipt breaks the digest the later one recorded.
5. That nothing was altered. The `integrity` block is a sha256 over the
   complete receipt schema and its stable ledger row. `clio-coder evidence build
   --run <id>` recomputes and cross-checks it; `verifyReceiptIntegrity` in
   `src/domains/dispatch/receipt-integrity.ts` is the reference
	implementation. Current receipts use v20. Lower versions are reported as
	retired, while malformed and future shapes fail verification. Incompatible
	state may be archived for inspection, but it is never read as evidence through
	a compatibility verifier.

The walkthrough for an audience is three commands: `clio-coder evidence build
--run <id>` (it verifies), open the receipt JSON (read `node`, `gate`,
`plan`, `reproducibility.git`), and `clio-coder evidence build` again after
hand-editing one byte of the receipt (it refuses, naming the mismatch).
