import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { Type } from "typebox";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import type { DispatchContract, DispatchRequest } from "../../src/domains/dispatch/contract.js";
import type { RunEnvelope, RunReceipt } from "../../src/domains/dispatch/types.js";
import { CONFIRMED_SCOPE, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import { resolveAgentTools } from "../../src/engine/worker-tools.js";
import { bashTool } from "../../src/tools/bash.js";
import { registerAllTools } from "../../src/tools/bootstrap.js";
import { credentialPresentTool } from "../../src/tools/credential-present.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import { editTool } from "../../src/tools/edit.js";
import { findTool } from "../../src/tools/find.js";
import { grepTool } from "../../src/tools/grep.js";
import { lsTool } from "../../src/tools/ls.js";
import { OBSERVATION_TURN_BUDGET_ENV } from "../../src/tools/observation.js";
import { applyToolProfile } from "../../src/tools/profiles.js";
import { readTool } from "../../src/tools/read.js";
import { createRegistry, type ToolSpec } from "../../src/tools/registry.js";
import { shapeToolResult } from "../../src/tools/result-shaping.js";
import { verifyTool } from "../../src/tools/verify/index.js";
import { writeTool } from "../../src/tools/write.js";

const scratchRoots: string[] = [];

function scratchDir(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-tools-basic-"));
	scratchRoots.push(root);
	return root;
}

function workspaceScratchDir(): string {
	const parent = join(process.cwd(), ".clio", "test-scratch");
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

function runReceipt(runId: string, task: string, overrides: Partial<RunReceipt> = {}): RunReceipt {
	return {
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
		integrity: {
			version: 1,
			algorithm: "sha256",
			digest: "0".repeat(64),
		},
		...overrides,
	};
}

function runEnvelope(runId: string): RunEnvelope {
	return {
		id: runId,
		agentId: "coder",
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
			const finalPromise = Promise.resolve(runReceipt(step.runId, req.task, step.receipt)).finally(() => {
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
		drain: async () => {},
	};
}

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
		writeFileSync(envPath, "CLIO_FILE_KEY=file-secret\nCLIO_BOTH_KEY=file-secret\n", "utf8");
		const previousEnv = process.env.CLIO_ENV_KEY;
		const previousBoth = process.env.CLIO_BOTH_KEY;
		process.env.CLIO_ENV_KEY = "env-secret";
		process.env.CLIO_BOTH_KEY = "env-secret";
		try {
			const envResult = await credentialPresentTool.run({ name: "CLIO_ENV_KEY", source: "environment" });
			strictEqual(envResult.kind, "ok");
			const envText = JSON.stringify(envResult);
			ok(envText.includes('"present":true'));
			ok(envText.includes('"source":"environment"'));
			ok(!envText.includes("env-secret"));

			const fileResult = await credentialPresentTool.run({ name: "CLIO_FILE_KEY", file: envPath, source: "file" });
			strictEqual(fileResult.kind, "ok");
			const fileText = JSON.stringify(fileResult);
			ok(fileText.includes('"present":true'));
			ok(fileText.includes('"source":"file"'));
			ok(!fileText.includes("file-secret"));

			const bothResult = await credentialPresentTool.run({ name: "CLIO_BOTH_KEY", file: envPath });
			strictEqual(bothResult.kind, "ok");
			ok(JSON.stringify(bothResult).includes('"source":"both"'));

			const absentResult = await credentialPresentTool.run({ name: "CLIO_ABSENT_KEY", file: envPath });
			strictEqual(absentResult.kind, "ok");
			const absentText = JSON.stringify(absentResult);
			ok(absentText.includes('"present":false'));
			ok(absentText.includes('"source":"none"'));
		} finally {
			if (previousEnv === undefined) delete process.env.CLIO_ENV_KEY;
			else process.env.CLIO_ENV_KEY = previousEnv;
			if (previousBoth === undefined) delete process.env.CLIO_BOTH_KEY;
			else process.env.CLIO_BOTH_KEY = previousBoth;
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
		mkdirSync(join(root, ".clio"));
		writeFileSync(join(root, "src", "index.ts"), "export const thinkingBudget = 1;\n", "utf8");
		writeFileSync(join(root, ".clio", "codewiki.json"), '{"text":"thinkingBudget"}\n', "utf8");

		const result = await grepTool.run({ pattern: "thinkingBudget", path: root });
		strictEqual(result.kind, "ok");
		ok(result.output.includes("src/index.ts"));
		ok(!result.output.includes(".clio/codewiki.json"));
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
	it("keeps dispatch target schema examples environment-neutral", () => {
		const tool = createDispatchTool({ dispatch: {} as DispatchContract });
		const schemaText = JSON.stringify(tool.parameters);

		for (const pattern of [/\bdynamo\b/i, /\bmini\b/i, /\bzbook\b/i, /\b192\.168\./]) {
			strictEqual(pattern.test(schemaText), false, `dispatch schema leaked ${pattern}`);
		}
	});

	it("dispatch list:true returns the agent catalog without dispatching", async () => {
		const tool = createDispatchTool({
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
		const noCatalog = createDispatchTool({ dispatch: {} as DispatchContract });
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
			drain: async () => {},
		};

		const tool = createDispatchTool({ dispatch: mockDispatch });
		const result = await tool.run({ task: "do work", agent_id: "coder" });

		strictEqual(result.kind, "ok");
		if (result.kind === "ok") {
			ok(result.output.includes("dispatch (parallel) total=1 failed=0"));
			ok(result.output.includes("run-123"));
			const details = result.details as { runIds?: unknown; receiptCount?: unknown } | undefined;
			ok(Array.isArray(details?.runIds) && details.runIds[0] === "run-123");
			strictEqual(details?.receiptCount, 1);
		}
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
			drain: async () => {},
		};

		const tool = createDispatchTool({ dispatch: mockDispatch });
		const result = await tool.run({
			tasks: [
				{
					task: "audit the boundary",
					agent_id: "coder",
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
			dispatch: {
				dispatch: async () => {
					throw new Error("dispatch must not run for oversized persona");
				},
			} as unknown as DispatchContract,
		});

		const result = await tool.run({
			tasks: [{ task: "do work", agent_id: "coder", persona: "x".repeat(8001) }],
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
			drain: async () => {},
		};

		const tool = createDispatchTool({ dispatch: mockDispatch });
		const result = await tool.run({ task: "fail work", agent_id: "coder" });

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
					runIds: ["run-1", "run-2"],
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
					finalPromise: Promise.resolve([runReceipt("run-1", "task 1"), runReceipt("run-2", "task 2")]),
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
			drain: async () => {},
		};

		const tool = createDispatchTool({ dispatch: mockDispatch });
		const result = await tool.run({
			tasks: [
				{ task: "task 1", agent_id: "coder" },
				{ task: "task 2", agent_id: "coder" },
			],
		});

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
			dispatch: fakeSequentialDispatch(
				[
					{ runId: "run-1", assistantText: "first worker answer" },
					{ runId: "run-2", assistantText: "second worker answer" },
					{ runId: "run-3", assistantText: "third worker answer" },
				],
				capturedRequests,
			),
		});

		const result = await tool.run({
			mode: "pipeline",
			tasks: [
				{ task: "step 1", agent_id: "coder" },
				{ task: "step 2", agent_id: "coder" },
				{ task: "step 3", agent_id: "coder" },
			],
		});

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
			dispatch: fakeSequentialDispatch(
				[
					{ runId: "run-1", assistantText: "first specialist answer" },
					{ runId: "run-2", assistantText: "second specialist answer" },
				],
				capturedRequests,
			),
		});

		const result = await tool.run({
			mode: "pipeline",
			tasks: [
				{
					task: "summarize interface",
					agent_id: "coder",
					persona: "# Interface Specialist\nSummarize the public contract.",
					tool_profile: "minimal-local",
				},
				{
					task: "check implications",
					agent_id: "coder",
					persona: "# Risk Specialist\nIdentify integration risks.",
					tool_profile: "science-local",
				},
			],
		});

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

		const result = await tool.run({
			mode: "pipeline",
			tasks: [
				{ task: "step 1", agent_id: "coder" },
				{ task: "step 2", agent_id: "coder" },
				{ task: "step 3", agent_id: "coder" },
			],
		});

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
						runIds?: unknown;
						receiptCount?: unknown;
						failedCount?: unknown;
						runs?: Array<{ runId?: unknown; exitCode?: unknown; receiptPath?: unknown }>;
				  }
				| undefined;
			strictEqual(details?.mode, "pipeline");
			deepStrictEqual(details?.runIds, ["run-1", "run-2"]);
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
						},
					},
				],
				capturedRequests,
			),
		});

		const result = await tool.run({
			mode: "pipeline",
			tasks: [
				{ task: "step 1", agent_id: "coder" },
				{ task: "step 2", agent_id: "coder" },
			],
		});

		strictEqual(result.kind, "ok");
		if (result.kind === "ok") {
			ok(result.output.includes("pipeline=step2 from=run-1 in=32b truncated"), result.output);
			ok(result.output.includes("persona=1b3fc16b2c4d..."), result.output);
			ok(result.output.includes("escalations=2req/0appr/1deny/1timeout"), result.output);
			const details = result.details as {
				runs?: Array<{
					runId?: unknown;
					pipeline?: unknown;
					personaOverride?: unknown;
					escalation?: unknown;
				}>;
			};
			// Plain first step carries no provenance keys.
			strictEqual(details.runs?.[0]?.runId, "run-1");
			ok(!("pipeline" in (details.runs?.[0] ?? {})), "plain step must omit pipeline");
			ok(!("personaOverride" in (details.runs?.[0] ?? {})), "plain step must omit personaOverride");
			ok(!("escalation" in (details.runs?.[0] ?? {})), "plain step must omit escalation");
			// Provenance-bearing second step carries the additive keys.
			deepStrictEqual(details.runs?.[1]?.pipeline, {
				fromRunId: "run-1",
				position: 2,
				inputBytes: 32,
				inputTruncated: true,
			});
			deepStrictEqual(details.runs?.[1]?.personaOverride, { promptHash: "1b3fc16b2c4d5e6f7a8b9c0d1e2f3a4b" });
			deepStrictEqual(details.runs?.[1]?.escalation, { requested: 2, approved: 0, denied: 1, timedOut: 1 });
		}
	});

	it("invalid dispatch mode error names all supported modes", async () => {
		const tool = createDispatchTool({ dispatch: {} as DispatchContract });
		const result = await tool.run({ mode: "serial", tasks: [{ task: "do work", agent_id: "coder" }] });

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
			dispatch: fakeSequentialDispatch([{ runId: "run-1", assistantText: "single worker answer" }], capturedRequests),
		});

		const result = await tool.run({
			mode: "pipeline",
			tasks: [{ task: "single step", agent_id: "coder" }],
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

describe("contracts/tools prompt hints", () => {
	it("carries promptHint metadata on exactly the four hinted tools, verbatim", () => {
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

		deepStrictEqual([...hinted.keys()].sort(), ["ask_user", "code_nav", "context", "dispatch"]);
		strictEqual(
			hinted.get("code_nav"),
			"Use code_nav for indexed code navigation (modes: symbol, path, entries, outline, deps, dependents).",
		);
		strictEqual(
			hinted.get("context"),
			'Call context with scope="skills" to list available skills. When the user message carries a skill request, first load that skill via context (scope="skills", name=<skill>) before doing anything else.',
		);
		strictEqual(hinted.get("dispatch"), "Call dispatch with list:true to see the agent fleet.");
		strictEqual(
			hinted.get("ask_user"),
			'Use ask_user for operator interviews, confirmations, and choices: one question per round in interview workflows, up to four tightly related questions otherwise, recommended option first. Finish with action="complete" and a compact decisions array before final prose. If cancelled, continue with defaults and do not ask again.',
		);
	});
});
