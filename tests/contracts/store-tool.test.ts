import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { storeWriteTarget } from "../../src/core/store-paths.js";
import { createStoreTool } from "../../src/tools/store/store-tool.js";
import { prepareStoreAdmissionArguments, prepareStoreArguments } from "../../src/tools/store/surface.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

async function withWorkspace(fn: (root: string) => Promise<void>): Promise<void> {
	const env = await isolateClioEnv("clio-coder-store-tool-");
	try {
		const root = join(env.dir, "workspace");
		mkdirSync(join(root, "out"), { recursive: true });
		writeFileSync(join(root, "out", "summary.csv"), "a,b\n1,2\n");
		await fn(root);
	} finally {
		env.restore();
	}
}

function body(result: { kind: string; output?: unknown; message?: unknown }): Record<string, unknown> {
	strictEqual(result.kind, "ok", String(result.message ?? ""));
	return JSON.parse(String(result.output).split("\n")[0] ?? "{}") as Record<string, unknown>;
}

describe("store tool", () => {
	it("normalizes path aliases, ref, numeric strings, and derived_from", () => {
		const out = prepareStoreArguments({
			op: "put",
			ref: "sim:run.h5",
			file_path: "out/run.h5",
			offset: "5",
			derived_from: "sim:a, sim:b",
		});
		deepStrictEqual(
			[out.tag, out.blob, out.path, out.offset, out.derived_from],
			["sim", "run.h5", "out/run.h5", 5, ["sim:a", "sim:b"]],
		);
	});

	it("runs put, list, stat, get, note, remove on the local backend", () =>
		withWorkspace(async (root) => {
			const tool = createStoreTool({ getCwd: () => root, writable: true });
			body(await tool.run({ op: "create", tag: "results", description: "run outputs" }));
			strictEqual(body(await tool.run({ op: "put", tag: "results", path: "out/summary.csv" })).drift, "none");
			const listed = body(await tool.run({ op: "list", tag: "results" }));
			deepStrictEqual(listed.blobs, [{ blob: "summary.csv", bytes: 8, recorded: true }]);
			strictEqual(body(await tool.run({ op: "stat", ref: "results:summary.csv" })).bytes, 8);
			match(String(body(await tool.run({ op: "get", ref: "results:summary.csv" })).path), /summary\.csv$/);
			body(await tool.run({ op: "note", ref: "results:summary.csv", note: "checked" }));
			strictEqual(body(await tool.run({ op: "remove", ref: "results:summary.csv" })).removed, true);
			strictEqual((await tool.run({ op: "stat", ref: "results:summary.csv" })).kind, "error");
		}));

	it("refuses the four write ops in a read-only session", () =>
		withWorkspace(async (root) => {
			const tool = createStoreTool({ getCwd: () => root, writable: false });
			for (const op of ["create", "put", "note", "remove"]) {
				const result = await tool.run({ op, tag: "results", blob: "summary.csv", path: "out/summary.csv", note: "x" });
				strictEqual(result.kind, "error");
				match(String(result.message), /can read the store but not write/);
			}
			strictEqual((await tool.run({ op: "tags" })).kind, "ok");
		}));
	it("stores a put under the name admission predicted when a link changes after admission", () =>
		withWorkspace(async (root) => {
			writeFileSync(join(root, "out", "b.dat"), "bytes\n");
			writeFileSync(join(root, "out", "c.bin"), "other\n");
			symlinkSync("b.dat", join(root, "out", "a.txt"));
			const tool = createStoreTool({ getCwd: () => root, writable: true });
			body(await tool.run({ op: "create", tag: "results" }));
			const admitted = prepareStoreAdmissionArguments({ op: "put", tag: "results", path: "out/a.txt" }, root);
			const predicted = basename(String(storeWriteTarget(root, admitted)));
			// The admitted file becomes a link to another workspace file before the tool runs.
			rmSync(join(root, "out", "b.dat"));
			symlinkSync("c.bin", join(root, "out", "b.dat"));
			body(await tool.run(admitted));
			deepStrictEqual(
				(body(await tool.run({ op: "list", tag: "results" })).blobs as Array<{ blob: string }>).map((b) => b.blob),
				[predicted],
			);
		}));
});
