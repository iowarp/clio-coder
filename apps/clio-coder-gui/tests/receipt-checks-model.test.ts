import assert from "node:assert/strict";
import { test } from "node:test";
import { contractName, receiptChecks } from "../client/pages/traces/receipt-checks-model.js";

// Each fixture restates the check-bearing fields of a real v20 receipt sealed by 0.5.6. Digests are
// shortened stand-ins; the states, bases and claim names are the ones those receipts carry.
const schemaOff = { sourceId: null, schemaDigest: null, runtimeEnforceable: false, enforcementPassed: null };
const verifiedTool = {
	verification: { state: "verified", basis: "validation-tool" },
	quality: {
		version: 1,
		typedValidations: [{ sourceId: "tool:verify", validatorDigest: "56b553e90c163eb12020273f", passed: true }],
		responseSchema: schemaOff,
		resultContract: null,
	},
};
const mutationClaimedNothingRan = {
	verification: { state: "unverified", basis: "no-validation-tool" },
	quality: {
		version: 1,
		typedValidations: [],
		responseSchema: schemaOff,
		resultContract: {
			sourceId: "agent-result-contract:mutation-report:8399543b0144",
			validatorDigest: "bd7ffaa4eb8a0d5b6a79",
			conformance: "pass",
			quality: "unmeasured",
		},
	},
	validationGrounding: { claimed: 1, grounded: 0, ungrounded: ["response"], basis: "no-command-executed" },
};
const verifierFailedCheck = {
	verification: { state: "unverified", basis: "validation-tool" },
	quality: {
		version: 1,
		typedValidations: [{ sourceId: "tool:verify", validatorDigest: "0aef27d554b6", passed: false }],
		responseSchema: schemaOff,
		resultContract: {
			sourceId: "agent-result-contract:verifier-report:b5b7b83f99dd",
			validatorDigest: "cab6258cfe95",
			conformance: "pass",
			quality: "fail",
		},
	},
};
const verifierNeverFinished = {
	verification: { state: "unverified", basis: "no-validation-tool" },
	hostVerification: { status: "skipped", reason: "worker_not_successful", checks: [] },
	quality: {
		version: 1,
		typedValidations: [],
		responseSchema: schemaOff,
		resultContract: {
			sourceId: "agent-result-contract:verifier-report:b5b7b83f99dd",
			validatorDigest: "9424112f7214",
			conformance: "not-reached",
			quality: "unmeasured",
		},
	},
};
const unmatchedCommands = {
	...mutationClaimedNothingRan,
	validationGrounding: {
		claimed: 3,
		grounded: 0,
		ungrounded: ["read pages.ts (current on-disk, line-numbered)", "contrast ratio check for dim/frame tokens"],
		basis: "unmatched-command",
	},
};
const scoutPassed = {
	verification: { state: "not_applicable", basis: "read-only-agent" },
	quality: {
		version: 1,
		typedValidations: [],
		responseSchema: schemaOff,
		resultContract: {
			sourceId: "agent-result-contract:scout-report:b38f0dd8fa91",
			validatorDigest: "d0f57151b941",
			conformance: "pass",
			quality: "pass",
		},
	},
};

const byKey = (receipt: Record<string, unknown>) => new Map(receiptChecks(receipt).map((row) => [row.key, row]));

test("a verify-tool pass is a verified run with one passed check, and nothing else is promoted", () => {
	const rows = byKey(verifiedTool);
	assert.equal(rows.get("verification")?.tone, "success");
	assert.equal(rows.get("verification")?.meaning, "A validation tool ran and passed.");
	assert.equal(rows.get("typed")?.word, "1 passed");
	assert.deepEqual(
		rows.get("typed")?.items.map((item) => [item.name, item.word, item.facts]),
		[["verify tool", "Passed", ["digest 56b553e90c16"]]],
	);
	assert.equal(rows.get("conformance")?.word, "No contract");
	assert.equal(rows.get("conformance")?.tone, "neutral");
	assert.equal(rows.has("quality"), false, "No contract means no quality row to misread");
	assert.equal(rows.get("grounding")?.word, "None claimed");
	assert.equal(rows.get("host")?.word, "None declared");
	assert.equal(rows.get("schema")?.word, "Not enforced");
});

test("format conformance and unmeasured quality stay two facts, and an ungrounded claim fails its own row", () => {
	const rows = byKey(mutationClaimedNothingRan);
	assert.equal(rows.get("conformance")?.tone, "success");
	assert.equal(rows.get("conformance")?.word, "Conforms");
	assert.match(rows.get("conformance")?.meaning ?? "", /mutation report contract requires\. Shape is not correctness\./);
	assert.equal(rows.get("conformance")?.exact, "mutation report contract · digest bd7ffaa4eb8a");
	assert.equal(rows.get("quality")?.tone, "unverified");
	assert.equal(rows.get("quality")?.word, "Not measured");
	assert.match(rows.get("quality")?.meaning ?? "", /not a quality pass/);
	assert.equal(rows.get("grounding")?.tone, "fail");
	assert.equal(rows.get("grounding")?.word, "0 of 1 claim grounded");
	assert.deepEqual(
		rows.get("grounding")?.items.map((item) => item.name),
		["response"],
	);
	assert.equal(rows.get("typed")?.word, "None ran");
	assert.equal(rows.get("typed")?.tone, "unverified");
	assert.equal(rows.get("verification")?.word, "Unverified");
});

test("a failed typed check and a failed quality label read as failures while the shape still conforms", () => {
	const rows = byKey(verifierFailedCheck);
	assert.equal(rows.get("verification")?.meaning, "A validation tool ran and did not pass.");
	assert.equal(rows.get("typed")?.tone, "fail");
	assert.equal(rows.get("typed")?.word, "1 failed");
	assert.equal(rows.get("conformance")?.tone, "success");
	assert.equal(rows.get("quality")?.tone, "fail");
	assert.equal(rows.get("quality")?.word, "Failed");
});

test("a run that never produced a result reads as not reached, and skipped host checks are not passes", () => {
	const rows = byKey(verifierNeverFinished);
	assert.equal(rows.get("conformance")?.word, "Not reached");
	assert.equal(rows.get("conformance")?.tone, "neutral");
	assert.equal(rows.get("quality")?.meaning, "Nothing was judged, so quality is unknown.");
	assert.equal(rows.get("host")?.word, "Skipped");
	assert.equal(rows.get("host")?.meaning, "The worker did not succeed, so the declared checks did not run.");
});

test("unmatched commands are reported as a warning with the claims named", () => {
	const rows = byKey(unmatchedCommands);
	assert.equal(rows.get("grounding")?.tone, "warn");
	assert.equal(rows.get("grounding")?.word, "0 of 3 claims grounded");
	assert.match(rows.get("grounding")?.meaning ?? "", /not held against the run/);
	assert.equal(rows.get("grounding")?.items.length, 2);
});

test("a read-only scout keeps verification not applicable beside a quality pass", () => {
	const rows = byKey(scoutPassed);
	assert.equal(rows.get("verification")?.word, "Not applicable");
	assert.equal(rows.get("verification")?.tone, "neutral");
	assert.equal(rows.get("quality")?.tone, "success");
	assert.equal(rows.get("conformance")?.meaning.includes("scout report"), true);
});

test("host checks list each command with its exit, reuse and output", () => {
	const rows = byKey({
		...verifiedTool,
		hostVerification: {
			status: "rejected",
			strategy: "batch-settled",
			checks: [
				{ check: "typecheck", argv: ["pnpm", "tsc"], cwd: "/r", exitCode: 0, durationMs: 812, memo: true, outputTail: "" },
				{
					check: "unit",
					argv: ["pnpm", "test"],
					cwd: "/r",
					exitCode: 1,
					durationMs: 4100,
					memo: false,
					outputTail: "1 failing",
					evidenceRunId: "run-2",
				},
			],
		},
	});
	const host = rows.get("host");
	assert.equal(host?.tone, "fail");
	assert.equal(host?.word, "Rejected");
	assert.match(host?.meaning ?? "", /once for the whole batch/);
	assert.deepEqual(
		host?.items.map((item) => [item.name, item.word, item.facts, item.output ?? null]),
		[
			["typecheck", "Passed", ["exit 0", "812 ms", "reused result"], null],
			["unit", "Failed", ["exit 1", "4100 ms", "evidence from run run-2"], "1 failing"],
		],
	);
	assert.equal(new Set(host?.items.map((item) => item.id)).size, 2);
});

test("an enforced response schema reports its own pass or failure", () => {
	const pass = byKey({
		quality: {
			...verifiedTool.quality,
			responseSchema: { ...schemaOff, runtimeEnforceable: true, enforcementPassed: true },
		},
	});
	assert.equal(pass.get("schema")?.tone, "success");
	const fail = byKey({
		quality: {
			...verifiedTool.quality,
			responseSchema: { ...schemaOff, runtimeEnforceable: true, enforcementPassed: false },
		},
	});
	assert.equal(fail.get("schema")?.tone, "fail");
	const unknown = byKey({
		quality: { ...verifiedTool.quality, responseSchema: { ...schemaOff, runtimeEnforceable: true } },
	});
	assert.equal(unknown.get("schema")?.tone, "unverified");
});

test("absent or unfamiliar fields never read as success", () => {
	const shapes: Record<string, unknown>[] = [
		{},
		{ quality: null, verification: "verified" },
		{ quality: { typedValidations: "yes" }, validationGrounding: { claimed: "1" } },
		{
			quality: {
				typedValidations: [{ sourceId: "tool:verify" }],
				resultContract: { conformance: "ok", quality: "great" },
			},
		},
		{ verification: { state: "trusted" }, hostVerification: { status: "fine", checks: [{ check: "x" }] } },
	];
	for (const shape of shapes)
		for (const row of receiptChecks(shape)) {
			assert.notEqual(row.tone, "success", `${JSON.stringify(shape)} promoted ${row.key}`);
			for (const item of row.items)
				assert.notEqual(item.tone, "success", `${JSON.stringify(shape)} promoted ${item.name}`);
		}
	const empty = byKey({});
	assert.equal(empty.get("verification")?.word, "Not recorded");
	assert.equal(empty.get("typed")?.word, "Not recorded");
	assert.equal(empty.get("conformance")?.word, "Not recorded");
	assert.equal(empty.get("quality")?.word, "Not recorded");
});

test("contract names come from the source id's kind segment", () => {
	assert.equal(contractName("agent-result-contract:architect-plan:12e2"), "architect plan");
	assert.equal(contractName("custom:source"), "custom:source");
	assert.equal(contractName(null), null);
});
