import { closeSync, constants, mkdirSync, openSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { workerSecretPaths } from "../../domains/safety/secret-paths.js";
import { canonicalizePath } from "../path-canonical.js";
import { sandboxAvailability } from "./availability.js";
import { buildSandboxInvocation } from "./invocation.js";
import type {
	SandboxAvailability,
	SandboxCommand,
	SandboxInvocation,
	SandboxInvocationSpec,
	SandboxMaskedPath,
	WorkerSandboxSpec,
} from "./types.js";

/**
 * Process-wide sandbox policy for a dispatched worker. The worker entry sets
 * it once from its WorkerSpec, the same way it sets commit attribution, and
 * both exec seams (bash-exec and safe-exec) consult it for every child they
 * spawn. The orchestrator never configures it, so main-agent commands keep
 * running unsandboxed.
 */
let active: WorkerSandboxSpec | null = null;
let unavailableReported = false;
let maskCache: ReadonlyArray<SandboxMaskedPath> | null = null;

export function configureWorkerProcessSandbox(spec: WorkerSandboxSpec | undefined): void {
	active = spec ?? null;
	unavailableReported = false;
}

/**
 * True when every command this worker spawns runs under bubblewrap bound to
 * the spec's writable roots, the same test dispatch applies before it offers
 * shell and verify to a write-confined worker.
 */
export function workerSandboxConfinesWrites(): boolean {
	if (active === null) return false;
	const availability = sandboxAvailability();
	return availability.available && availability.backend === "bwrap";
}

/**
 * Sockets and runtime directories reachable through the read-only root that
 * would let a sandboxed command act outside it: the session bus, agent
 * sockets under the user runtime directory, and the container daemon.
 */
function runtimeEscapePaths(): string[] {
	const uid = typeof process.getuid === "function" ? process.getuid() : null;
	return [...(uid === null ? [] : [`/run/user/${uid}`]), "/run/docker.sock", "/var/run/docker.sock"];
}

/** Existing secret and escape paths, each with the mount kind that hides it. */
function workerSandboxMaskedPaths(candidates?: ReadonlyArray<string>): SandboxMaskedPath[] {
	const masks: SandboxMaskedPath[] = [];
	for (const entry of candidates ?? [...workerSecretPaths(), ...runtimeEscapePaths()]) {
		try {
			// Mask the link's target: bwrap cannot mount over a symlink, and a
			// dotfile link such as ~/.aws -> /mnt/c/... otherwise failed every
			// sandboxed command. The target is what a read would reach.
			const target = realpathSync(entry);
			const stat = statSync(target);
			masks.push({ path: target, kind: stat.isDirectory() ? "directory" : "file" });
		} catch {
			// Absent paths need no mask, and bwrap cannot mount over them anyway.
		}
	}
	return masks;
}

function cachedMasks(): ReadonlyArray<SandboxMaskedPath> {
	maskCache ??= workerSandboxMaskedPaths();
	return maskCache;
}

/**
 * Mount targets must be physical: bwrap would otherwise mount over whatever a
 * symlinked component points at inside the new root, and the /tmp re-exposure
 * compares spellings.
 */
function physical(entry: string): string {
	try {
		return realpathSync(entry);
	} catch {
		// Missing paths keep their spelling; the builder binds them with -try.
		return entry;
	}
}

/** Materialize admitted directory boundaries without creating through an escaping link. */
function writableRoot(entry: string, workspace: string): string {
	// Exact-file boundaries cannot be replaced with directories or widened to
	// their parent just to make the mount possible.
	if (!entry.endsWith("/")) return physical(entry);
	const root = realpathSync(workspace);
	const target = canonicalizePath(entry);
	const contained = (candidate: string): boolean => {
		const relative = path.relative(root, candidate);
		return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
	};
	if (target === null || !contained(target)) {
		throw new Error(`sandbox: writable directory ${entry} resolves outside the worker workspace`);
	}
	// Pin each parent while creating its child: a worker replacing an ancestor
	// with a link cannot redirect this host-side mkdir outside the workspace.
	const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
	let directory = openSync(root, flags);
	try {
		for (const component of path.relative(root, target).split(path.sep).filter(Boolean)) {
			const child = `/proc/self/fd/${directory}/${component}`;
			try {
				mkdirSync(child);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			const next = openSync(child, flags);
			closeSync(directory);
			directory = next;
		}
		const created = realpathSync(`/proc/self/fd/${directory}`);
		if (!contained(created)) throw new Error(`sandbox: writable directory ${entry} escaped the worker workspace`);
		return created;
	} finally {
		closeSync(directory);
	}
}

/** Compose the invocation for one command under a worker policy and the probed backend. */
export function composeWorkerSandboxInvocation(
	policy: WorkerSandboxSpec,
	command: SandboxCommand,
	cwd: string,
	availability: SandboxAvailability,
	maskedPaths: ReadonlyArray<SandboxMaskedPath> = cachedMasks(),
): SandboxInvocation | null {
	if (!availability.available || availability.backend === null || availability.executable === null) return null;
	const spec: SandboxInvocationSpec = {
		command,
		cwd: physical(cwd),
		writableRoots: policy.writableRoots.map((entry) =>
			availability.backend === "bwrap" ? writableRoot(entry, policy.readableRoots[0] ?? cwd) : physical(entry),
		),
		readOnlyPaths: policy.readOnlyPaths.map(physical),
		gitWritablePaths: policy.gitWritablePaths.map(physical),
		readableRoots: policy.readableRoots.map(physical),
		network: policy.network,
		maskedPaths,
		// Agent sockets are masked; a dangling variable only produces confusing
		// connection errors in tools that honor it.
		unsetEnv: ["SSH_AUTH_SOCK"],
		// Under bubblewrap the private /tmp is the only scratch space outside the
		// writable roots, and an inherited TMPDIR elsewhere would be read-only.
		// macOS keeps its per-user TMPDIR, which the seatbelt profile allows.
		...(availability.backend === "bwrap" ? { setEnv: { TMPDIR: "/tmp", TMP: "/tmp", TEMP: "/tmp" } } : {}),
	};
	return buildSandboxInvocation(spec, availability.backend, availability.executable);
}

export type SandboxedSpawnPlan =
	| { kind: "direct" }
	| { kind: "sandboxed"; file: string; args: string[] }
	| { kind: "refused"; message: string };

/**
 * Decide how one worker child process spawns. No policy means the host runs
 * it directly (orchestrator, or `safety.sandbox: off`). `auto` without a
 * backend runs directly and says so once on stderr, which the dispatcher keeps
 * as worker diagnostics; `required` without a backend refuses the command.
 */
export function planSandboxedSpawn(
	command: SandboxCommand,
	cwd: string,
	typedGitWritablePaths: ReadonlyArray<string> = [],
): SandboxedSpawnPlan {
	const policy = active;
	if (policy === null) return { kind: "direct" };
	const availability = sandboxAvailability();
	// v060 review F1: only the typed Git seam supplies metadata writes, scoped
	// to this invocation; ordinary commands cannot inherit them from a spec.
	let invocation: SandboxInvocation | null;
	try {
		invocation = composeWorkerSandboxInvocation(
			{ ...policy, gitWritablePaths: typedGitWritablePaths },
			command,
			cwd,
			availability,
		);
	} catch (error) {
		return { kind: "refused", message: error instanceof Error ? error.message : String(error) };
	}
	if (invocation !== null) return { kind: "sandboxed", file: invocation.file, args: invocation.args };
	const reason = availability.reason ?? "no sandbox backend";
	if (policy.mode === "required") {
		return {
			kind: "refused",
			message: `sandbox: safety.sandbox is "required" but no worker sandbox is available (${reason}); the command was not run`,
		};
	}
	if (!unavailableReported) {
		unavailableReported = true;
		process.stderr.write(`[worker] sandbox unavailable (${reason}); worker commands run unsandboxed\n`);
	}
	return { kind: "direct" };
}
