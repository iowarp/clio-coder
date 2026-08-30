import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import {
	ClioCliDispatchInspector,
	ClioDispatchInspectError,
	projectDispatchInspection,
} from "../clio-dispatch-inspector.ts";

const FIXTURE = new URL("./dispatch-inspect-child-fixture.ts", import.meta.url).pathname;

Deno.test("the dispatch adapter invokes only fleet status and drops every raw identity", async () => {
	const root = await Deno.makeTempDir({ prefix: "clio-gui-dispatch-inspect-" });
	try {
		const inspector = new ClioCliDispatchInspector({
			executable: Deno.execPath(),
			prefixArgs: ["run", "--quiet", "--no-config", FIXTURE, "--"],
			now: () => Date.parse("2026-08-30T14:02:00.000Z"),
		});
		const inspection = await inspector.inspect(root);
		equal(inspection.scope, "installation");
		equal(inspection.inspectedAt, "2026-08-30T14:02:00.000Z");
		deepStrictEqual(inspection.admission, {
			state: "draining",
			expiresAt: "2026-08-30T14:05:00.000Z",
		});
		deepStrictEqual(inspection.running, { total: 3, alive: 1, stale: 1, dead: 1, unreported: 0 });
		equal(inspection.retryingCount, 1);
		equal(inspection.totals.totalTokens, 15_918_587);
		equal(inspection.totals.costUsd, 1.78098108);
		const frame = JSON.stringify(inspection);
		for (const forbidden of ["run-secret", "researcher", "builder", "reviewer", "ssh-private", "98765", "rawRequest"]) {
			ok(!frame.includes(forbidden), `dispatch projection leaked ${forbidden}`);
		}
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("dispatch projection rejects contradictory heartbeat and unsafe totals", () => {
	const base = {
		generatedAt: "2026-08-30T14:01:28.728Z",
		admission: { state: "open" },
		retrying: [],
		totals: { inputTokens: 1, outputTokens: 2, totalTokens: 3, costUsd: 0.1, runtimeSeconds: 4.5 },
	};
	rejects(
		Promise.resolve().then(() =>
			projectDispatchInspection({
				...base,
				running: [{ outcomePhase: "running", heartbeat: "stale" }],
			}, "2026-08-30T14:02:00.000Z")
		),
		/contradictory/u,
	);
	rejects(
		Promise.resolve().then(() =>
			projectDispatchInspection({
				...base,
				running: [],
				totals: { ...base.totals, costUsd: Number.POSITIVE_INFINITY },
			}, "2026-08-30T14:02:00.000Z")
		),
		/invalid dispatch totals/u,
	);
});

Deno.test("dispatch inspection maps incompatible output to a bounded GUI error", async () => {
	const inspector = new ClioCliDispatchInspector({
		executable: Deno.execPath(),
		prefixArgs: ["eval", "console.log('{}')", "--"],
	});
	await rejects(
		() => inspector.inspect(Deno.cwd()),
		(error: unknown) => error instanceof ClioDispatchInspectError && error.code === "internal",
	);
});
