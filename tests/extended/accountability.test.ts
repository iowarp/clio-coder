import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { EvidenceFinding, EvidenceTag, RunEvidence } from "../../src/domains/evidence/index.js";
import { composeTrustStatus } from "../../src/domains/evidence/index.js";
import { summarizeRunAccountability } from "../../src/domains/telemetry/accountability.js";

interface Fields {
	succeeded?: boolean;
	firstPassSuccess?: boolean;
	tags?: EvidenceTag[];
	completionWarning?: boolean;
	ungroundedClaims?: number;
	assessed?: boolean;
}

function run(runId: string, fields: Fields = {}): RunEvidence {
	const tags = fields.tags ?? [];
	const findings: EvidenceFinding[] = tags.map((tag, index) => ({
		id: `finding-${String(index + 1).padStart(3, "0")}`,
		severity: tag === "completion-evidence" && fields.completionWarning !== true ? "info" : "warn",
		tag,
		runId,
		message: tag,
	}));
	const at = "2026-09-05T00:00:00.000Z";
	return {
		runId,
		sessionId: null,
		integrity: { state: "verified", by: "seal" },
		trust: composeTrustStatus(),
		assessedAt: fields.assessed === false ? null : at,
		settled: {
			at,
			startedAt: at,
			endedAt: at,
			agentId: "worker",
			targetId: "local",
			runtimeId: "openai",
			wireModelId: "model",
			outcome: fields.succeeded === false ? "failed" : "succeeded",
			exitCode: fields.succeeded === false ? 1 : 0,
		},
		firstPassSuccess: fields.firstPassSuccess ?? true,
		failureCause: null,
		tags,
		findings,
		verdicts: [],
		provenance: null,
		decisions: [],
		ungroundedClaims: fields.ungroundedClaims ?? 0,
		totals: null,
	};
}

describe("accountability evidence fold", () => {
	it("returns zero counters for no assessed runs", () => {
		deepStrictEqual(summarizeRunAccountability([run("unassessed", { assessed: false })]), {
			totalRuns: 0,
			firstPassRuns: 0,
			firstPassRate: 0,
			unverifiedSuccesses: 0,
			ungroundedClaims: 0,
			failureCauses: [],
		});
	});

	it("counts each unverified success once and claims across all outcomes", () => {
		const summary = summarizeRunAccountability([
			run("none", { tags: ["no-validation"], ungroundedClaims: 2 }),
			run("proxy", { tags: ["proxy-validation"], ungroundedClaims: 3 }),
			run("completion", { tags: ["completion-evidence"], completionWarning: true }),
			run("overlap", {
				tags: ["no-validation", "proxy-validation", "completion-evidence"],
				completionWarning: true,
				ungroundedClaims: 1,
			}),
			run("failed", {
				succeeded: false,
				firstPassSuccess: false,
				tags: ["no-validation", "test-failure"],
				completionWarning: true,
				ungroundedClaims: 4,
			}),
			run("info", { tags: ["completion-evidence"] }),
			run("grounded"),
			run("unassessed", { assessed: false, tags: ["no-validation"] }),
		]);
		strictEqual(summary.totalRuns, 7);
		strictEqual(summary.firstPassRuns, 6);
		strictEqual(summary.firstPassRate, 6 / 7);
		strictEqual(summary.unverifiedSuccesses, 4);
		strictEqual(summary.ungroundedClaims, 10);
		deepStrictEqual(summary.failureCauses, [{ tag: "test-failure", count: 1 }]);
	});
});
