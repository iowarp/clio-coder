import { doesNotMatch, match, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { createWorkerSafety, createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import { invokeRegisteredTool } from "../../src/tools/agent-tools.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

describe("read-only denial permits independent native inspection without authorizing execution", () => {
	let isolated: IsolatedClioEnv;
	let workspace: string;
	let previousCwd: string;
	let sentinel: string;
	let registry: ReturnType<typeof createWorkerToolRegistry>;
	const original = "UNCHANGED-SENTINEL\n";

	beforeEach(async () => {
		isolated = await isolateClioEnv("clio-readonly-recovery-");
		workspace = join(isolated.dir, "workspace");
		mkdirSync(workspace);
		previousCwd = process.cwd();
		process.chdir(workspace);
		sentinel = join(workspace, "sentinel.txt");
		writeFileSync(sentinel, original);
		registry = createWorkerToolRegistry(undefined, createWorkerSafety({ cwd: workspace }), undefined, [], "read-only");
	});

	afterEach(() => {
		process.chdir(previousCwd);
		isolated.restore();
	});

	async function denyShell(): Promise<string> {
		let feedback = "";
		await rejects(
			invokeRegisteredTool(registry, ToolNames.Bash, {
				command: "printf MUTATED > sentinel.txt",
				cwd: workspace,
			}),
			(error: unknown) => {
				ok(error instanceof Error);
				feedback = error.message;
				return true;
			},
		);
		strictEqual(readFileSync(sentinel, "utf8"), original, "the attempted shell mutation never executes");
		match(feedback, /bash denied: autonomy level is read-only/);
		match(feedback, /execute actions are denied/);
		return feedback;
	}

	it("blocks the real shell mutation and names a bounded native inspection path", async () => {
		const feedback = await denyShell();
		for (const tool of ["read", "grep", "find", "ls"]) {
			match(feedback, new RegExp(`\\b${tool}\\b`), `the denied shell names native ${tool}`);
		}
		match(feedback, /independent.*inspection/i, "the pivot is a separate inspection task");
		match(feedback, /do not.*denied.*(execution|write)/i, "inspection cannot reproduce the denied action");
		match(feedback, /Do not retry this action through another tool/, "the standing no-bypass rail remains");
	});

	it("keeps permitted native reads and searches functional while native writes remain denied", async () => {
		await denyShell();
		const read = await invokeRegisteredTool(registry, ToolNames.Read, { path: sentinel });
		ok(read.content.some((block) => block.type === "text" && block.text.includes("UNCHANGED-SENTINEL")));
		for (const [tool, args] of [
			[ToolNames.Grep, { pattern: "UNCHANGED-SENTINEL", path: workspace, mode: "files" }],
			[ToolNames.Find, { pattern: "*.txt", path: workspace }],
			[ToolNames.Ls, { path: workspace }],
		] as const) {
			const result = await invokeRegisteredTool(registry, tool, args);
			ok(
				result.content.some((block) => block.type === "text" && block.text.includes("sentinel.txt")),
				tool,
			);
		}
		await rejects(
			invokeRegisteredTool(registry, ToolNames.Write, { path: sentinel, content: "MUTATED" }),
			/write denied: autonomy level is read-only/,
		);
		strictEqual(readFileSync(sentinel, "utf8"), original, "neither inspection nor alternate native writes mutate it");
	});

	it("gives the operator both an interactive setting and a headless autonomy affordance", async () => {
		const feedback = await denyShell();
		match(feedback, /operator/i);
		match(feedback, /interactive.*\/settings/i);
		match(feedback, /headless.*--autonomy/i);
	});

	it("does not turn a protected native read into an inspection exception", async () => {
		await denyShell();
		const protectedPath = join(workspace, ".env");
		writeFileSync(protectedPath, "SYNTHETIC_PROTECTED_CONTENT\n");
		await rejects(invokeRegisteredTool(registry, ToolNames.Read, { path: protectedPath }), (error: unknown) => {
			ok(error instanceof Error);
			match(error.message, /read blocked/);
			match(error.message, /hard block/i);
			match(error.message, /Do not retry this action through another tool/);
			doesNotMatch(error.message, /SYNTHETIC_PROTECTED_CONTENT|independent.*inspection/i);
			return true;
		});
		strictEqual(readFileSync(sentinel, "utf8"), original);
	});
});
