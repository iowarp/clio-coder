import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	attributeCommitMessage,
	CLIO_COMMIT_TRAILERS,
	CLIO_DECISION_TRAILER_CAP,
	decisionTrailerRefs,
} from "../../src/core/commit-attribution.js";
import {
	setCommitDecisionRefsProvider,
	withManagedGitCommitAttributionEnvironment,
} from "../../src/core/git-commit-attribution.js";
import type { ExecutionPlan, ExecutionPlanCodeStep } from "../../src/domains/dispatch/execution-plan.js";
import { deriveFleetCommitAttribution } from "../../src/domains/dispatch/fleet-commit-attribution.js";

const REFS = ["interview-1/db", "agent:a1b2/cache-key-shape"];

describe("Clio-Decision commit trailer", () => {
	it("renders one sorted trailer per ref, idempotently, after the role trailers", () => {
		const once = attributeCommitMessage("feat: add cache\n", { materiallyAuthored: true, decisions: REFS });
		strictEqual(
			once,
			[
				"feat: add cache",
				"",
				CLIO_COMMIT_TRAILERS.assisted,
				CLIO_COMMIT_TRAILERS.coAuthored,
				"Clio-Decision: agent:a1b2/cache-key-shape",
				"Clio-Decision: interview-1/db",
				"",
			].join("\n"),
		);
		strictEqual(attributeCommitMessage(once, { materiallyAuthored: true, decisions: REFS }), once);
	});

	it("respects a human-cased duplicate and drops a repeated Clio line", () => {
		const message = "fix: thing\n\nclio-decision: INTERVIEW-1/db\nClio-Decision: interview-1/db\n";
		const result = attributeCommitMessage(message, { decisions: ["interview-1/db"] });
		strictEqual(result, "fix: thing\n\nclio-decision: INTERVIEW-1/db\n");
	});

	it("writes only well-formed refs and caps the count", () => {
		deepStrictEqual(decisionTrailerRefs(["b/k", "a/k", "a/k", "nokey", "a/Bad Key", "x/k\nInjected: y", "/k", "a/"]), [
			"a/k",
			"b/k",
		]);
		const many = Array.from(
			{ length: CLIO_DECISION_TRAILER_CAP + 5 },
			(_, index) => `i/k-${String(index).padStart(2, "0")}`,
		);
		strictEqual(decisionTrailerRefs(many).length, CLIO_DECISION_TRAILER_CAP);
		const message = attributeCommitMessage("chore: x", { decisions: ["x/k\nInjected: y"] });
		strictEqual(message, "chore: x\n");
	});

	it("adds nothing when evidence carries no decisions", () => {
		strictEqual(
			attributeCommitMessage("chore: x\n", { validationSucceeded: true }),
			`chore: x\n\n${CLIO_COMMIT_TRAILERS.tested}\n`,
		);
	});
});

describe("fleet commit seam", () => {
	it("takes the decision refs from the committed step's sealed receipt", () => {
		const agentStep = { id: "build", kind: "agent", scope: "workspace" } as unknown as ExecutionPlan["steps"][number];
		const commitStep = { id: "commit", kind: "code", commitFrom: ["build"] } as unknown as ExecutionPlanCodeStep;
		const plan = { steps: [agentStep, commitStep] } as unknown as ExecutionPlan;
		const digest = "a".repeat(64);
		const evidence = deriveFleetCommitAttribution({
			plan,
			step: commitStep,
			priorResults: new Map([
				["build", { succeeded: true, integrityValid: true, receiptDigest: digest, decisionRefs: REFS }],
			]),
			validationFresh: true,
			independentReviewFresh: false,
		});
		deepStrictEqual(evidence.decisions, REFS);
		strictEqual(evidence.materiallyAuthored, true);
		strictEqual(evidence.receipt?.digest, digest);
		const bare = deriveFleetCommitAttribution({
			plan,
			step: commitStep,
			priorResults: new Map([["build", { succeeded: true, integrityValid: true, receiptDigest: digest }]]),
			validationFresh: false,
			independentReviewFresh: false,
		});
		strictEqual("decisions" in bare, false);
	});
});

describe("session commit seam", () => {
	const roots: string[] = [];
	afterEach(() => {
		setCommitDecisionRefsProvider(null);
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function outsideGit(): string {
		const root = mkdtempSync(join(tmpdir(), "clio-commit-decisions-"));
		roots.push(root);
		return root;
	}

	it("passes the live board's active refs through the spawn environment like assistance", () => {
		setCommitDecisionRefsProvider(() => ["interview-1/db", "agent:a1b2/cache-key-shape", "bad ref"]);
		const { env } = withManagedGitCommitAttributionEnvironment({}, { cwd: outsideGit(), enabled: true });
		strictEqual(env.CLIO_CODER_COMMIT_ASSISTED, "1");
		strictEqual(env.CLIO_CODER_COMMIT_DECISIONS, "agent:a1b2/cache-key-shape interview-1/db");
	});

	it("prefers explicit spawn evidence over the provider and omits the variable when empty", () => {
		setCommitDecisionRefsProvider(() => ["interview-1/db"]);
		const explicit = withManagedGitCommitAttributionEnvironment(
			{},
			{ cwd: outsideGit(), enabled: true, evidence: { materiallyAssisted: true, decisions: ["agent:z/only"] } },
		);
		strictEqual(explicit.env.CLIO_CODER_COMMIT_DECISIONS, "agent:z/only");
		setCommitDecisionRefsProvider(() => []);
		const empty = withManagedGitCommitAttributionEnvironment({}, { cwd: outsideGit(), enabled: true });
		strictEqual("CLIO_CODER_COMMIT_DECISIONS" in empty.env, false);
	});

	it("strips an inherited value so a nested seam starts clean", () => {
		const { env } = withManagedGitCommitAttributionEnvironment(
			{ CLIO_CODER_COMMIT_DECISIONS: "forged/ref" },
			{ cwd: outsideGit(), enabled: false },
		);
		strictEqual("CLIO_CODER_COMMIT_DECISIONS" in env, false);
		ok(!("CLIO_CODER_COMMIT_ASSISTED" in env));
		match(env.CLIO_CODER_GIT_COMMITS_ENABLED ?? "", /^0$/u);
	});
});
