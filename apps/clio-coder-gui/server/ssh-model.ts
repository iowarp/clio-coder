// Decisions for reaching a registered fleet node's own GUI over SSH, kept free of processes and
// sockets so node:test can exercise every branch. The argv shapes follow the worker transport in
// src/domains/dispatch/transport.ts, which is not a seam this app may import.

/** An SSH destination as the fleet registry records it. Empty and null read as unset. */
export interface SshEndpoint {
	readonly id: string;
	readonly host: string;
	readonly user?: string | null;
	readonly port?: number | null;
	readonly identityFile?: string | null;
	readonly connectTimeoutSec?: number | null;
	/** The node's worker entry; the CLI in front of its trailing `worker` word serves the GUI. */
	readonly clioCoderEntry?: string | null;
}

export const DEFAULT_SSH_CONNECT_TIMEOUT_SEC = 10;
/** The node's GUI stops itself after this long without a request or open stream. */
export const REMOTE_GUI_IDLE_MS = 10 * 60 * 1000;
/** Consecutive failed connections before the attachment stays failed until the operator opens it again. */
export const RECONNECT_ATTEMPTS = 5;

function port(value: number, name: string): string {
	if (!Number.isInteger(value) || value < 1 || value > 65535)
		throw new RangeError(`${name} must be a port from 1 to 65535.`);
	return String(value);
}

function destination(endpoint: SshEndpoint): string[] {
	if (endpoint.host.trim() === "" || endpoint.host.startsWith("-") || /\s/u.test(endpoint.host))
		throw new RangeError(`Fleet node ${endpoint.id} has no usable SSH host.`);
	const args: string[] = [];
	if (endpoint.port !== undefined && endpoint.port !== null) args.push("-p", port(endpoint.port, "SSH port"));
	if (endpoint.identityFile) args.push("-i", endpoint.identityFile);
	if (endpoint.user) args.push("-l", endpoint.user);
	return args;
}

function session(endpoint: SshEndpoint): string[] {
	const timeout =
		endpoint.connectTimeoutSec !== undefined &&
		endpoint.connectTimeoutSec !== null &&
		Number.isInteger(endpoint.connectTimeoutSec) &&
		endpoint.connectTimeoutSec > 0
			? endpoint.connectTimeoutSec
			: DEFAULT_SSH_CONNECT_TIMEOUT_SEC;
	return [
		"-o",
		"BatchMode=yes",
		"-o",
		`ConnectTimeout=${timeout}`,
		"-o",
		"ServerAliveInterval=15",
		"-o",
		"ServerAliveCountMax=3",
	];
}

/** The command channel: a byte pipe, never a terminal, that carries the token in and the ready line out. */
export function sshCommandArgs(endpoint: SshEndpoint, remoteCommand: string): string[] {
	return [...session(endpoint), "-T", ...destination(endpoint), endpoint.host, "--", remoteCommand];
}

/**
 * The forward that carries the proxied traffic. It runs no remote command and never rides on or
 * outlives an operator's multiplexed master, so stopping it stops exactly this forward.
 */
export function sshForwardArgs(endpoint: SshEndpoint, localPort: number, remotePort: number): string[] {
	return [
		...session(endpoint),
		"-N",
		"-o",
		"ExitOnForwardFailure=yes",
		"-o",
		"ControlMaster=no",
		"-o",
		"ControlPath=none",
		"-L",
		`127.0.0.1:${port(localPort, "Local forward port")}:127.0.0.1:${port(remotePort, "Remote GUI port")}`,
		...destination(endpoint),
		endpoint.host,
	];
}

/**
 * What the node's login shell runs to serve its own GUI for this app. The registry's worker entry
 * names the installed CLI with a trailing `worker`; a node registered by hand runs the `clio-coder`
 * on its PATH, which is what the worker transport assumes too.
 */
export function remoteGuiCommand(entry: string | null | undefined, idleMs = REMOTE_GUI_IDLE_MS): string {
	if (!Number.isInteger(idleMs) || idleMs < 1)
		throw new RangeError("The remote idle exit must be a positive number of milliseconds.");
	const trimmed = entry?.trim() ?? "";
	const cli = trimmed === "" ? "clio-coder" : trimmed.replace(/\s+worker$/u, "");
	return `${cli} gui --foreground --port 0 --no-open --idle-exit ${idleMs} --token-stdin`;
}

/** The port in a private server's ready line, which is its launch link, with or without a token fragment. */
export function parseReadyLine(line: string): number | null {
	const match = /^\[clio-coder:gui\] http:\/\/127\.0\.0\.1:(\d{1,5})\/\S*$/u.exec(line.trim());
	const value = Number(match?.[1]);
	return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null;
}

export interface BuildIdentity {
	readonly clio: string;
	readonly build: string | null;
}

/**
 * Whether this app's client may drive the node's server. The client is built with the server it
 * came from, so the package version must agree, and so must the exact build whenever both sides
 * know theirs; a source run reports no build and is trusted on its version alone.
 */
export function versionGate(
	id: string,
	local: BuildIdentity,
	remote: BuildIdentity,
): { ok: true } | { ok: false; detail: string } {
	const install = `Install this build there with: clio-coder fleet nodes install ${id} --yes`;
	if (remote.clio !== local.clio)
		return { ok: false, detail: `The node runs Clio Coder ${remote.clio} and this app is ${local.clio}. ${install}` };
	if (local.build !== null && remote.build !== null && local.build !== remote.build)
		return {
			ok: false,
			detail: `The node runs a different build of Clio Coder ${remote.clio} (${remote.build}, this app is ${local.build}). ${install}`,
		};
	return { ok: true };
}

/** How long to wait before reconnecting after `failures` consecutive failed connections, or null to stop. */
export function reconnectDelayMs(failures: number): number | null {
	if (!Number.isInteger(failures) || failures < 1 || failures > RECONNECT_ATTEMPTS) return null;
	return Math.min(1_000 * 2 ** (failures - 1), 30_000);
}
