import { equal, ok, rejects, throws } from "node:assert/strict";
import { ClioCliEvalInspector, ClioEvalInspectError, projectEvalInventory } from "../clio-eval-inspector.ts";

const FIXTURE = new URL("./eval-inventory-child-fixture.ts", import.meta.url).pathname;

Deno.test("the eval adapter invokes only the fixed inventory read", async () => {
	const root = await Deno.makeTempDir({ prefix: "clio-coder-gui-eval-" });
	try {
		const inspector = new ClioCliEvalInspector({
			executable: Deno.execPath(),
			prefixArgs: ["run", "--quiet", "--no-config", FIXTURE, "--"],
			now: () => Date.parse("2026-08-31T16:20:02.000Z"),
		});
		const inventory = await inspector.inspect(root);
		equal(inventory.scope, "installation");
		equal(inventory.inspectedAt, "2026-08-31T16:20:02.000Z");
		equal(inventory.available, true);
		equal(inventory.stored, 3);
		// A report this build cannot open is counted, not hidden.
		equal(inventory.unreadable, 1);
		equal(inventory.truncated, false);
		equal(inventory.reports.length, 2);
		equal(inventory.reports[0]?.summary.passed, 1);
		equal(inventory.reports[0]?.results.attachments, 6);
		// A report whose runs never reported provider usage has no counts, not zeroes.
		equal(inventory.reports[1]?.summary.tokens.measured, false);
		equal(inventory.reports[1]?.summary.tokens.total, null);
		// A report that predates per-scenario reductions carries none, which is not
		// the same as carrying an empty list.
		equal(inventory.reports[1]?.scenarios, null);
		// No path, transcript, digest, or metric value reaches the frame.
		const serialized = JSON.stringify(inventory);
		ok(!serialized.includes("/home"));
		ok(!serialized.includes("stdout"));
		ok(!serialized.includes("compiledPromptHash"));
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

const REPORT = {
	evalId: "eval-20260830T205857010Z-6bae168d-797142426afe",
	startedAt: "2026-08-30T20:58:57.010Z",
	suiteId: "public-main-agent-behavior",
	servingGroup: 1,
	clioVersion: "0.3.9",
	clioCommit: "7cf5b06a5e2d429a2ed06b086cb335793fa5a9c7",
	platform: "linux-x64",
	node: "v24.9.0",
	matrix: { target: "mini", model: "qwen3-27b", thinking: "off", dimensions: ["target"] },
	serving: {
		observed: true,
		targetId: "mini",
		runtimeId: "llamacpp",
		modelId: "qwen3-27b",
		serverBuild: "b1-c841aee",
		thinkingLevel: "off",
		totalSlots: 1,
		compiledPromptPinned: true,
	},
	summary: {
		runs: 2,
		passed: 1,
		failed: 1,
		passRate: 0.5,
		wallTimeMs: 10,
		tokens: {
			measured: true,
			runs: 2,
			measuredRuns: 2,
			input: 1,
			output: 1,
			total: 2,
			cacheRead: 0,
			cacheWrite: 0,
		},
	},
	results: {
		total: 2,
		withAssignment: 0,
		withTerminalReceipt: 0,
		withVerdict: 2,
		withBehavioral: 1,
		withExecutionEnvelope: 1,
		machineryFailures: 1,
		attachments: 4,
		canonicalMetrics: 8,
		otherMetrics: 1,
	},
	failureClasses: [{ failureClass: "runner_failed", count: 1 }],
	behaviorOutcomes: [{ outcome: "pass", count: 1 }],
	scenarios: [
		{
			scenarioId: "main-focused-edit",
			trials: 2,
			passed: 1,
			failed: 1,
			unmeasured: 0,
			machineryFailures: 1,
			passAtK: 1,
			passPowK: 0,
		},
	],
	scenariosTruncated: false,
	scenariosDropped: 0,
};

const BASE = {
	version: 1,
	generatedAt: "2026-08-31T16:20:00.000Z",
	available: true,
	stored: 1,
	unreadable: 0,
	truncated: false,
};

function project(report: unknown, overrides: Record<string, unknown> = {}) {
	return projectEvalInventory({ ...BASE, reports: [report], ...overrides }, BASE.generatedAt);
}

Deno.test("eval projection refuses contradictions the harness cannot produce", () => {
	equal(project(REPORT).reports[0]?.suiteId, "public-main-agent-behavior");

	// The entry path, the suite hash, and the transcript are exactly what this
	// boundary keeps host-side.
	throws(() => project({ ...REPORT, entry: "/home/me/dist/cli/index.js" }), /invalid eval report/u);
	// The stamp is read out of the id, so it cannot disagree with it.
	throws(
		() => project({ ...REPORT, startedAt: "2026-08-30T20:58:57.011Z" }),
		/start instant its own id does not carry/u,
	);
	// A pass rate and a run split are the same fact stated twice.
	throws(
		() => project({ ...REPORT, summary: { ...REPORT.summary, passed: 2 } }),
		/outcomes do not sum|pass rate that disagrees/u,
	);
	throws(
		() => project({ ...REPORT, summary: { ...REPORT.summary, passRate: 0.9 } }),
		/pass rate that disagrees/u,
	);
	// Unmeasured accounting carries no counts.
	throws(
		() => project({ ...REPORT, summary: { ...REPORT.summary, tokens: { ...REPORT.summary.tokens, measured: false } } }),
		/disagree with its own measurement flag/u,
	);
	// A behavioral document references a verdict; an envelope references a
	// behavioral document.
	throws(
		() => project({ ...REPORT, results: { ...REPORT.results, withBehavioral: 3 } }),
		/without the ones they reference/u,
	);
	throws(
		() => project({ ...REPORT, results: { ...REPORT.results, withExecutionEnvelope: 2 } }),
		/without the ones they reference/u,
	);
	// Every failed result carries a class, so the tally accounts for them exactly.
	throws(
		() => project({ ...REPORT, failureClasses: [] }),
		/does not account for its failures/u,
	);
	throws(
		() => project({ ...REPORT, behaviorOutcomes: [{ outcome: "pass", count: 2 }] }),
		/does not account for its documents/u,
	);
	// A scenario reduction is derived, so its own numbers must agree.
	throws(
		() =>
			project({
				...REPORT,
				scenarios: [{ ...REPORT.scenarios[0], passAtK: 0 }],
			}),
		/pass rates that disagree/u,
	);
	throws(
		() =>
			project({
				...REPORT,
				scenarios: [{ ...REPORT.scenarios[0], trials: 3 }],
			}),
		/outcomes do not sum to its trials/u,
	);
	// A whole scenario list accounts for every verdict it reduces.
	throws(
		() => project({ ...REPORT, results: { ...REPORT.results, withVerdict: 1, withBehavioral: 1 } }),
		/do not account for their verdicts/u,
	);
	// A report read off its declared matrix knows nothing about the runtime.
	throws(
		() => project({ ...REPORT, serving: { ...REPORT.serving, observed: false } }),
		/a declared matrix cannot supply/u,
	);
	// A store that does not exist has nothing to have counted.
	throws(
		() => projectEvalInventory({ ...BASE, available: false, reports: [REPORT] }, BASE.generatedAt),
		/contents for a store it says does not exist/u,
	);
	throws(
		() => projectEvalInventory({ ...BASE, stored: 0, reports: [REPORT] }, BASE.generatedAt),
		/more eval reports than its store holds/u,
	);
	throws(
		() => projectEvalInventory({ ...BASE, stored: 4, reports: [REPORT] }, BASE.generatedAt),
		/disagrees with its own bound/u,
	);
	throws(
		() => projectEvalInventory({ ...BASE, stored: 2, reports: [REPORT, REPORT] }, BASE.generatedAt),
		/duplicate eval identities/u,
	);
});

Deno.test("eval inspection maps incompatible output to a bounded GUI error", async () => {
	const inspector = new ClioCliEvalInspector({
		executable: Deno.execPath(),
		prefixArgs: ["eval", "console.log('{}')", "--"],
	});
	await rejects(
		() => inspector.inspect(Deno.cwd()),
		(error: unknown) => error instanceof ClioEvalInspectError && error.code === "internal",
	);
});
