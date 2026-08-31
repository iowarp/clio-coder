import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { asDirectoryPathBoundary, resolvePathBoundary } from "../../src/core/path-boundary.js";
import type { DispatchRequest } from "../../src/domains/dispatch/contract.js";
import { normalizeDispatchIntent } from "../../src/domains/dispatch/intent.js";
import {
	DispatchPathScopeInferenceError,
	legacyScopeInferenceNotice,
	resolveDispatchPathScope,
} from "../../src/domains/dispatch/path-scope.js";
import { dispatchRequestsFromArgs, prepareDispatchArguments } from "../../src/tools/dispatch-arguments.js";

const EMPTY_CHECKS = new Map();

function request(task: string, extras: Partial<DispatchRequest> = {}): DispatchRequest {
	return { agentId: "coder", executionRole: "builder", task, ...extras };
}

function resolveIntent(rawIntent: unknown) {
	const normalized = normalizeDispatchIntent(rawIntent, EMPTY_CHECKS);
	return normalized.ok
		? { ok: true as const, intent: normalized.intent, resolvedVerification: [] }
		: { ok: false as const, message: `${normalized.reason}: ${normalized.message}` };
}

describe("legacy dispatch path inference", () => {
	it("records a task-only path as inferred with medium confidence", () => {
		const scope = resolveDispatchPathScope(request("Inspect src/task.ts before answering."));
		deepStrictEqual(scope.workingContextPaths, ["src/task.ts"]);
		deepStrictEqual(scope.provenance.workingContextPaths, [
			{
				path: "src/task.ts",
				evidence: [
					{
						provenance: "inferred",
						source: "task",
						confidence: "medium",
						reason: "task_path_token",
					},
				],
			},
		]);
	});

	it("records a briefing-only path without retaining briefing prose", () => {
		const briefing = "The parent found a relevant implementation in docs/brief.md before this request.";
		const scope = resolveDispatchPathScope(request("Inspect the supplied implementation.", { briefing }));
		deepStrictEqual(scope.workingContextPaths, ["docs/brief.md"]);
		deepStrictEqual(scope.provenance.workingContextPaths[0]?.evidence, [
			{
				provenance: "inferred",
				source: "briefing",
				confidence: "low",
				reason: "briefing_path_token",
			},
		]);
		strictEqual(JSON.stringify(scope.provenance).includes(briefing), false);
	});

	it("records legacy writeRoots as derived high-confidence context and authority", () => {
		const cwd = process.cwd();
		const scope = resolveDispatchPathScope(request("Prepare the requested output.", { cwd, writeRoots: ["work/"] }));
		deepStrictEqual(scope.workingContextPaths, ["work/"]);
		deepStrictEqual(scope.writeBoundaries, [asDirectoryPathBoundary(resolvePathBoundary(cwd, "work/"))]);
		for (const entry of [scope.provenance.workingContextPaths[0], scope.provenance.writeBoundaries[0]]) {
			deepStrictEqual(entry?.evidence, [
				{
					provenance: "derived",
					source: "writeRoots",
					confidence: "high",
					reason: "legacy_write_roots",
				},
			]);
		}
	});

	it("deduplicates one path while preserving its task and briefing sources", () => {
		const scope = resolveDispatchPathScope(
			request("Inspect src/shared.ts.", { briefing: "The parent also identified src/shared.ts." }),
		);
		deepStrictEqual(scope.workingContextPaths, ["src/shared.ts"]);
		deepStrictEqual(
			scope.provenance.workingContextPaths[0]?.evidence.map((entry) => [entry.source, entry.confidence]),
			[
				["task", "medium"],
				["briefing", "low"],
			],
		);
	});

	it("keeps declared intent closed and reports prose paths without adding them", () => {
		const normalized = normalizeDispatchIntent({ read_roots: ["src/"] }, EMPTY_CHECKS);
		if (!normalized.ok) throw new Error(normalized.message);
		const scope = resolveDispatchPathScope(request("Inspect docs/undeclared.md.", { intent: normalized.intent }));
		deepStrictEqual(scope.workingContextPaths, ["src/"]);
		deepStrictEqual(scope.inferredOnlyPaths, ["docs/undeclared.md"]);
		strictEqual(scope.provenance.mode, "declared");
	});

	it("refuses contradictory declared and legacy write roots", () => {
		const parsed = dispatchRequestsFromArgs(
			prepareDispatchArguments({
				task: "Update the declared output.",
				writeRoots: ["legacy/"],
				intent: { write_roots: ["declared/"] },
			}),
			{
				auto: { approvedAuthorities: ["workspace-edit"], authorityBasis: "operator-plan-approval" },
				resolveIntent,
			},
		);
		strictEqual(parsed.ok, false);
		ok(parsed.ok === false);
		// The code is the stable part; the rest of the message has to name the fix,
		// because a caller that only learns "contradiction" cannot tell which of the
		// two declarations it is meant to drop.
		match(parsed.message, /^dispatch: task 1: intent_write_roots_contradiction: /u);
		match(parsed.message, /drop writeRoots and declare the exact write scope once in intent\.write_roots/u);
	});

	it("refuses a malformed inferred path with a typed code", () => {
		throws(
			() => resolveDispatchPathScope(request("Inspect src//broken.ts before answering.")),
			(error: unknown) => error instanceof DispatchPathScopeInferenceError && error.code === "legacy_scope_path_malformed",
		);
	});

	it("refuses an absolute inferred path with a typed code", () => {
		throws(
			() => resolveDispatchPathScope(request("Inspect /tmp/secret.ts before answering.")),
			(error: unknown) => error instanceof DispatchPathScopeInferenceError && error.code === "legacy_scope_path_absolute",
		);
	});

	it("records an explicit empty legacy scope and renders a typed warning", () => {
		const scope = resolveDispatchPathScope(request("Summarize the supplied information."));
		deepStrictEqual(scope.provenance, {
			version: 1,
			mode: "legacy-inferred",
			workingContextPaths: [],
			writeBoundaries: [],
		});
		const notice = legacyScopeInferenceNotice(scope);
		strictEqual(notice?.code, "legacy_scope_empty");
		match(notice?.message ?? "", /no declared intent and inferred no policy-bearing paths/u);
	});

	it("keeps JSON escapes and glob mentions in the lower-confidence legacy path flow", () => {
		const scope = resolveDispatchPathScope(
			request(String.raw`Use schema minimum:0\nlanguages and scan .cursor/rules/*.mdc before answering.`),
		);
		deepStrictEqual(scope.workingContextPaths, [".cursor/rules"]);
		strictEqual(scope.provenance.workingContextPaths[0]?.evidence[0]?.confidence, "medium");
	});
});
