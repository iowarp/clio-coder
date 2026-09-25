import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";

import { deriveReceiptVerification } from "../../src/domains/dispatch/receipt-findings.js";
import type { ToolCallStat } from "../../src/domains/dispatch/types.js";

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
	deepStrictEqual(deriveReceiptVerification({ toolStats: [stat("verify", { ok: 0, errors: 1 })] }), {
		state: "unverified",
		basis: "validation-tool",
	});
});

test("a validation tool with both passing and failing calls is still unverified", () => {
	deepStrictEqual(deriveReceiptVerification({ toolStats: [stat("npm test", { ok: 1, errors: 1 })] }), {
		state: "unverified",
		basis: "validation-tool",
	});
});

test("a validation tool that ran and passed stays verified", () => {
	deepStrictEqual(deriveReceiptVerification({ toolStats: [stat("pytest", { ok: 2, errors: 0 })] }), {
		state: "verified",
		basis: "validation-tool",
	});
});

test("no validation tool at all still reports that none ran", () => {
	deepStrictEqual(deriveReceiptVerification({ toolStats: [stat("read", { ok: 3, errors: 0 })] }), {
		state: "unverified",
		basis: "no-validation-tool",
	});
	deepStrictEqual(deriveReceiptVerification({ toolStats: [] }), {
		state: "unverified",
		basis: "no-validation-tool",
	});
});

// The two prior bases are decided before any tool evidence and keep their
// meaning: a read-only agent has nothing to validate, and an ACP peer may have
// validated where Clio could not observe it.
test("read-only and ACP bases are unchanged by a failed validation tool", () => {
	deepStrictEqual(
		deriveReceiptVerification({ toolStats: [stat("verify", { ok: 0, errors: 1 })] }, { capabilityClass: "read-only" }),
		{ state: "not_applicable", basis: "read-only-agent" },
	);
	deepStrictEqual(deriveReceiptVerification({ toolStats: [] }, { acpDelegation: true }), {
		state: "unknown",
		basis: "acp-external-unobserved",
	});
});

// A failed validation tool is observed evidence, so it outranks the ACP
// "could not observe" basis for the same run.
test("an observed failed validation outranks the ACP unobserved basis", () => {
	deepStrictEqual(
		deriveReceiptVerification({ toolStats: [stat("verify", { ok: 0, errors: 1 })] }, { acpDelegation: true }),
		{ state: "unverified", basis: "validation-tool" },
	);
});
