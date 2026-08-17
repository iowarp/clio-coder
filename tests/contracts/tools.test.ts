import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { Type } from "typebox";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import type { DispatchContract, DispatchRequest } from "../../src/domains/dispatch/contract.js";
import { withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { RunEnvelope, RunReceipt, RunReceiptDraft } from "../../src/domains/dispatch/types.js";
import { CONFIRMED_SCOPE, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import { resolveAgentTools } from "../../src/tools/agent-tools.js";
import { bashTool } from "../../src/tools/bash.js";
import { registerAllTools } from "../../src/tools/bootstrap.js";
import { credentialPresentTool } from "../../src/tools/credential-present.js";
import {
	createDispatchRunEventRegistry,
	createDispatchTool,
	type DispatchRunEventRegistry,
} from "../../src/tools/dispatch.js";
import { editTool } from "../../src/tools/edit.js";
import { findTool } from "../../src/tools/find.js";
import { grepTool } from "../../src/tools/grep.js";
import { lsTool } from "../../src/tools/ls.js";
import { OBSERVATION_TURN_BUDGET_ENV } from "../../src/tools/observation.js";
import { applyToolProfile } from "../../src/tools/profiles.js";
import { readTool } from "../../src/tools/read.js";
import { createRegistry, type ToolSpec } from "../../src/tools/registry.js";
import { shapeToolResult } from "../../src/tools/result-shaping.js";
import { createSteerTool } from "../../src/tools/steer.js";
import { verifyTool } from "../../src/tools/verify/index.js";
import { writeTool } from "../../src/tools/write.js";

const scratchRoots: string[] = [];

const unexpectedAgentPlanSelection: DispatchContract["planAgentSelection"] = () => {
	throw new Error("unexpected agent plan selection");
};

function scratchDir(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-tools-basic-"));
	scratchRoots.push(root);
	return root;
}

function workspaceScratchDir(): string {
	const parent = join(process.cwd(), ".clio-coder", "test-scratch");
	mkdirSync(parent, { recursive: true });
	const root = mkdtempSync(join(parent, "clio-tools-basic-"));
	scratchRoots.push(root);
	return root;
}

function writePackageJson(root: string, scripts: Record<string, string>): void {
	writeFileSync(join(root, "package.json"), `${JSON.stringify({ scripts }, null, "\t")}\n`, "utf8");
}

afterEach(() => {
	for (const root of scratchRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function mockToolSpec(name: ToolName, maxBytes: number): ToolSpec {
	return {
		name,
		description: "test tool",
		parameters: Type.Object({}),
		baseActionClass: "read",
		metadata: {
			objective: "test objective",
			uiLabel: name,
			retrySafety: "idempotent",
			costLatency: "local_fast",
			resultSizePolicy: {
				kind: "summary",
				maxBytes,
				followUpHint: "narrow the request",
			},
		},
		run: async () => ({ kind: "ok", output: "" }),
	};
}

function testRegistryWithTools(tools: ReadonlyArray<ToolName>) {
	const registry = createRegistry({
		safety: {
			classify: () => ({ actionClass: "read", reasons: [] }),
			evaluate: () => ({ kind: "allow", classification: { actionClass: "read", reasons: [] } }),
			observeLoop: () => ({ looping: false, key: "test", count: 0 }),
			scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE, confirmed: CONFIRMED_SCOPE },
			isSubset: () => true,
			audit: { recordCount: () => 0 },
		},
	});
	for (const tool of tools) registry.register(mockToolSpec(tool, 1024));
	return registry;
}

function resultSize(value: unknown): { truncated?: boolean } | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = (value as Record<string, unknown>).resultSize;
	if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
	const truncated = (candidate as Record<string, unknown>).truncated;
	return typeof truncated === "boolean" ? { truncated } : {};
}

function createConfirmableWriteRegistry(executed: string[]) {
	const spec: ToolSpec = {
		name: ToolNames.Write,
		description: "confirmable write",
		parameters: Type.Object({}),
		baseActionClass: "write",
		run: async (args) => {
			executed.push(String(args.path));
			return { kind: "ok", output: String(args.path) };
		},
	};
	const registry = createRegistry({
		safety: {
			classify: () => ({ actionClass: "write", reasons: [] }),
			evaluate: (_call, posture) =>
				posture === "confirmed"
					? { kind: "allow", classification: { actionClass: "write", reasons: ["confirmed"] } }
					: {
							kind: "ask",
							classification: { actionClass: "write", reasons: ["needs confirmation"] },
							rejection: { short: "confirm write", detail: "confirm write", hints: [] },
						},
			observeLoop: () => ({ looping: false, key: "test", count: 0 }),
			scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE, confirmed: CONFIRMED_SCOPE },
			isSubset: () => true,
			audit: { recordCount: () => 0 },
		},
	});
	registry.register(spec);
	return registry;
}

// The fake dispatch contract mirrors production truthfully: every receipt is
// sealed against the same ledger envelope getRun later returns, so the tool's
// integrity re-check passes unless a test tampers on purpose.
const sealedEnvelopes = new Map<string, RunEnvelope>();

function envelopeForDraft(draft: RunReceiptDraft): RunEnvelope {
	return {
		id: draft.runId,
		agentId: draft.agentId,
		executionRole: "builder",
		task: draft.task,
		targetId: draft.targetId,
		wireModelId: draft.wireModelId,
		runtimeId: draft.runtimeId,
		runtimeKind: draft.runtimeKind,
		startedAt: draft.startedAt,
		endedAt: draft.endedAt,
		status: "completed",
		exitCode: draft.exitCode,
		pid: null,
		heartbeatAt: null,
		receiptPath: `/tmp/${draft.runId}.json`,
		sessionId: draft.sessionId,
		cwd: "/tmp",
		tokenCount: draft.tokenCount,
		costUsd: draft.costUsd,
		...(draft.agentAudience !== undefined ? { agentAudience: draft.agentAudience } : {}),
		...(draft.requestOrigin !== undefined ? { requestOrigin: draft.requestOrigin } : {}),
		...(draft.outcome !== undefined ? { outcome: draft.outcome } : {}),
		...(draft.outcomeDetail !== undefined ? { outcomeDetail: draft.outcomeDetail } : {}),
		...(draft.lineage !== undefined ? { lineage: draft.lineage } : {}),
		...(draft.identity !== undefined ? { identity: draft.identity } : {}),
		...(draft.node !== undefined ? { node: draft.node } : {}),
		...(draft.reroutes !== undefined ? { reroutes: draft.reroutes } : {}),
		...(draft.pipeline !== undefined ? { pipeline: draft.pipeline } : {}),
		...(draft.gate !== undefined ? { gate: draft.gate } : {}),
		...(draft.plan !== undefined ? { plan: draft.plan } : {}),
		...(draft.personaOverride !== undefined ? { personaOverride: draft.personaOverride } : {}),
		...(draft.inputTokenCount !== undefined ? { inputTokenCount: draft.inputTokenCount } : {}),
		...(draft.outputTokenCount !== undefined ? { outputTokenCount: draft.outputTokenCount } : {}),
		...(draft.reasoningTokenCount !== undefined ? { reasoningTokenCount: draft.reasoningTokenCount } : {}),
		...(draft.cacheReadTokenCount !== undefined ? { cacheReadTokenCount: draft.cacheReadTokenCount } : {}),
		...(draft.cacheWriteTokenCount !== undefined ? { cacheWriteTokenCount: draft.cacheWriteTokenCount } : {}),
		...(draft.staticShellHash !== undefined ? { staticShellHash: draft.staticShellHash } : {}),
		...(draft.sessionShellHash !== undefined ? { sessionShellHash: draft.sessionShellHash } : {}),
		...(draft.dynamicHash !== undefined ? { dynamicHash: draft.dynamicHash } : {}),
	};
}

function runReceipt(runId: string, task: string, overrides: Partial<RunReceipt> = {}): RunReceipt {
	const { integrity: _ignored, ...cleanOverrides } = overrides;
	const draft: RunReceiptDraft = {
		executionRole: "builder",
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
		runId,
		agentId: "coder",
		task,
		targetId: "e",
		wireModelId: "m",
		runtimeId: "r",
		runtimeKind: "http",
		startedAt: "",
		endedAt: "",
		exitCode: 0,
		tokenCount: 0,
		costUsd: 0,
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: "0.0.0",
		piMonoVersion: "0.0.0",
		platform: "",
		nodeVersion: "",
		toolCalls: 0,
		toolStats: [],
		sessionId: null,
		...cleanOverrides,
	};
	const envelope = envelopeForDraft(draft);
	sealedEnvelopes.set(runId, envelope);
	return withReceiptIntegrity(draft, envelope);
}

function runEnvelope(runId: string): RunEnvelope {
	const sealed = sealedEnvelopes.get(runId);
	if (sealed !== undefined) return sealed;
	return {
		id: runId,
		agentId: "coder",
		executionRole: "builder",
		task: "do work",
		targetId: "e",
		wireModelId: "m",
		runtimeId: "r",
		runtimeKind: "http",
		startedAt: "",
		endedAt: "",
		status: "completed",
		exitCode: 0,
		pid: null,
		heartbeatAt: null,
		receiptPath: `/tmp/${runId}.json`,
		sessionId: null,
		cwd: "/tmp",
		tokenCount: 0,
		costUsd: 0,
	};
}

function singleConsumerIterator(
	events: ReadonlyArray<unknown>,
	terminalError?: Error,
): { iterator: AsyncIterableIterator<unknown>; consumers: () => number } {
	let consumerCount = 0;
	let index = 0;
	let terminalThrown = false;
	const iterator: AsyncIterableIterator<unknown> = {
		[Symbol.asyncIterator]() {
			consumerCount += 1;
			if (consumerCount > 1) throw new Error("second iterator consumer claimed ownership");
			return this;
		},
		async next() {
			const event = events[index];
			if (event !== undefined) {
				index += 1;
				return { done: false, value: event };
			}
			if (terminalError !== undefined && !terminalThrown) {
				terminalThrown = true;
				throw terminalError;
			}
			return { done: true, value: undefined };
		},
	};
	return { iterator, consumers: () => consumerCount };
}

function assistantMessageEvents(text: string): AsyncIterableIterator<unknown> {
	return (async function* () {
		if (text.length > 0) {
			yield {
				type: "message_end",
				message: { role: "assistant", content: text },
			};
		}
	})();
}

function fakeSequentialDispatch(
	steps: ReadonlyArray<{
		runId: string;
		assistantText: string;
		receipt?: Partial<RunReceipt>;
	}>,
	capturedRequests: DispatchRequest[],
): DispatchContract {
	let index = 0;
	let inFlight = false;
	return {
		dispatch: async (req: DispatchRequest) => {
			strictEqual(inFlight, false, "pipeline dispatch must wait for the active step to finish");
			const step = steps[index];
			if (!step) throw new Error(`unexpected dispatch ${index + 1}`);
			index += 1;
			inFlight = true;
			capturedRequests.push(req);
			const finalPromise = Promise.resolve(
				runReceipt(step.runId, req.task, {
					...(step.assistantText.length > 0
						? {
								output: {
									state: "final" as const,
									text: step.assistantText,
									bytes: Buffer.byteLength(step.assistantText, "utf8"),
									truncated: false,
								},
							}
						: {}),
					...(step.receipt ?? {}),
				}),
			).finally(() => {
				inFlight = false;
			});
			return {
				runId: step.runId,
				events: assistantMessageEvents(step.assistantText),
				finalPromise,
			};
		},
		dispatchBatch: async () => {
			throw new Error("dispatchBatch not used");
		},
		listRuns: () => [],
		getRun: (runId: string) => runEnvelope(runId),
		abort: () => {},
		steer: () => {},
		snapshot: () => ({
			generatedAt: new Date().toISOString(),
			running: [],
			retrying: [],
			totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
		}),
		planAgentSelection: unexpectedAgentPlanSelection,
		drain: async () => {},
	};
}

const approvedDispatch = {
	approval: { requestId: "test-dispatch-approval", requestedBy: "test-operator", actionClass: "dispatch" as const },
};

describe("contracts/tools basic happy paths", () => {
	it("writeTool writes file and creates parent folders", async () => {
		const root = scratchDir();
		const filePath = join(root, "nested", "note.txt");

		const r1 = await writeTool.run({ path: filePath, content: "one" });
		strictEqual(r1.kind, "ok");
		const r2 = await writeTool.run({ path: filePath, content: "two" });
		strictEqual(r2.kind, "ok");

		strictEqual(readFileSync(filePath, "utf8"), "two");
	});

	it("writeTool reports the written byte count as the ledger's shown size, not the confirmation length", async () => {
		const root = scratchDir();
		const filePath = join(root, "sized.txt");
		const content = "x".repeat(4753);

		const result = await writeTool.run({ path: filePath, content });
		strictEqual(result.kind, "ok");
		const observation = result.details?.observation as { shownBytes?: unknown } | undefined;
		strictEqual(observation?.shownBytes, 4753);
	});

	it("writeTool notes when an overwrite drops the trailing newline", async () => {
		const root = scratchDir();
		const filePath = join(root, "note.txt");

		const r1 = await writeTool.run({ path: filePath, content: "one\n" });
		strictEqual(r1.kind, "ok");
		ok(r1.kind === "ok" && !r1.output.includes("no longer ends with a newline"));

		const r2 = await writeTool.run({ path: filePath, content: "two" });
		strictEqual(r2.kind, "ok");
		ok(r2.kind === "ok" && r2.output.includes("no longer ends with a newline"));

		const r3 = await writeTool.run({ path: filePath, content: "three" });
		strictEqual(r3.kind, "ok");
		ok(r3.kind === "ok" && !r3.output.includes("no longer ends with a newline"));

		strictEqual(readFileSync(filePath, "utf8"), "three");
	});

	it("editTool applies edits and returns diff", async () => {
		const root = scratchDir();
		const filePath = join(root, "src.ts");
		writeFileSync(filePath, "export const a = 1;\nexport const b = 2;\n", "utf8");

		const result = await editTool.run({
			path: filePath,
			edits: [
				{ oldText: "export const a = 1;", newText: "export const a = 10;" },
				{ oldText: "export const b = 2;", newText: "export const b = 20;" },
			],
		});

		strictEqual(result.kind, "ok");
		strictEqual(readFileSync(filePath, "utf8"), "export const a = 10;\nexport const b = 20;\n");
		ok(result.details?.diff);
	});

	it("editTool success output carries the validation nudge at the point of failure", async () => {
		const root = scratchDir();
		const filePath = join(root, "nudge.ts");
		writeFileSync(filePath, "const n = 1;\n", "utf8");
		const result = await editTool.run({ path: filePath, edits: [{ oldText: "const n = 1;", newText: "const n = 2;" }] });
		strictEqual(result.kind, "ok");
		ok(
			result.kind === "ok" &&
				result.output.includes("Validate now: rerun the failing test or verify; navigation tools do not validate edits."),
			"the mutation result names the real validation path",
		);
	});

	it("editTool accepts the legacy top-level {oldText,newText} shape", async () => {
		const root = scratchDir();
		const filePath = join(root, "legacy.ts");
		writeFileSync(filePath, "const a = 1;\n", "utf8");

		const result = await editTool.run({ path: filePath, oldText: "const a = 1;", newText: "const a = 2;" });
		strictEqual(result.kind, "ok");
		strictEqual(readFileSync(filePath, "utf8"), "const a = 2;\n");
	});

	it("editTool accepts edits sent as a JSON string, and the canonical array", async () => {
		const root = scratchDir();
		const jsonFile = join(root, "jsonstr.ts");
		writeFileSync(jsonFile, "let x = 0;\n", "utf8");
		const asJson = await editTool.run({
			path: jsonFile,
			edits: JSON.stringify([{ oldText: "let x = 0;", newText: "let x = 9;" }]),
		});
		strictEqual(asJson.kind, "ok");
		strictEqual(readFileSync(jsonFile, "utf8"), "let x = 9;\n");

		const arrayFile = join(root, "array.ts");
		writeFileSync(arrayFile, "y = 1;\n", "utf8");
		const asArray = await editTool.run({ path: arrayFile, edits: [{ oldText: "y = 1;", newText: "y = 2;" }] });
		strictEqual(asArray.kind, "ok");
		strictEqual(readFileSync(arrayFile, "utf8"), "y = 2;\n");
	});

	it("registry applies prepareArguments before the tool body", async () => {
		let received: Record<string, unknown> | null = null;
		const spec: ToolSpec = {
			name: ToolNames.Read,
			description: "normalizing read",
			parameters: Type.Object({}),
			baseActionClass: "read",
			prepareArguments: (args) => (typeof args.legacy === "string" ? { path: args.legacy } : args),
			run: async (args) => {
				received = args;
				return { kind: "ok", output: "ok" };
			},
		};
		const registry = createRegistry({
			safety: {
				classify: () => ({ actionClass: "read", reasons: [] }),
				evaluate: () => ({ kind: "allow", classification: { actionClass: "read", reasons: [] } }),
				observeLoop: () => ({ looping: false, key: "test", count: 0 }),
				scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE, confirmed: CONFIRMED_SCOPE },
				isSubset: () => true,
				audit: { recordCount: () => 0 },
			},
		});
		registry.register(spec);
		const verdict = await registry.invoke({ tool: ToolNames.Read, args: { legacy: "x.ts" } });
		strictEqual(verdict.kind, "ok");
		strictEqual(received !== null && (received as Record<string, unknown>).path, "x.ts");
		strictEqual(received !== null && (received as Record<string, unknown>).legacy, undefined);
	});

	it("findTool locates files by glob relative to search root", async () => {
		const root = scratchDir();
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src", "index.ts"), "export const x = 1;\n", "utf8");
		writeFileSync(join(root, "README.md"), "# sample\n", "utf8");

		const result = await findTool.run({ pattern: "**/*.ts", path: root });
		strictEqual(result.kind, "ok");
		ok(result.output.includes("src/index.ts"));
	});

	it("findTool filters files by bare pattern (glob dialect)", async () => {
		const root = scratchDir();
		writeFileSync(join(root, "note.md"), "# sample\n", "utf8");
		writeFileSync(join(root, "code.ts"), "const x = 1;\n", "utf8");

		const result = await findTool.run({ pattern: "*.md", path: root });
		strictEqual(result.kind, "ok");
		strictEqual(result.output.trim(), "note.md");
	});

	it("lsTool lists files with details", async () => {
		const root = scratchDir();
		writeFileSync(join(root, "Alpha.txt"), "a\n", "utf8");

		const result = await lsTool.run({ path: root });
		strictEqual(result.kind, "ok");
		ok(result.output.includes("Alpha.txt"));
	});

	it("bashTool runs processes and preserves stderr/exitCode", async () => {
		const result = await bashTool.run({ command: "printf 'err' >&2; exit 7" });
		strictEqual(result.kind, "error");
		ok(result.message.includes("err"));
		ok(result.message.includes("exit 7"));
	});

	it("credential_present reports presence without exposing values", async () => {
		const root = scratchDir();
		const envPath = join(root, ".env");
		writeFileSync(envPath, "CLIO_CODER_FILE_KEY=file-secret\nCLIO_CODER_BOTH_KEY=file-secret\n", "utf8");
		const previousEnv = process.env.CLIO_CODER_ENV_KEY;
		const previousBoth = process.env.CLIO_CODER_BOTH_KEY;
		process.env.CLIO_CODER_ENV_KEY = "env-secret";
		process.env.CLIO_CODER_BOTH_KEY = "env-secret";
		try {
			const envResult = await credentialPresentTool.run({ name: "CLIO_CODER_ENV_KEY", source: "environment" });
			strictEqual(envResult.kind, "ok");
			const envText = JSON.stringify(envResult);
			ok(envText.includes('"present":true'));
			ok(envText.includes('"source":"environment"'));
			ok(!envText.includes("env-secret"));

			const fileResult = await credentialPresentTool.run({ name: "CLIO_CODER_FILE_KEY", file: envPath, source: "file" });
			strictEqual(fileResult.kind, "ok");
			const fileText = JSON.stringify(fileResult);
			ok(fileText.includes('"present":true'));
			ok(fileText.includes('"source":"file"'));
			ok(!fileText.includes("file-secret"));

			const bothResult = await credentialPresentTool.run({ name: "CLIO_CODER_BOTH_KEY", file: envPath });
			strictEqual(bothResult.kind, "ok");
			ok(JSON.stringify(bothResult).includes('"source":"both"'));

			const absentResult = await credentialPresentTool.run({ name: "CLIO_CODER_ABSENT_KEY", file: envPath });
			strictEqual(absentResult.kind, "ok");
			const absentText = JSON.stringify(absentResult);
			ok(absentText.includes('"present":false'));
			ok(absentText.includes('"source":"none"'));
		} finally {
			if (previousEnv === undefined) delete process.env.CLIO_CODER_ENV_KEY;
			else process.env.CLIO_CODER_ENV_KEY = previousEnv;
			if (previousBoth === undefined) delete process.env.CLIO_CODER_BOTH_KEY;
			else process.env.CLIO_CODER_BOTH_KEY = previousBoth;
		}
	});

	it("verifyTool runs declared verification-family scripts", async () => {
		const root = workspaceScratchDir();
		writePackageJson(root, {
			"check:boundaries": "node -e \"process.stdout.write('boundaries lane\\n')\"",
			"test:contracts": "node -e \"process.stdout.write('contracts lane\\n')\"",
		});

		const contracts = await verifyTool.run({ check: "test:contracts", cwd: root, timeout_ms: 10_000 });
		strictEqual(contracts.kind, "ok");
		ok(contracts.kind === "ok" && contracts.output.includes("contracts lane"));

		const boundaries = await verifyTool.run({ check: "check:boundaries", cwd: root, timeout_ms: 10_000 });
		strictEqual(boundaries.kind, "ok");
		ok(boundaries.kind === "ok" && boundaries.output.includes("boundaries lane"));
	});

	it("verifyTool with no check lists declared checks grouped by source", async () => {
		const root = workspaceScratchDir();
		writePackageJson(root, {
			dev: "node server.js",
			typecheck: "tsc --noEmit",
			"test:contracts": "node --test tests/contracts.test.mjs",
		});

		const result = await verifyTool.run({ cwd: root });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		ok(result.output.includes("Declared verification checks:"));
		ok(result.output.includes("package.json:"));
		ok(result.output.includes("- typecheck"));
		ok(result.output.includes("- test:contracts"));
		ok(!result.output.includes("- dev"), "non-verification scripts must not be listed");
	});

	it("verifyTool rejects non-verification families with a bash redirect", async () => {
		const result = await verifyTool.run({ check: "dev" });

		strictEqual(result.kind, "error");
		strictEqual(
			result.kind === "error" ? result.message : "",
			"verify: 'dev' is not a verification check (test*/lint*/build*/typecheck*/check*/format*/ci* or \"frontend\"); run it through bash.",
		);
	});

	it("verifyTool lists sorted declared verification checks for undeclared family names", async () => {
		const root = workspaceScratchDir();
		writePackageJson(root, {
			dev: "node server.js",
			format: "biome format --write .",
			"test:smoke": "node --test tests/smoke.test.mjs",
			lint: "biome check .",
			"check:boundaries": "node --test tests/boundaries.test.mjs",
			ci: "npm run test",
			clean: "rm -rf dist",
			build: "tsup",
			typecheck: "tsc --noEmit",
			test: "node --test",
			"ci:release": "npm run ci",
			"test:contracts": "node --test tests/contracts.test.mjs",
			"test:file": "node --test",
		});

		const result = await verifyTool.run({ check: "test:unit", cwd: root });

		strictEqual(result.kind, "error");
		strictEqual(
			result.kind === "error" ? result.message : "",
			"verify: package.json has no 'test:unit' script. Declared verification checks: build, check:boundaries, ci, ci:release, format, lint, test, test:contracts, test:file, test:smoke, typecheck.",
		);
	});

	it("verifyTool forwards args to a declared test:file lane for one named test file", async () => {
		const root = workspaceScratchDir();
		writePackageJson(root, { "test:file": "node --test" });
		writeFileSync(
			join(root, "selected.test.mjs"),
			[
				"import { strictEqual } from 'node:assert/strict';",
				"import test from 'node:test';",
				"",
				"test('selected file lane sentinel', () => {",
				"\tstrictEqual(1 + 1, 2);",
				"});",
			].join("\n"),
			"utf8",
		);
		writeFileSync(
			join(root, "unselected.test.mjs"),
			[
				"import { strictEqual } from 'node:assert/strict';",
				"import test from 'node:test';",
				"",
				"test('unselected file must not run', () => {",
				"\tstrictEqual(1, 2);",
				"});",
			].join("\n"),
			"utf8",
		);

		const result = await verifyTool.run({
			check: "test:file",
			args: ["selected.test.mjs"],
			cwd: root,
			timeout_ms: 10_000,
		});

		strictEqual(result.kind, "ok");
		ok(result.kind === "ok" && result.output.includes("selected file lane sentinel"));
		ok(result.kind === "ok" && !result.output.includes("unselected file must not run"));
	});

	it("grepTool skips ignored caches and binaries", async () => {
		const root = scratchDir();
		mkdirSync(join(root, "src"));
		mkdirSync(join(root, ".clio-coder"));
		writeFileSync(join(root, "src", "index.ts"), "export const thinkingBudget = 1;\n", "utf8");
		writeFileSync(join(root, ".clio-coder", "codewiki.json"), '{"text":"thinkingBudget"}\n', "utf8");

		const result = await grepTool.run({ pattern: "thinkingBudget", path: root });
		strictEqual(result.kind, "ok");
		ok(result.output.includes("src/index.ts"));
		ok(!result.output.includes(".clio-coder/codewiki.json"));
	});
});

describe("contracts/tools profiles", () => {
	it("keeps codewiki tools scout-owned by default while allowing navigation-heavy non-scout runs", () => {
		const candidateTools = [ToolNames.Read, ToolNames.Context, ToolNames.CodeNav];

		const scout = applyToolProfile(candidateTools, undefined, { agentId: "scout", task: "summarize the current work" });
		ok(scout.includes(ToolNames.CodeNav));

		const genericArchitect = applyToolProfile(candidateTools, undefined, {
			agentId: "architect",
			task: "write a high level implementation plan",
		});
		strictEqual(genericArchitect.includes(ToolNames.CodeNav), false);
		ok(genericArchitect.includes(ToolNames.Context));

		const navigationArchitect = applyToolProfile(candidateTools, undefined, {
			agentId: "architect",
			task: "map call sites and locate the implementation in src/domains/context/index.ts",
		});
		ok(navigationArchitect.includes(ToolNames.CodeNav));
	});

	it("applies scout codewiki ownership in the worker tool resolver", () => {
		const registry = testRegistryWithTools([ToolNames.Read, ToolNames.Context, ToolNames.CodeNav]);
		const genericArchitect = resolveAgentTools({
			registry,
			agentId: "architect",
			task: "write a high level plan",
		}).map((tool) => tool.name);
		strictEqual(genericArchitect.includes(ToolNames.CodeNav), false);

		const scout = resolveAgentTools({
			registry,
			agentId: "scout",
			task: "write a high level plan",
		}).map((tool) => tool.name);
		ok(scout.includes(ToolNames.CodeNav));

		const navigationArchitect = resolveAgentTools({
			registry,
			agentId: "architect",
			task: "locate the implementation for src/domains/context/index.ts",
			allowedTools: [ToolNames.CodeNav],
		}).map((tool) => tool.name);
		ok(navigationArchitect.includes(ToolNames.CodeNav));
	});
});

describe("contracts/tools permission sequencing", () => {
	it("confirms only the oldest parked call and re-emits permission for the next one", async () => {
		const executed: string[] = [];
		const spec: ToolSpec = {
			name: ToolNames.Write,
			description: "confirmable write",
			parameters: Type.Object({}),
			baseActionClass: "write",
			run: async (args) => {
				executed.push(String(args.path));
				return { kind: "ok", output: String(args.path) };
			},
		};
		const registry = createRegistry({
			safety: {
				classify: () => ({ actionClass: "write", reasons: [] }),
				evaluate: (_call, posture) =>
					posture === "confirmed"
						? { kind: "allow", classification: { actionClass: "write", reasons: ["confirmed"] } }
						: {
								kind: "ask",
								classification: { actionClass: "write", reasons: ["needs confirmation"] },
								rejection: { short: "confirm write", detail: "confirm write", hints: [] },
							},
				observeLoop: () => ({ looping: false, key: "test", count: 0 }),
				scopes: {
					readonly: { allowedActions: new Set(["read"]), allowedWriteRoots: [], allowNetwork: true, allowDispatch: false },
					workspace: {
						allowedActions: new Set(["read", "write"]),
						allowedWriteRoots: [process.cwd()],
						allowNetwork: true,
						allowDispatch: true,
					},
					confirmed: {
						allowedActions: new Set(["read", "write", "system_modify"]),
						allowedWriteRoots: [process.cwd()],
						allowNetwork: true,
						allowDispatch: true,
					},
				},
				isSubset: () => true,
				audit: { recordCount: () => 0 },
			},
		});
		registry.register(spec);
		const requested: string[] = [];
		registry.onPermissionRequired((call) => requested.push(String(call.args?.path)));

		const first = registry.invoke({ tool: ToolNames.Write, args: { path: "one" } });
		const second = registry.invoke({ tool: ToolNames.Write, args: { path: "two" } });

		strictEqual(requested.join(","), "one,two");
		await registry.resumeParkedCalls({ actionClass: "write", requestedBy: "test" });
		strictEqual((await first).kind, "ok");
		strictEqual(executed.join(","), "one");
		strictEqual(requested.join(","), "one,two,two");

		await registry.resumeParkedCalls({ actionClass: "write", requestedBy: "test" });
		strictEqual((await second).kind, "ok");
		strictEqual(executed.join(","), "one,two");
	});

	it("denies only the selected parked call and re-emits permission for the next one", async () => {
		const executed: string[] = [];
		const registry = createConfirmableWriteRegistry(executed);
		const requested: Array<{ path: string; requestId: string }> = [];
		registry.onPermissionRequired((call, _decision, meta) => {
			requested.push({ path: String(call.args?.path), requestId: meta.requestId });
		});

		const first = registry.invoke({ tool: ToolNames.Write, args: { path: "one" } });
		const second = registry.invoke({ tool: ToolNames.Write, args: { path: "two" } });

		strictEqual(registry.parkedCount(), 2);
		strictEqual(requested.map((request) => request.path).join(","), "one,two");
		const firstRequestId = requested[0]?.requestId;
		const secondRequestId = requested[1]?.requestId;
		ok(firstRequestId);
		ok(secondRequestId);
		strictEqual(registry.cancelParkedCall(firstRequestId, "operator declined"), true);

		const firstVerdict = await first;
		strictEqual(firstVerdict.kind, "blocked");
		strictEqual(registry.parkedCount(), 1);
		strictEqual(requested.map((request) => request.path).join(","), "one,two,two");
		strictEqual(requested[2]?.requestId, secondRequestId);

		await registry.resumeParkedCalls({ actionClass: "write", requestId: secondRequestId, requestedBy: "test" });
		strictEqual((await second).kind, "ok");
		strictEqual(executed.join(","), "two");
		strictEqual(registry.parkedCount(), 0);
	});

	it("grants by requestId rather than the oldest parked action class", async () => {
		const executed: string[] = [];
		const registry = createConfirmableWriteRegistry(executed);
		const requested: Array<{ path: string; requestId: string }> = [];
		registry.onPermissionRequired((call, _decision, meta) => {
			requested.push({ path: String(call.args?.path), requestId: meta.requestId });
		});

		const first = registry.invoke({ tool: ToolNames.Write, args: { path: "one" } });
		const second = registry.invoke({ tool: ToolNames.Write, args: { path: "two" } });

		const firstRequestId = requested[0]?.requestId;
		const secondRequestId = requested[1]?.requestId;
		ok(firstRequestId);
		ok(secondRequestId);
		await registry.resumeParkedCalls({ actionClass: "write", requestId: secondRequestId, requestedBy: "test" });

		strictEqual((await second).kind, "ok");
		strictEqual(executed.join(","), "two");
		strictEqual(registry.parkedCount(), 1);
		strictEqual(requested.map((request) => request.path).join(","), "one,two,one");
		strictEqual(requested[2]?.requestId, firstRequestId);

		strictEqual(registry.cancelParkedCall(firstRequestId, "operator declined"), true);
		strictEqual((await first).kind, "blocked");
		strictEqual(registry.parkedCount(), 0);
	});

	it("renotifyHead re-emits the oldest parked request without mutating queue depth", async () => {
		const executed: string[] = [];
		const registry = createConfirmableWriteRegistry(executed);
		const requested: Array<{ path: string; requestId: string }> = [];
		registry.onPermissionRequired((call, _decision, meta) => {
			requested.push({ path: String(call.args?.path), requestId: meta.requestId });
		});

		const first = registry.invoke({ tool: ToolNames.Write, args: { path: "one" } });
		const second = registry.invoke({ tool: ToolNames.Write, args: { path: "two" } });
		const firstRequestId = requested[0]?.requestId;
		ok(firstRequestId);
		strictEqual(registry.parkedCount(), 2);

		registry.renotifyHead();

		strictEqual(registry.parkedCount(), 2);
		deepStrictEqual(
			requested.map((request) => [request.path, request.requestId]),
			[
				["one", firstRequestId],
				["two", requested[1]?.requestId],
				["one", firstRequestId],
			],
		);
		registry.cancelParkedCalls("test done");
		strictEqual((await first).kind, "blocked");
		strictEqual((await second).kind, "blocked");
	});

	it("abort signals cancel parked calls and clear queue depth", async () => {
		const executed: string[] = [];
		const registry = createConfirmableWriteRegistry(executed);
		const requested: string[] = [];
		registry.onPermissionRequired((_call, _decision, meta) => {
			requested.push(meta.requestId);
		});
		const controller = new AbortController();

		const pending = registry.invoke({ tool: ToolNames.Write, args: { path: "one" } }, { signal: controller.signal });
		strictEqual(registry.parkedCount(), 1);
		controller.abort();
		const verdict = await pending;

		strictEqual(verdict.kind, "blocked");
		if (verdict.kind === "blocked") strictEqual(verdict.reason, "run aborted before the operator decided");
		strictEqual(registry.parkedCount(), 0);
		strictEqual(requested.length, 1);
		strictEqual(executed.length, 0);
	});

	it("already-aborted signals block permission asks without parking", async () => {
		const executed: string[] = [];
		const registry = createConfirmableWriteRegistry(executed);
		let requested = 0;
		registry.onPermissionRequired(() => {
			requested += 1;
		});
		const controller = new AbortController();
		controller.abort();

		const verdict = await registry.invoke(
			{ tool: ToolNames.Write, args: { path: "one" } },
			{ signal: controller.signal },
		);

		strictEqual(verdict.kind, "blocked");
		if (verdict.kind === "blocked") strictEqual(verdict.reason, "run aborted before the operator decided");
		strictEqual(registry.parkedCount(), 0);
		strictEqual(requested, 0);
		strictEqual(executed.length, 0);
	});

	it("approval request ids include a registry-unique token", async () => {
		const first = createConfirmableWriteRegistry([]);
		const second = createConfirmableWriteRegistry([]);
		let firstRequestId: string | undefined;
		let secondRequestId: string | undefined;
		first.onPermissionRequired((_call, _decision, meta) => {
			firstRequestId = meta.requestId;
		});
		second.onPermissionRequired((_call, _decision, meta) => {
			secondRequestId = meta.requestId;
		});

		const firstPending = first.invoke({ tool: ToolNames.Write, args: { path: "one" } });
		const secondPending = second.invoke({ tool: ToolNames.Write, args: { path: "two" } });

		ok(firstRequestId);
		ok(secondRequestId);
		match(firstRequestId, /^apr-[0-9a-f]{8}-1$/);
		match(secondRequestId, /^apr-[0-9a-f]{8}-1$/);
		ok(firstRequestId !== secondRequestId);
		first.cancelParkedCalls("test done");
		second.cancelParkedCalls("test done");
		strictEqual((await firstPending).kind, "blocked");
		strictEqual((await secondPending).kind, "blocked");
	});
});

describe("contracts/tools result shaping and truncation", () => {
	it("bounds large bash outputs with truncation metadata", () => {
		const result = shapeToolResult(mockToolSpec(ToolNames.Bash, 128), { kind: "ok", output: "x".repeat(1000) });

		strictEqual(result.kind, "ok");
		if (result.kind === "ok") {
			ok(result.output.includes("[tool result truncated]"));
			ok(result.output.includes("narrow the request"));
			strictEqual(resultSize(result.details)?.truncated, true);
		}
	});

	it("readTool prefix/lines fallback stays native", async () => {
		const root = scratchDir();
		const file = join(root, "large-line.txt");
		writeFileSync(file, "x".repeat(80_000), "utf8");

		const result = await readTool.run({ path: file });
		strictEqual(result.kind, "ok");
		if (result.kind === "ok") {
			ok(result.output.includes("Line 1 is"));
			ok(result.output.includes("Showing the UTF-8 prefix"));
		}
	});

	it("anchors the past-EOF read error so a paging model stops instead of walking the tail", async () => {
		const root = scratchDir();
		const file = join(root, "short.txt");
		writeFileSync(file, "one\ntwo\nthree\n", "utf8");

		const result = await readTool.run({ path: file, offset: 4 });
		strictEqual(result.kind, "error");
		if (result.kind === "error") {
			ok(result.message.includes("beyond end of file (3 lines total)"), "names the bound");
			ok(result.message.includes("no further content"), "states nothing exists past the last line");
			ok(result.message.includes("already returned everything"), "anchors on content the model already has");
		}
	});

	it("applies an aggregate per-turn observation budget across large reads", async () => {
		const root = scratchDir();
		const first = join(root, "first.txt");
		const second = join(root, "second.txt");
		// Each file (~90KB) exceeds the 50KB per-call read cap so the first read
		// is a full per-call slice.
		writeFileSync(first, `${"a".repeat(100)}\n`.repeat(900), "utf8");
		writeFileSync(second, `${"b".repeat(100)}\n`.repeat(900), "utf8");

		// Size the turn budget above the per-call cap so the first read takes a
		// full per-call slice and the second read is the one bound by the
		// aggregate per-turn budget.
		const turnBudget = 70 * 1024;
		const previousBudget = process.env[OBSERVATION_TURN_BUDGET_ENV];
		process.env[OBSERVATION_TURN_BUDGET_ENV] = String(turnBudget);
		try {
			const options = { sessionId: "s-read-budget", turnId: `turn-${Date.now()}` };
			const r1 = await readTool.run({ path: first }, options);
			const r2 = await readTool.run({ path: second }, options);

			strictEqual(r1.kind, "ok");
			strictEqual(r2.kind, "ok");
			if (r1.kind === "ok" && r2.kind === "ok") {
				ok(Buffer.byteLength(r1.output, "utf8") > 4_000, "first read should use most of the per-call cap");
				ok(Buffer.byteLength(r1.output + r2.output, "utf8") < turnBudget + 4_000);
				ok(r2.output.includes("Per-turn observation budget"));
				const observation = r2.details?.observation as
					| { budget?: { limitBytes?: unknown; usedBeforeBytes?: unknown } }
					| undefined;
				strictEqual(observation?.budget?.limitBytes, turnBudget);
				ok(
					typeof observation?.budget?.usedBeforeBytes === "number" && observation.budget.usedBeforeBytes > 4_000,
					"second read must see the first read's spend in the shared pool",
				);
			}
		} finally {
			if (previousBudget === undefined) delete process.env[OBSERVATION_TURN_BUDGET_ENV];
			else process.env[OBSERVATION_TURN_BUDGET_ENV] = previousBudget;
		}
	});
});

describe("contracts/tools dispatch run paths", () => {
	it("advertises the first-class singular task schema", () => {
		const tool = createDispatchTool({ getAgentSpecs: () => [], dispatch: {} as DispatchContract });
		const schema = tool.parameters as { properties?: Record<string, unknown> };
		ok(schema.properties?.task, "dispatch TypeBox schema must advertise top-level task");
		ok(
			tool.description.includes('task:"Verify the receipt boundary"'),
			"description includes a compact singular example",
		);
	});

	it("keeps singular task and briefing separate in the dispatched request", async () => {
		const captured: DispatchRequest[] = [];
		const tool = createDispatchTool({
			getAgentSpecs: () => [],
			dispatch: fakeSequentialDispatch([{ runId: "run-singular", assistantText: "bounded answer" }], captured),
		});
		const result = await tool.run({
			agent: "debugger",
			task: "Adversarially verify the receipt boundary.",
			briefing: "Prior receipt R1 left one unresolved claim.",
		});
		strictEqual(result.kind, "ok");
		strictEqual(captured.length, 1);
		strictEqual(captured[0]?.agentId, "debugger");
		strictEqual(captured[0]?.task, "Adversarially verify the receipt boundary.");
		strictEqual(captured[0]?.briefing, "Prior receipt R1 left one unresolved claim.");
	});

	it("applies shared briefing to batch tasks unless a task object overrides it", async () => {
		const captured: DispatchRequest[] = [];
		const tool = createDispatchTool({
			getAgentSpecs: () => [],
			dispatch: fakeSequentialDispatch(
				[
					{ runId: "run-shared-string", assistantText: "one" },
					{ runId: "run-shared-object", assistantText: "two" },
					{ runId: "run-override", assistantText: "three" },
				],
				captured,
			),
		});
		const result = await tool.run(
			{
				mode: "sequential",
				tasks: ["string task", { task: "object task" }, { task: "override task", briefing: "task context" }],
				briefing: "shared context",
			},
			approvedDispatch,
		);
		strictEqual(result.kind, "ok");
		deepStrictEqual(
			captured.map((request) => request.briefing),
			["shared context", "shared context", "task context"],
		);
	});

	it("rejects ambiguous task plus tasks and explains that briefing cannot replace a task", async () => {
		const tool = createDispatchTool({ getAgentSpecs: () => [], dispatch: {} as DispatchContract });
		const ambiguous = await tool.run({ task: "one", tasks: ["two"] });
		strictEqual(ambiguous.kind, "error");
		if (ambiguous.kind === "error") match(ambiguous.message, /either task .* or tasks .* not both/);

		const briefingOnly = await tool.run({ briefing: "context without an assignment" });
		strictEqual(briefingOnly.kind, "error");
		if (briefingOnly.kind === "error") {
			strictEqual(
				briefingOnly.message,
				'dispatch: missing task; pass task="..." for one run or tasks=[...] for a batch. briefing is optional context and cannot replace task. Example: {"agent":"auto","task":"map the modules that read fleet config and cite file paths"}',
			);
		}
	});

	it("keeps dispatch target schema examples environment-neutral", () => {
		const tool = createDispatchTool({ getAgentSpecs: () => [], dispatch: {} as DispatchContract });
		const schemaText = JSON.stringify(tool.parameters);

		for (const pattern of [/\bdynamo\b/i, /\bmini\b/i, /\bzbook\b/i, /\b192\.168\./]) {
			strictEqual(pattern.test(schemaText), false, `dispatch schema leaked ${pattern}`);
		}
	});

	it("dispatch list:true returns the agent catalog without dispatching", async () => {
		const tool = createDispatchTool({
			getAgentSpecs: () => [],
			dispatch: {
				dispatch: async () => {
					throw new Error("dispatch must not run for list:true");
				},
			} as unknown as DispatchContract,
			getAgentCatalog: () => "User-facing agents:\n- coder: bounded coding tasks",
		});
		const result = await tool.run({ list: true });
		strictEqual(result.kind, "ok");
		if (result.kind === "ok") {
			ok(result.output.includes("coder: bounded coding tasks"));
		}
		const noCatalog = createDispatchTool({ getAgentSpecs: () => [], dispatch: {} as DispatchContract });
		const missing = await noCatalog.run({ list: true });
		strictEqual(missing.kind, "error");
	});

	it("createDispatchTool triggers dispatch contract", async () => {
		const mockDispatch: DispatchContract = {
			dispatch: async (req: DispatchRequest) => {
				strictEqual(req.agentId, "coder");
				strictEqual(req.task, "do work");
				return {
					runId: "run-123",
					events: (async function* () {})(),
					finalPromise: Promise.resolve(runReceipt("run-123", "do work")),
				};
			},
			dispatchBatch: async () => {
				throw new Error("dispatchBatch not used");
			},
			listRuns: () => [],
			getRun: () => ({ ...runEnvelope("run-123"), receiptPath: "/tmp/receipt.json" }),
			abort: () => {},
			steer: () => {},
			snapshot: () => ({
				generatedAt: new Date().toISOString(),
				running: [],
				retrying: [],
				totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
			}),
			planAgentSelection: unexpectedAgentPlanSelection,
			drain: async () => {},
		};

		const runEvents = createDispatchRunEventRegistry();
		const tool = createDispatchTool({ getAgentSpecs: () => [], dispatch: mockDispatch, runEvents });
		const result = await tool.run({ task: "do work", agent: "coder" });

		strictEqual(result.kind, "ok");
		if (result.kind === "ok") {
			ok(result.output.includes("dispatch (parallel) total=1 failed=0"));
			ok(result.output.includes("run-123"));
			const details = result.details as { assignmentIds?: unknown; receiptCount?: unknown } | undefined;
			ok(Array.isArray(details?.assignmentIds) && details.assignmentIds[0] === "run-123");
			strictEqual(details?.receiptCount, 1);
		}
	});

	it("consumes a synchronous single stream once and publishes each non-heartbeat progress event once", async () => {
		const bus = createSafeEventBus();
		let pulls = 0;
		const progress: unknown[] = [];
		bus.on(BusChannels.DispatchProgress, (payload) => {
			progress.push(payload.event);
		});
		const events = [
			{ type: "heartbeat" },
			{ type: "clio_tool_finish", payload: { tool: "grep", outcome: "ok" } },
			{ type: "message_end", message: { role: "assistant", content: "once only" } },
		];
		const mockDispatch: DispatchContract = {
			dispatch: async () => ({
				runId: "run-once",
				events: (async function* () {
					for (const event of events) {
						pulls += 1;
						yield event;
					}
				})(),
				finalPromise: Promise.resolve(runReceipt("run-once", "once")),
			}),
			dispatchBatch: async () => {
				throw new Error("dispatchBatch not used");
			},
			listRuns: () => [],
			getRun: () => runEnvelope("run-once"),
			abort: () => {},
			steer: () => {},
			snapshot: () => ({
				generatedAt: new Date().toISOString(),
				running: [],
				retrying: [],
				totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
			}),
			planAgentSelection: unexpectedAgentPlanSelection,
			drain: async () => {},
		};
		const result = await createDispatchTool({ getAgentSpecs: () => [], dispatch: mockDispatch, bus }).run({
			task: "once",
		});
		strictEqual(result.kind, "ok");
		strictEqual(pulls, events.length, "the iterator has exactly one owner");
		deepStrictEqual(
			progress.map((event) => (event as { type: string }).type),
			["clio_tool_finish", "message_end"],
		);

		const ownedEvent = { type: "message_end", message: { role: "assistant", content: "domain owned" } };
		const ownedDispatch: DispatchContract = {
			...mockDispatch,
			ownsProgressBus: (candidate) => candidate === bus,
			dispatch: async () => {
				bus.emit(BusChannels.DispatchProgress, { runId: "run-owned", agentId: "coder", event: ownedEvent });
				return {
					runId: "run-owned",
					events: (async function* () {
						yield ownedEvent;
					})(),
					finalPromise: Promise.resolve(runReceipt("run-owned", "domain owned")),
				};
			},
			getRun: () => runEnvelope("run-owned"),
		};
		const progressBeforeOwnedRun = progress.length;
		strictEqual(
			(await createDispatchTool({ getAgentSpecs: () => [], dispatch: ownedDispatch, bus }).run({ task: "domain owned" }))
				.kind,
			"ok",
		);
		strictEqual(progress.length, progressBeforeOwnedRun + 1, "the tool does not duplicate domain-owned progress");
	});

	it("rejects duplicate active registration before a second iterator consumer can claim ownership", async () => {
		const runEvents = createDispatchRunEventRegistry();
		const guarded = singleConsumerIterator([{ type: "message_end", message: { role: "assistant", content: "once" } }]);
		let releaseReceipt!: () => void;
		const finalPromise = new Promise<RunReceipt>((resolve) => {
			releaseReceipt = () => resolve(runReceipt("run-owned-once", "owned once"));
		});
		const handle = { runId: "run-owned-once", events: guarded.iterator, finalPromise };
		const first = runEvents.registerSingle(handle, "coder");

		throws(() => runEvents.registerSingle(handle, "coder"), /run 'run-owned-once' is already registered/);
		strictEqual(guarded.consumers(), 1, "only the first registration claims the iterator");

		releaseReceipt();
		await first.completion;
	});

	it("uses deterministic registry failure precedence and cleans active runs while retaining their tails", async () => {
		const runEvents = createDispatchRunEventRegistry();
		const terminal = { type: "message_end", message: { role: "assistant", content: "retained before failure" } };
		const iteratorFailure = new Error("iterator failed");
		const failedIterator = singleConsumerIterator([terminal], iteratorFailure);
		const drainFailure = runEvents.registerSingle(
			{
				runId: "run-drain-failure",
				events: failedIterator.iterator,
				finalPromise: Promise.resolve(runReceipt("run-drain-failure", "drain failure")),
			},
			"coder",
		);
		await rejects(drainFailure.completion, (error: unknown) => error === iteratorFailure);
		strictEqual(runEvents.eventTail("run-drain-failure")?.entries.at(-1)?.detail, "retained before failure");

		// Re-registration after rejection proves the active-run claim was cleaned;
		// the completed tail remains available until bounded pruning evicts it.
		await runEvents.registerSingle(
			{
				runId: "run-drain-failure",
				events: (async function* () {})(),
				finalPromise: Promise.resolve(runReceipt("run-drain-failure", "retry")),
			},
			"coder",
		).completion;
		strictEqual(runEvents.eventTail("run-drain-failure")?.entries.at(-1)?.detail, "retained before failure");

		const receiptFailure = new Error("receipt failed");
		const finalFailure = runEvents.registerSingle(
			{
				runId: "run-final-failure",
				events: (async function* () {})(),
				finalPromise: Promise.reject(receiptFailure),
			},
			"coder",
		);
		await rejects(finalFailure.completion, (error: unknown) => error === receiptFailure);

		const preferredIteratorFailure = new Error("preferred iterator failure");
		const secondaryReceiptFailure = new Error("secondary receipt failure");
		const bothFailure = runEvents.registerSingle(
			{
				runId: "run-both-failure",
				events: singleConsumerIterator([], preferredIteratorFailure).iterator,
				finalPromise: Promise.reject(secondaryReceiptFailure),
			},
			"coder",
		);
		await rejects(bothFailure.completion, (error: unknown) => error === preferredIteratorFailure);
	});

	it("protects active tails from bounded pruning and releases them after settlement", async () => {
		const runEvents = createDispatchRunEventRegistry();
		let releaseDrain!: () => void;
		const drainGate = new Promise<void>((resolve) => {
			releaseDrain = resolve;
		});
		const active = runEvents.registerSingle(
			{
				runId: "run-active-tail",
				events: (async function* () {
					yield { type: "message_end", message: { role: "assistant", content: "active tail" } };
					await drainGate;
				})(),
				finalPromise: Promise.resolve(runReceipt("run-active-tail", "active")),
			},
			"coder",
		);
		await new Promise((resolve) => setImmediate(resolve));
		for (let index = 0; index < 70; index += 1) {
			runEvents.recordEvent(`run-completed-before-${index}`, "coder", {
				type: "message_end",
				message: { role: "assistant", content: `before ${index}` },
			});
		}
		ok(runEvents.eventTail("run-active-tail"), "active tail survives the completed-tail bound");

		releaseDrain();
		await active.completion;
		for (let index = 0; index < 70; index += 1) {
			runEvents.recordEvent(`run-completed-after-${index}`, "reviewer", {
				type: "message_end",
				message: { role: "assistant", content: `after ${index}` },
			});
		}
		strictEqual(runEvents.eventTail("run-active-tail"), null, "settled tail becomes eligible for pruning");
	});

	it("attaches a direct rejection observer to detached background completion", async () => {
		const baseRunEvents = createDispatchRunEventRegistry();
		let rejectEvents!: (error: Error) => void;
		const eventsGate = new Promise<never>((_resolve, reject) => {
			rejectEvents = reject;
		});
		let catchCalls = 0;
		let observedFailure: Promise<unknown> | undefined;
		const observingRunEvents: DispatchRunEventRegistry = {
			...baseRunEvents,
			registerBatch(handle, agentIds, bus) {
				const registered = baseRunEvents.registerBatch(handle, agentIds, bus);
				observedFailure = registered.completion.then(
					() => undefined,
					(error: unknown) => error,
				);
				const originalCatch = registered.completion.catch.bind(registered.completion);
				registered.completion.catch = ((onRejected) => {
					catchCalls += 1;
					return originalCatch(onRejected);
				}) as typeof registered.completion.catch;
				return registered;
			},
		};
		const mockDispatch: DispatchContract = {
			dispatch: async () => {
				throw new Error("dispatch not used");
			},
			dispatchBatch: async () => ({
				batchId: "batch-background-failure",
				assignmentIds: ["run-background-failure"],
				events: {
					[Symbol.asyncIterator]() {
						return this;
					},
					async next() {
						await eventsGate;
						return { done: true, value: undefined };
					},
				},
				finalPromise: Promise.resolve([runReceipt("run-background-failure", "background")]),
			}),
			listRuns: () => [],
			getRun: () => null,
			abort: () => {},
			steer: () => {},
			detached: {
				register: async () => ({ batchId: "batch-background-failure" }) as never,
				get: () => null,
				list: () => [],
				markCollected: async () => null,
			},
			snapshot: () => ({
				generatedAt: new Date().toISOString(),
				running: [],
				retrying: [],
				totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
			}),
			planAgentSelection: unexpectedAgentPlanSelection,
			drain: async () => {},
		};
		const result = await createDispatchTool({
			getAgentSpecs: () => [],
			dispatch: mockDispatch,
			runEvents: observingRunEvents,
		}).run({ tasks: ["background"], detach: true }, approvedDispatch);
		strictEqual(result.kind, "ok");
		strictEqual(catchCalls, 1, "detached dispatch observes the exact registered completion immediately");

		const backgroundFailure = new Error("detached iterator failed");
		rejectEvents(backgroundFailure);
		strictEqual(await observedFailure, backgroundFailure);
	});

	it("keeps an operator-addressed in-flight synchronous ACP run non-steerable", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let active = false;
		const runId = "run-acp-sync";
		const mockDispatch: DispatchContract = {
			dispatch: async () => {
				active = true;
				return {
					runId,
					events: (async function* () {
						await gate;
						yield { type: "message_end", message: { role: "assistant", content: "ACP done" } };
					})(),
					finalPromise: gate.then(() => {
						active = false;
						return runReceipt(runId, "ACP sync");
					}),
				};
			},
			dispatchBatch: async () => {
				throw new Error("dispatchBatch not used");
			},
			listRuns: () => [],
			getRun: () => ({ ...runEnvelope(runId), status: active ? "running" : "completed", runtimeKind: "acp-delegation" }),
			abort: () => {},
			steer: () => {
				throw new Error(`dispatch: run '${runId}' has no input channel; only native workers can be steered`);
			},
			snapshot: () => ({
				generatedAt: new Date().toISOString(),
				running: [],
				retrying: [],
				totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
			}),
			planAgentSelection: unexpectedAgentPlanSelection,
			drain: async () => {},
		};
		// This direct concurrency exercises the operator/contract surface, not
		// parent-model scheduling while the sequential dispatch tool is pending.
		const pending = createDispatchTool({ getAgentSpecs: () => [], dispatch: mockDispatch }).run({ task: "ACP sync" });
		while (!active) await new Promise((resolve) => setImmediate(resolve));
		const guided = await createSteerTool({ dispatch: mockDispatch }).run({
			action: "guide",
			run_id: runId,
			message: "try to steer",
		});
		strictEqual(guided.kind, "error");
		ok(guided.kind === "error" && guided.message.includes("no input channel"));
		release();
		strictEqual((await pending).kind, "ok");
	});

	it("task persona and tool_profile map onto dispatch request fields", async () => {
		const capturedRequests: DispatchRequest[] = [];
		const mockDispatch: DispatchContract = {
			dispatch: async (req: DispatchRequest) => {
				capturedRequests.push(req);
				return {
					runId: "run-persona",
					events: assistantMessageEvents("done"),
					finalPromise: Promise.resolve(runReceipt("run-persona", req.task)),
				};
			},
			dispatchBatch: async () => {
				throw new Error("dispatchBatch not used");
			},
			listRuns: () => [],
			getRun: (runId: string) => runEnvelope(runId),
			abort: () => {},
			steer: () => {},
			snapshot: () => ({
				generatedAt: new Date().toISOString(),
				running: [],
				retrying: [],
				totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
			}),
			planAgentSelection: unexpectedAgentPlanSelection,
			drain: async () => {},
		};

		const tool = createDispatchTool({ getAgentSpecs: () => [], dispatch: mockDispatch });
		const result = await tool.run({
			tasks: [
				{
					task: "audit the boundary",
					agent: "coder",
					persona: "# Boundary Auditor\nCheck imports and report risks.",
					tool_profile: "minimal-local",
				},
			],
		});

		strictEqual(result.kind, "ok");
		strictEqual(capturedRequests.length, 1);
		const request = capturedRequests[0] as DispatchRequest & { systemPrompt?: string };
		strictEqual(request.systemPrompt, "# Boundary Auditor\nCheck imports and report risks.");
		strictEqual(request.toolProfile, "minimal-local");
	});

	it("rejects persona above the 8000 character cap at the tool boundary", async () => {
		const tool = createDispatchTool({
			getAgentSpecs: () => [],
			dispatch: {
				dispatch: async () => {
					throw new Error("dispatch must not run for oversized persona");
				},
			} as unknown as DispatchContract,
		});

		const result = await tool.run({
			tasks: [{ task: "do work", agent: "coder", persona: "x".repeat(8001) }],
		});

		strictEqual(result.kind, "error");
		if (result.kind === "error") {
			match(result.message, /persona/i);
			match(result.message, /8000/);
		}
	});

	it("createDispatchTool headlines failed receipts as failures", async () => {
		const mockDispatch: DispatchContract = {
			dispatch: async () => ({
				runId: "run-failed",
				events: (async function* () {})(),
				finalPromise: Promise.resolve(
					runReceipt("run-failed", "fail work", {
						exitCode: 2,
						outcome: "failed",
						outcomeDetail: "exit code 2",
						failureMessage: "worker crashed",
					}),
				),
			}),
			dispatchBatch: async () => {
				throw new Error("dispatchBatch not used");
			},
			listRuns: () => [],
			getRun: () => ({ ...runEnvelope("run-failed"), receiptPath: "/tmp/failed-receipt.json" }),
			abort: () => {},
			steer: () => {},
			snapshot: () => ({
				generatedAt: new Date().toISOString(),
				running: [],
				retrying: [],
				totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
			}),
			planAgentSelection: unexpectedAgentPlanSelection,
			drain: async () => {},
		};

		const tool = createDispatchTool({ getAgentSpecs: () => [], dispatch: mockDispatch });
		const result = await tool.run({ task: "fail work", agent: "coder" });

		strictEqual(result.kind, "error");
		if (result.kind === "error") {
			ok(result.message.includes("dispatch (parallel) total=1 failed=1"));
			ok(result.message.includes("failure=worker crashed"));
		}
	});

	it("dispatch with multiple tasks triggers the batch dispatch contract", async () => {
		const mockDispatch: DispatchContract = {
			dispatch: async () => {
				throw new Error("dispatch not used");
			},
			dispatchBatch: async (reqs: ReadonlyArray<DispatchRequest>) => {
				strictEqual(reqs.length, 2);
				strictEqual(reqs[0]?.task, "task 1");
				strictEqual(reqs[1]?.task, "task 2");
				return {
					batchId: "batch-1",
					assignmentIds: ["run-1", "run-2"],
					events: (async function* () {
						yield {
							type: "batch_run_event",
							runId: "run-1",
							agentId: "coder",
							event: {
								type: "message_end",
								message: { role: "assistant", content: "first scout finding" },
							},
						};
						yield {
							type: "batch_run_event",
							runId: "run-2",
							agentId: "coder",
							event: {
								type: "message_end",
								message: { role: "assistant", content: "second scout finding" },
							},
						};
					})(),
					finalPromise: Promise.resolve([
						runReceipt("run-1", "task 1", {
							output: { state: "final", text: "first scout finding", bytes: 19, truncated: false },
						}),
						runReceipt("run-2", "task 2", {
							output: { state: "final", text: "second scout finding", bytes: 20, truncated: false },
						}),
					]),
				};
			},
			listRuns: () => [],
			getRun: (runId: string) => runEnvelope(runId),
			abort: () => {},
			steer: () => {},
			snapshot: () => ({
				generatedAt: new Date().toISOString(),
				running: [],
				retrying: [],
				totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
			}),
			planAgentSelection: unexpectedAgentPlanSelection,
			drain: async () => {},
		};

		const tool = createDispatchTool({ getAgentSpecs: () => [], dispatch: mockDispatch });
		const result = await tool.run(
			{
				tasks: [
					{ task: "task 1", agent: "coder" },
					{ task: "task 2", agent: "coder" },
				],
			},
			approvedDispatch,
		);

		strictEqual(result.kind, "ok");
		if (result.kind === "ok") {
			ok(result.output.includes("dispatch (parallel) total=2 failed=0"));
			ok(result.output.includes("receipt=/tmp/run-1.json"));
			ok(result.output.includes("first scout finding"));
			ok(result.output.includes("second scout finding"));
		}
	});

	it("mode pipeline dispatches steps sequentially and threads previous assistant text", async () => {
		const capturedRequests: DispatchRequest[] = [];
		const tool = createDispatchTool({
			getAgentSpecs: () => [],
			dispatch: fakeSequentialDispatch(
				[
					{ runId: "run-1", assistantText: "first worker answer" },
					{ runId: "run-2", assistantText: "second worker answer" },
					{ runId: "run-3", assistantText: "third worker answer" },
				],
				capturedRequests,
			),
		});

		const result = await tool.run(
			{
				mode: "pipeline",
				tasks: [
					{ task: "step 1", agent: "coder" },
					{ task: "step 2", agent: "coder" },
					{ task: "step 3", agent: "coder" },
				],
			},
			approvedDispatch,
		);

		strictEqual(result.kind, "ok");
		strictEqual(capturedRequests.length, 3);
		strictEqual((capturedRequests[0] as DispatchRequest & { pipelineInput?: unknown }).pipelineInput, undefined);
		deepStrictEqual((capturedRequests[1] as DispatchRequest & { pipelineInput?: unknown }).pipelineInput, {
			fromRunId: "run-1",
			position: 2,
			text: "first worker answer",
		});
		deepStrictEqual((capturedRequests[2] as DispatchRequest & { pipelineInput?: unknown }).pipelineInput, {
			fromRunId: "run-2",
			position: 3,
			text: "second worker answer",
		});
		if (result.kind === "ok") {
			ok(result.output.includes("dispatch (pipeline) total=3 failed=0"));
		}
	});

	it("mode pipeline preserves per-step persona and tool_profile", async () => {
		const capturedRequests: DispatchRequest[] = [];
		const tool = createDispatchTool({
			getAgentSpecs: () => [],
			dispatch: fakeSequentialDispatch(
				[
					{ runId: "run-1", assistantText: "first specialist answer" },
					{ runId: "run-2", assistantText: "second specialist answer" },
				],
				capturedRequests,
			),
		});

		const result = await tool.run(
			{
				mode: "pipeline",
				tasks: [
					{
						task: "summarize interface",
						agent: "coder",
						persona: "# Interface Specialist\nSummarize the public contract.",
						tool_profile: "minimal-local",
					},
					{
						task: "check implications",
						agent: "coder",
						persona: "# Risk Specialist\nIdentify integration risks.",
						tool_profile: "science-local",
					},
				],
			},
			approvedDispatch,
		);

		strictEqual(result.kind, "ok");
		strictEqual(capturedRequests.length, 2);
		const first = capturedRequests[0] as DispatchRequest & { systemPrompt?: string };
		const second = capturedRequests[1] as DispatchRequest & { systemPrompt?: string };
		strictEqual(first.systemPrompt, "# Interface Specialist\nSummarize the public contract.");
		strictEqual(first.toolProfile, "minimal-local");
		strictEqual(second.systemPrompt, "# Risk Specialist\nIdentify integration risks.");
		strictEqual(second.toolProfile, "science-local");
		deepStrictEqual((second as DispatchRequest & { pipelineInput?: unknown }).pipelineInput, {
			fromRunId: "run-1",
			position: 2,
			text: "first specialist answer",
		});
	});

	it("mode pipeline halts after a failed middle step and reports skipped tasks", async () => {
		const capturedRequests: DispatchRequest[] = [];
		const tool = createDispatchTool({
			getAgentSpecs: () => [],
			dispatch: fakeSequentialDispatch(
				[
					{ runId: "run-1", assistantText: "first worker answer" },
					{
						runId: "run-2",
						assistantText: "second worker failed",
						receipt: {
							exitCode: 2,
							outcome: "failed",
							outcomeDetail: "exit code 2",
							failureMessage: "middle step failed",
						},
					},
					{ runId: "run-3", assistantText: "must not dispatch" },
				],
				capturedRequests,
			),
		});

		const result = await tool.run(
			{
				mode: "pipeline",
				tasks: [
					{ task: "step 1", agent: "coder" },
					{ task: "step 2", agent: "coder" },
					{ task: "step 3", agent: "coder" },
				],
			},
			approvedDispatch,
		);

		strictEqual(result.kind, "error");
		strictEqual(capturedRequests.length, 2);
		strictEqual((capturedRequests[0] as DispatchRequest & { pipelineInput?: unknown }).pipelineInput, undefined);
		deepStrictEqual((capturedRequests[1] as DispatchRequest & { pipelineInput?: unknown }).pipelineInput, {
			fromRunId: "run-1",
			position: 2,
			text: "first worker answer",
		});
		if (result.kind === "error") {
			strictEqual(
				result.message.split("\n")[0],
				"dispatch: pipeline dispatch halted at step 2/3 (run run-2, outcome=failed); skipped 1 later step(s)",
			);
			match(result.message, /step 2/i);
			match(result.message, /skip(?:ped)?\s+1|1\s+skip/i);
			ok(result.message.includes("dispatch (pipeline) total=2 failed=1"));
			ok(result.message.includes("receipt=/tmp/run-1.json"));
			ok(result.message.includes("receipt=/tmp/run-2.json"));
			ok(result.message.includes("first worker answer"));
			ok(result.message.includes("second worker failed"));
			const details = result.details as
				| {
						mode?: unknown;
						assignmentIds?: unknown;
						receiptCount?: unknown;
						failedCount?: unknown;
						runs?: Array<{ runId?: unknown; exitCode?: unknown; receiptPath?: unknown }>;
				  }
				| undefined;
			strictEqual(details?.mode, "pipeline");
			deepStrictEqual(details?.assignmentIds, ["run-1", "run-2"]);
			strictEqual(details?.receiptCount, 2);
			strictEqual(details?.failedCount, 1);
			strictEqual(details?.runs?.[0]?.runId, "run-1");
			strictEqual(details?.runs?.[0]?.exitCode, 0);
			strictEqual(details?.runs?.[0]?.receiptPath, "/tmp/run-1.json");
			strictEqual(details?.runs?.[1]?.runId, "run-2");
			strictEqual(details?.runs?.[1]?.exitCode, 2);
			strictEqual(details?.runs?.[1]?.receiptPath, "/tmp/run-2.json");
		}
	});

	it("surfaces pipeline, persona, and escalation provenance in output lines and details, absent on plain steps", async () => {
		const capturedRequests: DispatchRequest[] = [];
		const tool = createDispatchTool({
			getAgentSpecs: () => [],
			dispatch: fakeSequentialDispatch(
				[
					{ runId: "run-1", assistantText: "first worker answer" },
					{
						runId: "run-2",
						assistantText: "second worker answer",
						receipt: {
							pipeline: { fromRunId: "run-1", position: 2, inputBytes: 32, inputTruncated: true },
							personaOverride: { promptHash: "1b3fc16b2c4d5e6f7a8b9c0d1e2f3a4b" },
							safety: {
								decisions: {
									allowed: 3,
									blocked: 0,
									permissionRequested: 2,
									escalationRequested: 2,
									escalationApproved: 0,
									escalationDenied: 1,
									escalationTimedOut: 1,
								},
								blockedAttempts: [],
								requestedActions: [],
								runtimeLimitations: [],
							},
							autonomyEnforcement: {
								grade: "approximated",
								autonomy: "auto-edit",
								externalMode: "acceptEdits",
								dangerousBypass: false,
							},
						},
					},
				],
				capturedRequests,
			),
		});

		const result = await tool.run(
			{
				mode: "pipeline",
				tasks: [
					{ task: "step 1", agent: "coder" },
					{ task: "step 2", agent: "coder" },
				],
			},
			approvedDispatch,
		);

		strictEqual(result.kind, "ok");
		if (result.kind === "ok") {
			ok(result.output.includes("pipeline=step2 from=run-1 in=32b truncated"), result.output);
			ok(result.output.includes("persona=1b3fc16b2c4d..."), result.output);
			ok(result.output.includes("escalations=2req/0appr/1deny/1timeout"), result.output);
			ok(result.output.includes("enforcement=approximated:auto-edit/acceptEdits"), result.output);
			const details = result.details as {
				runs?: Array<{
					runId?: unknown;
					pipeline?: unknown;
					personaOverride?: unknown;
					escalation?: unknown;
					autonomyEnforcement?: unknown;
				}>;
			};
			// Plain first step carries no provenance keys.
			strictEqual(details.runs?.[0]?.runId, "run-1");
			ok(!("pipeline" in (details.runs?.[0] ?? {})), "plain step must omit pipeline");
			ok(!("personaOverride" in (details.runs?.[0] ?? {})), "plain step must omit personaOverride");
			ok(!("escalation" in (details.runs?.[0] ?? {})), "plain step must omit escalation");
			ok(!("autonomyEnforcement" in (details.runs?.[0] ?? {})), "plain step must omit autonomyEnforcement");
			// Provenance-bearing second step carries the additive keys.
			deepStrictEqual(details.runs?.[1]?.pipeline, {
				fromRunId: "run-1",
				position: 2,
				inputBytes: 32,
				inputTruncated: true,
			});
			deepStrictEqual(details.runs?.[1]?.personaOverride, { promptHash: "1b3fc16b2c4d5e6f7a8b9c0d1e2f3a4b" });
			deepStrictEqual(details.runs?.[1]?.escalation, { requested: 2, approved: 0, denied: 1, timedOut: 1 });
			deepStrictEqual(details.runs?.[1]?.autonomyEnforcement, {
				grade: "approximated",
				autonomy: "auto-edit",
				externalMode: "acceptEdits",
				dangerousBypass: false,
			});
		}
	});

	it("routes an interleaved heterogeneous batch by run and agent while preserving receipt output order", async () => {
		const bus = createSafeEventBus();
		const progress: Array<{ runId: string; agentId: string; type: string }> = [];
		const runEvents = createDispatchRunEventRegistry();
		bus.on(BusChannels.DispatchProgress, (payload) => {
			progress.push({
				runId: payload.runId,
				agentId: payload.agentId,
				type: (payload.event as { type: string }).type,
			});
		});
		const wrappers = [
			{
				type: "batch_run_event",
				batchId: "batch-board",
				runId: "run-b2",
				agentId: "reviewer",
				event: { type: "clio_tool_finish", payload: { tool: "grep", outcome: "ok" } },
			},
			{
				type: "batch_run_event",
				batchId: "batch-board",
				runId: "run-b1",
				agentId: "coder",
				event: { type: "message_end", message: { role: "assistant", content: "first done" } },
			},
			{
				type: "batch_run_event",
				batchId: "batch-board",
				runId: "run-b2",
				agentId: "reviewer",
				event: { type: "message_end", message: { role: "assistant", content: "second done" } },
			},
		];
		const guarded = singleConsumerIterator(wrappers);
		const mockDispatch: DispatchContract = {
			dispatch: async () => {
				throw new Error("dispatch not used");
			},
			dispatchBatch: async () => ({
				batchId: "batch-board",
				assignmentIds: ["run-b1", "run-b2"],
				events: guarded.iterator,
				finalPromise: Promise.resolve([
					runReceipt("run-b1", "task 1"),
					runReceipt("run-b2", "task 2", { agentId: "reviewer" }),
				]),
			}),
			listRuns: () => [],
			getRun: (runId: string) => runEnvelope(runId),
			abort: () => {},
			steer: () => {},
			snapshot: () => ({
				generatedAt: new Date().toISOString(),
				running: [],
				retrying: [],
				totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
			}),
			planAgentSelection: unexpectedAgentPlanSelection,
			drain: async () => {},
		};
		const tool = createDispatchTool({ getAgentSpecs: () => [], dispatch: mockDispatch, bus, runEvents });
		const result = await tool.run(
			{
				tasks: [
					{ task: "task 1", agent: "coder" },
					{ task: "task 2", agent: "reviewer" },
				],
			},
			approvedDispatch,
		);
		strictEqual(result.kind, "ok");
		strictEqual(guarded.consumers(), 1, "the merged batch iterator has one consumer");
		deepStrictEqual(result.details?.assignmentIds, ["run-b1", "run-b2"]);
		deepStrictEqual(progress, [
			{ runId: "run-b2", agentId: "reviewer", type: "clio_tool_finish" },
			{ runId: "run-b1", agentId: "coder", type: "message_end" },
			{ runId: "run-b2", agentId: "reviewer", type: "message_end" },
		]);
		strictEqual(runEvents.eventTail("run-b1")?.agentId, "coder");
		deepStrictEqual(
			runEvents.eventTail("run-b1")?.entries.map((entry) => entry.detail),
			["first done"],
		);
		strictEqual(runEvents.eventTail("run-b2")?.agentId, "reviewer");
		deepStrictEqual(
			runEvents.eventTail("run-b2")?.entries.map((entry) => entry.type),
			["clio_tool_finish", "message_end"],
		);
		if (result.kind === "ok") {
			const firstReceipt = result.output.indexOf("- run-b1 agent=coder");
			const secondReceipt = result.output.indexOf("- run-b2 agent=reviewer");
			ok(firstReceipt >= 0 && secondReceipt > firstReceipt, "receipt summaries preserve finalPromise order");
		}
	});

	it("keeps the monitor tail useful under streaming floods: updates are skipped, tool and terminal events survive", async () => {
		const runId = `run-flood-${Date.now()}`;
		const runEvents = createDispatchRunEventRegistry();
		const mockDispatch: DispatchContract = {
			dispatch: async () => ({
				runId,
				events: (async function* () {
					for (let i = 0; i < 150; i += 1) {
						yield { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } };
					}
					yield { type: "clio_tool_start", payload: { tool: "grep" } };
					yield { type: "clio_tool_finish", payload: { tool: "grep", outcome: "ok" } };
					yield { type: "message_end", message: { role: "assistant", content: "flood survived" } };
				})(),
				finalPromise: Promise.resolve(runReceipt(runId, "flood")),
			}),
			dispatchBatch: async () => {
				throw new Error("dispatchBatch not used");
			},
			listRuns: () => [],
			getRun: (id: string) => runEnvelope(id),
			abort: () => {},
			steer: () => {},
			snapshot: () => ({
				generatedAt: new Date().toISOString(),
				running: [],
				retrying: [],
				totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
			}),
			planAgentSelection: unexpectedAgentPlanSelection,
			drain: async () => {},
		};
		const tool = createDispatchTool({ getAgentSpecs: () => [], dispatch: mockDispatch, runEvents });
		const result = await tool.run({ task: "flood", agent: "coder" });
		strictEqual(result.kind, "ok");
		const tail = runEvents.eventTail(runId);
		ok(tail !== null, "run tail exists");
		strictEqual(createDispatchRunEventRegistry().eventTail(runId), null, "independent tool bundles do not share tails");
		const types = tail?.entries.map((entry) => entry.type) ?? [];
		ok(!types.includes("message_update"), "bare streaming updates must not flood the tail");
		deepStrictEqual(types, ["clio_tool_start", "clio_tool_finish", "message_end"]);
		const terminal = tail?.entries.at(-1);
		strictEqual(terminal?.detail, "flood survived", "the terminal answer detail survives the flood");
	});

	it("renders a non-success outcome and its detail in output and details, including a timeout with no failureMessage", async () => {
		const mockDispatch: DispatchContract = {
			dispatch: async () => ({
				runId: "run-timeout",
				events: (async function* () {})(),
				finalPromise: Promise.resolve(
					runReceipt("run-timeout", "slow work", {
						exitCode: 1,
						outcome: "timed_out",
						outcomeDetail: "turn timeout exceeded",
					}),
				),
			}),
			dispatchBatch: async () => {
				throw new Error("dispatchBatch not used");
			},
			listRuns: () => [],
			getRun: () => ({ ...runEnvelope("run-timeout"), receiptPath: "/tmp/run-timeout.json" }),
			abort: () => {},
			steer: () => {},
			snapshot: () => ({
				generatedAt: new Date().toISOString(),
				running: [],
				retrying: [],
				totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
			}),
			planAgentSelection: unexpectedAgentPlanSelection,
			drain: async () => {},
		};
		const tool = createDispatchTool({ getAgentSpecs: () => [], dispatch: mockDispatch });
		const result = await tool.run({ task: "slow work", agent: "coder" });
		strictEqual(result.kind, "error");
		if (result.kind === "error") {
			ok(result.message.includes("outcome=timed_out"), result.message);
			ok(result.message.includes("detail=turn timeout exceeded"), result.message);
			const details = result.details as { runs?: Array<{ outcome?: unknown; outcomeDetail?: unknown }> };
			strictEqual(details.runs?.[0]?.outcome, "timed_out");
			strictEqual(details.runs?.[0]?.outcomeDetail, "turn timeout exceeded");
		}
	});

	it("invalid dispatch mode error names all supported modes", async () => {
		const tool = createDispatchTool({ getAgentSpecs: () => [], dispatch: {} as DispatchContract });
		const result = await tool.run({ mode: "serial", tasks: [{ task: "do work", agent: "coder" }] });

		strictEqual(result.kind, "error");
		if (result.kind === "error") {
			ok(result.message.includes("parallel"));
			ok(result.message.includes("sequential"));
			ok(result.message.includes("pipeline"));
		}
	});

	it("single-task pipeline dispatch sends no pipeline input", async () => {
		const capturedRequests: DispatchRequest[] = [];
		const tool = createDispatchTool({
			getAgentSpecs: () => [],
			dispatch: fakeSequentialDispatch([{ runId: "run-1", assistantText: "single worker answer" }], capturedRequests),
		});

		const result = await tool.run({
			mode: "pipeline",
			tasks: [{ task: "single step", agent: "coder" }],
		});

		strictEqual(result.kind, "ok");
		strictEqual(capturedRequests.length, 1);
		strictEqual((capturedRequests[0] as DispatchRequest & { pipelineInput?: unknown }).pipelineInput, undefined);
	});

	it("does not expose worker permission resolution as a model-facing registry tool", () => {
		const registry = testRegistryWithTools([]);
		registerAllTools(registry, {
			askUser: async () => ({ answers: [] }),
			dispatch: {
				dispatch: async () => {
					throw new Error("dispatch not used");
				},
				dispatchBatch: async () => {
					throw new Error("dispatchBatch not used");
				},
				listRuns: () => [],
				getRun: () => null,
				abort: () => {},
				steer: () => {},
				resolveWorkerPermission: () => {
					throw new Error("model-facing tools must not call resolveWorkerPermission");
				},
				snapshot: () => ({
					generatedAt: new Date().toISOString(),
					running: [],
					retrying: [],
					totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
				}),
				planAgentSelection: unexpectedAgentPlanSelection,
				drain: async () => {},
			} as DispatchContract & { resolveWorkerPermission(runId: string, requestId: string, decision: string): void },
		});

		const surface = registry
			.listVisible()
			.map((spec) => `${spec.name}\n${spec.description}\n${JSON.stringify(spec.parameters)}`)
			.join("\n---\n");

		strictEqual(registry.get("resolveWorkerPermission" as ToolName), undefined);
		strictEqual(/resolveWorkerPermission|permission_decision|worker permission/i.test(surface), false, surface);
	});
});

// A2 recon-evidence contract: the dispatch summary distinguishes sealed
// receipt integrity, the receipt's verification state, and advisory worker
// prose. Labels are derived from the sealed receipt only and never drive
// control flow; retry/outcome behavior is pinned unchanged elsewhere.
describe("contracts/tools dispatch evidence labeling", () => {
	const SPOT_CHECK_PHRASE = "Spot-check delegated claims before repeating them";

	function singleRunTool(
		runId: string,
		assistantText: string,
		receipt?: Partial<RunReceipt>,
		tamper?: (receipt: RunReceipt) => RunReceipt,
	) {
		return createDispatchTool({
			getAgentSpecs: () => [],
			dispatch: {
				dispatch: async (req: DispatchRequest) => {
					const sealed = runReceipt(runId, req.task, {
						...(assistantText.length > 0
							? {
									output: {
										state: "final" as const,
										text: assistantText,
										bytes: Buffer.byteLength(assistantText, "utf8"),
										truncated: false,
									},
								}
							: {}),
						...(receipt ?? {}),
					});
					return {
						runId,
						events: assistantMessageEvents(assistantText),
						finalPromise: Promise.resolve(tamper !== undefined ? tamper(sealed) : sealed),
					};
				},
				dispatchBatch: async () => {
					throw new Error("dispatchBatch not used");
				},
				listRuns: () => [],
				getRun: (id: string) => runEnvelope(id),
				abort: () => {},
				steer: () => {},
				snapshot: () => ({
					generatedAt: new Date().toISOString(),
					running: [],
					retrying: [],
					totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
				}),
				planAgentSelection: unexpectedAgentPlanSelection,
				drain: async () => {},
			},
		});
	}

	it("renders RECEIPT INTEGRITY FAILED when a sealed verification field was tampered", async () => {
		const tool = singleRunTool(
			"run-tamper",
			"I ran the tests and they pass.",
			{ verification: { state: "unverified", basis: "no-validation-tool" } },
			// Post-seal forgery: promote unverified to verified without resealing.
			(sealed) => ({ ...sealed, verification: { state: "verified", basis: "validation-tool" } }),
		);
		const result = await tool.run({ task: "tamper probe", agent: "coder" });
		// Integrity failure is surfaced prominently but stays descriptive: the
		// process outcome (exit 0) still shapes the result kind.
		strictEqual(result.kind, "ok");
		if (result.kind === "ok") {
			ok(result.output.includes("RECEIPT INTEGRITY FAILED for run-tamper (integrity mismatch)"), result.output);
			ok(result.output.includes('receipt_integrity=FAILED reason="integrity mismatch"'), result.output);
			const details = result.details as { runs?: Array<{ receiptIntegrity?: { ok?: boolean; reason?: string } }> };
			deepStrictEqual(details.runs?.[0]?.receiptIntegrity, { ok: false, reason: "integrity mismatch" });
		}
	});

	it("labels tool-verified worker output and omits spot-check guidance", async () => {
		const tool = singleRunTool("run-verified", "Implemented and validated; tests pass.", {
			verification: { state: "verified", basis: "validation-tool" },
			toolStats: [{ tool: "verify", count: 1, ok: 1, errors: 0, blocked: 0, totalDurationMs: 5 }],
			toolActivity: { calls: 1, succeeded: 1, failed: 0, blocked: 0, mutatingSucceeded: true },
		});
		const result = await tool.run({ task: "fix and test", agent: "coder" });
		strictEqual(result.kind, "ok");
		if (result.kind === "ok") {
			ok(result.output.includes("verification=verified/validation-tool"), result.output);
			ok(result.output.includes("worker output (tool-verified):"), result.output);
			strictEqual(result.output.includes(SPOT_CHECK_PHRASE), false, result.output);
			strictEqual(result.output.includes("RECEIPT INTEGRITY FAILED"), false, result.output);
			strictEqual(result.output.includes("non-evidence:"), false, result.output);
		}
	});

	it("labels unverified prose as worker claims and appends spot-check guidance", async () => {
		const tool = singleRunTool("run-unverified", "Edited src/x.ts:12 and everything works.", {
			verification: { state: "unverified", basis: "no-validation-tool" },
			toolActivity: { calls: 2, succeeded: 2, failed: 0, blocked: 0, mutatingSucceeded: true },
		});
		const result = await tool.run({ task: "quick edit", agent: "coder" });
		strictEqual(result.kind, "ok");
		if (result.kind === "ok") {
			ok(result.output.includes("verification=unverified/no-validation-tool"), result.output);
			ok(result.output.includes("worker claims (unverified prose):"), result.output);
			ok(result.output.includes(SPOT_CHECK_PHRASE), result.output);
		}
	});

	it("labels read-only recon advisory without calling it failed or validation evidence", async () => {
		const tool = singleRunTool("run-recon", "The dispatcher lives in src/tools/dispatch.ts:478.", {
			verification: { state: "not_applicable", basis: "read-only-agent" },
			toolActivity: { calls: 3, succeeded: 3, failed: 0, blocked: 0, mutatingSucceeded: false },
		});
		const result = await tool.run({ task: "map the dispatcher", agent: "scout" });
		strictEqual(result.kind, "ok");
		if (result.kind === "ok") {
			ok(result.output.includes("dispatch (parallel) total=1 failed=0"), result.output);
			ok(result.output.includes("verification=not_applicable/read-only-agent"), result.output);
			ok(result.output.includes("reconnaissance output (advisory leads, not validation evidence):"), result.output);
			// A cited recon answer earns no citation-free notice, and recon is not
			// an unverified/unknown claim, so no spot-check reminder either.
			strictEqual(result.output.includes("cites no file:line locations"), false, result.output);
			strictEqual(result.output.includes(SPOT_CHECK_PHRASE), false, result.output);
			strictEqual(result.output.includes("non-evidence:"), false, result.output);
		}
	});

	it("flags citation-free reconnaissance as non-evidence", async () => {
		const tool = singleRunTool("run-recon-bare", "The code seems fine overall and probably handles retries.", {
			verification: { state: "not_applicable", basis: "read-only-agent" },
			toolActivity: { calls: 2, succeeded: 2, failed: 0, blocked: 0, mutatingSucceeded: false },
		});
		const result = await tool.run({ task: "assess retries", agent: "scout" });
		strictEqual(result.kind, "ok");
		if (result.kind === "ok") {
			ok(
				result.output.includes(
					"non-evidence: this reconnaissance answer cites no file:line locations; treat its leads as unconfirmed.",
				),
				result.output,
			);
		}
	});

	it("keeps ACP-unobserved validation unknown instead of asserting unverified", async () => {
		const tool = singleRunTool("run-acp", "Delegated agent reports the migration is complete.", {
			verification: { state: "unknown", basis: "acp-external-unobserved" },
		});
		const result = await tool.run({ task: "delegate migration", agent: "claude-cli" });
		strictEqual(result.kind, "ok");
		if (result.kind === "ok") {
			ok(result.output.includes("verification=unknown/acp-external-unobserved"), result.output);
			ok(result.output.includes("worker claims (validation not observable at this layer):"), result.output);
			ok(result.output.includes(SPOT_CHECK_PHRASE), result.output);
			strictEqual(result.output.includes("verification=unverified"), false, result.output);
		}
	});

	it("notices zero successful tool calls as non-evidence", async () => {
		const tool = singleRunTool("run-zero-tool", "All done, nothing needed changing.", {
			verification: { state: "unverified", basis: "no-validation-tool" },
			outcome: "succeeded",
			outcomeDetail: "completed without executing any tools",
			toolActivity: { calls: 0, succeeded: 0, failed: 0, blocked: 0, mutatingSucceeded: false },
		});
		const result = await tool.run({ task: "impossible task", agent: "coder" });
		strictEqual(result.kind, "ok");
		if (result.kind === "ok") {
			ok(
				result.output.includes(
					"non-evidence: no tool call succeeded in this run; the text above was written without observed work.",
				),
				result.output,
			);
		}
	});

	it("notices failed and cap-exhausted runs as non-evidence", async () => {
		const capturedRequests: DispatchRequest[] = [];
		const tool = createDispatchTool({
			getAgentSpecs: () => [],
			dispatch: fakeSequentialDispatch(
				[
					{
						runId: "run-hard-fail",
						assistantText: "I finished the refactor.",
						receipt: { exitCode: 1, outcome: "failed", outcomeDetail: "exit code 1", failureMessage: "worker crashed" },
					},
					{
						runId: "run-cap",
						assistantText: "Partial synthesis from what I gathered.",
						receipt: {
							exitCode: 1,
							outcome: "failed",
							outcomeDetail: "exit code 1",
							failureMessage: "workerToolCallCap reached (50); tool calls are now disabled for the rest of this run.",
						},
					},
				],
				capturedRequests,
			),
		});
		const result = await tool.run(
			{
				mode: "sequential",
				tasks: [
					{ task: "refactor", agent: "coder" },
					{ task: "explore", agent: "coder" },
				],
			},
			approvedDispatch,
		);
		strictEqual(result.kind, "error");
		if (result.kind === "error") {
			ok(
				result.message.includes(
					"non-evidence: this run did not succeed; treat the text above as an unsubstantiated report, not results.",
				),
				result.message,
			);
			ok(
				result.message.includes(
					"non-evidence: the worker exhausted its tool-call cap; the text above is a partial synthesis, not verified results.",
				),
				result.message,
			);
		}
	});

	it("carries the structured verification state and integrity result in dispatchDetails", async () => {
		const tool = singleRunTool("run-details", "Structured details probe.", {
			verification: { state: "verified", basis: "validation-tool" },
			toolStats: [{ tool: "verify", count: 1, ok: 1, errors: 0, blocked: 0, totalDurationMs: 3 }],
		});
		const result = await tool.run({ task: "details probe", agent: "coder" });
		strictEqual(result.kind, "ok");
		if (result.kind === "ok") {
			const details = result.details as {
				runs?: Array<{ verification?: unknown; receiptIntegrity?: unknown }>;
			};
			deepStrictEqual(details.runs?.[0]?.verification, { state: "verified", basis: "validation-tool" });
			deepStrictEqual(details.runs?.[0]?.receiptIntegrity, { ok: true });
		}
	});
});

describe("contracts/tools prompt hints", () => {
	it("carries promptHint metadata on exactly the five hinted tools, verbatim", () => {
		const registry = testRegistryWithTools([]);
		registerAllTools(registry, {
			askUser: async () => ({ answers: [] }),
			dispatch: {} as DispatchContract,
		});

		const hinted = new Map<string, string>();
		for (const spec of registry.listAll()) {
			const hint = spec.metadata?.promptHint;
			if (typeof hint === "string") hinted.set(spec.name, hint);
		}

		deepStrictEqual([...hinted.keys()].sort(), ["ask_user", "code_nav", "context", "dispatch", "tasks"]);
		strictEqual(
			hinted.get("code_nav"),
			"Use code_nav for indexed code navigation (modes: symbol, path, entries, outline, deps, dependents, wiki).",
		);
		strictEqual(
			hinted.get("context"),
			'Call context with scope="skills" to list installed and marketplace skills; when one matches the task, or the operator names a skill or asks how one works, suggest the operator run /skill:<name> (a marketplace skill is offered for install) and never load it uninvited. When the user message carries a skill request, first load that skill via context (scope="skills", name=<skill>) before doing anything else.',
		);
		strictEqual(
			hinted.get("dispatch"),
			"Call dispatch with list:true only when the operator asks about agents, workers, or the fleet; never use it to inventory direct tools.",
		);
		strictEqual(
			hinted.get("tasks"),
			'When a request contains three or more distinct steps, declare the board before your first edit: tasks action="plan" with a title and the task list. ' +
				'Mark one task active with "start" before working it, close it with "done" plus an evidence note ' +
				'(what proves it works), and use "block" with a reason instead of silently stalling.',
		);
		strictEqual(
			hinted.get("ask_user"),
			'Use ask_user only when blocked on a decision the request does not answer; never ask about anything the operator already stated. One question per round in interview workflows, up to four tightly related questions otherwise, recommended option first. Finish with action="complete" and a compact decisions array before final prose. If cancelled, continue with defaults and do not ask again.',
		);
	});
});
