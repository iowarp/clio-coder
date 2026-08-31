import { deepStrictEqual, equal, ok, rejects, throws } from "node:assert/strict";
import { ClioCliFleetInspector, ClioFleetInspectError, projectFleetInspection } from "../clio-fleet-inspector.ts";

const FIXTURE = new URL("./fleet-inspect-child-fixture.ts", import.meta.url).pathname;

Deno.test("the fleet adapter invokes only the fixed recent-run projection", async () => {
	const root = await Deno.makeTempDir({
		prefix: "clio-coder-gui-fleet-inspect-",
	});
	try {
		const inspector = new ClioCliFleetInspector({
			executable: Deno.execPath(),
			prefixArgs: ["run", "--quiet", "--no-config", FIXTURE, "--"],
			now: () => Date.parse("2026-08-31T14:02:00.000Z"),
		});
		const inspection = await inspector.inspect(root);
		equal(inspection.scope, "installation");
		equal(inspection.inspectedAt, "2026-08-31T14:02:00.000Z");
		equal(inspection.runs.length, 1);
		const run = inspection.runs[0];
		ok(run !== undefined);
		equal(run.runId, "run-alpha");
		equal(run.events.length, 2);
		deepStrictEqual(run.evidence, {
			state: "pending",
			summary: "Receipt pending; this run has not finalized.",
		});
		const rootRow = inspection.roots[0];
		ok(rootRow !== undefined);
		equal(rootRow.rootId, "fleet-345ea2e6c1ad");
		equal(rootRow.plannedSteps, 3);
		equal(rootRow.steps.length, 3);
		// The index points into the run window rather than carrying its own
		// evidence, so no durable fleet-run location rides along with it.
		ok(!JSON.stringify(inspection.roots).includes("/fleet-runs/"));
		const council = inspection.councils[0];
		ok(council !== undefined);
		equal(council.group, "council-mfa2x1-7b3d0e");
		deepStrictEqual(council.members.map((member) => member.label), ["architect", "skeptic"]);
		equal(council.roundsPlanned, 2);
		equal(council.synthesis.kind, "judge");
		equal(council.synthesis.judge?.runId, "run-council-judge");
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("council projection rejects contradictions the ledger cannot produce", () => {
	const member = {
		label: "architect",
		agentId: "researcher",
		target: "local-lmstudio",
		model: "qwen3-coder",
		executionRole: "researcher",
		turns: [
			{ round: 1, runId: "run-a1", status: "completed", outcome: "succeeded", terminal: true },
			{ round: 2, runId: "run-a2", status: "completed", outcome: "succeeded", terminal: true },
		],
		turnsTruncated: false,
	};
	const council = {
		group: "council-mfa2x1-7b3d0e",
		startedAt: "2026-08-31T13:50:00.000Z",
		endedAt: "2026-08-31T13:58:00.000Z",
		running: false,
		roundsPlanned: 2,
		roundsObserved: 2,
		origin: "user",
		approval: "operator",
		members: [member],
		membersTruncated: false,
		membersRejected: 0,
		synthesis: { kind: "judge", sealedRunId: "run-sealed", judge: null },
	};
	const base = {
		version: 1,
		generatedAt: "2026-08-31T14:00:00.000Z",
		runs: [],
		truncated: false,
		roots: [],
		rootsTruncated: false,
		councilsTruncated: false,
	};
	const project = (value: unknown) => projectFleetInspection({ ...base, councils: [value] }, base.generatedAt);
	equal(project(council).councils[0]?.roundsObserved, 2);

	// A member's answer is the one thing this boundary exists to keep out.
	throws(() => project({ ...council, answer: "the schema should own it" }), /invalid council topology/u);
	// The operator writes the label, so it is the one council string the harness
	// did not mint. A label outside the shape both entry paths enforce means the
	// host projection did not run.
	throws(
		() => project({ ...council, members: [{ ...member, label: "/etc/clio-coder/settings.yaml" }] }),
		/invalid council topology/u,
	);
	throws(() => project({ ...council, members: [member, member] }), /duplicate council member labels/u);
	throws(
		() => project({ ...council, roundsObserved: 3, roundsPlanned: 3 }),
		/round count its members do not account for/u,
	);
	throws(() => project({ ...council, roundsPlanned: 1 }), /observed more rounds than it planned/u);
	throws(() => project({ ...council, running: true }), /end stamp contradicts its running state/u);
	throws(
		() => project({ ...council, synthesis: { kind: "judge", sealedRunId: null, judge: null } }),
		/named a council synthesis with no sealed record/u,
	);
	// A vote is tallied from the members' own answers, so it dispatches nobody.
	throws(
		() =>
			project({
				...council,
				synthesis: {
					kind: "vote",
					sealedRunId: "run-sealed",
					judge: {
						runId: "run-judge",
						agentId: "verifier",
						target: "local-lmstudio",
						model: "qwen3-coder",
						status: "completed",
						outcome: "succeeded",
					},
				},
			}),
		/judge run for a council that dispatches none/u,
	);
	// An outcome is written at finalization, so a turn that has not ended has none.
	throws(
		() =>
			project({
				...council,
				members: [{
					...member,
					turns: [{ round: 1, runId: "run-a1", status: "running", outcome: "succeeded", terminal: false }],
				}],
				roundsObserved: 1,
				roundsPlanned: 1,
			}),
		/outcome for a turn that has not finished/u,
	);
	// A member speaks once per round; a repeated round folds two rows into one voice.
	throws(
		() =>
			project({
				...council,
				members: [{
					...member,
					turns: [member.turns[0], { ...member.turns[0], runId: "run-a3" }],
				}],
				roundsObserved: 1,
				roundsPlanned: 1,
			}),
		/turns out of round order/u,
	);
	throws(
		() => projectFleetInspection({ ...base, councils: [council, council] }, base.generatedAt),
		/duplicate council identities/u,
	);
});

Deno.test("fleet projection rejects extra path fields and duplicate run identities", () => {
	const run = {
		runId: "run-alpha",
		agentId: "builder",
		model: "model",
		target: "target",
		node: "local",
		phase: "running",
		startedAt: "2026-08-31T14:00:00.000Z",
		elapsedMs: 10,
		task: null,
		journal: "missing",
		events: [],
		eventsTruncated: false,
		evidence: { state: "pending", summary: "Receipt pending." },
		outcome: null,
		outcomeDetail: null,
		terminal: false,
	};
	const base = {
		version: 1,
		generatedAt: "2026-08-31T14:00:00.000Z",
		truncated: false,
		roots: [],
		rootsTruncated: false,
		councils: [],
		councilsTruncated: false,
	};
	throws(
		() =>
			projectFleetInspection({
				...base,
				runs: [{ ...run, receiptPath: "/secret" }],
			}, base.generatedAt),
		/invalid durable run row/u,
	);
	throws(
		() => projectFleetInspection({ ...base, runs: [run, run] }, base.generatedAt),
		/duplicate durable run identities/u,
	);
	// A snapshot from a build that predates the root index is not a snapshot this
	// GUI can read: the closed key set is what keeps a new field from arriving
	// unvalidated, so it must reject in both directions.
	throws(
		() =>
			projectFleetInspection(
				{ version: 1, generatedAt: base.generatedAt, runs: [], truncated: false },
				base.generatedAt,
			),
		/invalid recent-run snapshot/u,
	);
});

Deno.test("fleet root projection rejects durable paths, bad attribution, and duplicate identities", () => {
	const root = {
		rootId: "fleet-345ea2e6c1ad",
		fleet: "build-review",
		startedAt: "2026-08-31T13:59:00.000Z",
		elapsedMs: 210_000,
		running: true,
		resumedFrom: null,
		plannedSteps: 2,
		recordedSteps: 1,
		steps: [
			{ stepId: "build", runId: "run-alpha", agentId: "builder", outcome: "succeeded", detail: null },
			{ stepId: "apply", runId: null, agentId: null, outcome: "not run", detail: null },
		],
		stepsTruncated: false,
	};
	const base = {
		version: 1,
		generatedAt: "2026-08-31T14:00:00.000Z",
		runs: [],
		truncated: false,
		rootsTruncated: false,
		councils: [],
		councilsTruncated: false,
	};
	const accepted = projectFleetInspection({ ...base, roots: [root] }, base.generatedAt);
	equal(accepted.roots[0]?.steps[1]?.agentId, null);
	throws(
		() =>
			projectFleetInspection(
				{ ...base, roots: [{ ...root, recordPath: "/state/fleet-runs/x.json" }] },
				base.generatedAt,
			),
		/invalid fleet root row/u,
	);
	throws(
		() =>
			projectFleetInspection({
				...base,
				roots: [{ ...root, steps: [{ ...root.steps[1], agentId: "builder" }] }],
			}, base.generatedAt),
		/attributed an agent to a fleet step that never ran/u,
	);
	throws(
		() => projectFleetInspection({ ...base, roots: [{ ...root, recordedSteps: 5 }] }, base.generatedAt),
		/contradictory fleet step counts/u,
	);
	throws(
		() =>
			projectFleetInspection({
				...base,
				roots: [{ ...root, plannedSteps: 4, steps: [root.steps[0], root.steps[0]] }],
			}, base.generatedAt),
		/duplicate fleet step identities/u,
	);
	throws(
		() => projectFleetInspection({ ...base, roots: [root, root] }, base.generatedAt),
		/duplicate fleet root identities/u,
	);
});

Deno.test("fleet inspection maps incompatible output to a bounded GUI error", async () => {
	const inspector = new ClioCliFleetInspector({
		executable: Deno.execPath(),
		prefixArgs: ["eval", "console.log('{}')", "--"],
	});
	await rejects(
		() => inspector.inspect(Deno.cwd()),
		(error: unknown) => error instanceof ClioFleetInspectError && error.code === "internal",
	);
});
