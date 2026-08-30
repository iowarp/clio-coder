import { deepStrictEqual, equal, match, ok, rejects, throws } from "node:assert/strict";
import { ClioCliUsageInspector, ClioUsageInspectError, projectUsageInspection } from "../clio-usage-inspector.ts";

const FIXTURE = new URL("./usage-inspect-child-fixture.ts", import.meta.url).pathname;

function fixtureInspector(scenario: "valid" | "missing" | "bad-jsonl" | "too-many" = "valid"): ClioCliUsageInspector {
	return new ClioCliUsageInspector({
		executable: Deno.execPath(),
		prefixArgs: ["run", "--quiet", "--no-config", FIXTURE, `--scenario=${scenario}`, "--"],
		now: () => Date.parse("2026-08-29T14:00:00.000Z"),
	});
}

Deno.test("the usage adapter keeps project-filtered aggregates and drops global rows, raw suggestions, ids, paths, and shapes", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-usage-inspect-" });
	try {
		const inspection = await fixtureInspector().inspect(root);
		equal(inspection.schema, "experimental");
		equal(inspection.windowDays, 30);
		equal(inspection.sessionCount, 3);
		equal(inspection.dispatchRunCount, 2);
		equal(inspection.totals?.totalTokens, 13_922_000);
		equal(inspection.totals?.costUsd, 4.125);
		equal(inspection.models[0]?.model, "qwen3.8-27b");
		equal(inspection.tools[0]?.calls, 17);
		deepStrictEqual(inspection.skills, [
			{ name: "frontend-design", activations: 5, observedInWindow: true },
			{ name: "unused-private-skill", activations: 0, observedInWindow: false },
		]);
		deepStrictEqual(inspection.recipes, [{ agentId: "researcher", runs: 4 }]);
		deepStrictEqual(inspection.opportunities, [
			{ kind: "workflow-distiller", count: 1 },
			{ kind: "recipe", count: 1 },
		]);
		const frame = JSON.stringify(inspection);
		for (
			const forbidden of [
				"/home/operator",
				"sk-secret",
				"private-requested-model",
				"session-global-secret",
				"private-cross-project-failure",
				"evidence-global-secret",
				"run-private",
				"private repeated task prompt",
			]
		) ok(!frame.includes(forbidden), `usage projection leaked ${forbidden}`);
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("missing usage stores remain missing instead of becoming zero activity", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-usage-missing-" });
	try {
		const inspection = await fixtureInspector("missing").inspect(root);
		deepStrictEqual(inspection.stores, { sessions: "missing", dispatchReceipts: "missing" });
		equal(inspection.sessionCount, null);
		equal(inspection.dispatchRunCount, null);
		equal(inspection.totals, null);
		ok(!JSON.stringify(inspection).includes("/home/operator"));
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("JSONL framing and experimental window inconsistencies fail closed", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-usage-invalid-" });
	try {
		await rejects(
			() => fixtureInspector("bad-jsonl").inspect(root),
			(error: unknown) => {
				ok(error instanceof ClioUsageInspectError);
				equal(error.code, "internal");
				match(error.message, /invalid or oversized/u);
				return true;
			},
		);
		const common = {
			schema: "experimental",
			windowDays: 30,
			from: "2026-07-30T13:00:00.000Z",
			to: "2026-08-29T13:00:00.000Z",
			kind: "fact",
		};
		throws(
			() =>
				projectUsageInspection([
					{ ...common, fact: "sessions", value: 1 },
					{ ...common, from: "2026-07-31T13:00:00.000Z", fact: "dispatch-runs", value: 1 },
				], "2026-08-29T14:00:00.000Z"),
			/inconsistent usage windows/u,
		);
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("the usage JSONL row ceiling fails closed before projection", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-usage-row-limit-" });
	try {
		await rejects(
			() => fixtureInspector("too-many").inspect(root),
			(error: unknown) => {
				ok(error instanceof ClioUsageInspectError);
				equal(error.code, "internal");
				match(error.message, /invalid or oversized/u);
				return true;
			},
		);
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});
