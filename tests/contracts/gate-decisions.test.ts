import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { GateDecisionDraft, GateDecisionOutcome } from "../../src/domains/dispatch/gate-decisions.js";
import {
	type GateDecisionArtifact,
	materializePendingGateDecision,
	readGateDecisionArtifacts,
	readGateDecisionArtifactsForRunIds,
	readPendingGateDecisions,
	recoverPendingGateDecisions,
	resolvePendingGateDecision,
	stagePendingGateDecision,
	stagePendingGateOutput,
	verifyGateDecisionArtifact,
	verifyPendingGateDecisionRecord,
} from "../../src/domains/dispatch/gate-decisions.js";
import type { RunGateSubjectRef } from "../../src/domains/dispatch/types.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const builder: RunGateSubjectRef = { runId: "builder-1", digest: "a".repeat(64) };
const reviewer: RunGateSubjectRef = { runId: "reviewer-1", digest: "b".repeat(64) };

/** Independent decider correlation, the ordinary case for a gated fixture. */
const INDEPENDENT_GATE_CORRELATION = {
	agent: false,
	target: true,
	modelFamily: false,
	runtime: true,
	node: true,
	independent: true,
} as const;

describe("gate decision artifacts", () => {
	it("durably distinguishes every review terminal state and detects tampering", () => {
		const isolated = isolateClioEnv("clio-gate-decisions-");
		try {
			for (const outcome of [
				"pass",
				"fail",
				"revise",
				"exhausted",
			] as const satisfies ReadonlyArray<GateDecisionOutcome>) {
				const written = writeGateDecision({
					group: "review-group",
					topology: "review",
					cycle: outcome === "exhausted" ? 2 : 1,
					outcome,
					subjects: [builder],
					decider: reviewer,
					correlation: INDEPENDENT_GATE_CORRELATION,
					detail: `${outcome} evidence`,
				});
				deepStrictEqual(verifyGateDecisionArtifact(written.artifact), { ok: true });
				deepStrictEqual(
					verifyGateDecisionArtifact({ ...written.artifact, outcome: "fail" }),
					outcome === "fail" ? { ok: true } : { ok: false, reason: "gate decision integrity mismatch" },
				);
			}

			deepStrictEqual(
				readGateDecisionArtifacts("review-group")
					.map((entry) => entry.artifact.outcome)
					.sort(),
				["exhausted", "fail", "pass", "revise"],
			);
		} finally {
			isolated.restore();
		}
	});

	it("links a compete winner to judge and candidate receipt digests", () => {
		const isolated = isolateClioEnv("clio-gate-winner-");
		try {
			const candidateTwo = { runId: "candidate-2", digest: "c".repeat(64) };
			const judge = { runId: "judge-1", digest: "d".repeat(64) };
			const { artifact } = writeGateDecision({
				group: "compete-group",
				topology: "compete",
				cycle: 1,
				outcome: "winner",
				subjects: [builder, candidateTwo],
				decider: judge,
				correlation: INDEPENDENT_GATE_CORRELATION,
				winner: { index: 2, subject: candidateTwo, branch: "clio/compete/compete-group/2" },
			});

			deepStrictEqual(verifyGateDecisionArtifact(artifact), { ok: true });
			strictEqual(artifact.winner?.index, 2);
			strictEqual(artifact.winner?.subject.digest, candidateTwo.digest);
			deepStrictEqual(
				verifyGateDecisionArtifact({
					...artifact,
					winner: artifact.winner ? { ...artifact.winner, index: 1 } : undefined,
				} as typeof artifact),
				{ ok: false, reason: "gate decision winner invalid" },
			);

			const confirmation = writeGateDecision({
				group: "compete-group",
				topology: "compete",
				cycle: 1,
				outcome: "operator-confirmed",
				subjects: [candidateTwo],
				winner: { index: 2, subject: candidateTwo, branch: "clio/compete/compete-group/2" },
				confirmation: { id: artifact.id, digest: artifact.integrity.digest },
			});
			deepStrictEqual(verifyGateDecisionArtifact(confirmation.artifact), { ok: true });
			deepStrictEqual(
				readGateDecisionArtifactsForRunIds(new Set([candidateTwo.runId]))
					.map((entry) => entry.artifact.outcome)
					.sort(),
				["operator-confirmed", "winner"],
			);
			const unauthenticated = structuredClone(confirmation.artifact);
			unauthenticated.subjects[0] = { runId: candidateTwo.runId, digest: null };
			deepStrictEqual(verifyGateDecisionArtifact(unauthenticated), {
				ok: false,
				reason: "gate decision subjects invalid",
			});
		} finally {
			isolated.restore();
		}
	});

	it("recovers every reviewer/judge outcome from output staged before receipt settlement", () => {
		const isolated = isolateClioEnv("clio-gate-output-pending-");
		try {
			const candidateTwo = { runId: "candidate-2", digest: "c".repeat(64) };
			const cases: Array<{
				outcome: GateDecisionOutcome;
				topology: "review" | "compete";
				subjects: RunGateSubjectRef[];
				decider: RunGateSubjectRef;
				correlation?: GateDecisionDraft["correlation"];
				winner?: GateDecisionDraft["winner"];
			}> = [
				{ outcome: "pass", topology: "review", subjects: [builder], decider: reviewer },
				{ outcome: "fail", topology: "review", subjects: [builder], decider: reviewer },
				{ outcome: "revise", topology: "review", subjects: [builder], decider: reviewer },
				{ outcome: "exhausted", topology: "review", subjects: [builder], decider: reviewer },
				{
					outcome: "winner",
					topology: "compete",
					subjects: [builder, candidateTwo],
					decider: { runId: "judge-1", digest: "d".repeat(64) },
					correlation: INDEPENDENT_GATE_CORRELATION,
					winner: { index: 2, subject: candidateTwo, branch: "clio/compete/pending-group-winner/2" },
				},
				{
					outcome: "no-winner",
					topology: "compete",
					subjects: [builder, candidateTwo],
					decider: { runId: "judge-2", digest: "e".repeat(64) },
					correlation: INDEPENDENT_GATE_CORRELATION,
				},
			];

			for (const testCase of cases) {
				const group = `pending-group-${testCase.outcome}`;
				const output =
					testCase.topology === "review"
						? JSON.stringify({ verdict: "pass", checks: [{ name: "review", passed: true, evidence: "inspected" }] })
						: JSON.stringify({ winner: 2, checks: [{ name: "ranking", passed: true, evidence: "compared" }] });
				const staged = stagePendingGateOutput({
					group,
					topology: testCase.topology,
					cycle: 1,
					subjects: testCase.subjects,
					deciderRunId: testCase.decider.runId,
					finalOutput: output,
				});
				deepStrictEqual(verifyPendingGateDecisionRecord(staged.record), { ok: true });
				strictEqual(staged.record.kind, "output");
				if (staged.record.kind === "output") strictEqual(staged.record.finalOutput, output);

				// Simulate restart after the receipt appeared but before the artifact:
				// reload the WAL from disk, bind the authenticated receipt ref, and
				// stop again after the resolved replacement is durable.
				const reloaded = readPendingGateDecisions().records.find((entry) => entry.record.id === staged.record.id);
				ok(reloaded, "staged output is discoverable after restart");
				const resolved = resolvePendingGateDecision(reloaded, {
					group,
					topology: testCase.topology,
					cycle: 1,
					outcome: testCase.outcome,
					subjects: testCase.subjects,
					decider: testCase.decider,
					correlation: INDEPENDENT_GATE_CORRELATION,
					...(testCase.winner !== undefined ? { winner: testCase.winner } : {}),
				});
				strictEqual(resolved.record.kind, "decision");
				strictEqual(existsSync(join(isolated.dir, "state", "gate-decisions", `${staged.record.id}.json`)), false);
			}

			const recovered = recoverPendingGateDecisions();
			deepStrictEqual(recovered.unresolved, []);
			deepStrictEqual(recovered.materialized.map((entry) => entry.artifact.outcome).sort(), [
				"exhausted",
				"fail",
				"no-winner",
				"pass",
				"revise",
				"winner",
			]);
			deepStrictEqual(readPendingGateDecisions(), { records: [], errors: [] });
		} finally {
			isolated.restore();
		}
	});

	it("replays no-output terminal failures and winner confirmations", () => {
		const isolated = isolateClioEnv("clio-gate-ready-pending-");
		try {
			const candidateTwo = { runId: "candidate-2", digest: "c".repeat(64) };
			const winner = {
				index: 2,
				subject: candidateTwo,
				branch: "clio/compete/confirmation-group/2",
			};
			const drafts: GateDecisionDraft[] = [
				{
					group: "builder-failure-group",
					topology: "review",
					cycle: 1,
					outcome: "exhausted",
					subjects: [builder],
					detail: "builder ended failed",
				},
				{
					group: "candidate-failure-group",
					topology: "compete",
					cycle: 1,
					outcome: "no-winner",
					subjects: [builder, candidateTwo],
					detail: "every candidate builder failed; nothing to judge",
				},
				{
					group: "confirmation-group",
					topology: "compete",
					cycle: 1,
					outcome: "operator-confirmed",
					subjects: [candidateTwo],
					winner,
					confirmation: { id: "winner-decision", digest: "d".repeat(64) },
				},
				{
					group: "confirmation-group",
					topology: "compete",
					cycle: 1,
					outcome: "full-auto-applied",
					subjects: [candidateTwo],
					winner,
					confirmation: { id: "winner-decision", digest: "d".repeat(64) },
				},
			];
			for (const draft of drafts) stagePendingGateDecision(draft);

			const recovered = recoverPendingGateDecisions();
			deepStrictEqual(recovered.materialized.map((entry) => entry.artifact.outcome).sort(), [
				"exhausted",
				"full-auto-applied",
				"no-winner",
				"operator-confirmed",
			]);
			strictEqual(readPendingGateDecisions().records.length, 0);
		} finally {
			isolated.restore();
		}
	});

	it("clears an already-written replay idempotently and fails closed on tamper", () => {
		const isolated = isolateClioEnv("clio-gate-pending-integrity-");
		try {
			const alreadyWritten = stagePendingGateDecision({
				group: "already-written",
				topology: "review",
				cycle: 1,
				outcome: "pass",
				subjects: [builder],
				decider: reviewer,
				correlation: INDEPENDENT_GATE_CORRELATION,
			});
			if (alreadyWritten.record.kind !== "decision") throw new Error("expected resolved pending fixture");
			const finalPath = join(isolated.dir, "state", "gate-decisions", `${alreadyWritten.record.id}.json`);
			writeFileSync(finalPath, JSON.stringify(alreadyWritten.record.decision, null, 2));
			const replayed = recoverPendingGateDecisions();
			strictEqual(replayed.materialized[0]?.path, finalPath);
			strictEqual(existsSync(alreadyWritten.path), false);

			const corrupted = stagePendingGateOutput({
				group: "tampered-output",
				topology: "review",
				cycle: 1,
				subjects: [builder],
				deciderRunId: reviewer.runId,
				finalOutput: "VERDICT: pass",
			});
			const raw = JSON.parse(readFileSync(corrupted.path, "utf8")) as Record<string, unknown>;
			raw.finalOutput = "VERDICT: fail";
			writeFileSync(corrupted.path, JSON.stringify(raw, null, 2));
			strictEqual(readPendingGateDecisions().errors.length, 1);
			throws(() => recoverPendingGateDecisions(), /journal is untrustworthy.*integrity mismatch/);
			strictEqual(existsSync(corrupted.path), true, "corrupt pending evidence remains quarantined for inspection");
			strictEqual(readGateDecisionArtifacts("tampered-output").length, 0);
		} finally {
			isolated.restore();
		}
	});
});

/** Every decision crosses the staged durable boundary; there is no direct writer. */
function writeGateDecision(draft: GateDecisionDraft): { artifact: GateDecisionArtifact; path: string } {
	return materializePendingGateDecision(stagePendingGateDecision(draft));
}
