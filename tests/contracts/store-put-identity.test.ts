import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { storePut } from "../../src/cli/store.js";
import type { StoreBackend } from "../../src/domains/store/backend.js";
import { createClioCoreStoreBackend } from "../../src/domains/store/backends/clio-core.js";
import { openStoreBackend } from "../../src/domains/store/index.js";
import { readBlobHistory } from "../../src/domains/store/records.js";
import { createStoreTool } from "../../src/tools/store/store-tool.js";
import { isolateClioEnv } from "../harness/scratch-env.js";
import { memoryHost } from "../harness/store-memory-host.js";

const WRITERS = 12;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const writerBytes = (n: number) => `writer ${n}\n`;

async function withWorkspace(fn: (root: string, dir: string) => Promise<void>): Promise<void> {
	const env = await isolateClioEnv("clio-coder-store-put-identity-");
	try {
		const root = join(env.dir, "workspace");
		mkdirSync(root, { recursive: true });
		for (let n = 1; n <= WRITERS; n++) writeFileSync(join(root, `w${n}.txt`), writerBytes(n));
		await fn(root, env.dir);
	} finally {
		env.restore();
	}
}

/** Every put record names the bytes its own writer sent, and the sequence has no gap. */
async function assertEachRecordIsItsWriters(backend: StoreBackend, count: number): Promise<void> {
	const { records } = await readBlobHistory(backend, "results", "shared.txt");
	deepStrictEqual(
		records.map((record) => record.seq),
		Array.from({ length: count }, (_, index) => index + 1),
	);
	for (const record of records) {
		strictEqual(record.kind, "put");
		const n = Number(/^writer (\d+)$/u.exec(record.note ?? "")?.[1]);
		ok(n >= 1 && n <= count, `record ${record.seq} has note ${record.note}`);
		deepStrictEqual(
			[record.identity?.bytes, record.identity?.sha256],
			[Buffer.byteLength(writerBytes(n)), sha(writerBytes(n))],
			`record ${record.seq} (writer ${n}) names another writer's bytes`,
		);
	}
}

async function concurrentCliPuts(root: string, openBackend: (cwd: string) => Promise<StoreBackend>) {
	return Promise.all(
		Array.from({ length: WRITERS }, (_, index) =>
			storePut(root, "results", `w${index + 1}.txt`, {
				blob: "shared.txt",
				note: `writer ${index + 1}`,
				openBackend,
			}),
		),
	);
}

describe("store put identity under concurrency", () => {
	it("each concurrent local put records the bytes it stored", () =>
		withWorkspace(async (root) => {
			const results = await concurrentCliPuts(root, openStoreBackend);
			for (const [index, result] of results.entries()) {
				strictEqual(result.identity?.sha256, sha(writerBytes(index + 1)));
				strictEqual(result.bytes, Buffer.byteLength(writerBytes(index + 1)));
			}
			await assertEachRecordIsItsWriters(await openStoreBackend(root), WRITERS);
		}));

	it("each concurrent clio-core put records the bytes it stored", () =>
		withWorkspace(async (root, dir) => {
			const backend = await createClioCoreStoreBackend(root, memoryHost(), { cacheRoot: join(dir, "cache") });
			await concurrentCliPuts(root, async () => backend);
			await assertEachRecordIsItsWriters(backend, WRITERS);
		}));

	it("a clio-core blob that changes while being read leaves every put recorded and successful", () =>
		withWorkspace(async (root, dir) => {
			const backend = await createClioCoreStoreBackend(root, memoryHost({ readDrift: true }), {
				cacheRoot: join(dir, "cache"),
			});
			const result = await storePut(root, "results", "w1.txt", {
				blob: "shared.txt",
				note: "writer 1",
				openBackend: async () => backend,
			});
			strictEqual(result.drift, "none");
			const tool = createStoreTool({ getCwd: () => root, writable: true, openBackend: async () => backend });
			const removed = await tool.run({ op: "remove", ref: "results:shared.txt" });
			strictEqual(removed.kind, "ok", String((removed as { message?: unknown }).message ?? ""));
			const put = await tool.run({ op: "put", tag: "results", path: "w2.txt", blob: "shared.txt", note: "writer 2" });
			strictEqual(put.kind, "ok", String((put as { message?: unknown }).message ?? ""));
			const { records } = await readBlobHistory(backend, "results", "shared.txt");
			deepStrictEqual(
				records.map((record) => [record.kind, record.identity?.sha256]),
				[
					["put", sha(writerBytes(1))],
					["remove", sha(writerBytes(1))],
					["put", sha(writerBytes(2))],
				],
			);
		}));

	it("the clio-core host reports the bytes it streamed, not what the final name holds after its rename", () => {
		const script = String.raw`
import hashlib, importlib.util, json, os, sys, threading
spec = importlib.util.spec_from_file_location("host", sys.argv[1])
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
class Fs:
    def __init__(self):
        self.files, self.mtime, self.clock = {}, {}, 1000
    def mkdir(self, path): pass
    def open(self, path, flags, mode):
        self.files[path], self.mtime[path] = b"", self.clock
        return path
    def pwrite(self, fd, data, offset):
        self.files[fd] = self.files[fd][:offset] + bytes(data)
        self.clock += 1
        self.mtime[fd] = self.clock
        return len(data)
    def fsync(self, fd): pass
    def close(self, fd): pass
    def remove(self, path): self.files.pop(path, None)
    def rename(self, old, new):
        self.files[new], self.mtime[new] = self.files.pop(old), self.mtime.pop(old)
        # Another writer's put lands on the final name before this one can look at it.
        self.files[new], self.mtime[new] = b"writer 20\n", 9999
    def stat(self, path):
        if path not in self.files: raise FileNotFoundError(2, "No such file", path)
        return {"mode": 0o100644, "size": len(self.files[path]), "mtime_ns": self.mtime[path] * 1_000_000}
core = object.__new__(host.Core)
core.fs = Fs()
source = os.path.join(sys.argv[3], "w9.txt")
open(source, "wb").write(b"writer 9\n")
put = core.put_blob_from_file({"tag": "agentspace/pk/results", "blob": "shared.txt", "source": source}, lambda n: None)
open(sys.argv[2], "w").write(json.dumps({"put": put, "want": hashlib.sha256(b"writer 9\n").hexdigest()}))
`;
		const dir = mkdtempSync(join(tmpdir(), "clio-core-host-put-"));
		try {
			writeFileSync(join(dir, "put.py"), script);
			const host = join(process.cwd(), "assets", "core-host", "clio_core_host.py");
			const args = ["-B", join(dir, "put.py"), host, join(dir, "out.json"), dir];
			const run = spawnSync("python3", args, { encoding: "utf8" });
			strictEqual(run.status, 0, run.stderr);
			const out = JSON.parse(readFileSync(join(dir, "out.json"), "utf8")) as {
				put: { bytes: number; modifiedMs: number; sha256?: string };
				want: string;
			};
			deepStrictEqual([out.put.bytes, out.put.sha256, out.put.modifiedMs], [9, out.want, 1001]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
