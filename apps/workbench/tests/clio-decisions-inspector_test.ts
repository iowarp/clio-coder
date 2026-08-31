import { deepStrictEqual, equal, ok, rejects, throws } from "node:assert/strict";
import {
	ClioCliDecisionsInspector,
	ClioDecisionsInspectError,
	projectGateDecisions,
} from "../clio-decisions-inspector.ts";

const FIXTURE = new URL("./decisions-child-fixture.ts", import.meta.url).pathname;

Deno.test("the decisions adapter invokes only the fixed sealed-verdict read", async () => {
	const root = await Deno.makeTempDir({ prefix: "clio-coder-gui-decisions-" });
	try {
		const inspector = new ClioCliDecisionsInspector({
			executable: Deno.execPath(),
			prefixArgs: ["run", "--quiet", "--no-config", FIXTURE, "--"],
			now: () => Date.parse("2026-08-31T14:02:00.000Z"),
		});
		const decisions = await inspector.inspect(root);
		equal(decisions.scope, "installation");
		equal(decisions.inspectedAt, "2026-08-31T14:02:00.000Z");
		equal(decisions.available, true);
		equal(decisions.decisions.length, 2);
		equal(decisions.decisions[0]?.topology, "review");
		equal(decisions.decisions[0]?.reason, "reviewer-report-invalid");
		equal(decisions.decisions[0]?.correlation?.independent, false);
		deepStrictEqual(decisions.decisions[1]?.winner, { index: 2, runId: "run-candidate-2" });
		// A sealed artifact that no longer authenticates is counted, not hidden.
		equal(decisions.unverifiable, 1);
		// Nothing the coordinator wrote as prose reaches the browser.
		const serialized = JSON.stringify(decisions);
		ok(!serialized.includes("verifier report"));
		ok(!serialized.includes("/gate-decisions/"));
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("decision projection refuses contradictions the sealed store cannot produce", () => {
	const decision = {
		id: "review-mt20xowx-a270cb-mt213mjr-5462547e6338",
		group: "review-mt20xowx-a270cb",
		topology: "review",
		cycle: 2,
		outcome: "exhausted",
		decidedAt: "2026-08-31T13:58:00.000Z",
		subjects: ["run-alpha"],
		subjectsTruncated: false,
		decider: "run-reviewer",
		correlation: { agent: false, target: true, modelFamily: true, runtime: true, node: true, independent: false },
		winner: null,
		confirms: null,
		reason: "reviewer-report-invalid",
	};
	const base = {
		version: 1,
		generatedAt: "2026-08-31T14:00:00.000Z",
		available: true,
		truncated: false,
		unverifiable: 0,
	};
	const project = (value: unknown) => projectGateDecisions({ ...base, decisions: [value] }, "2026-08-31T14:02:00.000Z");
	equal(project(decision).decisions[0]?.cycle, 2);

	// The reviewer's findings and the sealed reason line are what this boundary
	// exists to keep host-side.
	throws(() => project({ ...decision, detail: "reviewer reported 2 failed check(s)" }), /invalid gate decision/u);
	// A review gate cannot reach a compete verdict, and the reverse.
	throws(() => project({ ...decision, outcome: "winner" }), /outcome its topology cannot reach/u);
	// Independence is defined as sharing neither the agent nor the model family.
	throws(
		() => project({ ...decision, correlation: { ...decision.correlation, independent: true } }),
		/dimensions contradict its independence/u,
	);
	// A correlation measures a decider against its subjects.
	throws(() => project({ ...decision, decider: null }), /no decider to measure/u);
	// Only three outcomes name a winner, and each of them requires one.
	throws(
		() => project({ ...decision, winner: { index: 1, runId: "run-alpha" } }),
		/winner its outcome does not account for/u,
	);
	throws(
		() =>
			project({
				...decision,
				topology: "compete",
				outcome: "winner",
				winner: { index: 1, runId: "run-never-graded" },
			}),
		/winner the decision did not grade/u,
	);
	throws(
		() => projectGateDecisions({ ...base, decisions: [decision, decision] }, "2026-08-31T14:02:00.000Z"),
		/duplicate gate decision identities/u,
	);
	// An installation with no decision store has nothing to report.
	throws(
		() => projectGateDecisions({ ...base, available: false, decisions: [decision] }, "2026-08-31T14:02:00.000Z"),
		/from a store it says is absent/u,
	);
	// A snapshot from a build that predates this read is not one this GUI can
	// interpret, in either direction.
	throws(
		() =>
			projectGateDecisions(
				{ version: 1, generatedAt: base.generatedAt, available: true, decisions: [], truncated: false },
				"2026-08-31T14:02:00.000Z",
			),
		/invalid gate decision snapshot/u,
	);
});

Deno.test("decision reads map incompatible output to a bounded GUI error", async () => {
	const inspector = new ClioCliDecisionsInspector({
		executable: Deno.execPath(),
		prefixArgs: ["eval", "console.log('{}')", "--"],
	});
	await rejects(
		() => inspector.inspect(Deno.cwd()),
		(error: unknown) => error instanceof ClioDecisionsInspectError && error.code === "internal",
	);
});
