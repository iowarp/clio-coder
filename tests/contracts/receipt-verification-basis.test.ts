import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";

import { deriveRunVerification, verificationWithHostVerdict } from "../../src/domains/dispatch/run-findings.js";
import type { RunHostVerificationCheck, ToolCallStat } from "../../src/domains/dispatch/types.js";

// BT-012. A worker ran `verify` and it failed, and the receipt still said
// `basis: "no-validation-tool"` beside its own
// `quality.typedValidations: [{sourceId: "tool:verify", passed: false}]`. The
// basis names the claimant that answered, and the state carries the verdict:
// `docs/guide/glossary.md:202` defines grounded as "validation was observed to
// run and pass, named by its claimant". A tool that ran and failed was still
// observed, so the receipt may not report that no validation tool ran.
function stat(tool: string, counts: { ok: number; errors: number }): ToolCallStat {
	return {
		tool,
		count: counts.ok + counts.errors,
		ok: counts.ok,
		errors: counts.errors,
		blocked: 0,
		totalDurationMs: 1,
	};
}

test("a validation tool that ran and failed is unverified, not absent", () => {
	deepStrictEqual(deriveRunVerification({ toolStats: [stat("verify", { ok: 0, errors: 1 })] }), {
		state: "unverified",
		basis: "validation-tool",
	});
});

test("a validation tool with both passing and failing calls is still unverified", () => {
	deepStrictEqual(deriveRunVerification({ toolStats: [stat("npm test", { ok: 1, errors: 1 })] }), {
		state: "unverified",
		basis: "validation-tool",
	});
});

test("a validation tool that ran and passed stays verified", () => {
	deepStrictEqual(deriveRunVerification({ toolStats: [stat("pytest", { ok: 2, errors: 0 })] }), {
		state: "verified",
		basis: "validation-tool",
	});
});

test("no validation tool at all still reports that none ran", () => {
	deepStrictEqual(deriveRunVerification({ toolStats: [stat("read", { ok: 3, errors: 0 })] }), {
		state: "unverified",
		basis: "no-validation-tool",
	});
	deepStrictEqual(deriveRunVerification({ toolStats: [] }), {
		state: "unverified",
		basis: "no-validation-tool",
	});
});

// The two prior bases are decided before any tool evidence and keep their
// meaning: a read-only agent has nothing to validate, and an ACP peer may have
// validated where Clio could not observe it.
test("read-only and ACP bases are unchanged by a failed validation tool", () => {
	deepStrictEqual(
		deriveRunVerification({ toolStats: [stat("verify", { ok: 0, errors: 1 })] }, { capabilityClass: "read-only" }),
		{ state: "not_applicable", basis: "read-only-agent" },
	);
	deepStrictEqual(deriveRunVerification({ toolStats: [] }, { acpDelegation: true }), {
		state: "unknown",
		basis: "acp-external-unobserved",
	});
});

// A failed validation tool is observed evidence, so it outranks the ACP
// "could not observe" basis for the same run.
test("an observed failed validation outranks the ACP unobserved basis", () => {
	deepStrictEqual(
		deriveRunVerification({ toolStats: [stat("verify", { ok: 0, errors: 1 })] }, { acpDelegation: true }),
		{ state: "unverified", basis: "validation-tool" },
	);
});

// bt-17: a worker whose own check the record could not attribute (a bash run that
// needed approval) read `unverified, no-validation-tool` beside a host verdict of
// `verified`. The host's verdict on the finished tree is the record's verification.
test("the host verdict outranks the worker's own evidence, and reused or unrun checks do not", () => {
	const check = (exitCode: number, extra: Partial<RunHostVerificationCheck> = {}): RunHostVerificationCheck => ({
		check: "python-unittest",
		argv: ["python3", "-m", "unittest"],
		cwd: "/repo",
		exitCode,
		durationMs: 1,
		memo: false,
		outputTail: "",
		...extra,
	});
	const worker = deriveRunVerification({ toolStats: [stat("bash", { ok: 1, errors: 0 })] });
	deepStrictEqual(worker, { state: "unverified", basis: "no-validation-tool" });
	deepStrictEqual(verificationWithHostVerdict(worker, { status: "verified", checks: [check(0)] }), {
		state: "verified",
		basis: "host-verification",
	});
	const passedByWorker = { state: "verified", basis: "validation-tool" } as const;
	deepStrictEqual(verificationWithHostVerdict(passedByWorker, { status: "rejected", checks: [check(1)] }), {
		state: "unverified",
		basis: "host-verification",
	});
	const failedOnBase = check(1, { baseComparison: { status: "failed" } });
	deepStrictEqual(
		verificationWithHostVerdict(passedByWorker, { status: "rejected", checks: [failedOnBase] }),
		passedByWorker,
	);
	deepStrictEqual(
		verificationWithHostVerdict(worker, { status: "verified", checks: [check(0, { memo: true })] }),
		worker,
	);
	deepStrictEqual(
		verificationWithHostVerdict(worker, { status: "verified", checks: [check(0, { notRun: "nothing-changed" })] }),
		worker,
	);
	const readOnly = { state: "not_applicable", basis: "read-only-agent" } as const;
	deepStrictEqual(verificationWithHostVerdict(readOnly, { status: "verified", checks: [check(0)] }), readOnly);
});
