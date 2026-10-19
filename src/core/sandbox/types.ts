/**
 * Worker OS sandbox vocabulary (decision Q8, v060). A dispatched worker's own
 * child processes (the bash tool, run_script, verification checks) run under
 * an OS sandbox modeled on Codex CLI's workspace-write mode: the filesystem is
 * readable, writes land only in the worker's writable roots and a private
 * /tmp, and network is off unless the run was granted it.
 */

/** `safety.sandbox` setting values. */
export const SANDBOX_MODES = ["auto", "required", "off"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

export type SandboxBackend = "bwrap" | "seatbelt";

/**
 * `safety.sandboxUnixSockets` values. `block` refuses new Unix-domain sockets
 * inside the sandbox, because a socket visible in the filesystem view or the
 * shared network namespace (a terminal multiplexer, X11, a daemon's control
 * socket) runs commands outside it. `allow` leaves them reachable.
 */
export const UNIX_SOCKET_MODES = ["block", "allow"] as const;
export type UnixSocketMode = (typeof UNIX_SOCKET_MODES)[number];

export const WORKER_SANDBOX_SPEC_VERSION = 1;

/**
 * Sandbox policy carried on the WorkerSpec. Dispatch fills it from settings
 * and the run's write scope; the worker applies it to every child process it
 * spawns through the shared exec seams. Mode `off` never travels: the field
 * is simply absent.
 */
export interface WorkerSandboxSpec {
	version: typeof WORKER_SANDBOX_SPEC_VERSION;
	mode: Exclude<SandboxMode, "off">;
	/** Paths bound writable. Empty for a read-only run. */
	writableRoots: ReadonlyArray<string>;
	/**
	 * Paths re-bound read-only after the writable roots, so a writable root
	 * cannot rewrite its own Git metadata or Clio project policy.
	 */
	readOnlyPaths: ReadonlyArray<string>;
	/**
	 * Git metadata the run may write, applied after `readOnlyPaths`. For a task
	 * worktree this is what `git add` and `git commit` on the task branch need;
	 * typed Git (Phase C) narrows or widens it here rather than in the builder.
	 */
	gitWritablePaths: ReadonlyArray<string>;
	/**
	 * Paths re-exposed read-only after the private /tmp is mounted. Only paths
	 * under /tmp need it (a worktree or repository that lives there).
	 */
	readableRoots: ReadonlyArray<string>;
	/** False isolates the command in an empty network namespace. */
	network: boolean;
	/** `safety.sandboxPassEnv`: variables the environment scrub keeps. Absent when empty. */
	passEnv?: ReadonlyArray<string>;
	/** Credential variables Clio's own targets read, scrubbed whatever their names. Absent when empty. */
	secretEnv?: ReadonlyArray<string>;
	/** `safety.sandboxUnixSockets: allow`. Absent blocks Unix-domain sockets (unix-sockets.ts). */
	unixSockets?: "allow";
}

/**
 * How a sandboxed command's inherited environment is scrubbed before the
 * sandbox starts (env-scrub.ts). Credential variables never reach a contained
 * command, which can reach the network without any judgment.
 */
export interface SandboxEnvPolicy {
	/** `safety.sandboxPassEnv`: names kept even when they look like credentials. */
	passEnv: ReadonlyArray<string>;
	/** Credential variables Clio's own targets read (`auth.apiKeyEnvVar`), removed whatever they are named. */
	secretNames: ReadonlyArray<string>;
}

/** A path hidden from the sandboxed process. Only existing paths can be masked. */
export interface SandboxMaskedPath {
	path: string;
	kind: "directory" | "file";
}

export type SandboxCommand = { argv: ReadonlyArray<string> } | { shell: string };

/** Everything the pure invocation builders need. All paths are absolute. */
export interface SandboxInvocationSpec {
	command: SandboxCommand;
	cwd: string;
	writableRoots: ReadonlyArray<string>;
	readOnlyPaths?: ReadonlyArray<string>;
	gitWritablePaths?: ReadonlyArray<string>;
	readableRoots?: ReadonlyArray<string>;
	network: boolean;
	maskedPaths: ReadonlyArray<SandboxMaskedPath>;
	/** Variables set inside the sandbox, after the spawn environment. */
	setEnv?: Readonly<Record<string, string>>;
	/** Variables removed inside the sandbox. */
	unsetEnv?: ReadonlyArray<string>;
	/**
	 * False keeps the host's /tmp instead of mounting a private one, so a
	 * writable root under it (the yolo script sandbox binds the real /tmp)
	 * reaches the operator's own files. Default true.
	 */
	privateTmp?: boolean;
	/**
	 * Bubblewrap: the seccomp program file that refuses AF_UNIX sockets
	 * (unix-sockets.ts). The launch opens it on a file descriptor bwrap reads
	 * with `--seccomp`. Absent loads no filter.
	 */
	unixSocketFilter?: string;
	/** Seatbelt: deny connecting to and binding Unix-domain sockets. Bubblewrap takes `unixSocketFilter` instead. */
	denyUnixSockets?: boolean;
}

export interface SandboxInvocation {
	file: string;
	args: string[];
}

export interface SandboxAvailability {
	available: boolean;
	backend: SandboxBackend | null;
	/** Resolved sandbox executable when available. */
	executable: string | null;
	/** Why the sandbox is unavailable, or a caveat when it is. */
	reason: string | null;
}
