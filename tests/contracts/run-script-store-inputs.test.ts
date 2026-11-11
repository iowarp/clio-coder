import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { RunManifest } from "../../src/core/run-records.js";
import { openStoreBackend } from "../../src/domains/store/index.js";
import { currentState, readBlobHistory } from "../../src/domains/store/records.js";
import type { ToolResult } from "../../src/tools/registry.js";
import { createRunScriptTool } from "../../src/tools/run-script.js";
import { createStoreTool } from "../../src/tools/store/store-tool.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const BLOB_BYTES = "HDF\nrun042\n";
const BLOB_SHA = createHash("sha256").update(BLOB_BYTES).digest("hex");
const SUMMARIZE = `const fs = require("node:fs");
const data = fs.readFileSync(process.argv[2], "utf8");
fs.mkdirSync("results", { recursive: true });
fs.writeFileSync("results/summary.txt", "lines=" + data.split("\\n").length + "\\n");
`;

interface Fixture {
	root: string;
	outside: string;
	getPath: string;
}

async function withSimTag(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
	const env = await isolateClioEnv("clio-coder-run-script-store-");
	try {
		const root = join(env.dir, "workspace");
		mkdirSync(root);
		const outside = join(env.dir, "run042.h5");
		writeFileSync(outside, BLOB_BYTES);
		const backend = await openStoreBackend(root);
		await backend.getOrCreateTag("sim");
		await backend.putBlobFromFile("sim", "run042.h5", outside);
		await backend.getOrCreateTag("summary");
		writeFileSync(join(root, "summarize.js"), SUMMARIZE);
		const { path: getPath } = await backend.getBlobAsPath("sim", "run042.h5");
		await fn({ root: realpathSync(root), outside, getPath });
	} finally {
		env.restore();
	}
}

function manifestOf(result: ToolResult): RunManifest {
	const details = result.details as { manifestPath?: string } | undefined;
	ok(typeof details?.manifestPath === "string", JSON.stringify(result));
	return JSON.parse(readFileSync(details.manifestPath, "utf8")) as RunManifest;
}

describe("run_script store inputs", () => {
	for (const form of ["tag:blob", "get path"] as const) {
		it(`reads a store blob given as its ${form} and names it in a later put's record`, () =>
			withSimTag(async ({ root, getPath }) => {
				const input = form === "tag:blob" ? "sim:run042.h5" : getPath;
				const run = await createRunScriptTool({ getWorkspaceRoot: () => root }).run({
					interpreter: "node",
					script: "summarize.js",
					args: [input],
					inputs: [input],
					outputs: ["results/summary.txt"],
				});
				strictEqual(run.kind, "ok", run.kind === "error" ? run.message : "");
				const [recorded] = manifestOf(run).inputs;
				deepStrictEqual(recorded?.store, { tag: "sim", blob: "run042.h5" });
				strictEqual(recorded?.sha256, BLOB_SHA);
				deepStrictEqual(readdirSync(root).sort(), [".clio-coder", "results", "summarize.js"]);

				const store = createStoreTool({ getCwd: () => root, writable: true });
				const put = await store.run({ op: "put", tag: "summary", path: "results/summary.txt" });
				strictEqual(put.kind, "ok", put.kind === "error" ? put.message : "");
				const backend = await openStoreBackend(root);
				const record = currentState((await readBlobHistory(backend, "summary", "summary.txt")).records).put;
				deepStrictEqual(record?.used, [{ tag: "sim", blob: "run042.h5", bytes: BLOB_BYTES.length, sha256: BLOB_SHA }]);
			}));
	}

	it("still refuses an absolute input outside the store, and a blob the store does not hold", () =>
		withSimTag(async ({ root, outside }) => {
			const tool = createRunScriptTool({ getWorkspaceRoot: () => root });
			const cases: Array<[string, RegExp]> = [
				[outside, /inputs\[0\] must be workspace-relative or a store blob; absolute path .* is not allowed/u],
				["sim:missing.h5", /inputs\[0\] names sim:missing\.h5, which is not in the store/u],
			];
			for (const [input, expected] of cases) {
				const result = await tool.run({ interpreter: "node", script: "summarize.js", args: [input], inputs: [input] });
				strictEqual(result.kind, "error", input);
				if (result.kind === "error") match(result.message, expected);
			}
		}));
});
