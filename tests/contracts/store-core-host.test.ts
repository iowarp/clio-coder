import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type CoreHostTiming, startCoreHost } from "../../src/domains/store/core-host/supervisor.js";
import { StoreRefusal } from "../../src/domains/store/types.js";

// A scripted peer: argv[2] picks a canned behavior from the table below.
const HOST = String.raw`
const mode = process.argv[2];
const send = (value) => {
	const body = Buffer.from(JSON.stringify(value));
	const head = Buffer.alloc(4);
	head.writeUInt32BE(body.length);
	process.stdout.write(Buffer.concat([head, body]));
};
if (mode === "exit-at-start") {
	process.stderr.write("\u001b[97m/src/ipc_manager.cc:380 INFO 7 ClientInit listener bound\u001b[0m\n");
	process.stderr.write("\u001b[31m/src/ipc_manager.cc:1708 ERROR 7 WaitForLocalServer runtime is not running\u001b[0m\n");
	process.stderr.write("libclio: cannot attach to runtime\n");
	process.exit(3);
}
send({ hello: { host: "node", hostVersion: "0", coreVersion: "2.4.0", pool: "512.0", transport: "shm" } });
let pending = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
	pending = Buffer.concat([pending, chunk]);
	while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE(0)) {
		const request = JSON.parse(pending.subarray(4, 4 + pending.readUInt32BE(0)).toString());
		pending = pending.subarray(4 + pending.readUInt32BE(0));
		handle(request);
	}
});
function handle({ id, op, args }) {
	if (op === "shutdown") process.exit(0);
	if (mode === "silent" && op !== "ping") return process.stderr.write("stuck in GetBlob\n");
	if (mode === "garbage") return process.stdout.write("not a frame at all, just text\n");
	if (mode === "die-mid-call" && op !== "ping") {
		process.stderr.write("access violation\n");
		return process.kill(process.pid, "SIGKILL");
	}
	if (op === "putBlobFromFile") {
		let sent = 0;
		const tick = setInterval(() => send({ id, progress: (sent += 1024) }), 20);
		return setTimeout(() => {
			clearInterval(tick);
			send({ id, ok: true, result: { bytes: sent, modifiedMs: 0, version: null } });
		}, 300);
	}
	if (op === "getRecord") return send({ id, ok: false, reason: "not-found", message: "no record " + args.blob });
	send({ id, ok: true, result: op === "ping" ? {} : { created: true } });
}
`;

const scratch = mkdtempSync(join(tmpdir(), "clio-core-host-"));
const hostScript = join(scratch, "host.cjs");
writeFileSync(hostScript, HOST);
after(() => rmSync(scratch, { recursive: true, force: true }));

// The core tier runs beside the GUI and package tiers on small CI runners, where a starved child can take seconds to
// answer. A test that expects an answer gets deadlines far beyond that; only the silent host's test waits one out, and
// its deadline still leaves the host's stderr line time to arrive.
const roomy: Partial<CoreHostTiming> = { callMs: 20_000, progressMs: 10_000, pingIntervalMs: 50, closeGraceMs: 2_000 };
const expiring: Partial<CoreHostTiming> = { ...roomy, callMs: 1_500 };
const launch = (mode: string, timing: Partial<CoreHostTiming> = roomy) =>
	startCoreHost({ command: process.execPath, args: [hostScript, mode], timing });
const unavailable = (pattern: RegExp) => (error: unknown) =>
	error instanceof StoreRefusal && error.reason === "unavailable" && pattern.test(error.message);

test("a normal call round-trips and a host refusal keeps its reason", async () => {
	const host = await launch("normal");
	try {
		strictEqual(host.hello?.coreVersion, "2.4.0");
		strictEqual((await host.call("getOrCreateTag", { tag: "sim" })).created, true);
		await rejects(
			host.call("getRecord", { tag: "sim", blob: "r1" }),
			(error: unknown) => error instanceof StoreRefusal && error.reason === "not-found",
		);
		strictEqual(host.state, "ready");
	} finally {
		await host.close();
	}
	strictEqual(host.state, "closed");
});

test("ping is answered while a long put runs", async () => {
	const host = await launch("normal");
	try {
		const put = host.call("putBlobFromFile", { tag: "sim", blob: "b", source: "/x" });
		const ping = await host.call("ping", {});
		ok(ping);
		ok((await put).bytes > 0);
	} finally {
		await host.close();
	}
});

test("a host that stops answering is quarantined with its stderr tail, then restarted once", async () => {
	const host = await launch("silent", expiring);
	try {
		await rejects(host.call("getOrCreateTag", { tag: "sim" }), unavailable(/deadline[\s\S]*stuck in GetBlob/));
		strictEqual(host.state, "quarantined");
		await rejects(host.call("getOrCreateTag", { tag: "sim" }), unavailable(/deadline/));
		await rejects(host.call("getOrCreateTag", { tag: "sim" }), unavailable(/next restart is allowed/));
	} finally {
		await host.close();
	}
});

test("a host that writes garbage is quarantined", async () => {
	const host = await launch("garbage");
	try {
		await rejects(host.call("tagExists", { tag: "sim" }), unavailable(/malformed frame/));
		strictEqual(host.state, "quarantined");
	} finally {
		await host.close();
	}
});

test("a host that exits at start reports its exit code and stderr without routine runtime logging", async () => {
	await rejects(launch("exit-at-start"), (error: unknown) => {
		ok(unavailable(/exited with code 3[\s\S]*ERROR 7 WaitForLocalServer[\s\S]*cannot attach to runtime/)(error));
		const message = (error as Error).message;
		ok(!message.includes("\u001b") && !message.includes(" INFO "), message);
		return true;
	});
});

test("killing the host mid-call rejects with StoreRefusal and leaves the parent running", async () => {
	const host = await launch("die-mid-call");
	try {
		await rejects(host.call("listTags", {}), unavailable(/signal SIGKILL[\s\S]*access violation/));
		strictEqual(host.state, "quarantined");
	} finally {
		await host.close();
	}
});

// The Python host's ops against a fake clio_cte_core_ext client; no runtime needed.
const PY_CORE = String.raw`
import importlib.util, json, sys, threading
spec = importlib.util.spec_from_file_location("host", sys.argv[1])
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
class Future:
    def __init__(self, value=None, error=None, code=0):
        self.value, self.error, self.code = value, error, code
    def done(self): return True
    def wait(self, _): return self.code
    def result(self, _):
        if self.error: raise self.error
        return self.value
deleted = []
class Client:
    def AsyncGetBlobSize(self, tag_id, blob, query): return Future(7)
    def AsyncGetBlob(self, tag_id, blob, size, flags):
        return Future(error=RuntimeError("AsyncGetBlob failed with return code 62"))
    def AsyncDelTag(self, tag_id):
        deleted.append(tag_id)
        return Future()
    def AsyncPutBlobIfAbsent(self, tag_id, blob, data, flags): return Future({"code": 0})
    def AsyncSyncTag(self, tag_id):
        synced.append(tag_id)
        return Future()
class OldClient(Client):
    def __getattribute__(self, name):
        if name == "AsyncSyncTag": raise AttributeError(name)
        return object.__getattribute__(self, name)
synced = []
class Cte:
    PUT_EXISTS_RC = 60
    Client = Client
    class PoolQuery:
        @staticmethod
        def Dynamic(): return None
core = object.__new__(host.Core)
core.cte, core.client, core.tag_ids, core.tag_lock, core.fs = Cte, Client(), {"t": 5}, threading.Lock(), None
out = {}
try:
    core.get_record({"tag": "t", "blob": "r1"})
except host.Refusal as error:
    out["get"] = [error.reason, error.message]
core.put_record_if_absent({"tag": "t", "blob": "r2", "data": "eA=="})
core.client = OldClient()
out["oldPut"] = core.put_record_if_absent({"tag": "t", "blob": "r3", "data": "eA=="})["outcome"]
core.client = Client()
out["synced"] = synced
out["refuseBy"] = host.STALL_SECONDS + host.PROBE_SECONDS
Client.AsyncGetContainedBlobs = lambda self, tag_id: Future(["b#00000001"])
core.tag_exists = lambda tag: True
core.tag_ids["agentspace/pk/s4c%2F.records"] = 9
out["records"] = core.list_blobs({"tag": "agentspace/pk/s4c%2F.records", "records": True, "offset": 0, "limit": 10})["names"]
core.del_tag({"tag": "t"})
out["deleted"], out["cached"] = deleted, "t" in core.tag_ids
open(sys.argv[2], "w").write(json.dumps(out))
`;

test("the Python host names a record lost at a restart and deletes tags through AsyncDelTag", () => {
	const script = join(scratch, "py-core.py");
	writeFileSync(script, PY_CORE);
	const result = join(scratch, "py-core.json");
	const host = join(process.cwd(), "assets", "core-host", "clio_core_host.py");
	const run = spawnSync("python3", ["-B", script, host, result], { encoding: "utf8" });
	strictEqual(run.status, 0, run.stderr);
	const out = JSON.parse(readFileSync(result, "utf8")) as {
		get: [string, string];
		deleted: number[];
		cached: boolean;
		synced: number[];
		oldPut: string;
		refuseBy: number;
		records: string[];
	};
	strictEqual(out.get[0], "io");
	ok(/t:r1 was lost at a clio-core restart/u.test(out.get[1]), out.get[1]);
	strictEqual(JSON.stringify(out.deleted), "[5]");
	strictEqual(out.cached, false);
	strictEqual(JSON.stringify(out.synced), "[5]", "a record put syncs its tag once; an older wheel skips it");
	strictEqual(out.oldPut, "written");
	strictEqual(JSON.stringify(out.records), '["b#00000001"]', "a physical (encoded) records tag lists its records");
	ok(out.refuseBy < 3, `a stopped runtime is refused as unavailable within 3 s, not ${out.refuseBy} s`);
});

// A fake clio filesystem: a blob is a file under /<tag>, and its bytes count against the space until it is removed.
const PY_RM_TAG = String.raw`
import errno, importlib.util, json, os, sys, threading
spec = importlib.util.spec_from_file_location("host", sys.argv[1])
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
class Future:
    def done(self): return True
    def wait(self, _): return 0
class Client:
    def __init__(self): self.deleted = []
    def AsyncDelTag(self, tag_id):
        self.deleted.append(tag_id)
        return Future()
class Cte:
    Client = Client
class Fs:
    def __init__(self): self.files, self.dirs = {}, {"/"}
    def used(self): return sum(len(data) for data in self.files.values())
    def mkdir(self, path):
        if path in self.dirs: raise FileExistsError(errno.EEXIST, "exists", path)
        self.dirs.add(path)
    def open(self, path, flags, mode):
        self.files[path] = b""
        return path
    def pwrite(self, fd, data, offset):
        self.files[fd] = self.files[fd][:offset] + bytes(data)
        return len(data)
    def fsync(self, fd): pass
    def close(self, fd): pass
    def rename(self, old, new): self.files[new] = self.files.pop(old)
    def remove(self, path):
        if path not in self.files: raise OSError(errno.EIO, "remove failed", path)
        del self.files[path]
    def children(self, path):
        names = {p[len(path) + 1:].split("/")[0] for p in list(self.files) + list(self.dirs) if p.startswith(path + "/")}
        return sorted(names)
    def readdir(self, path):
        if path not in self.dirs: raise FileNotFoundError(errno.ENOENT, "no such directory", path)
        return self.children(path)
    def stat(self, path):
        if path in self.dirs: return {"mode": 0o040755, "size": 0, "mtime_ns": 0}
        if path not in self.files: raise FileNotFoundError(errno.ENOENT, "no such file", path)
        return {"mode": 0o100644, "size": len(self.files[path]), "mtime_ns": 1_000_000}
class FsWithRmdir(Fs):
    def rmdir(self, path):
        if self.children(path): raise OSError(errno.ENOTEMPTY, "not empty", path)
        self.dirs.discard(path)
out = {}
for name, fs in (("rmdir", FsWithRmdir()), ("noRmdir", Fs())):
    core = object.__new__(host.Core)
    tag, records = "agentspace/pk/t", "agentspace/pk/t%2F.records"
    core.cte, core.client, core.fs = Cte, Client(), fs
    core.tag_ids, core.tag_lock = {tag: 5, records: 6}, threading.Lock()
    core.tag_exists = lambda name: False
    def put(blob, data):
        source = os.path.join(sys.argv[3], "source")
        open(source, "wb").write(data)
        core.put_blob_from_file({"tag": tag, "blob": blob, "source": source}, lambda n: None)
    put("a", b"aa")
    put("b", b"bbb")
    put("sub/c", b"cccc")
    before = fs.used()
    core.del_tag({"tag": tag})
    core.del_tag({"tag": records})
    after = fs.used()
    put("seed", b"s")
    listed = core.list_blobs({"tag": tag, "offset": 0, "limit": 10})["names"]
    out[name] = {"before": before, "after": after, "listed": listed, "deleted": core.client.deleted, "dirs": sorted(fs.dirs)}
open(sys.argv[2], "w").write(json.dumps(out))
`;

test("the Python host's rm-tag removes the tag's blobs, so a re-created tag lists only new ones", () => {
	const script = join(scratch, "py-rm-tag.py");
	writeFileSync(script, PY_RM_TAG);
	const result = join(scratch, "py-rm-tag.json");
	const host = join(process.cwd(), "assets", "core-host", "clio_core_host.py");
	const run = spawnSync("python3", ["-B", script, host, result, scratch], { encoding: "utf8" });
	strictEqual(run.status, 0, run.stderr);
	const out = JSON.parse(readFileSync(result, "utf8")) as Record<
		string,
		{ before: number; after: number; listed: string[]; deleted: number[]; dirs: string[] }
	>;
	for (const [name, seen] of Object.entries(out)) {
		deepStrictEqual([seen.before, seen.after], [9, 0], `${name}: the removed bytes leave the space`);
		deepStrictEqual(seen.listed, ["seed"], name);
		deepStrictEqual(seen.deleted, [5, 6], name);
	}
	// With rmdir the old directories go too; without it only empty ones are left, and they list no blob.
	ok(!out.rmdir?.dirs.includes("/agentspace/pk/t/sub"), JSON.stringify(out.rmdir?.dirs));
	ok(out.noRmdir?.dirs.includes("/agentspace/pk/t/sub"), JSON.stringify(out.noRmdir?.dirs));
});
