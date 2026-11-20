export const FLEET_HELP = `clio-coder fleet <subcommand>

Run repo-owned playbooks on the fleet, and inspect the dispatch status surface.
Author and check playbooks with clio-coder playbook.

Subcommands:
  nodes add|discover|install|tools|list|remove|test
                                manage SSH worker nodes and project verification
  land [<run>] [options]        list, preview or land task branches finished runs kept
  run <playbook> [--var k=v ...]  preflight and execute a playbook
       [--resume <runId>]        replay a completed prefix from a prior run of the same plan
       [--output-format text|json|stream-json]
                                json prints one fleet_end result document; stream-json prints
                                fleet_started, step_dispatched, step_settled and fleet_end lines
       [--cwd <dir>]             run as if started in <dir>
       [--timeout <duration>]    stop the fleet when the deadline passes and exit 124 (bare number: seconds)
       [--max-cost-usd <usd>]    stop the fleet once settled steps spend this much and exit 4; the cap
                                is the lower of this and the playbook's budgetUsd
       [--detach]               start the fleet in the background and return once its root is recorded;
                                json prints one fleet_accepted line
       [--json]                 deprecated: the per-step JSON lines of earlier releases
  status [--json] [--all]       show running, retrying, and total dispatch state
  list [--all-projects] [--limit N] [--json]
                                list this project's fleet roots, newest first, with each one's state
                                (sealed, ended, running, orphaned) and sealed outcome; --all is an alias
  decisions --json [--all]      emit a bounded window of sealed review and compete gate verdicts
  view <runId> [--follow] [--all]  read one run's ledger entry, event journal, and run record
  view <fleetRootId> [--all]    list a fleet run's steps and the run id to view for each
  code-steps <rootId> [--json]  list the deterministic code steps one fleet root ran, from the
                                code_step.settled records in the root's run journal
  events <fleetRootId> [--follow] [--json] [--all]
                                print a fleet run's live event journal of hash-chained, unsigned
                                lines; each settled step names the manifest bytes written at that
                                moment, and --follow exits after fleet_sealed
  verify <runId> [--json] [--exit-code]
                                re-verify one run's sealed scope now and print its trust state;
                                --exit-code exits 0 verified, 1 failed or unavailable, 75 pending
  admission [status|drain|open] [--json]
                                show the dispatch admission gate, deny new execution starts for up
                                to one hour (drain), or reopen it (open)
  drain [--json]                alias of admission drain
  resume [--json]               alias of admission open
  cancel <runId> [--json] [--reason <text>]
                                cancel one running run from any terminal
  cancel <fleetRootId> [--json] [--reason <text>]
                                stop a fleet root: no further step starts and its running steps are canceled;
                                a root that already sealed exits 0 with its recorded outcome
  wait <fleetRootId> [--timeout <duration>] [--json]
                                wait for a fleet root to seal and print its fleet result; exits with the
                                root's exit code, 1 when its owner died unsealed, 75 when --timeout expires

Notes:
  Inspection defaults to this project. Pass --all to inspect machine-wide state.
  status reads the durable run ledger. Rows started by another process show
  heartbeat liveness from the recorded worker pid; per-token live meters are
  only available inside the process that owns the run.
  view is read-only and shares no memory with the orchestrator, so it follows a
  run from a second terminal or over SSH. Its transcript comes from the run
  event journal, written when fleet.history.journal is on (the default). Handed the
  fleet-<hex> root id that run prints, it lists that run's steps instead.
  drain preserves running work. Repeat it to renew the one-hour expiry; resume
  clears it early. The expiry keeps an abandoned drain from wedging CLIO Coder.
  cancel asks the process that owns the run to abort it and waits up to 15s
  for the run to seal canceled; it exits 1 while the request is still pending.
  When the owning process is gone it terminates the orphaned worker's process
  group and settles the ledger row itself.
  fleet run exits 0 when every required step succeeded and every loop converged,
  1 otherwise, and the signal's code when interrupted. With --output-format it
  exits 141 once the fleet has sealed if stdout's reader went away; the fleet is
  never canceled for that.
`;

/**
 * Answer the fleet group's own help without loading src/cli/fleet.ts and its domain graph, the way run-help.ts
 * answers `run --help`. The checks mirror runFleetCommand's, in its order: `view` and `events` own their help, so
 * they return null; otherwise `help` or `--help`/`-h` anywhere prints the group help on stdout (exit 0), and no
 * verb prints it on stderr (exit 2). Returns null when the arguments ask for a fleet verb.
 */
export function answerFleetHelp(args: ReadonlyArray<string>): number | null {
	const sub = args[0];
	const asksHelp = args.includes("--help") || args.includes("-h");
	if ((sub === "view" || sub === "events") && asksHelp) return null;
	if (sub === "help" || asksHelp) {
		process.stdout.write(FLEET_HELP);
		return 0;
	}
	if (sub === undefined) {
		process.stderr.write(FLEET_HELP);
		return 2;
	}
	return null;
}
