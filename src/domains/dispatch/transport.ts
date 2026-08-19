/**
 * Worker transport ladder.
 *
 * One interface, one wire protocol: a WorkerSpec JSON line into the worker's
 * stdin, NDJSON events out of its stdout, stderr tail for diagnostics. The
 * `local` tier is today's subprocess fork; the `ssh` tier launches the same
 * worker entry on a remote node over an SSH-tunneled channel. Container and
 * cloud tiers are future implementors of this same interface, not variations
 * of the protocol.
 *
 * SSH tier invariants:
 *   - The remote environment is a whitelist, never the orchestrator's
 *     process.env. Remote workers default to CLIO_CODER_RESIDENCY=observe so a
 *     worker on a node that serves models for the operator can never evict a
 *     resident model.
 *   - The orchestrator cwd is entered on the remote node (shared-filesystem
 *     assumption; path parity is a doctor preflight, and placement refuses
 *     nodes that have not passed it).
 *   - Abort closes the channel (the worker's parent monitor aborts on stdin
 *     EOF) and escalates to a remote `kill` fallback using the pid the worker
 *     announced, so no remote process is stranded.
 */

import { spawn } from "node:child_process";
import { AI_AGENT_NAME } from "../../core/agent-environment.js";
import { shellQuote } from "../../core/shell-quote.js";
import type { WorkerSpec } from "../../worker/spec-contract.js";
import type { RunNodeIdentity } from "./types.js";
import {
	type SpawnedWorker,
	type SpawnOptions,
	spawnNativeWorker,
	spawnWorkerProcess,
	type WorkerProcessOptions,
} from "./worker-spawn.js";

export type WorkerTransportKind = "local" | "ssh";

/**
 * What a placement hands a transport: every process option except the env,
 * which each transport owns. This is derived from WorkerProcessOptions rather
 * than restated, because a restated subset is how a placed worker's
 * `onLedgerPost` went missing: this type once listed only cwd, both transports
 * forwarded exactly that, and every callback dispatch passed for a worker on a
 * fleet node was dropped at the seam. Assigning the wider option literal to the
 * narrower parameter is legal, so nothing complained.
 */
export type WorkerTransportSpawnOptions = Omit<WorkerProcessOptions, "env">;

export interface WorkerTransport {
	readonly kind: WorkerTransportKind;
	readonly node: RunNodeIdentity;
	spawn(spec: WorkerSpec, opts?: WorkerTransportSpawnOptions): SpawnedWorker;
}

/** Connection facts for one SSH-reachable fleet node. */
export interface SshNodeEndpoint {
	id: string;
	host: string;
	user?: string;
	port?: number;
	identityFile?: string;
	/**
	 * Remote worker-entry invocation. Defaults to `clio-coder worker`, which requires
	 * a version-matched clio-coder on the remote PATH (the doctor fleet preflight
	 * verifies both). Operators with non-PATH installs point this at their
	 * entry, e.g. `/opt/clio-coder/bin/clio-coder worker`.
	 */
	clioCoderEntry?: string;
	/**
	 * Residency posture exported to the remote worker. Defaults to "observe":
	 * remote workers must never evict models resident on their node. "manage"
	 * is an explicit per-node opt-in.
	 */
	residency?: "observe" | "manage";
	connectTimeoutSec?: number;
	/**
	 * Operator-declared capability labels for this node, exported to the remote
	 * worker so its announcement attests the configured labels alongside the
	 * resource values it observes.
	 */
	labels?: ReadonlyArray<string>;
}

export interface SshTransportOptions {
	/** ssh client binary; contract tests substitute a fake shim. */
	sshBinary?: string;
	shutdownGraceMs?: number;
}

export const LOCAL_NODE_ID = "local";

export function localNodeIdentity(): RunNodeIdentity {
	return { id: LOCAL_NODE_ID, kind: "local" };
}

export function createLocalWorkerTransport(opts?: Omit<SpawnOptions, "cwd">): WorkerTransport {
	return {
		kind: "local",
		node: localNodeIdentity(),
		spawn(spec, spawnOpts) {
			// The caller's per-spawn options ride over the transport's own defaults.
			return spawnNativeWorker(spec, { ...opts, ...spawnOpts });
		},
	};
}

const DEFAULT_SSH_CONNECT_TIMEOUT_SEC = 10;
const DEFAULT_REMOTE_CLIO_ENTRY = "clio-coder worker";

/**
 * The env whitelist exported to the remote worker. Nothing from the
 * orchestrator's process.env crosses the wire; the WorkerSpec already carries
 * the resolved target (whose URL resolves on the remote node, so a
 * localhost-served model plane is per-node by construction) and any
 * orchestrator-supplied credential.
 */
function remoteEnvAssignments(node: SshNodeEndpoint): string {
	const residency = node.residency ?? "observe";
	// `$$` is the login shell's pid, and it leads the process group the remote
	// command runs in. `exec` replaces that shell in place, so the worker
	// inherits both the pid and the group leadership, and the value it announces
	// is the group an abort must signal.
	const labels = (node.labels ?? []).map((label) => label.trim()).filter((label) => label.length > 0);
	const labelAssignment = labels.length > 0 ? ` CLIO_CODER_WORKER_LABELS=${shellQuote(labels.join(","))}` : "";
	return `AI_AGENT=${AI_AGENT_NAME} CLIO_CODER_RESIDENCY=${residency} CLIO_CODER_WORKER_PGID=$$${labelAssignment}`;
}

export function buildRemoteWorkerCommand(node: SshNodeEndpoint, cwd: string): string {
	const entry =
		node.clioCoderEntry !== undefined && node.clioCoderEntry.trim().length > 0
			? node.clioCoderEntry.trim()
			: DEFAULT_REMOTE_CLIO_ENTRY;
	return `cd ${shellQuote(cwd)} && exec env ${remoteEnvAssignments(node)} ${entry}`;
}

export function buildSshArgs(node: SshNodeEndpoint, remoteCommand: string): string[] {
	const connectTimeout = node.connectTimeoutSec ?? DEFAULT_SSH_CONNECT_TIMEOUT_SEC;
	const args: string[] = [
		"-o",
		"BatchMode=yes",
		"-o",
		`ConnectTimeout=${connectTimeout}`,
		// The channel is a byte pipe, never a terminal: a pty would translate
		// newlines and inject control sequences into the NDJSON stream.
		"-T",
	];
	if (node.port !== undefined) args.push("-p", String(node.port));
	if (node.identityFile !== undefined && node.identityFile.length > 0) args.push("-i", node.identityFile);
	if (node.user !== undefined && node.user.length > 0) args.push("-l", node.user);
	args.push(node.host, "--", remoteCommand);
	return args;
}

export function createSshWorkerTransport(node: SshNodeEndpoint, opts?: SshTransportOptions): WorkerTransport {
	const sshBinary = opts?.sshBinary ?? "ssh";
	const identity: RunNodeIdentity = { id: node.id, kind: "ssh", host: node.host };
	return {
		kind: "ssh",
		node: identity,
		spawn(spec, spawnOpts) {
			const cwd = spawnOpts?.cwd ?? process.cwd();
			const remote: { pid: number | null; processGroupId: number | null } = { pid: null, processGroupId: null };
			const killRemote = (): void => {
				// The negative pid targets the whole remote process group, so a
				// runtime's own children go with it. Without an announced group the
				// single pid is the most the orchestrator can prove it may signal.
				const group = remote.processGroupId;
				const command =
					group !== null
						? `kill -TERM -${group} 2>/dev/null || kill -TERM ${remote.pid ?? group} 2>/dev/null || true`
						: remote.pid !== null
							? `kill -TERM ${remote.pid} 2>/dev/null || true`
							: null;
				if (command === null) return;
				// Best-effort second channel: the primary signal is the channel
				// close (the worker's parent monitor aborts and exits on stdin
				// EOF); this covers a worker that stopped reading its stdin.
				try {
					const fallback = spawn(sshBinary, buildSshArgs(node, command), {
						stdio: "ignore",
						detached: true,
					});
					fallback.unref();
				} catch {
					// the channel-close path remains the primary termination signal
				}
			};
			// The remote command cds itself, so cwd is consumed here and never
			// applied to the local ssh client. The announce and forced-kill hooks
			// are the transport's own and compose with the caller's rather than
			// replacing them; every other option is forwarded as handed.
			const { cwd: _consumedCwd, onAnnounce, onForcedKill, ...forwarded } = spawnOpts ?? {};
			return spawnWorkerProcess(sshBinary, buildSshArgs(node, buildRemoteWorkerCommand(node, cwd)), spec, {
				...(opts?.shutdownGraceMs !== undefined ? { shutdownGraceMs: opts.shutdownGraceMs } : {}),
				...forwarded,
				env: process.env,
				onAnnounce: (attestation) => {
					remote.pid = attestation.pid;
					remote.processGroupId = attestation.processGroupId;
					onAnnounce?.(attestation);
				},
				onForcedKill: () => {
					killRemote();
					onForcedKill?.();
				},
			});
		},
	};
}
