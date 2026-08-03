import { ok, strictEqual, throws } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	type AttemptApplyEvidence,
	applyAttempt,
	beginAttempt,
	closeWorkspaceTransaction,
	discardAttempt,
	evaluateApplyEligibility,
	openWorkspaceTransaction,
	sealAttempt,
	type WorkspaceTransaction,
} from "../../src/domains/dispatch/workspace-transaction.js";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A scratch repository with one commit. Never the operator's checkout. */
function repository(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-workspace-tx-"));
	git(root, ["init", "-q", "-b", "main"]);
	git(root, ["config", "user.name", "clio-test"]);
	git(root, ["config", "user.email", "clio-test@local"]);
	writeFileSync(join(root, "src.txt"), "baseline\n");
	writeFileSync(join(root, "PROTECTED.md"), "do not touch\n");
	git(root, ["add", "-A"]);
	git(root, ["commit", "-q", "-m", "baseline", "--no-verify"]);
	return root;
}

const PASSING: AttemptApplyEvidence = {
	outcomeSucceeded: true,
	receiptIntegrityOk: true,
	resultContractConformed: true,
	qualityGatePassed: true,
};

function open(root: string, protectedPaths: string[] = []): WorkspaceTransaction {
	return openWorkspaceTransaction({ root, assignmentId: "assignment1", protectedPaths });
}

describe("contracts/dispatch active workspace routing", () => {
	it("workspace activation refuses a non-git checkout", () => {
		const plain = mkdtempSync(join(tmpdir(), "clio-workspace-plain-"));
		throws(() => openWorkspaceTransaction({ root: plain, assignmentId: "assignment1" }), /requires a git repository/u);
	});

	it("failed attempt mutations are absent from the fallback baseline", () => {
		const root = repository();
		const transaction = open(root);

		const first = beginAttempt(transaction, 0);
		writeFileSync(join(first.path, "src.txt"), "attempt zero partial edit\n");
		writeFileSync(join(first.path, "stray.txt"), "junk\n");
		sealAttempt(first, "attempt 0");
		discardAttempt(transaction, first);

		// The fallback branches from the same approved baseline, so it observes
		// the original file and none of the failed attempt's leftovers.
		const second = beginAttempt(transaction, 1);
		strictEqual(readFileSync(join(second.path, "src.txt"), "utf8"), "baseline\n");
		strictEqual(existsSync(join(second.path, "stray.txt")), false);
		discardAttempt(transaction, second);
		closeWorkspaceTransaction(transaction);
	});

	it("no two editing attempts share one mutable checkout", () => {
		const root = repository();
		const transaction = open(root);
		const first = beginAttempt(transaction, 0);
		const second = beginAttempt(transaction, 1);

		ok(first.path !== second.path);
		ok(first.branch !== second.branch);
		writeFileSync(join(first.path, "src.txt"), "only in attempt zero\n");
		strictEqual(readFileSync(join(second.path, "src.txt"), "utf8"), "baseline\n");
		// The operator checkout is untouched while both attempts are live: no
		// tracked file changed, and the only untracked entry is our own scaffolding.
		strictEqual(readFileSync(join(root, "src.txt"), "utf8"), "baseline\n");
		strictEqual(git(root, ["status", "--porcelain", "--untracked-files=no"]), "");

		discardAttempt(transaction, first);
		discardAttempt(transaction, second);
		closeWorkspaceTransaction(transaction);
	});

	it("only the quality-passing terminal attempt is applied", () => {
		const root = repository();
		const transaction = open(root);
		const failed = beginAttempt(transaction, 0);
		writeFileSync(join(failed.path, "src.txt"), "losing work\n");
		sealAttempt(failed, "attempt 0");
		discardAttempt(transaction, failed);

		const winner = beginAttempt(transaction, 1);
		writeFileSync(join(winner.path, "src.txt"), "winning work\n");
		sealAttempt(winner, "attempt 1");
		const result = applyAttempt(transaction, winner, PASSING);

		ok(result.applied);
		strictEqual(readFileSync(join(root, "src.txt"), "utf8"), "winning work\n");
		ok(!git(root, ["log", "--oneline"]).includes("losing"));
	});

	it("failed quality gate applies no changes", () => {
		const root = repository();
		const transaction = open(root);
		const attempt = beginAttempt(transaction, 0);
		writeFileSync(join(attempt.path, "src.txt"), "ungated work\n");
		sealAttempt(attempt, "attempt 0");

		const failed = applyAttempt(transaction, attempt, { ...PASSING, qualityGatePassed: false });
		ok(!failed.applied);
		ok(failed.reasons.includes("quality-gate-failed"));
		strictEqual(readFileSync(join(root, "src.txt"), "utf8"), "baseline\n");

		// An absent gate is a missing precondition, not an implicit pass, and an
		// unreached result contract cannot authorize a mutation either.
		const absent = applyAttempt(transaction, attempt, { ...PASSING, qualityGatePassed: null });
		ok(!absent.applied);
		ok(absent.reasons.includes("quality-gate-absent"));
		strictEqual(readFileSync(join(root, "src.txt"), "utf8"), "baseline\n");

		strictEqual(
			evaluateApplyEligibility({ ...PASSING, resultContractConformed: null })[0],
			"result-contract-not-reached",
		);
		strictEqual(evaluateApplyEligibility({ ...PASSING, outcomeSucceeded: false })[0], "attempt-did-not-succeed");
		strictEqual(evaluateApplyEligibility({ ...PASSING, receiptIntegrityOk: false })[0], "receipt-integrity-unverified");
		strictEqual(evaluateApplyEligibility(PASSING).length, 0);

		discardAttempt(transaction, attempt);
		closeWorkspaceTransaction(transaction);
	});

	it("protected artifact drift blocks apply", () => {
		const root = repository();
		const transaction = open(root, [join(root, "PROTECTED.md")]);
		const attempt = beginAttempt(transaction, 0);
		writeFileSync(join(attempt.path, "PROTECTED.md"), "touched anyway\n");
		sealAttempt(attempt, "attempt 0");

		const result = applyAttempt(transaction, attempt, PASSING);
		ok(!result.applied);
		strictEqual(result.reasons[0], "protected-artifact-drift");
		strictEqual(readFileSync(join(root, "PROTECTED.md"), "utf8"), "do not touch\n");
	});

	it("apply failure preserves the winner and recovery metadata", () => {
		const root = repository();
		const transaction = open(root, [join(root, "PROTECTED.md")]);
		const attempt = beginAttempt(transaction, 0);
		writeFileSync(join(attempt.path, "PROTECTED.md"), "touched anyway\n");
		writeFileSync(join(attempt.path, "src.txt"), "real work worth keeping\n");
		sealAttempt(attempt, "attempt 0");

		const result = applyAttempt(transaction, attempt, PASSING);
		ok(!result.applied);
		ok(result.preserved !== undefined);
		strictEqual(result.preserved.branch, attempt.branch);
		ok(result.preserved.recovery.includes(attempt.branch));
		// The evidence survives: the worktree is intact and cleanup refuses.
		strictEqual(readFileSync(join(attempt.path, "src.txt"), "utf8"), "real work worth keeping\n");
		throws(() => closeWorkspaceTransaction(transaction), /preserves an unapplied winner/u);
	});

	it("cancellation cleans losing worktrees after all owned workers settle", () => {
		const root = repository();
		const transaction = open(root);
		const first = beginAttempt(transaction, 0);
		const second = beginAttempt(transaction, 1);
		writeFileSync(join(first.path, "src.txt"), "canceled work\n");
		sealAttempt(first, "attempt 0");

		discardAttempt(transaction, first);
		discardAttempt(transaction, second);
		closeWorkspaceTransaction(transaction);

		strictEqual(existsSync(first.path), false);
		strictEqual(existsSync(second.path), false);
		strictEqual(existsSync(join(root, ".clio", "attempts")), false);
		// No attempt branch outlives the canceled transaction.
		ok(!git(root, ["branch", "--list", "--format=%(refname:short)"]).includes("clio/attempt/"));
		strictEqual(readFileSync(join(root, "src.txt"), "utf8"), "baseline\n");
	});

	it("route changes occur only at attempt boundaries", () => {
		const root = repository();
		const transaction = open(root);
		// A transaction pins one baseline for its whole life. A route change
		// between attempts therefore cannot move the state an attempt starts
		// from, which is what makes a mid-attempt switch unnecessary and a
		// boundary switch safe.
		const baseline = transaction.baseline;
		const first = beginAttempt(transaction, 0);
		writeFileSync(join(first.path, "src.txt"), "attempt zero\n");
		sealAttempt(first, "attempt 0");
		discardAttempt(transaction, first);

		strictEqual(transaction.baseline, baseline);
		const second = beginAttempt(transaction, 1);
		strictEqual(git(second.path, ["rev-parse", "HEAD"]), baseline);
		discardAttempt(transaction, second);
		closeWorkspaceTransaction(transaction);
	});

	it("a dirty operator checkout blocks apply", () => {
		const root = repository();
		const transaction = open(root);
		const attempt = beginAttempt(transaction, 0);
		writeFileSync(join(attempt.path, "src.txt"), "attempt work\n");
		sealAttempt(attempt, "attempt 0");
		writeFileSync(join(root, "src.txt"), "operator's own uncommitted edit\n");

		const result = applyAttempt(transaction, attempt, PASSING);
		ok(!result.applied);
		strictEqual(result.reasons[0], "destination-not-clean");
		// The operator's in-progress work is never overwritten or committed.
		strictEqual(readFileSync(join(root, "src.txt"), "utf8"), "operator's own uncommitted edit\n");
	});
});
