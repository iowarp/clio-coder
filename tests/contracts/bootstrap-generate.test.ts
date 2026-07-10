import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	BOOTSTRAP_SCOUT_MAX_OUTPUT_BYTES,
	modelBootstrapGenerate,
	resolveBootstrapScoutRoute,
} from "../../src/cli/bootstrap-generate.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { UnsupportedResponseSchemaError } from "../../src/core/response-schema.js";
import { BOOTSTRAP_OUTPUT_JSON_SCHEMA, buildBootstrapPrompt } from "../../src/domains/context/bootstrap-prompt.js";
import {
	type BootstrapGenerateInput,
	type BootstrapGenerationTelemetry,
	buildCodewiki,
	scanAgentConfigs,
} from "../../src/domains/context/index.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";

const scratchRoots: string[] = [];

afterEach(() => {
	for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function bootstrapInput(): Promise<BootstrapGenerateInput> {
	const cwd = mkdtempSync(join(tmpdir(), "clio-bootstrap-generate-"));
	scratchRoots.push(cwd);
	writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "telemetry-fixture", type: "module" }), "utf8");
	writeFileSync(join(cwd, "index.ts"), "export const telemetryFixture = true;\n", "utf8");
	return {
		cwd,
		projectType: "typescript",
		siblingFiles: [],
		adoption: scanAgentConfigs({ cwd }),
		codewiki: await buildCodewiki({ cwd, language: "typescript", generatedAt: "2026-07-09T00:00:00.000Z" }),
	};
}

function receipt(overrides: Partial<RunReceipt> = {}): RunReceipt {
	return {
		runId: "scout-run-1",
		agentId: "scout",
		requestOrigin: "internal",
		task: "bootstrap",
		targetId: "mini",
		wireModelId: "MiniCPM-test",
		runtimeId: "llamacpp",
		runtimeKind: "http",
		runtimeResolution: {
			effectiveThinkingLevel: "off",
		} as NonNullable<RunReceipt["runtimeResolution"]>,
		startedAt: "2026-07-09T00:00:00.000Z",
		endedAt: "2026-07-09T00:00:01.250Z",
		exitCode: 0,
		tokenCount: 321,
		inputTokenCount: 250,
		outputTokenCount: 71,
		cacheReadTokenCount: 12,
		cacheWriteTokenCount: 3,
		reasoningTokenCount: 0,
		costUsd: 0,
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: "0.2.9-test",
		piMonoVersion: "test",
		platform: "linux",
		nodeVersion: process.version,
		toolCalls: 2,
		toolStats: [],
		sessionId: null,
		integrity: { version: 4, algorithm: "sha256", digest: "0".repeat(64) },
		...overrides,
	};
}

async function* eventStream(text: string): AsyncIterableIterator<unknown> {
	yield { type: "agent_start" };
	yield { type: "message_end", message: { role: "assistant", content: text } };
}

function fakeDispatch(
	text: string,
	finalReceipt = receipt(),
): {
	contract: DispatchContract;
	tasks: string[];
	requests: Parameters<DispatchContract["dispatch"]>[0][];
} {
	const tasks: string[] = [];
	const requests: Parameters<DispatchContract["dispatch"]>[0][] = [];
	const contract: DispatchContract = {
		dispatch: async (request) => {
			requests.push(request);
			tasks.push(request.task);
			return {
				runId: finalReceipt.runId,
				events: eventStream(text),
				finalPromise: Promise.resolve(finalReceipt),
			};
		},
		dispatchBatch: async () => {
			throw new Error("not used");
		},
		listRuns: () => [],
		getRun: () => null,
		abort: () => {},
		steer: () => {},
		snapshot: () => ({
			generatedAt: "2026-07-09T00:00:00.000Z",
			running: [],
			retrying: [],
			totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
		}),
		drain: async () => {},
	};
	return { contract, tasks, requests };
}

describe("contracts/bootstrap Scout generation", () => {
	it("keeps the wire schema inside the deployed llama.cpp grammar subset", () => {
		const serialized = JSON.stringify(BOOTSTRAP_OUTPUT_JSON_SCHEMA);
		strictEqual(serialized.includes("minLength"), false);
		strictEqual(serialized.includes("maxLength"), false);
		strictEqual(serialized.includes("maxItems"), false);
	});

	it("reports receipt-backed Scout telemetry with UTF-8 byte counts", async () => {
		const input = await bootstrapInput();
		const response = JSON.stringify({
			projectName: "Telemetry Fixture",
			identity: "A compact scientific μ-service.",
			conventions: [],
			invariants: [],
			sections: [],
		});
		const dispatch = fakeDispatch(response);
		const reports: BootstrapGenerationTelemetry[] = [];

		const output = await modelBootstrapGenerate({
			dispatch: dispatch.contract,
			route: { target: "mini", model: "MiniCPM-test" },
		})({
			...input,
			reportGeneration: (telemetry) => reports.push(telemetry),
		});

		strictEqual(output.projectName, "Telemetry Fixture");
		strictEqual(reports.length, 1);
		deepStrictEqual(reports[0], {
			mode: "scout",
			parserOutcome: "parsed",
			scout: {
				structuredOutputMode: "native-schema",
				runId: "scout-run-1",
				targetId: "mini",
				wireModelId: "MiniCPM-test",
				runtimeId: "llamacpp",
				runtimeKind: "http",
				thinkingLevel: "off",
				tokens: { total: 321, input: 250, output: 71, cacheRead: 12, cacheWrite: 3, reasoning: 0 },
				toolCalls: 2,
				toolFailures: 0,
				toolBlocked: 0,
				durationMs: 1250,
				promptBytes: Buffer.byteLength(buildBootstrapPrompt(input), "utf8"),
				outputBytes: Buffer.byteLength(response, "utf8"),
			},
		});
		strictEqual(dispatch.tasks.length, 1);
		strictEqual(dispatch.requests[0]?.target, "mini");
		strictEqual(dispatch.requests[0]?.model, "MiniCPM-test");
		strictEqual(dispatch.requests[0]?.thinkingLevel, "off");
		deepStrictEqual(dispatch.requests[0]?.responseSchema, BOOTSTRAP_OUTPUT_JSON_SCHEMA);
	});

	it("resolves the configured Scout binding and refuses missing or dangling profiles", () => {
		const configured = structuredClone(DEFAULT_SETTINGS);
		configured.workers.profiles.scout = {
			target: "mini",
			model: "MiniCPM-test",
			thinkingLevel: "off",
		};
		configured.workers.agentBindings.scout = "scout";
		deepStrictEqual(resolveBootstrapScoutRoute(configured), {
			target: "mini",
			model: "MiniCPM-test",
			thinkingLevel: "off",
		});

		const unbound = structuredClone(DEFAULT_SETTINGS);
		throws(() => resolveBootstrapScoutRoute(unbound), /has no worker profile binding/);
		unbound.workers.agentBindings.scout = "missing";
		throws(() => resolveBootstrapScoutRoute(unbound), /profile 'missing' is not configured/);
	});

	it("retries a valid non-schema Scout route through the bounded prompt parser", async () => {
		const input = await bootstrapInput();
		const response = JSON.stringify({
			projectName: "Telemetry Fixture",
			identity: "A compact scientific service.",
			conventions: [],
			invariants: [],
			sections: [],
		});
		const dispatch = fakeDispatch(response);
		const original = dispatch.contract.dispatch;
		dispatch.contract.dispatch = async (request) => {
			if (request.responseSchema !== undefined) {
				dispatch.requests.push(request);
				throw new UnsupportedResponseSchemaError("schema unavailable on this runtime");
			}
			return original(request);
		};
		const reports: BootstrapGenerationTelemetry[] = [];

		const output = await modelBootstrapGenerate({
			dispatch: dispatch.contract,
			route: { target: "dynamo", model: "qwopus", thinkingLevel: "medium" },
		})({ ...input, reportGeneration: (telemetry) => reports.push(telemetry) });

		strictEqual(output.projectName, "Telemetry Fixture");
		strictEqual(dispatch.requests.length, 2);
		ok(dispatch.requests[0]?.responseSchema);
		strictEqual(dispatch.requests[1]?.responseSchema, undefined);
		strictEqual(dispatch.requests[1]?.target, "dynamo");
		strictEqual(dispatch.requests[1]?.model, "qwopus");
		strictEqual(dispatch.requests[1]?.thinkingLevel, "medium");
		strictEqual(reports[0]?.mode, "scout");
		strictEqual(reports[0]?.scout?.structuredOutputMode, "prompt-parser");
	});

	it("bounds Scout output before parsing and discloses the observed bytes", async () => {
		const input = await bootstrapInput();
		const oversized = "x".repeat(BOOTSTRAP_SCOUT_MAX_OUTPUT_BYTES + 1);
		const dispatch = fakeDispatch(oversized);
		const reports: BootstrapGenerationTelemetry[] = [];

		const output = await modelBootstrapGenerate({ dispatch: dispatch.contract })({
			...input,
			reportGeneration: (telemetry) => reports.push(telemetry),
		});

		strictEqual(output.projectName, "Telemetry Fixture");
		strictEqual(reports[0]?.mode, "heuristic");
		strictEqual(reports[0]?.parserOutcome, "not-run");
		match(reports[0]?.fallbackReason ?? "", /output exceeded/);
		strictEqual(reports[0]?.scout?.outputBytes, BOOTSTRAP_SCOUT_MAX_OUTPUT_BYTES + 1);
	});

	it("reports rejected parsing once and retains the successful Scout receipt on fallback", async () => {
		const input = await bootstrapInput();
		const invalid = "not JSON μ";
		const dispatch = fakeDispatch(invalid);
		const reports: BootstrapGenerationTelemetry[] = [];

		const output = await modelBootstrapGenerate({ dispatch: dispatch.contract })({
			...input,
			reportGeneration: (telemetry) => reports.push(telemetry),
		});

		strictEqual(output.projectName, "Telemetry Fixture");
		strictEqual(reports.length, 1);
		strictEqual(reports[0]?.mode, "heuristic");
		strictEqual(reports[0]?.parserOutcome, "rejected");
		match(reports[0]?.fallbackReason ?? "", /did not contain a JSON object/);
		strictEqual(reports[0]?.scout?.runId, "scout-run-1");
		strictEqual(reports[0]?.scout?.tokens?.total, 321);
		strictEqual(reports[0]?.scout?.outputBytes, Buffer.byteLength(invalid, "utf8"));
	});

	it("reports dispatch failures as a non-parser heuristic fallback", async () => {
		const input = await bootstrapInput();
		const reports: BootstrapGenerationTelemetry[] = [];
		const dispatch = fakeDispatch("").contract;
		dispatch.dispatch = async () => {
			throw new Error("local Scout target unavailable");
		};

		const output = await modelBootstrapGenerate({ dispatch })({
			...input,
			reportGeneration: (telemetry) => reports.push(telemetry),
		});

		ok(output.identity.length > 0);
		strictEqual(reports.length, 1);
		strictEqual(reports[0]?.mode, "heuristic");
		strictEqual(reports[0]?.parserOutcome, "not-run");
		match(reports[0]?.fallbackReason ?? "", /local Scout target unavailable/);
		ok((reports[0]?.scout?.promptBytes ?? 0) > 0);
		strictEqual(reports[0]?.scout?.outputBytes, 0);
	});
});
