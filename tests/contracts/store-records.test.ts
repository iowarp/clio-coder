import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { runRecordsDir } from "../../src/core/run-records.js";
import { recordsTag, storeProjectKey, storeProjectRoot, storeTagDir } from "../../src/core/store-paths.js";
import type { StoreBackend } from "../../src/domains/store/backend.js";
import { createClioCoreStoreBackend } from "../../src/domains/store/backends/clio-core.js";
import type { CoreHost } from "../../src/domains/store/core-host/supervisor.js";
import { openStoreBackend } from "../../src/domains/store/index.js";
import { buildPutRecord, findProducingRun } from "../../src/domains/store/provenance.js";
import {
	appendRecord,
	currentState,
	driftOf,
	readBlobHistory,
	type StoreRecord,
	summarizeRecords,
} from "../../src/domains/store/records.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

async function withBackend(fn: (backend: StoreBackend, root: string) => Promise<void>): Promise<void> {
	const env = await isolateClioEnv("clio-coder-store-records-");
	try {
		const root = join(env.dir, "workspace");
		mkdirSync(root, { recursive: true });
		await fn(await openStoreBackend(root), root);
	} finally {
		env.restore();
	}
}

const by = { actor: "main" as const };

describe("store records", () => {
	it("gives twenty concurrent appends for one blob seq 1 to 20 with no gap or duplicate", () =>
		withBackend(async (backend) => {
			const written = await Promise.all(
				Array.from({ length: 20 }, () =>
					appendRecord(backend, { kind: "note", tag: "sim", blob: "a.dat", producedBy: by }),
				),
			);
			deepStrictEqual(
				written.map((record) => record.seq).sort((a, b) => a - b),
				Array.from({ length: 20 }, (_, index) => index + 1),
			);
			deepStrictEqual((await summarizeRecords(backend, "sim", ["a.dat", "b.dat"])).get("a.dat"), {
				recorded: true,
				lastSeq: 20,
			});
		}));

	it("folds history into the current put, its notes and removal", () =>
		withBackend(async (backend) => {
			const identity = { bytes: 1, modifiedMs: 1, sha256: null };
			await appendRecord(backend, { kind: "put", tag: "sim", blob: "x", identity, producedBy: by });
			await appendRecord(backend, { kind: "note", tag: "sim", blob: "x", note: "first", producedBy: by });
			const second = await appendRecord(backend, { kind: "put", tag: "sim", blob: "x", identity, producedBy: by });
			const state = currentState((await readBlobHistory(backend, "sim", "x")).records);
			strictEqual(state.put?.seq, second.seq);
			deepStrictEqual(state.notes, []);
			await appendRecord(backend, { kind: "remove", tag: "sim", blob: "x", identity, producedBy: by });
			const removed = currentState((await readBlobHistory(backend, "sim", "x")).records);
			ok(removed.removed);
			strictEqual(removed.put, null);
		}));

	it("copies the producing run into the put record and matches no run after an edit", () =>
		withBackend(async (backend, root) => {
			writeFileSync(join(root, "in.csv"), "1,2\n");
			writeFileSync(join(root, "out.csv"), "3\n");
			const sha = (text: string) => createHash("sha256").update(text).digest("hex");
			const out = statSync(join(root, "out.csv"));
			const runId = "20261109T220000Z-abcdef";
			const runDir = join(runRecordsDir(root), runId);
			mkdirSync(runDir, { recursive: true });
			const manifest = JSON.stringify({
				version: 1,
				runId,
				tool: "run_script",
				finishedAt: "2026-11-09T22:00:01.000Z",
				script: { path: "sum.py", sha256: sha("script") },
				argv: ["/usr/bin/python3", "sum.py", "--token", "s3cr3t-value"],
				outcome: "succeeded",
				inputs: [{ path: "in.csv", exists: true, bytes: 4, sha256: sha("1,2\n") }],
				outputs: [{ path: "out.csv", exists: true, status: "created", bytes: 2, mtimeMs: out.mtimeMs, sha256: sha("3\n") }],
			});
			writeFileSync(join(runDir, "run.json"), manifest);
			const body = await buildPutRecord({
				backend,
				cwd: root,
				tag: "sim",
				blob: "out.csv",
				sourceAbs: join(root, "out.csv"),
				stat: { bytes: 2, modifiedMs: 5, version: null },
				hash: { sha256: sha("3\n") },
				receipt: { backend: "local", key: "/store/out.csv", version: null },
				actor: "main",
			});
			await appendRecord(backend, body);
			rmSync(runDir, { recursive: true });
			const { put } = currentState((await readBlobHistory(backend, "sim", "out.csv")).records);
			strictEqual(put?.generatedBy?.script.path, "sum.py");
			strictEqual(put?.generatedBy?.matchedBy, "sha256");
			ok(!put?.generatedBy?.argv.join(" ").includes("s3cr3t-value"));
			deepStrictEqual(put?.used, [{ path: "in.csv", bytes: 4, sha256: sha("1,2\n") }]);

			mkdirSync(runDir, { recursive: true });
			writeFileSync(join(runDir, "run.json"), manifest);
			strictEqual(findProducingRun(root, "out.csv", { bytes: 2, mtimeMs: out.mtimeMs, sha256: sha("4\n") }), null);
		}));

	it("names a clio-core input read through its cached copy by tag and blob", () =>
		withBackend(async (_local, root) => {
			const host = {
				state: "ready",
				hello: null,
				call: async (op: string) => {
					if (op === "facts") return { durable: true };
					throw new Error(`unexpected host op ${op}`);
				},
				stderrTail: () => "",
				close: async () => {},
			} as unknown as CoreHost;
			const cacheRoot = join(root, "..", "cache");
			const backend = await createClioCoreStoreBackend(root, host, { cacheRoot });
			const cached = join(cacheRoot, storeProjectKey(storeProjectRoot(root)), "inputs", "sim.h5");
			mkdirSync(dirname(cached), { recursive: true });
			writeFileSync(cached, "h5");
			mkdirSync(join(root, "data"));
			symlinkSync(cached, join(root, "data", "sim.h5"));
			writeFileSync(join(root, "out.json"), "{}");
			const out = statSync(join(root, "out.json"));
			const runId = "20261110T220000Z-abcdef";
			mkdirSync(join(runRecordsDir(root), runId), { recursive: true });
			writeFileSync(
				join(runRecordsDir(root), runId, "run.json"),
				JSON.stringify({
					version: 1,
					runId,
					tool: "run_script",
					finishedAt: "2026-11-10T22:00:01.000Z",
					script: { path: "sum.py", sha256: null },
					argv: ["python3", "sum.py"],
					outcome: "succeeded",
					inputs: [{ path: "data/sim.h5", exists: true, bytes: 2, sha256: null }],
					outputs: [{ path: "out.json", exists: true, status: "created", bytes: 2, mtimeMs: out.mtimeMs }],
				}),
			);
			const body = await buildPutRecord({
				backend,
				cwd: root,
				tag: "results",
				blob: "out.json",
				sourceAbs: join(root, "out.json"),
				stat: { bytes: 2, modifiedMs: 5, version: null },
				hash: { sha256: null },
				receipt: { backend: "clio-core", key: "out.json", version: null },
				actor: "main",
			});
			deepStrictEqual(body.used, [{ tag: "inputs", blob: "sim.h5", bytes: 2, sha256: null }]);
		}));

	it("names a local input read through the copy get handed out by tag and blob", () =>
		withBackend(async (backend, root) => {
			await backend.getOrCreateTag("inputs");
			writeFileSync(join(root, "source.h5"), "h5");
			await backend.putBlobFromFile("inputs", "sim.h5", join(root, "source.h5"));
			const got = await backend.getBlobAsPath("inputs", "sim.h5");
			deepStrictEqual(await backend.blobRefOfPath(realpathSync(got.path)), { tag: "inputs", blob: "sim.h5" });
			mkdirSync(join(root, "data"));
			symlinkSync(got.path, join(root, "data", "sim.h5"));
			writeFileSync(join(root, "out.json"), "{}");
			const out = statSync(join(root, "out.json"));
			const runId = "20261110T220000Z-abcdef";
			mkdirSync(join(runRecordsDir(root), runId), { recursive: true });
			writeFileSync(
				join(runRecordsDir(root), runId, "run.json"),
				JSON.stringify({
					version: 1,
					runId,
					tool: "run_script",
					finishedAt: "2026-11-10T22:00:01.000Z",
					script: { path: "sum.py", sha256: null },
					argv: ["python3", "sum.py"],
					outcome: "succeeded",
					inputs: [{ path: "data/sim.h5", exists: true, bytes: 2, sha256: null }],
					outputs: [{ path: "out.json", exists: true, status: "created", bytes: 2, mtimeMs: out.mtimeMs }],
				}),
			);
			const body = await buildPutRecord({
				backend,
				cwd: root,
				tag: "results",
				blob: "out.json",
				sourceAbs: join(root, "out.json"),
				stat: { bytes: 2, modifiedMs: 5, version: null },
				hash: { sha256: null },
				receipt: { backend: "local", key: "out.json", version: null },
				actor: "main",
			});
			deepStrictEqual(body.used, [{ tag: "inputs", blob: "sim.h5", bytes: 2, sha256: null }]);

			// A copy whose blob is gone, or a file in the cache that was never a blob, names nothing.
			await backend.delBlob("inputs", "sim.h5");
			strictEqual(await backend.blobRefOfPath(realpathSync(got.path)), null);
			const stray = join(dirname(got.path), "stray.h5");
			writeFileSync(stray, "x");
			strictEqual(await backend.blobRefOfPath(realpathSync(stray)), null);
		}));

	it("lists a blob the script read both as a store input and through its get copy once", () =>
		withBackend(async (backend, root) => {
			const sha = createHash("sha256").update("h5").digest("hex");
			await backend.getOrCreateTag("inputs");
			writeFileSync(join(root, "source.h5"), "h5");
			await backend.putBlobFromFile("inputs", "sim.h5", join(root, "source.h5"));
			const got = await backend.getBlobAsPath("inputs", "sim.h5");
			mkdirSync(join(root, "data"));
			symlinkSync(got.path, join(root, "data", "sim.h5"));
			writeFileSync(join(root, "out.json"), "{}");
			const out = statSync(join(root, "out.json"));
			const runId = "20261110T230000Z-abcdef";
			mkdirSync(join(runRecordsDir(root), runId), { recursive: true });
			writeFileSync(
				join(runRecordsDir(root), runId, "run.json"),
				JSON.stringify({
					version: 1,
					runId,
					tool: "run_script",
					finishedAt: "2026-11-10T23:00:01.000Z",
					script: { path: "sum.py", sha256: null },
					argv: ["python3", "sum.py"],
					outcome: "succeeded",
					inputs: [
						{ path: "inputs:sim.h5", exists: true, bytes: 2, sha256: sha, store: { tag: "inputs", blob: "sim.h5" } },
						{ path: "data/sim.h5", exists: true, bytes: 2, sha256: sha },
						{ path: "notes.txt", exists: true, bytes: 1, sha256: null },
						{ path: "notes.txt", exists: true, bytes: 1, sha256: null },
					],
					outputs: [{ path: "out.json", exists: true, status: "created", bytes: 2, mtimeMs: out.mtimeMs }],
				}),
			);
			const body = await buildPutRecord({
				backend,
				cwd: root,
				tag: "results",
				blob: "out.json",
				sourceAbs: join(root, "out.json"),
				stat: { bytes: 2, modifiedMs: 5, version: null },
				hash: { sha256: null },
				receipt: { backend: "local", key: "out.json", version: null },
				actor: "main",
			});
			deepStrictEqual(body.used, [
				{ tag: "inputs", blob: "sim.h5", bytes: 2, sha256: sha },
				{ path: "notes.txt", bytes: 1, sha256: null },
			]);
		}));

	it("keeps clio-core tag and blob names apart: tag a blob b/c is not tag a/b blob c", () =>
		withBackend(async (_local, root) => {
			const paths: string[] = [];
			let spaceTags: string[] = [];
			const host = {
				state: "ready",
				hello: null,
				call: async (op: string, args: { tag?: string; blob?: string }) => {
					if (op === "facts") return { durable: true };
					if (op === "statBlob") {
						paths.push(`/${args.tag}/${args.blob}`);
						return { stat: null };
					}
					if (op === "listTags") return { tags: spaceTags };
					throw new Error(`unexpected host op ${op}`);
				},
				stderrTail: () => "",
				close: async () => {},
			} as unknown as CoreHost;
			const backend = await createClioCoreStoreBackend(root, host, { cacheRoot: join(root, "..", "cache") });
			await backend.statBlob("results", "raw/x");
			await backend.statBlob("results/raw", "x");
			strictEqual(paths.length, 2);
			ok(paths[0] !== paths[1], paths.join(" "));
			const prefix = paths[1]?.slice(1, paths[1].lastIndexOf("/results")) ?? "";
			spaceTags = [`${prefix}/results`, `${prefix}/results%2Fraw`];
			deepStrictEqual(await backend.listTags(), ["results", "results/raw"]);
		}));

	it("reads only the newest records when a limit is given", () =>
		withBackend(async (backend) => {
			for (let n = 0; n < 5; n++) {
				await appendRecord(backend, { kind: "note", tag: "sim", blob: "h", note: `n${n}`, producedBy: by });
			}
			const reads: string[] = [];
			const counting: StoreBackend = {
				...backend,
				getRecord: (tag, name) => {
					reads.push(name);
					return backend.getRecord(tag, name);
				},
			};
			const { records } = await readBlobHistory(counting, "sim", "h", { limit: 2 });
			deepStrictEqual(
				records.map((record) => record.seq),
				[4, 5],
			);
			strictEqual(reads.length, 2);
			deepStrictEqual(
				(await readBlobHistory(backend, "sim", "h")).records.map((record) => record.seq),
				[1, 2, 3, 4, 5],
			);
		}));

	it(
		"lists one blob's records without walking the other blobs' records",
		{ skip: process.platform === "win32" || process.getuid?.() === 0 },
		() =>
			withBackend(async (backend, root) => {
				await appendRecord(backend, { kind: "note", tag: "sim", blob: "run/h", note: "mine", producedBy: by });
				await appendRecord(backend, { kind: "note", tag: "sim", blob: "other/b", note: "theirs", producedBy: by });
				// A walk into another blob's directory now fails, so only a listing that skips it can succeed.
				const other = join(storeTagDir(root, recordsTag("sim")), "blobs", "other");
				chmodSync(other, 0o000);
				try {
					deepStrictEqual(
						(await readBlobHistory(backend, "sim", "run/h")).records.map((record) => record.note),
						["mine"],
					);
				} finally {
					chmodSync(other, 0o700);
				}
			}),
	);

	it("reports each drift value", () => {
		const put = { identity: { bytes: 2, modifiedMs: 5, sha256: null } } as StoreRecord;
		strictEqual(driftOf(put, { bytes: 2, modifiedMs: 5, version: null }), "none");
		strictEqual(driftOf(put, { bytes: 3, modifiedMs: 5, version: null }), "changed");
		strictEqual(driftOf(put, null), "missing");
		strictEqual(driftOf(null, { bytes: 2, modifiedMs: 5, version: null }), "unrecorded");
	});
});
