import { deepStrictEqual, equal, ok, rejects, throws } from "node:assert/strict";
import { ClioCliTraceInspector, ClioTraceInspectError, projectTraceInspection } from "../clio-trace-inspector.ts";

const FIXTURE = new URL("./trace-inspect-child-fixture.ts", import.meta.url).pathname;

Deno.test("the trace adapter invokes only the fixed accounting projection", async () => {
	const root = await Deno.makeTempDir({ prefix: "clio-coder-gui-trace-inspect-" });
	try {
		const inspector = new ClioCliTraceInspector({
			executable: Deno.execPath(),
			prefixArgs: ["run", "--quiet", "--no-config", FIXTURE, "--"],
			now: () => Date.parse("2026-08-31T14:02:00.000Z"),
		});
		const inspection = await inspector.inspect(root);
		equal(inspection.scope, "installation");
		equal(inspection.inspectedAt, "2026-08-31T14:02:00.000Z");
		equal(inspection.available, true);
		equal(inspection.runs.length, 1);
		const run = inspection.runs[0];
		ok(run !== undefined);
		equal(run.runId, "run-alpha");
		equal(run.totalTokens, 28_665);
		equal(run.phases.length, 2);
		// The fact that a phase errored crosses; nothing about why it did.
		equal(run.phases[1]?.failed, true);
		equal(run.phases[1]?.retries, 1);
		const frame = JSON.stringify(inspection);
		for (const forbidden of ["request", "description", "error", "phase_id", "assignment", ".sqlite"]) {
			ok(!frame.includes(forbidden), `trace projection leaked ${forbidden}`);
		}
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("trace projection rejects extra fields, duplicate runs, and impossible availability", () => {
	const phase = {
		name: "builder",
		kind: "agent",
		owner: "builder",
		status: "success",
		attempt: 1,
		retries: 0,
		failed: false,
		elapsedMs: 10,
		totalTokens: 5,
		totalCostUsd: 0,
	};
	const events = {
		total: 4,
		firstAt: "2026-08-31T14:00:00.000Z",
		lastAt: "2026-08-31T14:00:29.000Z",
		kinds: [{ kind: "message_update", count: 3 }, { kind: "tool_call", count: 1 }],
		kindsTruncated: false,
	};
	const processes = {
		total: 2,
		running: 1,
		kinds: [{ kind: "worker", total: 2, running: 1 }],
		kindsTruncated: false,
	};
	const run = {
		runId: "run-alpha",
		agent: "builder",
		target: "local",
		model: "model",
		runtime: "lmstudio",
		node: null,
		status: "success",
		startedAt: "2026-08-31T14:00:00.000Z",
		elapsedMs: 10,
		totalTokens: 5,
		totalCostUsd: 0,
		phases: [phase],
		phasesTruncated: false,
		events,
		processes,
	};
	const at = "2026-08-31T14:02:00.000Z";
	const base = { version: 1, generatedAt: at, available: true, truncated: false };

	const accepted = projectTraceInspection({ ...base, runs: [run] }, at);
	equal(accepted.runs[0]?.phases[0]?.name, "builder");

	throws(
		() => projectTraceInspection({ ...base, runs: [{ ...run, request: "the prompt text" }] }, at),
		/invalid trace run row/u,
	);
	throws(
		() => projectTraceInspection({ ...base, runs: [{ ...run, phases: [{ ...phase, error: "boom" }] }] }, at),
		/invalid trace phase row/u,
	);
	throws(
		() => projectTraceInspection({ ...base, runs: [run, run] }, at),
		/duplicate trace run identities/u,
	);
	// A database that was never written cannot also have produced rows.
	throws(
		() => projectTraceInspection({ ...base, available: false, runs: [run] }, at),
		/contradictory trace availability facts/u,
	);
	throws(
		() => projectTraceInspection({ ...base, available: false, truncated: true, runs: [] }, at),
		/contradictory trace availability facts/u,
	);
	// A snapshot from a build that predates this DTO is not one this GUI reads.
	throws(
		() => projectTraceInspection({ version: 1, generatedAt: at, runs: [], truncated: false }, at),
		/invalid trace snapshot/u,
	);
});

Deno.test("an installation with no trace database projects as unavailable, not as empty", () => {
	const at = "2026-08-31T14:02:00.000Z";
	const inspection = projectTraceInspection(
		{ version: 1, generatedAt: at, available: false, runs: [], truncated: false },
		at,
	);
	deepStrictEqual(inspection, {
		scope: "installation",
		inspectedAt: at,
		generatedAt: at,
		available: false,
		runs: [],
		truncated: false,
	});
});

Deno.test("trace inspection maps incompatible output to a bounded GUI error", async () => {
	const inspector = new ClioCliTraceInspector({
		executable: Deno.execPath(),
		prefixArgs: ["eval", "console.log('{}')", "--"],
	});
	await rejects(
		() => inspector.inspect(Deno.cwd()),
		(error: unknown) => error instanceof ClioTraceInspectError && error.code === "internal",
	);
});

Deno.test("trace shapes must account for themselves and never carry a row", () => {
	const at = "2026-08-31T14:02:00.000Z";
	const phase = {
		name: "builder",
		kind: "agent",
		owner: "builder",
		status: "success",
		attempt: 1,
		retries: 0,
		failed: false,
		elapsedMs: 10,
		totalTokens: 5,
		totalCostUsd: 0,
	};
	const events = {
		total: 4,
		firstAt: "2026-08-31T14:00:00.000Z",
		lastAt: "2026-08-31T14:00:29.000Z",
		kinds: [{ kind: "message_update", count: 3 }, { kind: "tool_call", count: 1 }],
		kindsTruncated: false,
	};
	const processes = {
		total: 2,
		running: 1,
		kinds: [{ kind: "worker", total: 2, running: 1 }],
		kindsTruncated: false,
	};
	const run = {
		runId: "run-alpha",
		agent: "builder",
		target: "local",
		model: "model",
		runtime: "lmstudio",
		node: null,
		status: "success",
		startedAt: "2026-08-31T14:00:00.000Z",
		elapsedMs: 10,
		totalTokens: 5,
		totalCostUsd: 0,
		phases: [phase],
		phasesTruncated: false,
		events,
		processes,
	};
	const base = { version: 1, generatedAt: at, available: true, truncated: false };
	equal(projectTraceInspection({ ...base, runs: [run] }, at).runs[0]?.events.total, 4);

	for (
		const broken of [
			// A complete breakdown accounts for every event.
			{ ...run, events: { ...events, kinds: [{ kind: "message_update", count: 3 }] } },
			// A truncated one accounts for fewer, never more.
			{ ...run, events: { ...events, total: 2, kindsTruncated: true } },
			// A run with no events has no span, and one with events has both ends.
			{ ...run, events: { ...events, total: 0, kinds: [] } },
			{ ...run, events: { ...events, firstAt: null } },
			// Still alive is a subset of started, per kind and overall.
			{ ...run, processes: { ...processes, running: 5 } },
			{ ...run, processes: { ...processes, kinds: [{ kind: "worker", total: 1, running: 2 }] } },
			// One kind, once.
			{ ...run, events: { ...events, kinds: [events.kinds[0], events.kinds[0]] } },
			// The row-level fields are the ones that must never appear.
			{ ...run, events: { ...events, payloads: ["{}"] } },
			{ ...run, processes: { ...processes, commands: ["/usr/bin/node agent.js"] } },
		]
	) {
		throws(() => projectTraceInspection({ ...base, runs: [broken] }, at));
	}
});
