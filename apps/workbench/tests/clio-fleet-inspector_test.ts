import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
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
	};
	rejects(
		Promise.resolve().then(() =>
			projectFleetInspection({
				...base,
				runs: [{ ...run, receiptPath: "/secret" }],
			}, base.generatedAt)
		),
		/invalid durable run row/u,
	);
	rejects(
		Promise.resolve().then(() => projectFleetInspection({ ...base, runs: [run, run] }, base.generatedAt)),
		/duplicate durable run identities/u,
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
