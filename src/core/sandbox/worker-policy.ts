import { existsSync } from "node:fs";
import path from "node:path";
import { ToolNames } from "../tool-names.js";
import {
	type SandboxAvailability,
	type SandboxBackend,
	type SandboxEnvPolicy,
	type SandboxMode,
	type UnixSocketMode,
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
	/** How the worker's sandboxed commands scrub their inherited environment (env-scrub.ts). */
	env?: SandboxEnvPolicy;
	/** `safety.sandboxUnixSockets`; absent blocks them. */
	unixSockets?: UnixSocketMode;
	/**
	 * Every hooks directory git could run for the worker's tree, core.hooksPath
	 * included (git-hooks-fingerprint.ts). One inside a writable root stays
	 * read-only, because a hook planted there runs outside the sandbox on the
	 * operator's next git command.
	 */
	gitHooksDirs?: ReadonlyArray<string>;
}

/** True when `candidate` lies strictly below `root`, which may end in a slash. */
function strictlyInside(root: string, candidate: string): boolean {
	const rel = path.relative(root, candidate);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
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
export function protectedInside(root: string): string[] {
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
	const passEnv = input.env?.passEnv ?? [];
	const secretEnv = input.env?.secretNames ?? [];
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
				// A hooks directory at or above a root would freeze the root itself, so only one strictly inside counts.
				...(input.gitHooksDirs ?? []).filter((dir) => writableRoots.some((root) => strictlyInside(root, dir))),
			]),
		],
		gitWritablePaths: [],
		readableRoots: [...new Set(readableRoots)],
		network: workerSandboxNetwork(input.allowedTools, input.networkSetting),
		...(passEnv.length > 0 ? { passEnv: [...passEnv] } : {}),
		...(secretEnv.length > 0 ? { secretEnv: [...secretEnv] } : {}),
		...(input.unixSockets === "allow" ? { unixSockets: "allow" as const } : {}),
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

/**
 * Admitted MCP servers start under the worker's own sandbox, so with network
 * off a server fetched by npx or uvx, or one that reaches a remote API or
 * reads credentials from the masked home, is admitted and then fails on its
 * first call. Admission and the dispatch result say so once, by server, and
 * name the setting; the confinement itself is unchanged. A server the
 * operator granted network starts with it and is not named, unless admission
 * withheld the grant because the run can write the server's code; that one
 * is named with the reason. Null when no admitted server runs confined
 * without network.
 */
export function workerMcpNoNetworkNotice(
	sandbox: Pick<WorkerSandboxReceipt, "mode" | "available" | "network">,
	servers: ReadonlyArray<{ serverId: string; network?: true }>,
	withheld: ReadonlyArray<{ serverId: string; reason: string }> = [],
): string | null {
	const held = new Set(withheld.map((entry) => entry.serverId));
	const ids = [
		...new Set(
			servers.filter((entry) => entry.network !== true && !held.has(entry.serverId)).map((entry) => entry.serverId),
		),
	];
	if (ids.length + withheld.length === 0 || sandbox.mode === "off" || sandbox.network || sandbox.available === false) {
		return null;
	}
	const parts: string[] = [];
	if (ids.length > 0) {
		const named = ids.map((id) => `'${id}'`).join(", ");
		const subject = ids.length === 1 ? `MCP server ${named} starts` : `MCP servers ${named} start`;
		parts.push(
			`${subject} inside the worker's OS sandbox with no network, a read-only home and credential directories masked, so a server launched through npx or uvx, or one that needs network or stored credentials, fails on its first call. Grant one server network with clio-coder mcp trust <id> --network (or network: true in a user declaration), or set safety.sandboxNetwork: true for every sandboxed worker command; the home stays read-only.`,
		);
	}
	// A grant the run's write roots voided is not restored by granting it again.
	for (const entry of withheld) {
		parts.push(
			`MCP server '${entry.serverId}' starts without its network grant because ${entry.reason}, so the worker could rewrite the code that would run with network. A project server runs from the run's own tree, so only a read-only dispatch keeps its grant; a user or plugin server keeps it under write roots that exclude its code.`,
		);
	}
	return `[dispatch sandbox] ${parts.join(" ")}`;
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
	return `Shell sandbox: ${backend}. Commands you run can write ${writes}; .git and .clio-coder stay read-only; network is ${spec.network ? "allowed" : "off"}; credential variables are unset and secret files such as .env and private keys cannot be read, so name a command that needs one in your result instead of working around it.${seed}`;
}
