import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runRecordsDir } from "../../src/core/run-records.js";
import type { StoreBackend } from "../../src/domains/store/backend.js";
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

	it("reports each drift value", () => {
		const put = { identity: { bytes: 2, modifiedMs: 5, sha256: null } } as StoreRecord;
		strictEqual(driftOf(put, { bytes: 2, modifiedMs: 5, version: null }), "none");
		strictEqual(driftOf(put, { bytes: 3, modifiedMs: 5, version: null }), "changed");
		strictEqual(driftOf(put, null), "missing");
		strictEqual(driftOf(null, { bytes: 2, modifiedMs: 5, version: null }), "unrecorded");
	});
});
