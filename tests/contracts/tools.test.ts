import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { Type } from "typebox";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import type { DispatchContract, DispatchRequest } from "../../src/domains/dispatch/contract.js";
import type { RunEnvelope, RunReceipt } from "../../src/domains/dispatch/types.js";
import { bashTool } from "../../src/tools/bash.js";
import { createDispatchBatchTool, createDispatchTool } from "../../src/tools/dispatch.js";
import { editTool } from "../../src/tools/edit.js";
import { findTool } from "../../src/tools/find.js";
import { globTool } from "../../src/tools/glob.js";
import { grepTool } from "../../src/tools/grep.js";
import { lsTool } from "../../src/tools/ls.js";
import { resolveToolPalette } from "../../src/tools/palette.js";
import { readTool } from "../../src/tools/read.js";
import type { ToolSpec } from "../../src/tools/registry.js";
import { shapeToolResult } from "../../src/tools/result-shaping.js";
import { writeTool } from "../../src/tools/write.js";

const scratchRoots: string[] = [];

function scratchDir(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-tools-basic-"));
	scratchRoots.push(root);
	return root;
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

function resultSize(value: unknown): { truncated?: boolean } | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = (value as Record<string, unknown>).resultSize;
	if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
	const truncated = (candidate as Record<string, unknown>).truncated;
	return typeof truncated === "boolean" ? { truncated } : {};
}

function runReceipt(runId: string, task: string): RunReceipt {
	return {
		runId,
		agentId: "coder",
		task,
		endpointId: "e",
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
	};
}

function runEnvelope(runId: string): RunEnvelope {
	return {
		id: runId,
		agentId: "coder",
		task: "do work",
		endpointId: "e",
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

	it("findTool locates files by glob relative to search root", async () => {
		const root = scratchDir();
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src", "index.ts"), "export const x = 1;\n", "utf8");
		writeFileSync(join(root, "README.md"), "# sample\n", "utf8");

		const result = await findTool.run({ pattern: "**/*.ts", path: root });
		strictEqual(result.kind, "ok");
		ok(result.output.includes("src/index.ts"));
	});

	it("globTool filters files by pattern", async () => {
		const root = scratchDir();
		writeFileSync(join(root, "note.md"), "# sample\n", "utf8");

		const result = await globTool.run({ pattern: "*.md", path: root });
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

describe("contracts/tools palette", () => {
	it("keeps create_skill hidden for install/update skill requests", () => {
		const install = resolveToolPalette({
			mode: "default",
			providerSupportsTools: true,
			userText: "install a local skill folder for this project",
		});
		ok(install.activeTools.includes(ToolNames.ReadSkill));
		strictEqual(install.activeTools.includes(ToolNames.CreateSkill), false);

		const update = resolveToolPalette({
			mode: "default",
			providerSupportsTools: true,
			userText: "update the skill catalog and tell me what exists",
		});
		ok(update.activeTools.includes(ToolNames.ReadSkill));
		strictEqual(update.activeTools.includes(ToolNames.CreateSkill), false);
	});

	it("exposes create_skill only for authoring intent", () => {
		const palette = resolveToolPalette({
			mode: "default",
			providerSupportsTools: true,
			userText: "create a skill for reviewing MPI tests",
		});
		ok(palette.activeTools.includes(ToolNames.ReadSkill));
		ok(palette.activeTools.includes(ToolNames.CreateSkill));
	});

	it("keeps bash out unless shell intent is explicit", () => {
		const palette = resolveToolPalette({
			mode: "default",
			providerSupportsTools: true,
			userText: "fix the TypeScript test failure",
		});
		strictEqual(palette.activeTools.includes(ToolNames.Bash), false);

		const shell = resolveToolPalette({
			mode: "default",
			providerSupportsTools: true,
			userText: "run this bash command after inspecting the repo",
		});
		ok(shell.activeTools.includes(ToolNames.Bash));
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
});

describe("contracts/tools dispatch run paths", () => {
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
			drain: async () => {},
		};

		const tool = createDispatchTool({ dispatch: mockDispatch });
		const result = await tool.run({ task: "do work", agent_id: "coder" });

		strictEqual(result.kind, "ok");
		if (result.kind === "ok") {
			ok(result.output.includes("dispatch run run-123 completed"));
			strictEqual(result.details?.runId, "run-123");
		}
	});

	it("createDispatchBatchTool triggers batch dispatch contract", async () => {
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
			drain: async () => {},
		};

		const tool = createDispatchBatchTool({ dispatch: mockDispatch });
		const result = await tool.run({
			tasks: [
				{ task: "task 1", agent_id: "coder" },
				{ task: "task 2", agent_id: "coder" },
			],
		});

		strictEqual(result.kind, "ok");
		if (result.kind === "ok") {
			ok(result.output.includes("completed"));
			ok(result.output.includes("total=2"));
			ok(result.output.includes("receipt=/tmp/run-1.json"));
			ok(result.output.includes("first scout finding"));
			ok(result.output.includes("second scout finding"));
		}
	});
});
