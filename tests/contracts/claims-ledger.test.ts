import { strict as assert } from "node:assert";
import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	appendClaims,
	claimFromVerifyResult,
	claimsLogPath,
	claimsProjectRoot,
	readClaims,
} from "../../src/domains/claims/index.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const source = { channel: "verify", sessionId: "s1", toolCallId: "t1", requestedBy: "model" } as const;

function numericDetails(passed: boolean, validation: string, execution = "succeeded"): Record<string, unknown> {
	return {
		check: "stats",
		declaredCommand: ["python3", "stats.py"],
		judgement: { execution, validation },
		report: {
			kind: "numeric-compare",
			passed,
			tolerance: { relative: 1e-9 },
			combine: "all",
			nonFinite: "fail",
			rule: "relative<=1e-9 must hold",
			keys: [{ key: "std", passed, failed: passed ? [] : ["relative"], held: [], violated: [], detail: "" }],
			failedKeys: passed ? [] : ["std"],
			summary: "",
			reference: { source: "ref", path: "ref/stats.json", sha256: "a".repeat(64), bytes: 10 },
			actual: { sha256: "b".repeat(64), bytes: 10 },
		},
	};
}

describe("claims ledger (#406)", () => {
	it("records a failed judgement as disagreement and a check that never judged as nothing", () => {
		const at = "2026-11-06T00:00:00.000Z";
		const failed = claimFromVerifyResult({ details: numericDetails(false, "failed"), project: "/p", at, source });
		assert.equal(failed?.verdict, "disagrees");
		assert.equal(
			claimFromVerifyResult({ details: numericDetails(false, "not-run", "failed"), project: "/p", at, source }),
			null,
		);
		// A judgement word that contradicts the report is not trusted into a claim.
		assert.equal(claimFromVerifyResult({ details: numericDetails(false, "passed"), project: "/p", at, source }), null);
	});

	it("keys the log by the repository root and drops a line edited after capture", async () => {
		const env = await isolateClioEnv("clio-claims-");
		try {
			const repo = join(env.dir, "repo");
			mkdirSync(join(repo, ".git"), { recursive: true });
			mkdirSync(join(repo, "notebooks"), { recursive: true });
			const project = claimsProjectRoot(join(repo, "notebooks"));
			assert.equal(project, realpathSync(repo));
			const claim = claimFromVerifyResult({
				details: numericDetails(true, "passed"),
				project,
				at: "2026-11-06T00:00:00.000Z",
				source,
			});
			assert.ok(claim);
			await appendClaims([claim]);
			appendFileSync(claimsLogPath(project), `${JSON.stringify({ ...claim, verdict: "disagrees" })}\n`);
			const read = readClaims(claimsProjectRoot(repo));
			assert.deepEqual(
				read.records.map((record) => [record.id, record.verdict]),
				[[claim.id, "agrees"]],
			);
			assert.equal(read.mismatched, 1);
		} finally {
			env.restore();
		}
	});
});
