import { createHash } from "node:crypto";
import { type Dirent, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { endianness, homedir, machine } from "node:os";
import path from "node:path";
import { safeResourceWrite } from "../safe-resource-write.js";
import { clioStateDir } from "../xdg.js";
import { probeSandboxInvocation } from "./availability.js";
import { buildBwrapInvocation, UNIX_SOCKET_FILTER_STDIN } from "./bwrap.js";
import type { SandboxAvailability, SandboxInvocationSpec, SandboxMaskedPath, UnixSocketMode } from "./types.js";

/**
 * Unix-domain sockets inside the OS sandbox. A contained command keeps the
 * host network namespace and reads most of the filesystem, and Linux lets a
 * process connect to a socket on a read-only mount. A terminal multiplexer's
 * socket (tmux, Herdr), an X11 display or a daemon's control socket each runs
 * commands outside the sandbox, and abstract-namespace sockets (X11, some
 * D-Bus buses) have no path a mount could hide.
 *
 * Under bubblewrap every launch therefore loads a seccomp program that makes
 * `socket(AF_UNIX, ...)` fail with EPERM and allows every other call,
 * `socketpair` included, so pipes between a command's own processes keep
 * working. Seatbelt denies Unix-socket connects and binds in its profile.
 * Where bubblewrap cannot load the program, each launch masks the
 * user-owned sockets it finds instead, which leaves abstract sockets and
 * sockets created after the launch reachable.
 */

// seccomp_data layout: int nr, u32 arch, u64 instruction_pointer, u64 args[6].
const SECCOMP_DATA_NR = 0;
const SECCOMP_DATA_ARCH = 4;
/** Low word of args[0] on a little-endian host; the kernel reads the domain as an int. */
const SECCOMP_DATA_ARG0_LOW = 16;

const BPF_LD_W_ABS = 0x20;
const BPF_ALU_AND_K = 0x54;
const BPF_JMP_JEQ_K = 0x15;
const BPF_RET_K = 0x06;

const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_ERRNO = 0x00050000;
const EPERM = 1;
const AF_UNIX = 1;
/** socketcall(2) call number for socket(2). */
const SYS_SOCKET = 1;

const AUDIT_ARCH_X86_64 = 0xc000003e;
const AUDIT_ARCH_I386 = 0x40000003;
const AUDIT_ARCH_AARCH64 = 0xc00000b7;
const AUDIT_ARCH_ARM = 0x40000028;
/** x32 syscalls carry this bit in `nr` under AUDIT_ARCH_X86_64. */
const X32_SYSCALL_BIT = 0x40000000;

/**
 * Per ABI: the socket syscall, socketcall where the ABI routes socket(2)
 * through it, and io_uring_setup, whose IORING_OP_SOCKET creates a socket
 * without the socket syscall. A 64-bit process can still enter the 32-bit
 * ABI (int 0x80 on x86_64), so each family's compat ABI is filtered too.
 */
const ABIS = [
	{ label: "x86_64", arch: AUDIT_ARCH_X86_64, socket: 41, ioUringSetup: 425, x32: true },
	{ label: "aarch64", arch: AUDIT_ARCH_AARCH64, socket: 198, ioUringSetup: 425 },
	{ label: "i386", arch: AUDIT_ARCH_I386, socket: 359, socketcall: 102, ioUringSetup: 425 },
	{ label: "arm", arch: AUDIT_ARCH_ARM, socket: 281, ioUringSetup: 425 },
] as const;

/** Kernel machines whose native and compat ABIs the program covers. */
const COVERED_MACHINES = new Set(["x86_64", "aarch64", "arm64", "i386", "i686", "armv7l", "armv8l"]);

interface Step {
	code: number;
	k: number;
	/** Label jumped to when the comparison holds; absent falls through. */
	jt?: string;
	/** Label jumped to when it does not; absent falls through. */
	jf?: string;
	label?: string;
}

/** Classic BPF jumps are forward offsets of at most 255 instructions. */
function assemble(steps: ReadonlyArray<Step>): Buffer {
	const at = new Map<string, number>();
	steps.forEach((step, index) => {
		if (step.label !== undefined) at.set(step.label, index);
	});
	const out = Buffer.alloc(steps.length * 8);
	steps.forEach((step, index) => {
		const offset = (label: string | undefined): number => {
			if (label === undefined) return 0;
			const target = at.get(label);
			if (target === undefined || target <= index || target - index - 1 > 255) {
				throw new Error(`seccomp program: bad jump to ${label}`);
			}
			return target - index - 1;
		};
		out.writeUInt16LE(step.code, index * 8);
		out.writeUInt8(offset(step.jt), index * 8 + 2);
		out.writeUInt8(offset(step.jf), index * 8 + 3);
		out.writeUInt32LE(step.k >>> 0, index * 8 + 4);
	});
	return out;
}

/**
 * Pure: the seccomp program bwrap loads, as the raw `struct sock_filter`
 * array in host byte order. Under the x86_64, x32, i386, aarch64 and arm
 * ABIs it returns EPERM for socket(AF_UNIX), for i386 socketcall(SYS_SOCKET)
 * (which cannot be read further) and for io_uring_setup, and allows
 * everything else; any other ABI is allowed whole. Null on a big-endian
 * host, where the offsets differ and no covered ABI runs.
 */
export function unixSocketFilterProgram(byteOrder: "BE" | "LE" = endianness()): Buffer | null {
	if (byteOrder !== "LE") return null;
	const ld = (offset: number, label?: string): Step => ({
		code: BPF_LD_W_ABS,
		k: offset,
		...(label !== undefined ? { label } : {}),
	});
	const jeq = (k: number, jt?: string, jf?: string): Step => ({
		code: BPF_JMP_JEQ_K,
		k,
		...(jt !== undefined ? { jt } : {}),
		...(jf !== undefined ? { jf } : {}),
	});
	const steps: Step[] = [ld(SECCOMP_DATA_ARCH)];
	ABIS.forEach((abi, index) => {
		const last = index === ABIS.length - 1;
		steps.push(jeq(abi.arch, abi.label, last ? "allow" : undefined));
	});
	for (const abi of ABIS) {
		steps.push(ld(SECCOMP_DATA_NR, abi.label));
		// An x32 call is the x86_64 number with the x32 bit set; masking it
		// sends both through the same comparisons.
		if ("x32" in abi) steps.push({ code: BPF_ALU_AND_K, k: ~X32_SYSCALL_BIT >>> 0 });
		steps.push(jeq(abi.socket, "domain"));
		if ("socketcall" in abi) steps.push(jeq(abi.socketcall, "socketcall"));
		steps.push(jeq(abi.ioUringSetup, "deny", "allow"));
	}
	steps.push(
		ld(SECCOMP_DATA_ARG0_LOW, "domain"),
		jeq(AF_UNIX, "deny", "allow"),
		ld(SECCOMP_DATA_ARG0_LOW, "socketcall"),
		jeq(SYS_SOCKET, "deny", "allow"),
		{ code: BPF_RET_K, k: SECCOMP_RET_ALLOW, label: "allow" },
		{ code: BPF_RET_K, k: SECCOMP_RET_ERRNO | EPERM, label: "deny" },
	);
	return assemble(steps);
}

/** The program file under Clio's state directory; its name carries the content digest. */
function filterFilePath(program: Buffer): string {
	const digest = createHash("sha256").update(program).digest("hex").slice(0, 16);
	return path.join(clioStateDir(), "sandbox", `unix-socket-filter-${digest}.bpf`);
}

/**
 * Impure: the program file, rewritten whenever it is missing or holds other
 * bytes, so a stale or altered file never reaches bwrap. It is read again on
 * every launch, which costs one small read.
 */
function unixSocketFilterFile(program: Buffer): string {
	const file = filterFilePath(program);
	let current: Buffer | null = null;
	try {
		if (lstatSync(file).isFile()) current = readFileSync(file);
	} catch {
		// Absent: written below.
	}
	if (current === null || !current.equals(program)) safeResourceWrite(file, program, { mode: 0o444 });
	return file;
}

export type UnixSocketFilterSupport = { ok: true } | { ok: false; reason: string };

const supportCache = new Map<string, UnixSocketFilterSupport>();

/**
 * Impure, probed once per bwrap executable: whether a launch can load the
 * filter here. The kernel machine must be one the program covers, and bwrap
 * must start a command with the program, which proves the kernel accepted it.
 * The probe hands the program over stdin, so doctor's probe writes no file.
 */
function unixSocketFilterSupport(bwrap: string): UnixSocketFilterSupport {
	const cached = supportCache.get(bwrap);
	if (cached !== undefined) return cached;
	const support = probeFilterSupport(bwrap);
	supportCache.set(bwrap, support);
	return support;
}

function probeFilterSupport(bwrap: string): UnixSocketFilterSupport {
	const program = unixSocketFilterProgram();
	if (program === null || !COVERED_MACHINES.has(machine())) {
		return { ok: false, reason: `no unix-socket filter for ${machine()} (${endianness()})` };
	}
	const failure = probeSandboxInvocation(
		buildBwrapInvocation(
			{
				command: { argv: ["/bin/true"] },
				cwd: "/",
				writableRoots: [],
				network: false,
				maskedPaths: [],
				unixSocketFilter: UNIX_SOCKET_FILTER_STDIN,
			},
			bwrap,
		),
		program,
	);
	return failure === null ? { ok: true } : { ok: false, reason: `bubblewrap did not load the filter: ${failure}` };
}

/** Where a launch looks for sockets to mask when the filter cannot load. */
export interface UnixSocketRoots {
	/** Trees the command works in (workspace, worker cwd, worktree, checkouts). Scanned, never masked whole. */
	workspaceRoots: ReadonlyArray<string>;
	/** Writable trees beyond the temp roots, such as `safety.scratchRoots`. */
	scratchRoots?: ReadonlyArray<string>;
	/** A private /tmp hides the host's, so it is not scanned. */
	privateTmp: boolean;
	/** Defaults to the operator's home directory. */
	home?: string;
}

const HOME_SCAN_DEPTH = 4;
const TREE_SCAN_DEPTH = 3;
/** Entries one discovery may visit before it stops and reports itself capped. */
const SOCKET_WALK_BUDGET = 40_000;
/** Masks past this many are not added; each is one bwrap argument pair. */
const SOCKET_MASK_LIMIT = 256;
/** Sockets come and go with their daemons, so a scan is reused only briefly. */
const SOCKET_SCAN_TTL_MS = 5_000;
/** Large or generated trees that hold no daemon socket worth the walk. */
const SKIPPED_SOCKET_DIRS = new Set([
	"node_modules",
	".git",
	".cache",
	".npm",
	".pnpm-store",
	".cargo",
	".rustup",
	".nvm",
	".pyenv",
	".conda",
	"miniconda3",
	"anaconda3",
	".venv",
	"venv",
	"go",
	".gradle",
	".m2",
	"snap",
	".vscode-server",
	"Trash",
	"__pycache__",
]);

interface UnixSocketMaskScan {
	masks: SandboxMaskedPath[];
	/** True when the walk ran out of budget or more than the mask limit were found. */
	capped: boolean;
}

function physical(entry: string): string | null {
	try {
		return realpathSync(entry);
	} catch {
		return null;
	}
}

function isInside(parent: string, candidate: string): boolean {
	const rel = path.relative(parent, candidate);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

interface SocketWalk {
	visited: number;
	capped: boolean;
	found: Set<string>;
	skip: ReadonlyArray<string>;
}

/** Bounded walk for sockets owned by `uid`; links are never followed. */
function walkSockets(root: string, maxDepth: number, uid: number, state: SocketWalk): void {
	const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
	while (stack.length > 0 && !state.capped) {
		const frame = stack.pop();
		if (frame === undefined) break;
		let entries: Dirent[];
		try {
			entries = readdirSync(frame.dir, { withFileTypes: true });
		} catch {
			// Unreadable to this process: its sockets are unreachable from the sandbox too.
			continue;
		}
		for (const entry of entries) {
			if (state.visited >= SOCKET_WALK_BUDGET) {
				state.capped = true;
				return;
			}
			state.visited += 1;
			const child = path.join(frame.dir, entry.name);
			if (entry.isSocket()) {
				try {
					if (lstatSync(child).uid === uid) state.found.add(child);
				} catch {
					// Gone already.
				}
			} else if (
				entry.isDirectory() &&
				frame.depth + 1 < maxDepth &&
				!SKIPPED_SOCKET_DIRS.has(entry.name) &&
				!state.skip.some((masked) => isInside(masked, child))
			) {
				stack.push({ dir: child, depth: frame.depth + 1 });
			}
		}
	}
}

/**
 * A daemon's private socket directory directly under a temp root, such as
 * /tmp/tmux-<uid>, is masked whole so a socket made there after the launch is
 * hidden too. It must be the operator's, closed to group and others, and hold
 * no tree the command works in.
 */
function privateSocketDir(
	socket: string,
	tempRoots: ReadonlyArray<string>,
	keep: ReadonlyArray<string>,
	uid: number,
): string | null {
	const dir = path.dirname(socket);
	if (!tempRoots.includes(path.dirname(dir))) return null;
	if (keep.some((root) => isInside(dir, root))) return null;
	try {
		const stat = lstatSync(dir);
		return stat.isDirectory() && stat.uid === uid && (stat.mode & 0o077) === 0 ? dir : null;
	} catch {
		return null;
	}
}

interface CachedSocketScan {
	at: number;
	scan: UnixSocketMaskScan;
}

const socketScanCache = new Map<string, CachedSocketScan>();

function scanSockets(
	roots: UnixSocketRoots,
	existing: ReadonlyArray<SandboxMaskedPath>,
	uid: number,
): UnixSocketMaskScan {
	const unique = (entries: ReadonlyArray<string>): string[] => [
		...new Set(entries.map(physical).filter((entry): entry is string => entry !== null)),
	];
	const workspaceRoots = unique(roots.workspaceRoots);
	const scratchRoots = unique(roots.scratchRoots ?? []);
	// A private /tmp hides the host's; /var/tmp is visible either way.
	const tempRoots = unique([...(roots.privateTmp ? [] : ["/tmp"]), "/var/tmp", ...(roots.scratchRoots ?? [])]);
	const home = unique([roots.home ?? homedir()]);
	const state: SocketWalk = {
		visited: 0,
		capped: false,
		found: new Set(),
		skip: existing.filter((mask) => mask.kind === "directory").map((mask) => mask.path),
	};
	// Scan the command's explicit roots before shared trees can exhaust the bounded walk (#434).
	for (const root of unique([...workspaceRoots, ...scratchRoots])) walkSockets(root, TREE_SCAN_DEPTH, uid, state);
	for (const root of home) walkSockets(root, HOME_SCAN_DEPTH, uid, state);
	for (const root of tempRoots) walkSockets(root, TREE_SCAN_DEPTH, uid, state);
	const keep = [...workspaceRoots, ...scratchRoots];
	const taken = new Set(existing.map((mask) => mask.path));
	const masks: SandboxMaskedPath[] = [];
	let capped = state.capped;
	for (const socket of [...state.found].sort()) {
		if (taken.has(socket) || masks.some((mask) => mask.kind === "directory" && isInside(mask.path, socket))) continue;
		if (masks.length >= SOCKET_MASK_LIMIT) {
			capped = true;
			break;
		}
		const dir = privateSocketDir(socket, tempRoots, keep, uid);
		const mask: SandboxMaskedPath = dir !== null ? { path: dir, kind: "directory" } : { path: socket, kind: "file" };
		if (taken.has(mask.path)) continue;
		taken.add(mask.path);
		masks.push(mask);
	}
	return { masks, capped };
}

/**
 * Impure: masks for the user-owned sockets a command could reach, for a
 * launch that cannot load the filter. Home is walked four levels deep, the
 * temp roots, scratch roots and work trees three, skipping dependency and
 * cache trees. A scan is reused for 5 s, and a mask whose path is gone by now
 * is dropped, because bwrap fails a mount over a missing path on a read-only
 * tree.
 */
function discoverUnixSocketMasks(
	roots: UnixSocketRoots,
	existing: ReadonlyArray<SandboxMaskedPath> = [],
	now: number = Date.now(),
): UnixSocketMaskScan {
	const uid = typeof process.getuid === "function" ? process.getuid() : -1;
	const key = JSON.stringify([roots, existing.map((mask) => mask.path).sort()]);
	const cached = socketScanCache.get(key);
	const scan =
		cached !== undefined && now - cached.at < SOCKET_SCAN_TTL_MS ? cached.scan : scanSockets(roots, existing, uid);
	if (cached === undefined || cached.scan !== scan) socketScanCache.set(key, { at: now, scan });
	const present = (mask: SandboxMaskedPath): boolean => {
		try {
			const stat = lstatSync(mask.path);
			return mask.kind === "directory" ? stat.isDirectory() : stat.isSocket();
		} catch {
			return false;
		}
	};
	return { masks: scan.masks.filter(present), capped: scan.capped };
}

/** How one launch treats Unix-domain sockets. */
export type UnixSocketState =
	| { kind: "allowed" }
	| { kind: "filter" }
	| { kind: "profile" }
	| { kind: "masks"; reason: string; capped: boolean };

export interface UnixSocketLaunch {
	/** Spread into the launch's invocation spec. */
	fields: Pick<SandboxInvocationSpec, "unixSocketFilter" | "denyUnixSockets">;
	/** Masks for the sockets found, when bubblewrap cannot load the filter. */
	masks: SandboxMaskedPath[];
	state: UnixSocketState;
}

/**
 * Impure: what one sandbox launch adds for Unix-domain sockets. `allow`
 * adds nothing. Seatbelt denies them in its profile. Bubblewrap loads the
 * filter when this host supports it, and otherwise masks the sockets
 * discovered under `roots`, skipping those `existing` masks already hide.
 */
export function unixSocketLaunch(
	mode: UnixSocketMode,
	availability: SandboxAvailability,
	roots: UnixSocketRoots,
	existing: ReadonlyArray<SandboxMaskedPath>,
	support?: UnixSocketFilterSupport,
): UnixSocketLaunch {
	if (mode === "allow" || !availability.available || availability.executable === null) {
		return { fields: {}, masks: [], state: { kind: "allowed" } };
	}
	if (availability.backend === "seatbelt")
		return { fields: { denyUnixSockets: true }, masks: [], state: { kind: "profile" } };
	let reason: string;
	const probed = support ?? unixSocketFilterSupport(availability.executable);
	const program = probed.ok ? unixSocketFilterProgram() : null;
	if (program !== null) {
		try {
			return { fields: { unixSocketFilter: unixSocketFilterFile(program) }, masks: [], state: { kind: "filter" } };
		} catch (error) {
			reason = `the filter file could not be written: ${error instanceof Error ? error.message : String(error)}`;
		}
	} else {
		reason = probed.ok ? "no unix-socket filter for this host" : probed.reason;
	}
	const scan = discoverUnixSocketMasks(roots, existing);
	return { fields: {}, masks: scan.masks, state: { kind: "masks", reason, capped: scan.capped } };
}

/** What doctor and the worker diagnostics say about one host's unix-socket treatment. */
export function unixSocketStateLine(state: UnixSocketState): string {
	switch (state.kind) {
		case "allowed":
			return "unix sockets: allowed (safety.sandboxUnixSockets is allow), so a contained command can reach any socket it sees";
		case "filter":
			return "unix sockets: a seccomp filter refuses new AF_UNIX sockets (socketpair still works)";
		case "profile":
			return "unix sockets: the seatbelt profile denies connecting to and binding them (unverified on macOS)";
		case "masks":
			return `unix sockets: the seccomp filter is unavailable (${state.reason}), so the user-owned sockets found at launch are masked${state.capped ? " up to the search limit" : ""}; abstract sockets and sockets created later stay reachable`;
	}
}

/** Impure: the treatment the next launch on this host gets, without discovering sockets. */
export function unixSocketHostState(mode: UnixSocketMode, availability: SandboxAvailability): UnixSocketState {
	if (mode === "allow" || !availability.available || availability.executable === null) return { kind: "allowed" };
	if (availability.backend === "seatbelt") return { kind: "profile" };
	const support = unixSocketFilterSupport(availability.executable);
	return support.ok ? { kind: "filter" } : { kind: "masks", reason: support.reason, capped: false };
}
