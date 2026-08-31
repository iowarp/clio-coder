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
	} finally {
		await Deno.remove(root, { recursive: true });
	}
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
