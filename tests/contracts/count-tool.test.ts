import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import { createWorkerSafety, createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import { resolveAgentTools } from "../../src/tools/agent-tools.js";
import type { ToolRegistry, ToolResult } from "../../src/tools/registry.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/**
 * count gives a delegated worker without bash its file's length (WTF-P 0.8.3
 * B3). Workspace scope lives in read-scope.test.ts.
 */
describe("count tool (WTF-P 0.8.3 B3)", () => {
	let scratch: IsolatedClioEnv;
	let registry: ToolRegistry;
	let root: string;
	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-count-tool-");
		root = join(scratch.dir, "paper");
		mkdirSync(join(root, "sections"), { recursive: true });
		registry = createWorkerToolRegistry(undefined, createWorkerSafety({ cwd: scratch.dir }));
	});
	afterEach(() => scratch.restore());

	async function count(path: string): Promise<ToolResult> {
		const verdict = await registry.invoke({ tool: ToolNames.Count, args: { path } });
		if (verdict.kind !== "ok") throw new Error(`count was not admitted: ${JSON.stringify(verdict)}`);
		return verdict.result;
	}

	it("counts words as wc -w does and a last line without a newline", async () => {
		const file = join(root, "sections", "intro.tex");
		writeFileSync(file, "Admission  control\tgates\n\nevery  worker run.");
		const result = await count(file);
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		deepStrictEqual(
			[result.details?.words, result.details?.lines, result.details?.bytes],
			[6, 3, Buffer.byteLength("Admission  control\tgates\n\nevery  worker run.")],
		);
		strictEqual(result.output, `${file}: 6 words, 3 lines, 44 bytes`);
	});

	it("refuses a directory", async () => {
		const result = await count(root);
		strictEqual(result.kind, "error");
	});

	it("is attached on a surface without bash and sits behind the gateway beside bash", () => {
		const names = (allowedTools: ToolName[]) =>
			resolveAgentTools({ registry: createWorkerToolRegistry(), allowedTools }).map((tool) => tool.name);
		deepStrictEqual(names([ToolNames.Read, ToolNames.Write, ToolNames.Count]), [
			ToolNames.Count,
			ToolNames.Read,
			ToolNames.Write,
		]);
		deepStrictEqual(names([ToolNames.Bash, ToolNames.Read, ToolNames.Count, ToolNames.Gateway]), [
			ToolNames.Bash,
			ToolNames.Gateway,
			ToolNames.Read,
		]);
	});
});
