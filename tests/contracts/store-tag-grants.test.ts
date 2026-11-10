import { match, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { storeGrantBoundaries, storeProjectDir } from "../../src/core/store-paths.js";
import { writeRootsOverlap } from "../../src/domains/dispatch/parallel-writers.js";
import { isSubset, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import { createStoreTool } from "../../src/tools/store/store-tool.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

async function withWorkspace(fn: (root: string) => Promise<void>): Promise<void> {
	const env = await isolateClioEnv("clio-coder-store-grants-");
	try {
		const root = join(env.dir, "workspace");
		mkdirSync(join(root, "out"), { recursive: true });
		writeFileSync(join(root, "out", "summary.csv"), "a,b\n1,2\n");
		await fn(root);
	} finally {
		env.restore();
	}
}

describe("store tag grants", () => {
	it("a worker scope holding granted tag directories stays a subset of the workspace scope", () =>
		withWorkspace(async (root) => {
			const previous = process.cwd();
			process.chdir(root);
			try {
				const worker = {
					...WORKSPACE_SCOPE,
					allowedWriteRoots: [`${join(root, "out")}/`, ...storeGrantBoundaries(root, ["results"])],
				};
				strictEqual(isSubset(worker, WORKSPACE_SCOPE), true);
				strictEqual(storeGrantBoundaries(root, ["results"])[0]?.startsWith(storeProjectDir(root)), true);
			} finally {
				process.chdir(previous);
			}
		}));

	it("puts into a granted tag as the worker and refuses an ungranted tag", () =>
		withWorkspace(async (root) => {
			await createStoreTool({ getCwd: () => root, writable: true }).run({ op: "create", tag: "results" });
			await createStoreTool({ getCwd: () => root, writable: true }).run({ op: "create", tag: "other" });
			const tool = createStoreTool({
				getCwd: () => root,
				writable: false,
				grant: { tags: ["results"], dispatchRunId: "run-1" },
			});
			strictEqual((await tool.run({ op: "put", tag: "results", path: "out/summary.csv" })).kind, "ok");
			const refused = await tool.run({ op: "put", tag: "other", path: "out/summary.csv" });
			strictEqual(refused.kind, "error");
			match(String((refused as { message?: unknown }).message), /no grant for tag 'other'/);
			const created = await tool.run({ op: "create", tag: "fresh" });
			strictEqual(created.kind, "error");
			match(String((created as { message?: unknown }).message), /can read the store but not write/);
		}));

	it("parallel writers granted the same tag do not overlap", () =>
		withWorkspace(async (root) => {
			const store = storeGrantBoundaries(root, ["results"]);
			strictEqual(writeRootsOverlap([`${join(root, "a")}/`, ...store], [`${join(root, "b")}/`, ...store]), false);
			strictEqual(writeRootsOverlap([`${join(root, "a")}/`], [`${join(root, "a", "x")}/`]), true);
		}));
});
