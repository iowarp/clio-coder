import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import {
	BOOTSTRAP_MAX_OUTPUT_BYTES,
	modelBootstrapGenerate,
	resolveBootstrapRoute,
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
		verification: { state: "unverified", basis: "no-validation-tool" },
		routingIntent: {
			posture: "balanced",
			maxCostUsd: null,
			deadlineMs: null,
			minimumQuality: null,
			requiredCapabilities: [],
			locality: "any",
			failover: "none",
		},
		quality: {
			version: 1,
			typedValidations: [],
			responseSchema: { sourceId: null, schemaDigest: null, runtimeEnforceable: false, enforcementPassed: null },
			resultContract: null,
		},
		costProvenance: "unknown",
		outcome: "succeeded",
		runId: "scout-run-1",
		agentId: "scout",
		executionRole: "builder",
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
		integrity: { version: 15, algorithm: "sha256", digest: "0".repeat(64) },
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
		planAgentSelection: () => {
			throw new Error("unexpected agent plan selection");
		},
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

describe("contracts/bootstrap model generation", () => {
	// Nested inside the describe, not at module top level: under
	// --experimental-test-isolation=none every file shares one root test
	// context, so a top-level beforeEach/afterEach runs around every test in
	// every file, not just this one's.
	afterEach(() => {
		for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("keeps the wire schema inside the deployed llama.cpp grammar subset", () => {
		const serialized = JSON.stringify(BOOTSTRAP_OUTPUT_JSON_SCHEMA);
		strictEqual(serialized.includes("minLength"), false);
		strictEqual(serialized.includes("maxLength"), false);
		strictEqual(serialized.includes("maxItems"), false);
	});

	/**
	 * The bootstrap dispatch used to be clamped to a 30s product ceiling layered
	 * over the operator's `internalDispatchTimeoutMs` guardrail. The agent is
	 * instructed to explore the repository with code_nav first, so that ceiling
	 * aborted real runs mid-exploration and every model-driven bootstrap silently
	 * degraded to the heuristic. The guardrail is the operator's knob for slow
	 * targets; the call site has no better information than it does.
	 */
	it("lets the operator guardrail govern the bootstrap deadline instead of a product ceiling", async () => {
		const input = await bootstrapInput();
		const response = JSON.stringify({
			projectName: "Deadline Fixture",
			identity: "A project whose bootstrap outlives the deleted 30s ceiling.",
			conventions: [],
			invariants: [],
			sections: [],
		});
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const aborted: string[] = [];
		const base = fakeDispatch(response);
		const contract: DispatchContract = {
			...base.contract,
			dispatch: async () => ({
				runId: "scout-run-1",
				events: (async function* () {
					await gate;
					yield { type: "message_end", message: { role: "assistant", content: response } };
				})(),
				finalPromise: Promise.resolve(receipt()),
			}),
			abort: (runId: string) => {
				aborted.push(runId);
			},
		};

		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const generated = modelBootstrapGenerate({ dispatch: contract })(input);
			await Promise.resolve();
			// Well past the deleted ceiling, comfortably inside the 15 minute default.
			mock.timers.tick(120_000);
			strictEqual(aborted.length, 0, "the deleted 30s ceiling must not abort a run the guardrail still allows");
			release();
			const output = await generated;
			strictEqual(output.projectName, "Deadline Fixture");
		} finally {
			mock.timers.reset();
		}
	});

	it("reports receipt-backed bootstrap telemetry with UTF-8 byte counts", async () => {
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
			mode: "model",
			parserOutcome: "parsed",
			run: {
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

	it("resolves the configured bootstrap binding and refuses dangling profiles", () => {
		const configured = structuredClone(DEFAULT_SETTINGS);
		configured.workers.profiles.handbook = {
			target: "mini",
			model: "MiniCPM-test",
			thinkingLevel: "off",
		};
		configured.workers.agentBindings["context-bootstrap"] = "handbook";
		deepStrictEqual(resolveBootstrapRoute(configured), {
			target: "mini",
			model: "MiniCPM-test",
			thinkingLevel: "off",
		});

		const dangling = structuredClone(DEFAULT_SETTINGS);
		dangling.workers.agentBindings["context-bootstrap"] = "missing";
		throws(() => resolveBootstrapRoute(dangling), /profile 'missing' is not configured/);

		const targetless = structuredClone(DEFAULT_SETTINGS);
		targetless.workers.profiles.empty = { target: null, model: null, thinkingLevel: "off" };
		targetless.workers.agentBindings["context-bootstrap"] = "empty";
		throws(() => resolveBootstrapRoute(targetless), /profile 'empty' has no target/);
	});

	// Bootstrap used to throw when no binding existed, which made it the only
	// internal dispatch that could not run off workers.default. A fresh install
	// with a working default therefore never produced a model-driven CLIO-CODER.md.
	it("falls back to workers.default when no bootstrap binding is configured", () => {
		const unbound = structuredClone(DEFAULT_SETTINGS);
		unbound.workers.default = { target: "dynamo", model: "qwopus-coder", thinkingLevel: "off" };
		deepStrictEqual(resolveBootstrapRoute(unbound), {
			target: "dynamo",
			model: "qwopus-coder",
			thinkingLevel: "off",
		});

		const bound = structuredClone(unbound);
		bound.workers.profiles.fast = { target: "mini", model: "MiniCPM-test", thinkingLevel: "off" };
		bound.workers.agentBindings["context-bootstrap"] = "fast";
		strictEqual(resolveBootstrapRoute(bound).target, "mini", "an explicit binding still wins over the default");

		const routeless = structuredClone(DEFAULT_SETTINGS);
		throws(() => resolveBootstrapRoute(routeless), /workers.default has no target/);
	});

	// Bootstrap used to run through the Scout recipe, so operators who cared
	// which model wrote their handbook bound `scout`. An upgrade that ignored
	// that binding would silently move handbook generation onto workers.default.
	it("honors a legacy scout binding when no context-bootstrap binding exists", () => {
		const legacy = structuredClone(DEFAULT_SETTINGS);
		legacy.workers.default = { target: "dynamo", model: "qwopus-coder", thinkingLevel: "off" };
		legacy.workers.profiles.fast = { target: "mini", model: "MiniCPM-test", thinkingLevel: "off" };
		legacy.workers.agentBindings.scout = "fast";
		strictEqual(resolveBootstrapRoute(legacy).target, "mini");

		const both = structuredClone(legacy);
		both.workers.profiles.handbook = { target: "zbook", model: "handbook-model", thinkingLevel: "off" };
		both.workers.agentBindings["context-bootstrap"] = "handbook";
		strictEqual(
			resolveBootstrapRoute(both).target,
			"zbook",
			"an explicit context-bootstrap binding outranks the legacy scout binding",
		);
	});

	it("retries a valid non-schema bootstrap route through the bounded prompt parser", async () => {
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
		strictEqual(reports[0]?.mode, "model");
		strictEqual(reports[0]?.run?.structuredOutputMode, "prompt-parser");
	});

	/**
	 * llama-server compiles `response_format.schema` into a sampler grammar and
	 * refuses the request with HTTP 400 when that grammar will not build beside
	 * the tool grammar, which is every bootstrap run on that runtime. The
	 * refusal arrives on the receipt rather than at dispatch, so the fallback
	 * that already existed for the admission-time refusal never armed and the
	 * flagship onboarding step could not reach the model at all.
	 */
	it("retries through the prompt parser when the server rejects the schema-derived grammar", async () => {
		const input = await bootstrapInput();
		const response = JSON.stringify({
			projectName: "Grammar Fixture",
			identity: "A project whose first bootstrap request the server refused.",
			conventions: [],
			invariants: [],
			sections: [],
		});
		const dispatch = fakeDispatch(response);
		const original = dispatch.contract.dispatch;
		dispatch.contract.dispatch = async (request) => {
			if (request.responseSchema === undefined) return original(request);
			dispatch.requests.push(request);
			return {
				runId: "scout-run-rejected",
				events: eventStream(""),
				finalPromise: Promise.resolve(
					receipt({
						runId: "scout-run-rejected",
						outcome: "failed",
						exitCode: 1,
						failureMessage:
							'400: {"code":400,"message":"Failed to initialize samplers: failed to parse grammar","type":"invalid_request_error"}',
					}),
				),
			};
		};
		const reports: BootstrapGenerationTelemetry[] = [];

		const output = await modelBootstrapGenerate({
			dispatch: dispatch.contract,
			route: { target: "mini", model: "Nemo-test", thinkingLevel: "off" },
		})({ ...input, reportGeneration: (telemetry) => reports.push(telemetry) });

		strictEqual(output.projectName, "Grammar Fixture");
		strictEqual(dispatch.requests.length, 2);
		ok(dispatch.requests[0]?.responseSchema);
		strictEqual(dispatch.requests[1]?.responseSchema, undefined);
		strictEqual(dispatch.requests[1]?.target, "mini");
		strictEqual(reports.length, 1);
		strictEqual(reports[0]?.mode, "model");
		strictEqual(reports[0]?.parserOutcome, "parsed");
		strictEqual(reports[0]?.run?.structuredOutputMode, "prompt-parser");
	});

	/**
	 * A rejected request returns no assistant text, so the empty-text throw
	 * fired first and described a healthy target as a model that said nothing.
	 * The receipt is the authority whenever it records a nonzero exit.
	 */
	it("reports the receipt failure rather than the empty transcript it causes", async () => {
		const input = await bootstrapInput();
		const dispatch = fakeDispatch("");
		dispatch.contract.dispatch = async (request) => {
			dispatch.requests.push(request);
			return {
				runId: "scout-run-1",
				events: eventStream(""),
				finalPromise: Promise.resolve(
					receipt({ outcome: "failed", exitCode: 1, failureMessage: "413: request entity too large" }),
				),
			};
		};
		const reports: BootstrapGenerationTelemetry[] = [];

		const output = await modelBootstrapGenerate({ dispatch: dispatch.contract })({
			...input,
			reportGeneration: (telemetry) => reports.push(telemetry),
		});

		strictEqual(output.projectName, "Telemetry Fixture");
		strictEqual(reports.length, 1);
		match(reports[0]?.fallbackReason ?? "", /bootstrap agent failed with exit 1: 413: request entity too large/);
		strictEqual(
			/did not return an assistant response/.test(reports[0]?.fallbackReason ?? ""),
			false,
			"a nonzero receipt must not be reported as a silent model",
		);
		// One attempt only: the failure is not a schema refusal.
		strictEqual(dispatch.requests.length, 1);
	});

	it("still names the silent model when the transcript is empty and the receipt is clean", async () => {
		const input = await bootstrapInput();
		const dispatch = fakeDispatch("");
		const reports: BootstrapGenerationTelemetry[] = [];

		const output = await modelBootstrapGenerate({ dispatch: dispatch.contract })({
			...input,
			reportGeneration: (telemetry) => reports.push(telemetry),
		});

		strictEqual(output.projectName, "Telemetry Fixture");
		match(reports[0]?.fallbackReason ?? "", /did not return an assistant response/);
		strictEqual(reports[0]?.parserOutcome, "not-run");
	});

	it("bounds bootstrap output before parsing and discloses the observed bytes", async () => {
		const input = await bootstrapInput();
		const oversized = "x".repeat(BOOTSTRAP_MAX_OUTPUT_BYTES + 1);
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
		strictEqual(reports[0]?.run?.outputBytes, BOOTSTRAP_MAX_OUTPUT_BYTES + 1);
	});

	it("reports rejected parsing once and retains the successful bootstrap receipt on fallback", async () => {
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
		strictEqual(reports[0]?.run?.runId, "scout-run-1");
		strictEqual(reports[0]?.run?.tokens?.total, 321);
		strictEqual(reports[0]?.run?.outputBytes, Buffer.byteLength(invalid, "utf8"));
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
		ok((reports[0]?.run?.promptBytes ?? 0) > 0);
		strictEqual(reports[0]?.run?.outputBytes, 0);
	});
});
