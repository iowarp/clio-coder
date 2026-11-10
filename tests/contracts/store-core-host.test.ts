import { ok, rejects, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("a host that exits at start reports its exit code and stderr", async () => {
	await rejects(launch("exit-at-start"), unavailable(/exited with code 3[\s\S]*cannot attach to runtime/));
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
