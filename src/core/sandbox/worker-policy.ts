import { existsSync } from "node:fs";
import path from "node:path";
import { ToolNames } from "../tool-names.js";
import {
	type SandboxAvailability,
	type SandboxBackend,
	type SandboxMode,
	WORKER_SANDBOX_SPEC_VERSION,
	type WorkerSandboxSpec,
} from "./types.js";
import { readTaskWorktreeGitLayout } from "./worktree-git.js";

export interface WorkerSandboxPolicyInput {
	mode: SandboxMode;
	readOnly: boolean;
	/** The worker's working directory (inside the task worktree when it has one). */
	cwd: string;
	/** Canonical dispatch write boundaries; exact files and trailing-slash subtrees. */
	writeBoundaries: ReadonlyArray<string>;
	taskWorktree?: { path: string; branch: string };
	allowedTools: ReadonlyArray<string>;
	/** `safety.sandboxNetwork`: the operator's standing network grant for worker commands. */
	networkSetting: boolean;
	/** Parent checkouts supplying shared task dependencies; also visible when under /tmp. */
	dependencyRoots?: ReadonlyArray<string>;
}

/**
 * Network for worker commands follows the run's retrieval grant. A worker
 * trusted with web_fetch already has an egress channel, so an isolated shell
 * would protect nothing while breaking package installs; a worker without it
 * gets an empty network namespace unless the operator opted in.
 */
function workerSandboxNetwork(allowedTools: ReadonlyArray<string>, networkSetting: boolean): boolean {
	return networkSetting || allowedTools.includes(ToolNames.WebFetch);
}

/** Paths inside a writable root that stay read-only, as in Codex's workspace-write mode. */
function protectedInside(root: string): string[] {
	const base = root.length > 1 ? root.replace(/\/+$/u, "") : root;
	return [path.join(base, ".git"), path.join(base, ".clio-coder")];
}

/**
 * Dispatch-side policy for one native worker run, or undefined when the
 * operator turned the sandbox off. Writable roots are the run's write
 * boundaries, else its task worktree, else its cwd; a read-only run gets none.
 */
export function resolveWorkerSandboxSpec(input: WorkerSandboxPolicyInput): WorkerSandboxSpec | undefined {
	if (input.mode === "off") return undefined;
	const writableRoots = input.readOnly
		? []
		: input.writeBoundaries.length > 0
			? [...input.writeBoundaries]
			: [input.taskWorktree?.path ?? input.cwd];
	const layout = input.taskWorktree === undefined ? null : readTaskWorktreeGitLayout(input.taskWorktree.path);
	const readableRoots = [
		input.cwd,
		...(input.taskWorktree !== undefined ? [input.taskWorktree.path] : []),
		...(layout !== null ? [layout.commonDir] : []),
		...(input.dependencyRoots ?? []),
	];
	return {
		version: WORKER_SANDBOX_SPEC_VERSION,
		mode: input.mode,
		writableRoots,
		// Exact-file boundaries contain no .git to protect, and binding
		// `<file>/.git` fails bwrap with ENOTDIR, which -try does not skip, so
		// every sandboxed command in a run with file write roots failed.
		readOnlyPaths: [
			...new Set([
				...(input.writeBoundaries.length > 0 && !input.readOnly
					? writableRoots.filter((root) => root.endsWith("/"))
					: writableRoots
				).flatMap(protectedInside),
				...(input.dependencyRoots ?? []),
			]),
		],
		gitWritablePaths: [],
		readableRoots: [...new Set(readableRoots)],
		network: workerSandboxNetwork(input.allowedTools, input.networkSetting),
	};
}

/** Effective sandbox sealed on a native worker receipt. */
export interface WorkerSandboxReceipt {
	mode: SandboxMode;
	backend: SandboxBackend | null;
	/**
	 * Probed on the orchestrator host for a local worker. Null when the mode is
	 * off, or when the worker runs on a remote node whose own probe decides.
	 */
	available: boolean | null;
	reason?: string;
	writableRoots: ReadonlyArray<string>;
	gitWritablePaths: ReadonlyArray<string>;
	network: boolean;
}

export function workerSandboxReceipt(
	mode: SandboxMode,
	spec: WorkerSandboxSpec | undefined,
	availability: SandboxAvailability | null,
): WorkerSandboxReceipt {
	if (spec === undefined) {
		return { mode: "off", backend: null, available: null, writableRoots: [], gitWritablePaths: [], network: true };
	}
	return {
		mode,
		backend: availability?.available === true ? availability.backend : null,
		available: availability === null ? null : availability.available,
		...(availability?.reason ? { reason: availability.reason } : {}),
		writableRoots: [...spec.writableRoots],
		gitWritablePaths: [...spec.gitWritablePaths],
		network: spec.network,
	};
}

/** One sentence for the worker's dynamic safety line. */
export function workerSandboxLine(spec: WorkerSandboxSpec | undefined, availability: SandboxAvailability): string {
	if (spec === undefined) return "Shell sandbox: off.";
	if (!availability.available) {
		return spec.mode === "required"
			? `Shell sandbox: unavailable (${availability.reason ?? "no backend"}); shell and verification commands are refused.`
			: `Shell sandbox: unavailable (${availability.reason ?? "no backend"}); commands run unsandboxed.`;
	}
	// Seatbelt has no private mount: its profile admits the shared system temp
	// directories, and the profile is unverified on macOS (seatbelt.ts), so the
	// worker is told both instead of being promised bubblewrap's isolation.
	const seatbelt = availability.backend === "seatbelt";
	const tmp = seatbelt ? "the shared temp directories" : "a private /tmp";
	const writes = spec.writableRoots.length === 0 ? `only ${tmp}` : `only your writable roots and ${tmp}`;
	// bwrap binds a missing exact-file root with --bind-try, which skips it, so
	// a command can never create that file. The native write tool can, inside
	// the same boundary, so the worker is told to seed the file with it first.
	const missing = spec.writableRoots.filter((root) => !root.endsWith("/") && !existsSync(root));
	const seed =
		missing.length === 0
			? ""
			: ` These write-root files do not exist yet and shell commands cannot create them, so create each with the write tool before any command writes to it: ${missing.join(", ")}.`;
	const backend = seatbelt ? "seatbelt (experimental, unverified macOS profile)" : availability.backend;
	return `Shell sandbox: ${backend}. Commands you run can write ${writes}; .git and .clio-coder stay read-only; network is ${spec.network ? "allowed" : "off"}.${seed}`;
}
