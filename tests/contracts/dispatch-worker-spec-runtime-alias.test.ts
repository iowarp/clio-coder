import { doesNotThrow, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyFailure, decideRetry } from "../../src/domains/dispatch/failure-classification.js";
import type { RunTerminationEvidence } from "../../src/domains/dispatch/outcome.js";
import type { SpawnedWorkerResult } from "../../src/domains/dispatch/worker-spawn.js";
import {
	parseWorkerSpec,
	serializeWorkerRuntimeDescriptor,
	WORKER_RUNTIME_DESCRIPTOR_VERSION,
	WORKER_SPEC_VERSION,
} from "../../src/worker/spec-contract.js";

/**
 * The shape the operator's settings produce: the target names the runtime by the
 * legacy `lmstudio-native` spelling while routing resolved it to `lmstudio`.
 */
function specWithTargetRuntime(targetRuntime: string, aliases?: ReadonlyArray<string>): Record<string, unknown> {
	return {
		specVersion: WORKER_SPEC_VERSION,
		settingsFingerprint: "a".repeat(64),
		systemPrompt: "",
		agentId: "coder",
		executionRole: "builder",
		task: "t",
		target: { id: "dynamo", runtime: targetRuntime, url: "http://127.0.0.1:1234" },
		runtime: {
			version: WORKER_RUNTIME_DESCRIPTOR_VERSION,
			id: "lmstudio",
			kind: "http",
			apiFamily: "openai-completions",
			auth: "none",
			...(aliases === undefined ? {} : { aliases }),
		},
		runtimeId: "lmstudio",
		wireModelId: "model",
		allowedTools: [],
		budget: { toolCalls: 18, readReserve: 4, synthesis: true, hardCap: 50 },
	};
}

describe("worker spec target runtime alias", () => {
	it("accepts a target whose configured runtime is an alias of the resolved runtime", () => {
		doesNotThrow(() => parseWorkerSpec(specWithTargetRuntime("lmstudio-native", ["lmstudio-native"])));
	});

	it("accepts the canonical runtime id whether or not aliases are carried", () => {
		doesNotThrow(() => parseWorkerSpec(specWithTargetRuntime("lmstudio")));
		doesNotThrow(() => parseWorkerSpec(specWithTargetRuntime("lmstudio", ["lmstudio-native"])));
	});

	it("still rejects a target naming an unrelated runtime, and names the settings fix", () => {
		throws(
			() => parseWorkerSpec(specWithTargetRuntime("llamacpp", ["lmstudio-native"])),
			/target runtime mismatch.*Set the target's runtime to 'lmstudio'/s,
		);
	});

	it("rejects an alias list that is not an array of strings", () => {
		throws(() => parseWorkerSpec(specWithTargetRuntime("lmstudio", [7 as unknown as string])), /runtime\.aliases/);
	});

	it("carries the runtime's aliases into the serialized descriptor and omits an empty list", () => {
		const base = { id: "lmstudio", kind: "http", apiFamily: "openai-completions", auth: "none" } as const;
		strictEqual(
			serializeWorkerRuntimeDescriptor({ ...base, aliases: ["lmstudio-native"] } as never).aliases?.[0],
			"lmstudio-native",
		);
		strictEqual(serializeWorkerRuntimeDescriptor({ ...base, aliases: [] } as never).aliases, undefined);
		strictEqual(serializeWorkerRuntimeDescriptor({ ...base } as never).aliases, undefined);
	});
});

describe("worker spec rejection is not retried", () => {
	const evidence: RunTerminationEvidence = {
		abortedByOperator: false,
		policyDenied: null,
		permissionFailure: false,
		stallKilled: false,
		timedOut: false,
		exitCode: 2,
	} as RunTerminationEvidence;

	it("classifies a spec-contract rejection as deterministic and refuses a retry", () => {
		const result = {
			exitCode: 2,
			stderrTail: "[worker] fatal: WorkerSpec target runtime mismatch: target.runtime=lmstudio-native runtimeId=lmstudio",
		} as SpawnedWorkerResult;
		const failureClass = classifyFailure(evidence, result, "failed", null);
		strictEqual(failureClass, "deterministic-task");
		const decision = decideRetry(failureClass, 0, 2);
		strictEqual(decision.retry, false);
		strictEqual(decision.reasonCode, "non-retryable-deterministic-task");
	});

	it("leaves an ordinary worker failure retryable", () => {
		const result = { exitCode: 1, stderrTail: "[worker] agent ended with stopReason=error" } as SpawnedWorkerResult;
		const failureClass = classifyFailure(evidence, result, "failed", null);
		strictEqual(failureClass, "worker-runtime");
		strictEqual(decideRetry(failureClass, 0, 2).retry, true);
	});
});
