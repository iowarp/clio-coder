import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { createWorkerSafety, createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import type { ToolInvokeOptions, ToolRegistry, ToolResult } from "../../src/tools/registry.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/**
 * ls through a worker registry over a real directory tree: ordering, the
 * continuation a bounded listing hands back, and the refusals a model sees
 * for a path that is not a listable directory. Symlink rendering, unreadable
 * entries, and wide-directory selection live in search-completeness.test.ts;
 * workspace scope lives in read-scope.test.ts.
 */

describe("ls tool", () => {
	let scratch: IsolatedClioEnv;
	let registry: ToolRegistry;
	let root: string;
	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-ls-tool-");
		root = join(scratch.dir, "tree");
		mkdirSync(join(root, "sub"), { recursive: true });
		mkdirSync(join(root, "empty"));
		for (const name of [".hidden", "b.txt", "A.md", "c"]) writeFileSync(join(root, name), name);
		registry = createWorkerToolRegistry(undefined, createWorkerSafety({ cwd: scratch.dir }));
	});
	afterEach(() => scratch.restore());

	async function call(args: Record<string, unknown>, options?: ToolInvokeOptions): Promise<ToolResult> {
		const verdict = await registry.invoke({ tool: ToolNames.Ls, args }, options);
		if (verdict.kind !== "ok") throw new Error(`ls was not admitted: ${JSON.stringify(verdict)}`);
		return verdict.result;
	}

	function ok(result: ToolResult): Extract<ToolResult, { kind: "ok" }> {
		if (result.kind !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
		return result;
	}

	it("lists dotfiles and marks directories in case-insensitive order", async () => {
		const listed = ok(await call({ path: root }));
		strictEqual(listed.output, ".hidden\nA.md\nb.txt\nc\nempty/\nsub/");
		deepStrictEqual(listed.details?.selection, { scanned: 6, retained: 6 });
		strictEqual((listed.details?.observation as { truncated: boolean }).truncated, false);
	});

	it("hands back a doubled limit until the listing is complete", async () => {
		const first = ok(await call({ path: root, limit: 2 }));
		strictEqual(first.output, ".hidden\nA.md\n\n[ls: 2/6 entries shown (12B of 12B) | next: limit=4]");
		const observation = first.details?.observation as { shownCount: number; totalCount: number; next: string };
		deepStrictEqual([observation.shownCount, observation.totalCount, observation.next], [2, 6, "limit=4"]);
		const second = ok(await call({ path: root, limit: 4 }));
		match(second.output, /^\.hidden\nA\.md\nb\.txt\nc\n\n\[ls: 4\/6 entries shown .*\| next: limit=8\]$/);
		const complete = ok(await call({ path: root, limit: 8 }));
		strictEqual(complete.output, ".hidden\nA.md\nb.txt\nc\nempty/\nsub/");
		strictEqual((complete.details?.observation as { next?: string }).next, undefined);
		// A limit the tool cannot use falls back to the default rather than listing nothing.
		strictEqual(ok(await call({ path: root, limit: 0 })).output, complete.output);
	});

	it("lists the working directory when no path is given and says when a directory is empty", async (t) => {
		const previous = process.cwd();
		process.chdir(root);
		t.after(() => process.chdir(previous));
		strictEqual(ok(await call({})).output, ".hidden\nA.md\nb.txt\nc\nempty/\nsub/");
		const empty = ok(await call({ path: "empty" }));
		strictEqual(empty.output, "(empty directory)");
		deepStrictEqual(empty.details?.selection, { scanned: 0, retained: 0 });
	});

	it("refuses a file, a missing path, and a cancelled listing with the reason", async () => {
		const file = await call({ path: join(root, "b.txt") });
		strictEqual(file.kind, "error");
		if (file.kind === "error") strictEqual(file.message, `ls: not a directory: ${join(root, "b.txt")}`);
		const missing = await call({ path: join(root, "missing") });
		strictEqual(missing.kind, "error");
		if (missing.kind === "error") match(missing.message, /^ls: ENOENT: no such file or directory/);
		const controller = new AbortController();
		controller.abort();
		const aborted = await call({ path: root }, { signal: controller.signal });
		strictEqual(aborted.kind, "error");
		if (aborted.kind === "error") strictEqual(aborted.message, "ls: operation aborted during enumeration");
	});
});
