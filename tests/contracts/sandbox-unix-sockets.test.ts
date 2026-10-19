import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readSettings } from "../../src/core/config.js";
import { sandboxAvailability } from "../../src/core/sandbox/availability.js";
import { buildBwrapInvocation } from "../../src/core/sandbox/bwrap.js";
import { mainSandboxPolicy, planMainSandboxSpawn } from "../../src/core/sandbox/main-session.js";
import { buildSeatbeltInvocation } from "../../src/core/sandbox/seatbelt.js";
import { WORKER_SANDBOX_SPEC_VERSION, type WorkerSandboxSpec } from "../../src/core/sandbox/types.js";
import { unixSocketFilterProgram, unixSocketLaunch } from "../../src/core/sandbox/unix-sockets.js";
import { resolveWorkerSandboxSpec } from "../../src/core/sandbox/worker-policy.js";
import { composeWorkerSandboxInvocation } from "../../src/core/sandbox/worker-process.js";
import { readLayeredSettings } from "../../src/core/settings-layers.js";
import { settingsChangeKind } from "../../src/domains/config/classify.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

// Kernel ABI constants, written out here rather than imported so the program is checked against them.
const AUDIT_ARCH_X86_64 = 0xc000003e;
const AUDIT_ARCH_I386 = 0x40000003;
const AUDIT_ARCH_AARCH64 = 0xc00000b7;
const AUDIT_ARCH_ARM = 0x40000028;
const AUDIT_ARCH_RISCV64 = 0xc00000f3;
const X32 = 0x40000000;
const ALLOW = 0x7fff0000;
const EPERM = 0x00050001;

interface Insn {
	code: number;
	jt: number;
	jf: number;
	k: number;
}

function decode(program: Buffer): Insn[] {
	assert.equal(program.length % 8, 0);
	return Array.from({ length: program.length / 8 }, (_, index) => ({
		code: program.readUInt16LE(index * 8),
		jt: program.readUInt8(index * 8 + 2),
		jf: program.readUInt8(index * 8 + 3),
		k: program.readUInt32LE(index * 8 + 4),
	}));
}

/** The classic BPF subset the program uses, run over one `struct seccomp_data`. */
function run(insns: Insn[], arch: number, nr: number, arg0: bigint): number {
	const data = Buffer.alloc(64);
	data.writeInt32LE(nr | 0, 0);
	data.writeUInt32LE(arch, 4);
	data.writeBigUInt64LE(arg0, 16);
	let a = 0;
	for (let pc = 0; pc < insns.length; pc++) {
		const insn = insns[pc] as Insn;
		if (insn.code === 0x20) a = data.readUInt32LE(insn.k);
		else if (insn.code === 0x54) a = (a & insn.k) >>> 0;
		else if (insn.code === 0x15) pc += a === insn.k ? insn.jt : insn.jf;
		else if (insn.code === 0x06) return insn.k;
		else throw new Error(`unexpected opcode ${insn.code}`);
	}
	throw new Error("program fell off the end");
}

test("the unix-socket seccomp program refuses AF_UNIX sockets under x86_64, x32, i386, aarch64 and arm, and allows the rest", () => {
	const program = unixSocketFilterProgram("LE");
	assert.ok(program !== null);
	const insns = decode(program);
	// Load the arch, dispatch on each covered ABI, and end on ALLOW and ERRNO(EPERM).
	assert.deepEqual(insns[0], { code: 0x20, jt: 0, jf: 0, k: 4 });
	assert.deepEqual(
		insns.slice(1, 5).map((insn) => insn.k),
		[AUDIT_ARCH_X86_64, AUDIT_ARCH_AARCH64, AUDIT_ARCH_I386, AUDIT_ARCH_ARM],
	);
	assert.deepEqual(insns.at(-2), { code: 0x06, jt: 0, jf: 0, k: ALLOW });
	assert.deepEqual(insns.at(-1), { code: 0x06, jt: 0, jf: 0, k: EPERM });
	// x86_64 loads nr, clears the x32 bit, then compares with socket (41); aarch64 compares with 198.
	const x86 = insns.findIndex((insn, index) => insn.code === 0x20 && insn.k === 0 && insns[index + 1]?.code === 0x54);
	assert.deepEqual(
		insns.slice(x86, x86 + 3).map(({ code, k }) => [code, k]),
		[
			[0x20, 0],
			[0x54, 0xbfffffff],
			[0x15, 41],
		],
	);
	const aarch64 = insns.findIndex((insn, index) => insn.code === 0x20 && insn.k === 0 && insns[index + 1]?.k === 198);
	assert.ok(aarch64 > x86);
	assert.equal(unixSocketFilterProgram("BE"), null);

	const cases: Array<[string, number, number, bigint, number]> = [
		["x86_64 socket(AF_UNIX)", AUDIT_ARCH_X86_64, 41, 1n, EPERM],
		["x86_64 socket(AF_UNIX) with a high word", AUDIT_ARCH_X86_64, 41, 1n | (1n << 32n), EPERM],
		["x86_64 socket(AF_INET)", AUDIT_ARCH_X86_64, 41, 2n, ALLOW],
		["x86_64 socketpair(AF_UNIX)", AUDIT_ARCH_X86_64, 53, 1n, ALLOW],
		["x86_64 connect", AUDIT_ARCH_X86_64, 42, 1n, ALLOW],
		["x32 socket(AF_UNIX)", AUDIT_ARCH_X86_64, X32 | 41, 1n, EPERM],
		["x86_64 io_uring_setup", AUDIT_ARCH_X86_64, 425, 1n, EPERM],
		["i386 socket(AF_UNIX)", AUDIT_ARCH_I386, 359, 1n, EPERM],
		["i386 socket(AF_INET)", AUDIT_ARCH_I386, 359, 2n, ALLOW],
		["i386 socketcall(SYS_SOCKET)", AUDIT_ARCH_I386, 102, 1n, EPERM],
		["i386 socketcall(SYS_SOCKETPAIR)", AUDIT_ARCH_I386, 102, 8n, ALLOW],
		["aarch64 socket(AF_UNIX)", AUDIT_ARCH_AARCH64, 198, 1n, EPERM],
		["aarch64 socket(AF_INET6)", AUDIT_ARCH_AARCH64, 198, 10n, ALLOW],
		["aarch64 socketpair(AF_UNIX)", AUDIT_ARCH_AARCH64, 199, 1n, ALLOW],
		["aarch64 io_uring_setup", AUDIT_ARCH_AARCH64, 425, 1n, EPERM],
		["arm socket(AF_UNIX)", AUDIT_ARCH_ARM, 281, 1n, EPERM],
		["arm socketpair(AF_UNIX)", AUDIT_ARCH_ARM, 288, 1n, ALLOW],
		["an uncovered arch", AUDIT_ARCH_RISCV64, 198, 1n, ALLOW],
	];
	for (const [name, arch, nr, arg0, expected] of cases) {
		assert.equal(run(insns, arch, nr, arg0), expected, name);
	}
});

test("the seatbelt profile denies unix-socket connects and binds when blocking, keeping DNS only with network", () => {
	const profile = (spec: { network: boolean; denyUnixSockets?: boolean }): string =>
		buildSeatbeltInvocation({
			command: { argv: ["/usr/bin/true"] },
			cwd: "/w",
			writableRoots: [],
			maskedPaths: [],
			...spec,
		}).args[1] as string;
	const networked = profile({ network: true, denyUnixSockets: true }).split("\n");
	const allowNetwork = networked.indexOf("(allow network*)");
	const deny = networked.indexOf("(deny network-outbound (remote unix-socket))");
	assert.ok(allowNetwork >= 0 && deny > allowNetwork, "the deny follows the network grant, so it wins");
	assert.ok(networked.includes("(deny network-bind (local unix-socket))"));
	assert.ok(networked.some((line) => line.includes("/private/var/run/mDNSResponder")));
	const offline = profile({ network: false, denyUnixSockets: true });
	assert.match(offline, /\(deny network-outbound \(remote unix-socket\)\)/u);
	assert.doesNotMatch(offline, /mDNSResponder/u);
	assert.doesNotMatch(profile({ network: true }), /unix-socket/u);

	// The worker compose path asks Seatbelt for the rules unless the operator allowed sockets.
	const seatbelt = { available: true, backend: "seatbelt" as const, executable: "/usr/bin/sandbox-exec", reason: null };
	const policy: WorkerSandboxSpec = {
		version: WORKER_SANDBOX_SPEC_VERSION,
		mode: "auto",
		writableRoots: [],
		readOnlyPaths: [],
		gitWritablePaths: [],
		readableRoots: [],
		network: true,
	};
	const composed = (spec: WorkerSandboxSpec): string =>
		composeWorkerSandboxInvocation(spec, { argv: ["/usr/bin/true"] }, "/", seatbelt, [])?.args[1] ?? "";
	assert.match(composed(policy), /\(deny network-bind \(local unix-socket\)\)/u);
	assert.doesNotMatch(composed({ ...policy, unixSockets: "allow" }), /unix-socket/u);
});

test("safety.sandboxUnixSockets defaults to block, is user-layer only, applies live and reaches the worker spec", async (t) => {
	const home = await isolateClioEnv("clio-unix-socket-settings-");
	t.after(() => home.restore());
	const workspace = join(home.dir, "workspace");
	mkdirSync(join(workspace, ".clio-coder"), { recursive: true });
	mkdirSync(join(home.dir, "config"), { recursive: true });
	const userFile = join(home.dir, "config", "settings.yaml");
	writeFileSync(userFile, "version: 2\n");
	assert.equal(readSettings().safety.sandboxUnixSockets, "block");
	writeFileSync(userFile, "version: 2\nsafety:\n  sandboxUnixSockets: allow\n");
	assert.equal(readSettings().safety.sandboxUnixSockets, "allow");
	writeFileSync(userFile, "version: 2\nsafety:\n  sandboxUnixSockets: maybe\n");
	assert.throws(() => readSettings(), /safety\.sandboxUnixSockets/u);

	// A repository cannot reopen the sockets for its own commands.
	writeFileSync(userFile, "version: 2\n");
	writeFileSync(join(workspace, ".clio-coder", "settings.local.yaml"), "safety:\n  sandboxUnixSockets: allow\n");
	const layered = readLayeredSettings(workspace);
	assert.equal(layered.settings.safety.sandboxUnixSockets, "block");
	const issue = layered.issues.find((item) => item.path === "safety.sandboxUnixSockets");
	assert.match(issue?.message ?? "", /user settings/u);

	assert.equal(settingsChangeKind("safety.sandboxUnixSockets"), "hotReload");
	const spec = (unixSockets: "block" | "allow") =>
		resolveWorkerSandboxSpec({
			mode: "auto",
			readOnly: false,
			cwd: workspace,
			writeBoundaries: [],
			allowedTools: [],
			networkSetting: false,
			unixSockets,
		});
	assert.equal(spec("allow")?.unixSockets, "allow");
	assert.equal(spec("block")?.unixSockets, undefined);
});

const PROBE = [
	"import socket, sys",
	"path, port = sys.argv[1], int(sys.argv[2])",
	"def attempt(f):",
	"    try: return f()",
	"    except OSError as e: return f'{type(e).__name__}:{e.errno}'",
	"def unix():",
	"    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.connect(path); s.close(); return 'connected'",
	"def tcp():",
	"    s = socket.create_connection(('127.0.0.1', port), timeout=5); s.close(); return 'connected'",
	"def pair():",
	"    a, b = socket.socketpair(); a.sendall(b'x'); return 'pair-' + b.recv(1).decode()",
	"print(f'unix={attempt(unix)} tcp={attempt(tcp)} socketpair={attempt(pair)}')",
].join("\n");

function runProbe(file: string, args: string[]): Promise<string> {
	return new Promise((resolve) => {
		execFile(file, args, { timeout: 20_000 }, (_error, stdout, stderr) => resolve(`${stdout}${stderr}`));
	});
}

async function listen(server: Server, target: string | { host: string; port: number }): Promise<void> {
	await new Promise<void>((resolve) => server.listen(target, resolve));
}

test("under bwrap a contained command cannot open a unix socket but keeps socketpair and TCP; allow reopens it", async (t) => {
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap") {
		t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
		return;
	}
	if (spawnSync("python3", ["-c", "pass"]).status !== 0) {
		t.skip("python3 is not installed");
		return;
	}
	const python = "python3";
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "clio-unix-")));
	const workspace = join(scratch, "ws");
	const socketDir = join(scratch, "sock");
	mkdirSync(workspace);
	mkdirSync(socketDir);
	// Sockets this test made itself: a unix listener in the scratch tree and a TCP one on loopback.
	const socketPath = join(socketDir, "l.sock");
	const unixServer = createServer((socket) => socket.end());
	const tcpServer = createServer((socket) => socket.end());
	await listen(unixServer, socketPath);
	await listen(tcpServer, { host: "127.0.0.1", port: 0 });
	t.after(() => {
		unixServer.close();
		tcpServer.close();
	});
	const address = tcpServer.address();
	assert.ok(address !== null && typeof address === "object");
	const argv = [python, "-c", PROBE, socketPath, String(address.port)];

	const contained = async (unixSockets: "block" | "allow"): Promise<string> => {
		const policy = mainSandboxPolicy({ workspace, scratchRoots: [scratch], unixSockets });
		const plan = planMainSandboxSpawn(policy, { argv }, workspace, availability);
		assert.equal(plan.kind, "sandboxed");
		if (plan.kind !== "sandboxed") return "";
		return runProbe(plan.file, plan.args);
	};
	const blocked = await contained("block");
	assert.match(blocked, /unix=PermissionError:1 tcp=connected socketpair=pair-x/u, blocked);
	const allowed = await contained("allow");
	assert.match(allowed, /unix=connected tcp=connected socketpair=pair-x/u, allowed);

	// A worker's sandbox loads the same filter, network or not: a socket on disk is not network.
	const worker = composeWorkerSandboxInvocation(
		{
			version: WORKER_SANDBOX_SPEC_VERSION,
			mode: "required",
			writableRoots: [workspace],
			readOnlyPaths: [],
			gitWritablePaths: [],
			readableRoots: [workspace],
			network: false,
		},
		{ argv },
		workspace,
		availability,
		[],
	);
	assert.ok(worker !== null);
	assert.match(await runProbe(worker.file, worker.args), /unix=PermissionError:1 /u);

	// Without a filter the launch masks the sockets it finds, so the listener is gone while sockets still open.
	const fallback = unixSocketLaunch(
		"block",
		availability,
		{ workspaceRoots: [workspace], scratchRoots: [scratch], privateTmp: false, home: workspace },
		[],
		{ ok: false, reason: "forced by the test" },
	);
	assert.equal(fallback.state.kind, "masks");
	assert.deepEqual(fallback.fields, {});
	assert.ok(fallback.masks.some((mask) => mask.path === socketPath && mask.kind === "file"));
	const masked = buildBwrapInvocation(
		{
			command: { argv },
			cwd: workspace,
			writableRoots: [workspace],
			network: true,
			maskedPaths: fallback.masks,
			privateTmp: false,
		},
		availability.executable ?? undefined,
	);
	const output = await runProbe(masked.file, masked.args);
	assert.match(output, /unix=ConnectionRefusedError:111 tcp=connected/u, output);
});
