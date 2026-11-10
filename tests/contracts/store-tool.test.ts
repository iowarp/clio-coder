import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { storeProjectDir, storeWriteTarget } from "../../src/core/store-paths.js";
import { withStoreLock } from "../../src/domains/store/index.js";
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

	it("records exactly the stored bytes when puts to one blob race", () =>
		withWorkspace(async (root) => {
			const tool = createStoreTool({ getCwd: () => root, writable: true });
			body(await tool.run({ op: "create", tag: "results" }));
			const files = Array.from({ length: 6 }, (_, i) => {
				mkdirSync(join(root, `w${i}`));
				writeFileSync(join(root, `w${i}`, "x.bin"), `writer ${i} `.repeat(4096 * (i + 1)));
				return `w${i}/x.bin`;
			});
			await Promise.all(files.map((file) => tool.run({ op: "put", tag: "results", path: file })));
			const stat = body(await tool.run({ op: "stat", ref: "results:x.bin" }));
			const live = readFileSync(String(body(await tool.run({ op: "get", ref: "results:x.bin" })).path));
			strictEqual(stat.drift, "none");
			strictEqual((stat.identity as { sha256: string }).sha256, createHash("sha256").update(live).digest("hex"));
		}));

	it("reports drift when bytes change under the same size and mtime", () =>
		withWorkspace(async (root) => {
			const tool = createStoreTool({ getCwd: () => root, writable: true });
			body(await tool.run({ op: "create", tag: "results" }));
			body(await tool.run({ op: "put", tag: "results", path: "out/summary.csv" }));
			const live = String(body(await tool.run({ op: "get", ref: "results:summary.csv" })).path);
			// touch -r copies the full-precision mtime, as a copy tool that preserves timestamps would.
			const stamp = join(root, "stamp");
			execFileSync("touch", ["-r", live, stamp]);
			writeFileSync(live, "x,y\n3,4\n");
			execFileSync("touch", ["-r", stamp, live]);
			strictEqual(body(await tool.run({ op: "stat", ref: "results:summary.csv" })).drift, "changed");
		}));

	it("refuses an unknown tag class", () =>
		withWorkspace(async (root) => {
			const tool = createStoreTool({ getCwd: () => root, writable: true });
			const result = await tool.run({ op: "create", tag: "results", class: "scratch" });
			strictEqual(result.kind, "error");
			match(String(result.message), /class must be one of/);
		}));

	it("keeps a comma inside a blob name in a derived_from string", () => {
		deepStrictEqual(prepareStoreArguments({ op: "put", derived_from: "sim:a,b.csv, sim:c" }).derived_from, [
			"sim:a,b.csv",
			"sim:c",
		]);
	});

	it("breaks a store lock whose holder died", () =>
		withWorkspace(async (root) => {
			const dead = spawnSync(process.execPath, ["-e", ""]).pid;
			const key = "blob\0results\0x.bin";
			const digest = createHash("sha256").update(key).digest("hex").slice(0, 32);
			const file = join(storeProjectDir(root), "locks", `${digest}.lock`);
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, JSON.stringify({ pid: dead, host: hostname(), token: "old", at: Date.now() }));
			strictEqual(await withStoreLock(root, key, async () => "ran"), "ran");
			strictEqual(existsSync(file), false);
		}));
});
