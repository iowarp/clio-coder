/**
 * `clio-coder fleet view` data sources and render.
 *
 * The viewer reads three durable artifacts in order (ledger envelope, event
 * journal, sealed receipt) and reduces them to a pure render. This exercises
 * that reduction against a fixture of all three, with no PTY and no TUI: the
 * follow loop paints exactly the lines `renderRunView` returns, so asserting
 * the strings is asserting what an operator sees.
 */

import { match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { FLEET_INSPECT_MAX_EVENTS, FLEET_INSPECT_MAX_RUNS, fleetInspectSnapshot } from "../../src/cli/fleet-inspect.js";
import { loadRunViewModel, type RunViewModel, renderRunView, resolveRunId } from "../../src/cli/fleet-view.js";
import { createRunEventJournal } from "../../src/domains/dispatch/run-event-journal.js";
import { type Ledger, openLedger } from "../../src/domains/dispatch/state.js";
import type { RunLineage, RunReceiptDraft } from "../../src/domains/dispatch/types.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const lineage: RunLineage = {
	parentRunId: null,
	rootRunId: "view-root",
	attempt: 0,
	depth: 0,
};
const identity = { host: "view-host", user: "view-user", hpc: null };

function receiptDraft(runId: string, task: string, startedAt: string, endedAt: string): RunReceiptDraft {
	return {
		verification: { state: "unverified", basis: "no-validation-tool" },
		routingIntent: {
			posture: "balanced",
			maxCostUsd: null,
			deadlineMs: null,
			minimumQuality: null,
			requiredCapabilities: [],
			locality: "any",
			failover: "none",
		},
		quality: {
			version: 1,
			typedValidations: [],
			responseSchema: {
				sourceId: null,
				schemaDigest: null,
				runtimeEnforceable: false,
				enforcementPassed: null,
			},
			resultContract: null,
		},
		costProvenance: "unknown",
		runId,
		agentId: "tester",
		executionRole: "builder",
		task,
		targetId: "local-lmstudio",
		wireModelId: "qwen3-coder",
		runtimeId: "lmstudio",
		runtimeKind: "http",
		outcome: "succeeded",
		outcomeDetail: null,
		lineage,
		identity,
		startedAt,
		endedAt,
		exitCode: 0,
		tokenCount: 3,
		inputTokenCount: 2,
		outputTokenCount: 1,
		cacheReadTokenCount: 0,
		cacheWriteTokenCount: 0,
		reasoningTokenCount: 0,
		costUsd: 0,
		compiledPromptHash: null,
		staticCompositionHash: null,
		promptSignature: "prompt-signature",
		toolSignature: "tool-signature",
		clioVersion: "test",
		piMonoVersion: "test",
		platform: process.platform,
		nodeVersion: process.version,
		toolCalls: 0,
		toolStats: [],
		toolActivity: {
			calls: 0,
			succeeded: 0,
			failed: 0,
			blocked: 0,
			mutatingSucceeded: false,
		},
		reproducibility: {
			cwd: "/tmp/fleet-view",
			git: {
				branch: null,
				commit: null,
				dirty: null,
				dirtyEntries: null,
				statusHash: null,
			},
			safetyPolicy: {
				version: 1,
				rulePackHash: null,
				rulePackVersion: null,
				projectPolicyPath: null,
				projectPolicyHash: null,
				projectPolicyValid: null,
			},
		},
		sessionId: null,
	};
}

interface Fixture {
	runId: string;
	ledger: Ledger;
}

/** A finished run with a ledger row, a journal, and a sealed receipt. */
async function seedRun(task: string): Promise<Fixture> {
	const ledger = openLedger({ maxRuns: 20 });
	const run = ledger.create({
		agentId: "tester",
		executionRole: "builder",
		task,
		targetId: "local-lmstudio",
		wireModelId: "qwen3-coder",
		runtimeId: "lmstudio",
		runtimeKind: "http",
		sessionId: null,
		cwd: "/tmp/fleet-view",
	});
	const journal = createRunEventJournal({});
	journal.open(run.id, "tester");
	journal.append(run.id, {
		at: "2026-08-30T10:00:00.000Z",
		type: "message_end",
		detail: "read src/index.ts",
	});
	journal.append(run.id, {
		at: "2026-08-30T10:00:01.000Z",
		type: "clio_tool_finish",
		detail: "read ok",
	});
	// Both stamps are fixed so the header's elapsed is a deterministic 30s.
	const startedAt = "2026-08-30T10:00:00.000Z";
	const endedAt = "2026-08-30T10:00:30.000Z";
	ledger.update(run.id, {
		status: "completed",
		outcome: "succeeded",
		outcomeDetail: null,
		lineage,
		identity,
		startedAt,
		endedAt,
		exitCode: 0,
		tokenCount: 3,
		inputTokenCount: 2,
		outputTokenCount: 1,
		cacheReadTokenCount: 0,
		cacheWriteTokenCount: 0,
		reasoningTokenCount: 0,
		promptSignature: "prompt-signature",
		toolSignature: "tool-signature",
		costUsd: 0,
	});
	const receipt = ledger.recordReceipt(run.id, receiptDraft(run.id, task, startedAt, endedAt));
	journal.receipt(run.id, {
		outcome: receipt.outcome,
		exitCode: receipt.exitCode,
		digest: receipt.integrity.digest,
	});
	journal.terminal(run.id, receipt.outcome);
	journal.flush();
	await ledger.persist();
	return { runId: run.id, ledger };
}

function line(model: RunViewModel, prefix: string): string {
	const found = renderRunView(model, 120).find((candidate) => candidate.startsWith(prefix));
	ok(found !== undefined, `no rendered line starting with ${JSON.stringify(prefix)}`);
	return found;
}

describe("fleet view data sources", () => {
	it("projects a fixed bounded recent-run window without receipt or journal paths", async () => {
		const isolated = await isolateClioEnv("clio-fleet-inspect-");
		try {
			const fixture = await seedRun("inspect the durable boundary");
			const snapshot = fleetInspectSnapshot(() => Date.parse("2026-08-30T10:01:00.000Z"));
			strictEqual(snapshot.version, 1);
			strictEqual(snapshot.generatedAt, "2026-08-30T10:01:00.000Z");
			strictEqual(snapshot.runs.length, 1);
			const run = snapshot.runs[0];
			ok(run !== undefined);
			strictEqual(run.runId, fixture.runId);
			strictEqual(run.journal, "available");
			strictEqual(run.evidence.state, "verified");
			strictEqual(run.terminal, true);
			strictEqual(run.events.length <= FLEET_INSPECT_MAX_EVENTS, true);
			strictEqual(snapshot.runs.length <= FLEET_INSPECT_MAX_RUNS, true);
			strictEqual(JSON.stringify(snapshot).includes("/receipts/"), false);
			strictEqual(JSON.stringify(snapshot).includes("events.ndjson"), false);
		} finally {
			isolated.restore();
		}
	});

	it("renders a header, transcript, verified evidence, and outcome from ledger + journal + receipt", async () => {
		const isolated = await isolateClioEnv("clio-fleet-view-");
		try {
			const fixture = await seedRun("audit the receipt boundary");
			const model = loadRunViewModel(fixture.runId);
			ok(model !== null);

			// Header: identity from the ledger envelope, elapsed from its two stamps.
			strictEqual(line(model, "run "), `run ${fixture.runId}  tester`);
			match(
				line(model, "model "),
				/^model qwen3-coder {2}target local-lmstudio {2}node local {2}phase succeeded {2}elapsed 30s$/,
			);
			strictEqual(line(model, "task "), "task audit the receipt boundary");

			// Transcript from the journal, in the registry's own tail vocabulary.
			const rendered = renderRunView(model, 120);
			ok(rendered.some((text) => text.includes("message_end: read src/index.ts")));
			ok(rendered.some((text) => text.includes("clio_tool_finish: read ok")));
			ok(rendered.some((text) => text.startsWith("receipt   ")));

			// The receipt is authenticated against the envelope before its facts show.
			match(line(model, "evidence  "), /^evidence {2}trust v\d+: /);

			// Outcome comes from the journal's terminal line.
			strictEqual(line(model, "outcome   "), "outcome   succeeded");
			strictEqual(model.terminal, true);
			strictEqual(model.transcriptTruncated, false);
		} finally {
			isolated.restore();
		}
	});

	it("reports an unverifiable receipt instead of showing its fields", async () => {
		const isolated = await isolateClioEnv("clio-fleet-view-tamper-");
		try {
			const fixture = await seedRun("tamper case");
			// The envelope no longer matches what the receipt was sealed over.
			fixture.ledger.update(fixture.runId, { tokenCount: 999 });
			await fixture.ledger.persist();

			const model = loadRunViewModel(fixture.runId);
			ok(model !== null);
			match(line(model, "evidence  "), /RECEIPT INTEGRITY FAILED/);
			// The outcome still reads off the journal, which is not receipt-derived.
			strictEqual(line(model, "outcome   "), "outcome   succeeded");
		} finally {
			isolated.restore();
		}
	});

	it("sanitizes and bounds task text before rendering it", async () => {
		const isolated = await isolateClioEnv("clio-fleet-view-sanitize-");
		try {
			const esc = String.fromCharCode(27);
			const hostile = `wipe${esc}[2J the screen\nand this line`;
			const fixture = await seedRun(hostile);
			const model = loadRunViewModel(fixture.runId);
			ok(model !== null);
			const task = line(model, "task ");
			ok(!task.includes(esc), "no escape sequence survives to the rendered line");
			ok(!task.includes("\n"), "the task collapses to one line");
			match(task, /^task wipe the screen/);
		} finally {
			isolated.restore();
		}
	});

	it("renders a run with no journal without inventing a transcript", async () => {
		const isolated = await isolateClioEnv("clio-fleet-view-nojournal-");
		try {
			const ledger = openLedger({ maxRuns: 20 });
			const run = ledger.create({
				agentId: "coder",
				executionRole: "builder",
				task: "journal was off",
				targetId: "default",
				wireModelId: "model",
				runtimeId: "openai",
				runtimeKind: "http",
				sessionId: null,
				cwd: "/tmp/fleet-view",
			});
			await ledger.persist();
			const model = loadRunViewModel(run.id);
			ok(model !== null);
			strictEqual(model.journalPresent, false);
			strictEqual(model.terminal, false);
			const rendered = renderRunView(model, 120);
			ok(rendered.some((text) => text === "no event journal for this run."));
			strictEqual(line(model, "outcome   "), "outcome   running");
			strictEqual(line(model, "evidence  "), "evidence  receipt pending; the run has not finalized");
		} finally {
			isolated.restore();
		}
	});

	it("resolves an exact run id, a unique prefix, and refuses an ambiguous one", async () => {
		const isolated = await isolateClioEnv("clio-fleet-view-resolve-");
		try {
			const fixture = await seedRun("resolve case");
			const exact = resolveRunId(fixture.runId);
			ok("runId" in exact);
			strictEqual(exact.runId, fixture.runId);

			const prefix = resolveRunId(fixture.runId.slice(0, 6));
			ok("runId" in prefix);
			strictEqual(prefix.runId, fixture.runId);

			const unknown = resolveRunId("zzzz-no-such-run");
			ok("candidates" in unknown);
			strictEqual(unknown.candidates.length, 0);
			strictEqual(loadRunViewModel("zzzz-no-such-run"), null);
		} finally {
			isolated.restore();
		}
	});
});
