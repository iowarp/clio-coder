/**
 * Slice 5a: change manifests are evidence-linked governance artifacts. When a
 * resolver is injected, `validateChangeManifest` checks that every non-empty
 * `evidenceRef` is a well-formed `run-<id>` / `session-<id>` bundle id and that
 * it resolves to a real bundle. A dangling or malformed ref fails; a resolvable
 * ref passes and summarizes. The resolver is a pure predicate, so the evolution
 * domain never imports the evidence domain. Without a resolver the validator
 * keeps its prior schema-only behavior (backward compatible).
 */

import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { listEvidenceOverviews } from "../../src/domains/evidence/index.js";
import {
	type ChangeManifest,
	summarizeChangeManifest,
	validateChangeManifest,
} from "../../src/domains/evolution/index.js";

/**
 * Build a minimal valid change manifest with one low-authority change so the
 * only validation lever under test is the evidence-ref handling. Authority is
 * `prompt` (low), so non-empty `predictedRegressions` is not required; callers
 * override `iterationId` and `evidenceRefs` per case.
 */
function buildManifest(overrides: { iterationId: string; evidenceRefs: string[] }): unknown {
	const manifest: ChangeManifest = {
		version: 1,
		iterationId: overrides.iterationId,
		baseGitSha: "0000000000000000000000000000000000000000",
		createdAt: "2026-06-25T00:00:00.000Z",
		changes: [
			{
				id: "change-1",
				componentIds: ["context-file:CLIO-CODER.md"],
				filesChanged: ["CLIO-CODER.md"],
				authorityLevel: "prompt",
				evidenceRefs: overrides.evidenceRefs,
				rootCause: "Observed defect with linked evidence.",
				targetedFix: "Apply the smallest change that addresses the root cause.",
				predictedFixes: ["The defect no longer reproduces."],
				predictedRegressions: ["No expected regression."],
				validationPlan: ["npm run test"],
				rollbackPlan: "Revert the filesChanged entries for this change.",
			},
		],
	};
	return manifest as unknown;
}

function evidenceRefIssues(result: ReturnType<typeof validateChangeManifest>): string[] {
	if (result.valid) return [];
	return result.issues.filter((issue) => issue.path.includes(".evidenceRefs")).map((issue) => issue.message);
}

describe("evolution evidence-linked manifests (Slice 5a)", () => {
	it("fails a dangling evidenceRef when a resolver is provided", () => {
		const value = buildManifest({ iterationId: "iteration-2", evidenceRefs: ["run-doesnotexist"] });
		const result = validateChangeManifest(value, { resolveEvidenceRef: () => false });
		strictEqual(result.valid, false);
		const messages = evidenceRefIssues(result);
		ok(
			messages.some((message) => message.includes("evidence bundle not found: run-doesnotexist")),
			`expected a dangling-ref issue, got ${JSON.stringify(messages)}`,
		);
	});

	it("passes and summarizes when refs resolve", () => {
		const value = buildManifest({ iterationId: "iteration-2", evidenceRefs: ["run-abc"] });
		const result = validateChangeManifest(value, { resolveEvidenceRef: (ref) => ref === "run-abc" });
		strictEqual(result.valid, true);
		if (!result.valid) return;
		const summary = summarizeChangeManifest(result.manifest);
		strictEqual(summary.iterationId, "iteration-2");
		strictEqual(summary.changeCount, 1);
	});

	it("accepts a well-formed session bundle id", () => {
		const value = buildManifest({ iterationId: "iteration-2", evidenceRefs: ["session-xyz"] });
		const result = validateChangeManifest(value, { resolveEvidenceRef: (ref) => ref === "session-xyz" });
		strictEqual(result.valid, true);
	});

	it("fails a malformed ref on the format check when a resolver is provided", () => {
		for (const bad of ["abc", "bundle-1", "run-", "session-"]) {
			const value = buildManifest({ iterationId: "iteration-2", evidenceRefs: [bad] });
			const result = validateChangeManifest(value, { resolveEvidenceRef: () => true });
			strictEqual(result.valid, false, `expected ${bad} to be rejected`);
			const messages = evidenceRefIssues(result);
			ok(
				messages.some((message) => message.includes("expected a run-<id> or session-<id> bundle id")),
				`expected a format issue for ${bad}, got ${JSON.stringify(messages)}`,
			);
		}
	});

	it("keeps the exploratory-1 empty-refs exemption with and without a resolver", () => {
		const value = buildManifest({ iterationId: "exploratory-1", evidenceRefs: [] });
		strictEqual(validateChangeManifest(value).valid, true);
		strictEqual(validateChangeManifest(value, { resolveEvidenceRef: () => false }).valid, true);
	});

	it("is backward compatible: without options no ref checks run", () => {
		// A non-exploratory manifest whose refs are dangling AND malformed still
		// validates when no resolver is injected, proving the new checks are gated.
		const value = buildManifest({ iterationId: "iteration-2", evidenceRefs: ["not-a-bundle", "run-missing"] });
		const result = validateChangeManifest(value);
		strictEqual(result.valid, true);
	});

	it("resolves refs through a real evidence store (listEvidenceOverviews)", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-evolution-refs-"));
		try {
			const evidenceId = "run-xyz";
			const dir = join(scratch, "evidence", evidenceId);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "overview.json"), JSON.stringify(overviewFixture(evidenceId)), "utf8");

			const overviews = await listEvidenceOverviews(scratch);
			const knownIds = new Set(overviews.map((overview) => overview.evidenceId));
			ok(knownIds.has(evidenceId), `expected ${evidenceId} to be discovered, got ${JSON.stringify([...knownIds])}`);

			const resolveEvidenceRef = (ref: string) => knownIds.has(ref);
			const present = validateChangeManifest(buildManifest({ iterationId: "iteration-2", evidenceRefs: [evidenceId] }), {
				resolveEvidenceRef,
			});
			strictEqual(present.valid, true);

			const absent = validateChangeManifest(buildManifest({ iterationId: "iteration-2", evidenceRefs: ["run-absent"] }), {
				resolveEvidenceRef,
			});
			strictEqual(absent.valid, false);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});

/** A minimal `overview.json` payload that satisfies the store parser. */
function overviewFixture(evidenceId: string): Record<string, unknown> {
	return {
		version: 1,
		evidenceId,
		source: { kind: "run", runId: "xyz" },
		generatedAt: "2026-06-25T00:00:00.000Z",
		runIds: ["xyz"],
		sessionId: null,
		statuses: ["succeeded"],
		startedAt: null,
		endedAt: null,
		tasks: [],
		cwds: [],
		agentIds: [],
		targetIds: [],
		runtimeIds: [],
		modelIds: [],
		totals: {
			runs: 1,
			receipts: 1,
			toolCalls: 0,
			toolErrors: 0,
			blockedToolCalls: 0,
			tokens: 0,
			costUsd: 0,
			wallTimeMs: 0,
		},
		tags: [],
		files: [],
	};
}
