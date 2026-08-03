import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import {
	agentRoleFactsResolver,
	deriveExecutionRole,
	EXECUTION_ROLES,
	type ExecutionRole,
	isExecutionRole,
	requestExecutionRole,
	withAttemptRole,
} from "../../src/domains/dispatch/execution-role.js";
import { type RouteCandidate, routeCandidateKey } from "../../src/domains/dispatch/route-decision.js";
import { createRouteHistoryStore, type RouteHistoryRecord } from "../../src/domains/dispatch/route-history.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { scriptedGateFabric } from "../harness/gate-fabric.js";

type ToolRunResult =
	| { kind: "ok"; output: string; details?: Record<string, unknown> }
	| { kind: "error"; message: string; details?: Record<string, unknown> };

function approvedDispatchOptions(requestId = "apr-execution-role") {
	return { approval: { requestId, requestedBy: "test-operator", actionClass: "dispatch" as const } };
}

/** The three builtin shapes Slice 3 names, as their strict Slice 2 recipe facts. */
const RECIPE_FACTS = agentRoleFactsResolver((agentId) => {
	if (agentId === "verifier") return { capabilityClass: "verification", resultContract: { kind: "verifier-report" } };
	if (agentId === "scout") return { capabilityClass: "read-only", resultContract: { kind: "scout-report" } };
	if (agentId === "researcher") return { capabilityClass: "read-only", resultContract: { kind: "research-report" } };
	if (agentId === "debugger") return { capabilityClass: "verification", resultContract: { kind: "debugger-report" } };
	if (agentId === "coder") return { capabilityClass: "workspace-edit", resultContract: { kind: "mutation-report" } };
	return null;
});

function historyRecord(route: RouteCandidate, executionRole: ExecutionRole, digest: string): RouteHistoryRecord {
	return {
		version: 3,
		receiptDigest: digest,
		assignmentId: "assignment-1",
		route,
		executionRole,
		qualityLabel: "pass",
		reliability: "success",
		firstPass: true,
		completedCostUsd: 0.1,
		completedPhaseTiming: null,
		cacheRead: false,
		sourceDigests: [digest],
		settledAt: "2026-07-20T00:00:00.000Z",
	};
}

function routeFixture(overrides: Partial<RouteCandidate> = {}): RouteCandidate {
	return {
		agentId: "coder",
		specFingerprint: "spec-a",
		executionRole: "builder",
		targetId: "primary",
		modelId: "model-a",
		runtimeId: "openai",
		nodeId: "local",
		toolSignature: "tools-a",
		promptCompositionHash: "prompt-a",
		endpointIdentityHash: "endpoint-a",
		settingsFingerprint: "settings-a",
		...overrides,
	};
}

describe("dispatch execution roles", () => {
	beforeEach(() => {
		isolateDispatchState();
	});
	after(() => {
		restoreDispatchState();
	});

	it("every receipt carries one semantic execution role", async () => {
		const fabric = scriptedGateFabric({});
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: fabric.spawn });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract });
			const result = (await tool.run(
				{ tasks: ["fix the build"], review: true },
				approvedDispatchOptions(),
			)) as ToolRunResult;
			strictEqual(result.kind, "ok", result.kind === "error" ? result.message : "");
			const runIds = (result.details?.assignmentIds ?? []) as ReadonlyArray<string>;
			ok(runIds.length > 0, "the gated dispatch sealed receipts");
			const roles: string[] = [];
			for (const runId of runIds) {
				const envelope = bundle.contract.getRun(runId);
				ok(envelope, `run ${runId} has a ledger envelope`);
				ok(isExecutionRole(envelope?.executionRole), `run ${runId} carries a known execution role`);
				roles.push(String(envelope?.executionRole));
			}
			// Exactly one role per run, drawn only from the single union.
			ok(roles.every((role) => (EXECUTION_ROLES as ReadonlyArray<string>).includes(role)));
			ok(roles.includes("builder") && roles.includes("reviewer"), `roles were ${roles.join(",")}`);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("retry attempts are recovery while the first attempt keeps its role", () => {
		for (const role of EXECUTION_ROLES) {
			strictEqual(withAttemptRole(role, 0), role, `attempt zero keeps ${role}`);
			strictEqual(withAttemptRole(role, 1), "recovery", `the first retry of ${role} is recovery`);
			strictEqual(withAttemptRole(role, 4), "recovery");
		}
		// Recovery wins over every topology and recipe signal, because a retry is
		// never an independent observation of the route it re-runs.
		strictEqual(
			deriveExecutionRole({
				attempt: 1,
				gateRole: "judge",
				capabilityClass: "verification",
				resultContractKind: "verifier-report",
			}),
			"recovery",
		);
	});

	it("compete candidates remain builders and the decider is judge", () => {
		for (const gateRole of ["builder", "candidate"] as const) {
			strictEqual(
				deriveExecutionRole({
					attempt: 0,
					gateRole,
					// Even a read-only reconnaissance recipe is builder evidence in a
					// build slot: topology overrides the recipe default.
					capabilityClass: "read-only",
					resultContractKind: "scout-report",
				}),
				"builder",
				`${gateRole} is builder evidence`,
			);
		}
		strictEqual(
			deriveExecutionRole({
				attempt: 0,
				gateRole: "judge",
				capabilityClass: "verification",
				resultContractKind: "verifier-report",
			}),
			"judge",
		);
		strictEqual(
			deriveExecutionRole({
				attempt: 0,
				gateRole: "reviewer",
				capabilityClass: "verification",
				resultContractKind: "verifier-report",
			}),
			"reviewer",
		);
	});

	it("direct scout verifier and coder requests derive distinct roles", () => {
		const roleOf = (agentId: string): ExecutionRole => requestExecutionRole({ agentId, resolveFacts: RECIPE_FACTS });
		strictEqual(roleOf("scout"), "researcher");
		strictEqual(roleOf("researcher"), "researcher");
		strictEqual(roleOf("verifier"), "verifier");
		strictEqual(roleOf("coder"), "builder");
		// A Debugger is verification-class but its contract deliberately does not
		// pose as a gate verdict, so it must not pool with verifier samples.
		strictEqual(roleOf("debugger"), "builder");
		notStrictEqual(roleOf("scout"), roleOf("verifier"));
		notStrictEqual(roleOf("verifier"), roleOf("coder"));
		// An unresolvable recipe claims no special standing.
		strictEqual(requestExecutionRole({ agentId: "unknown", resolveFacts: RECIPE_FACTS }), "builder");
	});

	it("route history keys differ by execution role", () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-role-history-"));
		try {
			const store = createRouteHistoryStore({ stateDir: dir });
			const builderRoute = routeFixture({ executionRole: "builder" });
			const reviewerRoute = routeFixture({ executionRole: "reviewer" });
			const recoveryRoute = routeFixture({ executionRole: "recovery" });

			// The same agent, target, model, runtime, and node is a different route
			// identity per role, so the estimator never mixes the populations.
			notStrictEqual(routeCandidateKey(builderRoute), routeCandidateKey(reviewerRoute));
			notStrictEqual(routeCandidateKey(builderRoute), routeCandidateKey(recoveryRoute));

			strictEqual(store.upsert(historyRecord(builderRoute, "builder", "a".repeat(64))), "inserted");
			strictEqual(store.upsert(historyRecord(reviewerRoute, "reviewer", "b".repeat(64))), "inserted");
			strictEqual(store.upsert(historyRecord(recoveryRoute, "recovery", "c".repeat(64))), "inserted");

			strictEqual(store.recordsFor(builderRoute).length, 1);
			strictEqual(store.recordsFor(reviewerRoute).length, 1);
			strictEqual(store.recordsFor(recoveryRoute).length, 1);
			deepStrictEqual(
				store.recordsFor(builderRoute).map((record) => record.executionRole),
				["builder"],
			);
			strictEqual(store.all().length, 3, "three roles are three separate samples");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
