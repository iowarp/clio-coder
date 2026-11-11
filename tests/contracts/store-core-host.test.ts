import { ok, rejects, strictEqual } from "node:assert/strict";
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

const fast: Partial<CoreHostTiming> = { callMs: 400, progressMs: 200, pingIntervalMs: 50, closeGraceMs: 500 };
const launch = (mode: string, timing: Partial<CoreHostTiming> = fast) =>
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
	const host = await launch("silent");
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

test("a host that exits at start reports its exit code and stderr without routine runtime logging (M-40 F17)", async () => {
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
core.cte, core.client, core.tag_ids, core.tag_lock = Cte, Client(), {"t": 5}, threading.Lock()
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
	};
	strictEqual(out.get[0], "io");
	ok(/t:r1 was lost at a clio-core restart/u.test(out.get[1]), out.get[1]);
	strictEqual(JSON.stringify(out.deleted), "[5]");
	strictEqual(out.cached, false);
	strictEqual(JSON.stringify(out.synced), "[5]", "a record put syncs its tag once; an older wheel skips it");
	strictEqual(out.oldPut, "written");
	ok(out.refuseBy < 3, `a stopped runtime is refused as unavailable within 3 s, not ${out.refuseBy} s`);
});
