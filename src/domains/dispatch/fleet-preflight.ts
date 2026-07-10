/**
 * Doctor fleet preflight: durable per-node eligibility evidence.
 *
 * A remote node is dispatch-eligible for a project only after one preflight
 * pass proved, over the node's real SSH channel: reachability, a
 * version-matched clio on the remote invocation path, path parity for the
 * project root (shared-filesystem assumption), and a writable remote state
 * dir. Results persist under the state dir so `clio doctor` (a separate
 * process) can grant eligibility that dispatch admission later checks; a
 * record is invalidated by a different host, project root, or local clio
 * version.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readClioVersion } from "../../core/package-root.js";
import { clioStateDir } from "../../core/xdg.js";
import { atomicWrite } from "../../engine/session.js";
import { buildSshArgs, type SshNodeEndpoint, shellQuote } from "./transport.js";

export interface FleetPreflightChecks {
	reachable: boolean;
	clioPresent: boolean;
	versionMatch: boolean;
	pathParity: boolean;
	stateDirWritable: boolean;
}

export interface FleetPreflightRecord {
	nodeId: string;
	host: string;
	projectRoot: string;
	ok: boolean;
	checkedAt: string;
	/** Local clio version at check time; a different local version invalidates the record. */
	localVersion: string;
	remoteVersion: string | null;
	detail: string | null;
	checks: FleetPreflightChecks;
}

interface FleetPreflightStoreFile {
	version: 1;
	records: FleetPreflightRecord[];
}

function storePath(): string {
	return join(clioStateDir(), "fleet-preflight.json");
}

export function readFleetPreflightRecords(): FleetPreflightRecord[] {
	const path = storePath();
	if (!existsSync(path)) return [];
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as FleetPreflightStoreFile;
		if (parsed?.version !== 1 || !Array.isArray(parsed.records)) return [];
		return parsed.records;
	} catch {
		return [];
	}
}

/** Upsert records keyed by (nodeId, projectRoot). */
export function recordFleetPreflight(records: ReadonlyArray<FleetPreflightRecord>): void {
	const existing = readFleetPreflightRecords();
	const merged = new Map<string, FleetPreflightRecord>();
	for (const record of existing) merged.set(`${record.nodeId}\0${record.projectRoot}`, record);
	for (const record of records) merged.set(`${record.nodeId}\0${record.projectRoot}`, record);
	const file: FleetPreflightStoreFile = { version: 1, records: [...merged.values()] };
	atomicWrite(storePath(), JSON.stringify(file, null, 2));
}

export interface FleetPreflightVerdict {
	ok: boolean;
	reason: string | null;
}

/**
 * Dispatch-admission view of the store. Fails closed: no record, a failing
 * record, a host mismatch, or a stale local version all deny with a reason
 * that names the fix.
 */
export function fleetPreflightVerdict(
	node: { id: string; host: string },
	projectRoot: string,
	records: ReadonlyArray<FleetPreflightRecord> = readFleetPreflightRecords(),
): FleetPreflightVerdict {
	const record = records.find((entry) => entry.nodeId === node.id && entry.projectRoot === projectRoot);
	if (!record) {
		return {
			ok: false,
			reason: `node '${node.id}' has not passed the fleet preflight for ${projectRoot}; run 'clio doctor'`,
		};
	}
	if (record.host !== node.host) {
		return {
			ok: false,
			reason: `node '${node.id}' preflight was recorded for host '${record.host}' but the node now points at '${node.host}'; run 'clio doctor'`,
		};
	}
	if (record.localVersion !== readClioVersion()) {
		return {
			ok: false,
			reason: `node '${node.id}' preflight predates a local clio upgrade (${record.localVersion} -> ${readClioVersion()}); run 'clio doctor'`,
		};
	}
	if (!record.ok) {
		return {
			ok: false,
			reason: `node '${node.id}' failed its last fleet preflight: ${record.detail ?? "see clio doctor"}`,
		};
	}
	return { ok: true, reason: null };
}

const PREFLIGHT_MARKER = "clio-preflight/1";
const DEFAULT_PREFLIGHT_TIMEOUT_MS = 20_000;

/**
 * One remote probe script, one SSH round trip. Marker lines keep parsing
 * order-independent and tolerant of login-shell noise. XDG_STATE_HOME
 * mirrors the local xdg resolution's Linux default; per-node CLIO_* dir
 * overrides are not visible over this channel and are unsupported.
 */
export function buildPreflightScript(node: SshNodeEndpoint, projectRoot: string): string {
	const entry = node.clioEntry !== undefined && node.clioEntry.trim().length > 0 ? node.clioEntry.trim() : "clio worker";
	// Version-check the CLI the worker invocation resolves to: strip the
	// trailing `worker` subcommand to get the base CLI invocation.
	const cliBase = entry.endsWith(" worker") ? entry.slice(0, -" worker".length) : null;
	const versionProbe =
		cliBase !== null
			? `v=$(${cliBase} --version 2>/dev/null | head -n 1); if [ -n "$v" ]; then echo "clio=$v"; else echo clio=missing; fi`
			: `echo clio=custom-entry`;
	return [
		`echo ${shellQuote(PREFLIGHT_MARKER)}`,
		`if cd ${shellQuote(projectRoot)} 2>/dev/null; then echo cwd=ok; else echo cwd=missing; fi`,
		versionProbe,
		`d="\${XDG_STATE_HOME:-$HOME/.local/state}/clio"; if mkdir -p "$d" 2>/dev/null && [ -w "$d" ]; then echo state=ok; else echo state=fail; fi`,
	].join("; ");
}

function parseSemver(text: string): string | null {
	const match = text.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
	return match?.[1] ?? null;
}

export interface FleetPreflightRunOptions {
	sshBinary?: string;
	timeoutMs?: number;
	now?: () => Date;
}

function runSsh(
	sshBinary: string,
	args: ReadonlyArray<string>,
	timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(sshBinary, [...args], { timeout: timeoutMs, encoding: "utf8" }, (error, stdout, stderr) => {
			const code =
				error === null
					? 0
					: typeof (error as { code?: unknown }).code === "number"
						? (error as { code: number }).code
						: 255;
			resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
		});
	});
}

/** Run the preflight against one node and return the (not yet persisted) record. */
export async function runFleetNodePreflight(
	node: SshNodeEndpoint,
	projectRoot: string,
	options?: FleetPreflightRunOptions,
): Promise<FleetPreflightRecord> {
	const sshBinary = options?.sshBinary ?? "ssh";
	const timeoutMs = options?.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;
	const localVersion = readClioVersion();
	const checkedAt = (options?.now?.() ?? new Date()).toISOString();
	const checks: FleetPreflightChecks = {
		reachable: false,
		clioPresent: false,
		versionMatch: false,
		pathParity: false,
		stateDirWritable: false,
	};
	const record: FleetPreflightRecord = {
		nodeId: node.id,
		host: node.host,
		projectRoot,
		ok: false,
		checkedAt,
		localVersion,
		remoteVersion: null,
		detail: null,
		checks,
	};
	const script = buildPreflightScript(node, projectRoot);
	const result = await runSsh(sshBinary, buildSshArgs(node, script), timeoutMs);
	if (!result.stdout.includes(PREFLIGHT_MARKER)) {
		const stderr = result.stderr.trim().split("\n").slice(-1)[0] ?? "";
		record.detail = `unreachable (ssh exit ${result.code}${stderr.length > 0 ? `: ${stderr}` : ""})`;
		return record;
	}
	checks.reachable = true;
	const lines = result.stdout.split("\n").map((line) => line.trim());
	checks.pathParity = lines.includes("cwd=ok");
	checks.stateDirWritable = lines.includes("state=ok");
	const clioLine = lines.find((line) => line.startsWith("clio="));
	const clioValue = clioLine?.slice("clio=".length) ?? "missing";
	if (clioValue === "custom-entry") {
		// A custom clioEntry that is not `<cli> worker` cannot be version-probed;
		// the operator vouches for it. Presence is asserted, match is assumed.
		checks.clioPresent = true;
		checks.versionMatch = true;
		record.remoteVersion = null;
	} else if (clioValue !== "missing") {
		checks.clioPresent = true;
		record.remoteVersion = parseSemver(clioValue);
		checks.versionMatch = record.remoteVersion !== null && record.remoteVersion === parseSemver(localVersion);
	}
	const failures: string[] = [];
	if (!checks.pathParity)
		failures.push(`project root ${projectRoot} missing on node (disjoint filesystems are unsupported)`);
	if (!checks.clioPresent) failures.push("clio not found on remote PATH (set fleet.nodes[].clioEntry or install clio)");
	else if (!checks.versionMatch) {
		failures.push(
			`clio version mismatch (local ${parseSemver(localVersion) ?? localVersion}, remote ${record.remoteVersion ?? "unknown"})`,
		);
	}
	if (!checks.stateDirWritable) failures.push("remote clio state dir is not writable");
	record.ok = failures.length === 0;
	record.detail = failures.length > 0 ? failures.join("; ") : null;
	return record;
}
