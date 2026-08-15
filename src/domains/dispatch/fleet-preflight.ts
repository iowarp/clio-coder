/**
 * Doctor fleet preflight: durable per-node eligibility evidence.
 *
 * A remote node is dispatch-eligible for a project only after one preflight
 * pass proved, over the node's real SSH channel: reachability, a
 * version-matched clio on the remote invocation path, path parity for the
 * project root (shared-filesystem assumption), and a writable remote state
 * dir. Results persist under the state dir so `clio-coder doctor` (a separate
 * process) can grant eligibility that dispatch admission later checks; a
 * record is invalidated by a different host, project root, or local clio
 * version.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { readClioVersion } from "../../core/package-root.js";
import { shellQuote } from "../../core/shell-quote.js";
import { clioStateDir } from "../../core/xdg.js";
import { atomicWrite } from "../../engine/session.js";
import {
	evaluateRouteFacts,
	type FactState,
	type NodeResourceFact,
	type NodeTargetFact,
	type RouteFactEvaluationOptions,
	type RouteFactRequirement,
	type RouteFactVerdict,
} from "./route-facts.js";
import { buildSshArgs, type SshNodeEndpoint } from "./transport.js";
import { endpointIdentityHash } from "./worker-protocol.js";

export interface FleetPreflightChecks {
	reachable: boolean;
	clioPresent: boolean;
	versionMatch: boolean;
	pathParity: boolean;
	stateDirWritable: boolean;
}

/** Targets to probe from the node, resolved from settings by the caller. */
export interface FleetPreflightTarget {
	id: string;
	url?: string;
	wireModelId?: string;
	runtimeId: string;
}

export interface FleetPreflightRecord {
	nodeId: string;
	host: string;
	projectRoot: string;
	ok: boolean;
	checkedAt: string;
	/** Local clio-coder version at check time; a different local version invalidates the record. */
	localVersion: string;
	remoteVersion: string | null;
	detail: string | null;
	checks: FleetPreflightChecks;
	/**
	 * Per-target facts observed from this node. A `localhost` endpoint means a
	 * different machine on every node, so these are the only endpoint facts that
	 * may decide whether this node can serve that target.
	 */
	targets: NodeTargetFact[];
	/** Bounded resource facts for this node; unknown values stay null. */
	resources: NodeResourceFact | null;
}

interface FleetPreflightStoreFile {
	version: 2;
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
		// One current version. A store written by an earlier release carries no
		// node-local target facts, so it is discarded and re-probed rather than
		// read as if its silence meant "no requirement".
		if (parsed?.version !== 2 || !Array.isArray(parsed.records)) return [];
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
	const file: FleetPreflightStoreFile = { version: 2, records: [...merged.values()] };
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
			reason: `node '${node.id}' has not passed the fleet preflight for ${projectRoot}; run 'clio-coder doctor'`,
		};
	}
	if (record.host !== node.host) {
		return {
			ok: false,
			reason: `node '${node.id}' preflight was recorded for host '${record.host}' but the node now points at '${node.host}'; run 'clio-coder doctor'`,
		};
	}
	if (record.localVersion !== readClioVersion()) {
		return {
			ok: false,
			reason: `node '${node.id}' preflight predates a local clio-coder upgrade (${record.localVersion} -> ${readClioVersion()}); run 'clio-coder doctor'`,
		};
	}
	if (!record.ok) {
		return {
			ok: false,
			reason: `node '${node.id}' failed its last fleet preflight: ${record.detail ?? "see clio-coder doctor"}`,
		};
	}
	return { ok: true, reason: null };
}

/**
 * Route-admission view of the stored node-local facts. Every fact is keyed by
 * the node that observed it, so a requirement for node B is never satisfied by
 * evidence node A produced.
 */
export function routeFactVerdict(
	requirement: RouteFactRequirement,
	records: ReadonlyArray<FleetPreflightRecord> = readFleetPreflightRecords(),
	options?: RouteFactEvaluationOptions,
): RouteFactVerdict {
	const targets: NodeTargetFact[] = [];
	const resources: NodeResourceFact[] = [];
	for (const record of records) {
		targets.push(...record.targets);
		if (record.resources !== null) resources.push(record.resources);
	}
	return evaluateRouteFacts(targets, resources, requirement, options);
}

const PREFLIGHT_MARKER = "clio-preflight/1";
const DEFAULT_PREFLIGHT_TIMEOUT_MS = 20_000;

/**
 * One remote probe script, one SSH round trip. Marker lines keep parsing
 * order-independent and tolerant of login-shell noise. XDG_STATE_HOME
 * mirrors the local xdg resolution's Linux default; per-node CLIO_CODER_* dir
 * overrides are not visible over this channel and are unsupported.
 */
function buildPreflightScript(
	node: SshNodeEndpoint,
	projectRoot: string,
	targets: ReadonlyArray<FleetPreflightTarget> = [],
): string {
	const entry =
		node.clioEntry !== undefined && node.clioEntry.trim().length > 0 ? node.clioEntry.trim() : "clio-coder worker";
	// Version-check the CLI the worker invocation resolves to: strip the
	// trailing `worker` subcommand to get the base CLI invocation.
	const cliBase = entry.endsWith(" worker") ? entry.slice(0, -" worker".length) : null;
	const versionProbe =
		cliBase !== null
			? `v=$(${cliBase} --version 2>/dev/null | head -n 1); if [ -n "$v" ]; then echo "clio=$v"; else echo clio=missing; fi`
			: `echo clio=custom-entry`;
	const lines = [
		`echo ${shellQuote(PREFLIGHT_MARKER)}`,
		`if cd ${shellQuote(projectRoot)} 2>/dev/null; then echo cwd=ok; else echo cwd=missing; fi`,
		versionProbe,
		`d="\${XDG_STATE_HOME:-$HOME/.local/state}/clio-coder"; if mkdir -p "$d" 2>/dev/null && [ -w "$d" ]; then echo state=ok; else echo state=fail; fi`,
		// Resource observation runs on the node. A node without nvidia-smi reports
		// unknown; it never reports zero GPUs, which a fit requirement would read
		// as a proven absence rather than an absence of evidence.
		`echo "cpu=$(nproc 2>/dev/null || echo unknown)"`,
		`echo "memkb=$(awk '/MemTotal/{print $2}' /proc/meminfo 2>/dev/null || echo unknown)"`,
		`g=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null); if [ -n "$g" ]; then echo "gpu=$(echo "$g" | wc -l)"; echo "vrammb=$(echo "$g" | paste -sd+ - | bc 2>/dev/null || echo unknown)"; else echo gpu=unknown; echo vrammb=unknown; fi`,
	];
	for (const target of targets) {
		// The endpoint is resolved here, on the node. An orchestrator-local probe
		// of the same URL would describe a different machine entirely.
		if (target.url === undefined || target.url.trim().length === 0) {
			lines.push(`echo ${shellQuote(`target=${target.id}:noendpoint`)}`);
			continue;
		}
		const modelsUrl = `${target.url.replace(/\/+$/u, "")}/v1/models`;
		lines.push(
			`b=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' ${shellQuote(modelsUrl)} 2>/dev/null || echo 000); ` +
				`m=$(curl -sS -m 5 ${shellQuote(modelsUrl)} 2>/dev/null || echo ""); ` +
				`echo ${shellQuote(`target=${target.id}:`)}"$b"; ` +
				(target.wireModelId !== undefined
					? `case "$m" in *${shellQuote(target.wireModelId).slice(1, -1)}*) echo ${shellQuote(`model=${target.id}:true`)};; *) echo ${shellQuote(`model=${target.id}:false`)};; esac`
					: `echo ${shellQuote(`model=${target.id}:unknown`)}`),
		);
	}
	return lines.join("; ");
}

function parseSemver(text: string): string | null {
	const match = text.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
	return match?.[1] ?? null;
}

export interface FleetPreflightRunOptions {
	sshBinary?: string;
	timeoutMs?: number;
	now?: () => Date;
	/** Targets to probe from this node; omitted means node health only. */
	targets?: ReadonlyArray<FleetPreflightTarget>;
}

function parseUnknownableNumber(lines: ReadonlyArray<string>, prefix: string, scale = 1): number | null {
	const line = lines.find((entry) => entry.startsWith(prefix));
	if (line === undefined) return null;
	const raw = line.slice(prefix.length).trim();
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) && value >= 0 ? value * scale : null;
}

/**
 * Turn the node's probe output into per-target facts. Anything the node did
 * not answer stays `unknown`: an absent line is missing evidence, and reading
 * it as a negative would let one flaky probe permanently condemn a route.
 */
function parseTargetFacts(
	lines: ReadonlyArray<string>,
	targets: ReadonlyArray<FleetPreflightTarget>,
	probedAt: string,
	probeDurationMs: number,
): NodeTargetFact[] {
	return targets.map((target) => {
		const statusLine = lines.find((entry) => entry.startsWith(`target=${target.id}:`));
		const status = statusLine?.slice(`target=${target.id}:`.length).trim() ?? "";
		const code = Number.parseInt(status, 10);
		const reachable: FactState =
			status === ""
				? "unknown"
				: status === "noendpoint"
					? "unknown"
					: Number.isFinite(code) && code >= 200 && code < 500
						? "true"
						: "false";
		const modelLine = lines.find((entry) => entry.startsWith(`model=${target.id}:`));
		const modelValue = modelLine?.slice(`model=${target.id}:`.length).trim();
		const modelAvailable: FactState = modelValue === "true" ? "true" : modelValue === "false" ? "false" : "unknown";
		return {
			nodeId: "",
			targetId: target.id,
			reachable,
			// The runtime the target names is registered in this same release on
			// every node, and the version check already proved release parity.
			runtimeCompatible: reachable === "true" ? "true" : "unknown",
			modelAvailable,
			// A worker observes only the models it loads itself, so residency is
			// never inferred from an endpoint listing.
			modelResident: "unknown",
			endpointIdentityHash: endpointIdentityHash(target.url),
			wireModelId: target.wireModelId ?? null,
			probedAt,
			probeDurationMs,
		};
	});
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
	const targets = options?.targets ?? [];
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
		targets: [],
		resources: null,
	};
	const script = buildPreflightScript(node, projectRoot, targets);
	const probeStartedAt = performance.now();
	const result = await runSsh(sshBinary, buildSshArgs(node, script), timeoutMs);
	// Probe latency is durable eligibility evidence compared across nodes and
	// across passes, so it is measured on the monotonic clock.
	const probeDurationMs = Math.round(performance.now() - probeStartedAt);
	if (!result.stdout.includes(PREFLIGHT_MARKER)) {
		const stderr = result.stderr.trim().split("\n").slice(-1)[0] ?? "";
		record.detail = `unreachable (ssh exit ${result.code}${stderr.length > 0 ? `: ${stderr}` : ""})`;
		return record;
	}
	checks.reachable = true;
	const lines = result.stdout.split("\n").map((line) => line.trim());
	record.targets = parseTargetFacts(lines, targets, checkedAt, probeDurationMs).map((fact) => ({
		...fact,
		nodeId: node.id,
	}));
	record.resources = {
		nodeId: node.id,
		labels: [...(node.labels ?? [])],
		cpuCount: parseUnknownableNumber(lines, "cpu="),
		totalMemoryBytes: parseUnknownableNumber(lines, "memkb=", 1024),
		gpuCount: parseUnknownableNumber(lines, "gpu="),
		vramBytes: parseUnknownableNumber(lines, "vrammb=", 1024 * 1024),
		observedAt: checkedAt,
	};
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
	if (!checks.clioPresent)
		failures.push("clio-coder not found on remote PATH (set fleet.nodes[].clioEntry or install clio-coder)");
	else if (!checks.versionMatch) {
		failures.push(
			`clio-coder version mismatch (local ${parseSemver(localVersion) ?? localVersion}, remote ${record.remoteVersion ?? "unknown"})`,
		);
	}
	if (!checks.stateDirWritable) failures.push("remote clio-coder state dir is not writable");
	record.ok = failures.length === 0;
	record.detail = failures.length > 0 ? failures.join("; ") : null;
	return record;
}
