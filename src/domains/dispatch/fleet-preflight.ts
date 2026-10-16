/**
 * Doctor fleet preflight: durable per-node eligibility evidence.
 *
 * A remote node is dispatch-eligible for a project only after one preflight
 * pass proved, over the node's real SSH channel: reachability, a
 * version-matched clio on the remote invocation path, path parity for the
 * project root (shared storage or a matching clean checkout), and a writable remote state
 * dir. Results persist under the state dir so `clio-coder doctor` (a separate
 * process) can grant eligibility that dispatch admission later checks; a
 * record is invalidated by a different host, project root, or local clio
 * version.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readClioVersion } from "../../core/package-root.js";
import { runCommandVector } from "../../core/safe-exec.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { shellQuote } from "../../core/shell-quote.js";
import { withStateFileLockSync } from "../../core/state-file-lock.js";
import { resolveClioDirs } from "../../core/xdg.js";
import { WORKER_SPEC_HOOKLESS_VERSION, WORKER_SPEC_VERSION, WORKER_SPEC_VERSIONS } from "../../worker/spec-contract.js";
import type { FleetProjectVerification } from "./fleet-project-verification.js";
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
	/** Only supported listing protocols are probed; other runtimes remain unknown. */
	listing?: "openai" | "ollama";
	headers?: Record<string, string>;
}

export interface FleetPreflightRecord {
	nodeId: string;
	connectionHash?: string;
	project?: FleetProjectVerification;
	host: string;
	projectRoot: string;
	ok: boolean;
	checkedAt: string;
	/** Local clio-coder version at check time; a different local version invalidates the record. */
	localVersion: string;
	remoteVersion: string | null;
	/** Worker spec versions this install wrote at check time; a different set invalidates the record. */
	localWorkerSpecs?: number[];
	/**
	 * Spec versions the node's worker reported reading; null when it did not
	 * report them, which counts as reading the hook-free version only.
	 */
	remoteWorkerSpecs?: number[] | null;
	detail: string | null;
	/** What a passing node cannot run, such as hooked dispatches on a build that predates the spec report. */
	note?: string;
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
	version: 3;
	records: FleetPreflightRecord[];
}

function storePath(): string {
	return join(resolveClioDirs().state, "fleet-preflight.json");
}

export function readFleetPreflightRecords(): FleetPreflightRecord[] {
	const path = storePath();
	if (!existsSync(path)) return [];
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as FleetPreflightStoreFile;
		// One current version. A store written by an earlier release carries no
		// connection hashes, so it is discarded and re-probed rather than
		// read as if its silence meant "no requirement".
		if (parsed?.version !== 3 || !Array.isArray(parsed.records)) return [];
		return parsed.records;
	} catch {
		return [];
	}
}

/**
 * Upsert records keyed by (nodeId, projectRoot). `nodes test --record` and `doctor --fix`
 * write: plain doctor stays observation-only, and dispatch admission fails
 * closed on a node that has no stored passing record.
 */
export function recordFleetPreflight(records: ReadonlyArray<FleetPreflightRecord>): void {
	withStateFileLockSync(storePath(), () => {
		const merged = new Map<string, FleetPreflightRecord>();
		for (const record of [...readFleetPreflightRecords(), ...records]) {
			merged.set(`${record.nodeId}\0${record.projectRoot}`, record);
		}
		const file: FleetPreflightStoreFile = { version: 3, records: [...merged.values()] };
		safeResourceWrite(storePath(), JSON.stringify(file, null, 2), { mode: 0o600 });
	});
}

/** A day bounds stale access/runtime evidence while keeping explicit checks practical. */
export const FLEET_PREFLIGHT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function fleetConnectionHash(node: SshNodeEndpoint): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				host: node.host,
				user: node.user ?? null,
				port: node.port ?? null,
				identityFile: node.identityFile ?? null,
				clioCoderEntry: node.clioCoderEntry ?? "clio-coder worker",
				clioCoderVersionCommand: node.clioCoderVersionCommand ?? null,
				clientVersion: readClioVersion(),
			}),
		)
		.digest("hex");
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
	node: SshNodeEndpoint,
	projectRoot: string,
	records: ReadonlyArray<FleetPreflightRecord> = readFleetPreflightRecords(),
): FleetPreflightVerdict {
	const record = records.find((entry) => entry.nodeId === node.id && entry.projectRoot === projectRoot);
	if (!record) {
		return {
			ok: false,
			reason: `node '${node.id}' has not passed the fleet preflight for ${projectRoot}; run 'clio-coder doctor --fix'`,
		};
	}
	if (record.host !== node.host) {
		return {
			ok: false,
			reason: `node '${node.id}' preflight was recorded for host '${record.host}' but the node now points at '${node.host}'; run 'clio-coder doctor --fix'`,
		};
	}
	if (record.localWorkerSpecs?.join(" ") !== WORKER_SPEC_VERSIONS.join(" ")) {
		return {
			ok: false,
			reason: `node '${node.id}' preflight predates this build's worker spec versions (${WORKER_SPEC_VERSIONS.join(", ")}); run 'clio-coder doctor --fix'`,
		};
	}
	if (record.localVersion !== readClioVersion()) {
		return {
			ok: false,
			reason: `node '${node.id}' preflight predates a local clio-coder upgrade (${record.localVersion} -> ${readClioVersion()}); run 'clio-coder doctor --fix'`,
		};
	}
	if (record.connectionHash !== fleetConnectionHash(node)) {
		return {
			ok: false,
			reason: `node '${node.id}' connection or worker entry changed; run 'clio-coder fleet nodes test ${node.id} --record'`,
		};
	}
	const age = Date.now() - Date.parse(record.checkedAt);
	if (!Number.isFinite(age) || age < 0 || age > FLEET_PREFLIGHT_MAX_AGE_MS) {
		return {
			ok: false,
			reason: `node '${node.id}' preflight expired (checks last one day); run 'clio-coder fleet nodes test ${node.id} --record'`,
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

const PREFLIGHT_MARKER = "clio-coder-preflight/1";
const DEFAULT_PREFLIGHT_TIMEOUT_MS = 20_000;

/**
 * One remote probe script, one SSH round trip. Marker lines keep parsing
 * order-independent and tolerant of login-shell noise. XDG_STATE_HOME
 * mirrors the local xdg resolution's Linux default; per-node CLIO_CODER_* dir
 * overrides are not visible over this channel and are unsupported.
 */
function buildPreflightScript(node: SshNodeEndpoint, projectRoot: string): string {
	const entry =
		node.clioCoderEntry !== undefined && node.clioCoderEntry.trim().length > 0
			? node.clioCoderEntry.trim()
			: "clio-coder worker";
	// Version-check the CLI the worker invocation resolves to: strip the
	// trailing `worker` subcommand to get the base CLI invocation.
	const cliBase = entry.endsWith(" worker") ? entry.slice(0, -" worker".length) : null;
	const versionCommand = node.clioCoderVersionCommand ?? (cliBase !== null ? `${cliBase} --version` : null);
	// The spec versions the node's worker reads. A build older than the report
	// ignores the flag and prints its version line, which reads as unreported.
	const specProbe =
		cliBase !== null
			? `w=$(${cliBase} version --worker-specs 2>/dev/null | head -n 1); echo "workerSpecs=$w"`
			: "echo workerSpecs=unverified-entry";
	const versionProbe =
		versionCommand !== null
			? `v=$(${versionCommand} 2>/dev/null | head -n 1); if [ -n "$v" ]; then echo "clioCoder=$v"; else echo clioCoder=missing; fi`
			: "echo clioCoder=unverified-entry";
	const lines = [
		`echo ${shellQuote(PREFLIGHT_MARKER)}`,
		`if cd ${shellQuote(projectRoot)} 2>/dev/null; then echo cwd=ok; else echo cwd=missing; fi`,
		versionProbe,
		specProbe,
		`d="\${XDG_STATE_HOME:-$HOME/.local/state}/clio-coder"; if [ -d "$d" ]; then if [ -w "$d" ]; then echo state=ok; else echo state=fail; fi; else p="$d"; while [ ! -e "$p" ] && [ "$p" != / ]; do p=$(dirname "$p"); done; if [ -d "$p" ] && [ -w "$p" ] && [ -x "$p" ]; then echo state=creatable; else echo state=fail; fi; fi`,
		// Resource observation runs on the node. A node without nvidia-smi reports
		// unknown; it never reports zero GPUs, which a fit requirement would read
		// as a proven absence rather than an absence of evidence.
		`echo "cpu=$(nproc 2>/dev/null || echo unknown)"`,
		`echo "memkb=$(awk '/MemTotal/{print $2}' /proc/meminfo 2>/dev/null || echo unknown)"`,
		`g=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null); if [ -n "$g" ]; then echo "gpu=$(echo "$g" | wc -l)"; echo "vrammb=$(echo "$g" | paste -sd+ - | bc 2>/dev/null || echo unknown)"; else echo gpu=unknown; echo vrammb=unknown; fi`,
	];
	return lines.join("; ");
}

/** The spec versions a node's `version --worker-specs` printed; null for anything else. */
function parseWorkerSpecs(reported: string): number[] | null {
	const text = reported.trim();
	return /^\d+(?: \d+)*$/.test(text) ? text.split(" ").map(Number) : null;
}

/**
 * Why a node's worker cannot serve every spec this build writes, or null when
 * it can. An unreported node is handled by the caller as hook-free only.
 */
function workerSpecMismatch(specs: ReadonlyArray<number>): string | null {
	const local = WORKER_SPEC_VERSIONS.join(" and ");
	if (WORKER_SPEC_VERSIONS.every((version) => specs.includes(version))) return null;
	return `worker spec mismatch (this build writes versions ${local}, the node's worker reads ${specs.join(" and ")})`;
}

function parseSemver(text: string): string | null {
	const match = text.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/);
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
/** Credentials are sent over stdin; neither argv nor persisted facts contains them. */
const TARGET_PROBE_SCRIPT = String.raw`
const fs = require('node:fs');
(async () => {
 const targets = JSON.parse(fs.readFileSync(0, 'utf8'));
 const facts = await Promise.all(targets.map(async t => {
  const out = {id:t.id, reachable:'unknown', modelAvailable:'unknown', runtimeCompatible:'unknown'};
  if (!t.url) return out;
  let url;
  try { url = new URL(t.url); } catch { return out; }
  if (!['http:', 'https:'].includes(url.protocol)) return out;
  if (t.listing === 'openai') url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1/models';
  else if (t.listing === 'ollama') url.pathname = url.pathname.replace(/\/+$/, '') + '/api/tags';
  try {
   const response = await fetch(url, {headers:t.headers, redirect:'error', signal:AbortSignal.timeout(5000)});
   out.reachable = 'true';
   out.authentication = response.status === 401 || response.status === 403 ? 'false' : response.ok ? 'true' : 'unknown';
   out.httpStatus = response.status;
   if (!response.ok || !t.listing) return out;
   const reader = response.body.getReader(); let size = 0; const chunks = [];
   for (;;) { const {done,value} = await reader.read(); if (done) break; size += value.length; if (size > 1048576) { await reader.cancel(); return out; } chunks.push(Buffer.from(value)); }
   const body = JSON.parse(Buffer.concat(chunks).toString());
   const rows = t.listing === 'ollama' ? body.models : body.data;
   if (!Array.isArray(rows) || !rows.every(r => r && typeof (t.listing === 'ollama' ? r.name : r.id) === 'string')) return out;
   // A model catalog proves listing support, not generation/runtime compatibility.
   if (t.wireModelId) out.modelAvailable = rows.some(r => (t.listing === 'ollama' ? r.name : r.id) === t.wireModelId) ? 'true' : 'false';
  } catch { if (out.reachable === 'unknown') out.reachable = 'false'; }
  return out;
 }));
 console.log('clio-coder-targets=' + JSON.stringify(facts));
})().catch(() => process.exitCode = 1);
`;

async function probeTargets(
	node: SshNodeEndpoint,
	targets: ReadonlyArray<FleetPreflightTarget>,
	sshBinary: string,
	checkedAt: string,
): Promise<NodeTargetFact[]> {
	if (targets.length === 0) return [];
	const result = await runCommandVector(sshBinary, buildSshArgs(node, `node -e ${shellQuote(TARGET_PROBE_SCRIPT)}`), {
		input: JSON.stringify(targets),
		timeoutMs: 15_000,
		maxOutputBytes: 128_000,
	});
	let observations: Array<{
		id: string;
		reachable: FactState;
		modelAvailable: FactState;
		runtimeCompatible: FactState;
		authentication?: FactState;
		httpStatus?: number;
	}> = [];
	try {
		const line = result.stdout.split("\n").find((line) => line.startsWith("clio-coder-targets="));
		if (line) {
			const parsed: unknown = JSON.parse(line.slice("clio-coder-targets=".length));
			if (Array.isArray(parsed)) observations = parsed.filter((item) => item && typeof item.id === "string");
		}
	} catch {
		// A broken probe carries unknown facts and cannot grant route readiness.
	}
	return targets.map((target) => {
		const observation = observations.find((item) => item.id === target.id);
		return {
			nodeId: node.id,
			targetId: target.id,
			reachable: observation?.reachable ?? "unknown",
			modelAvailable: observation?.modelAvailable ?? "unknown",
			runtimeCompatible: observation?.runtimeCompatible ?? "unknown",
			authentication: observation?.authentication ?? "unknown",
			httpStatus: observation?.httpStatus ?? null,
			modelResident: "unknown",
			endpointIdentityHash: endpointIdentityHash(target.url),
			wireModelId: target.wireModelId ?? null,
			probedAt: checkedAt,
			probeDurationMs: Math.round(result.durationMs),
		};
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
		connectionHash: fleetConnectionHash(node),
		host: node.host,
		projectRoot,
		ok: false,
		checkedAt,
		localVersion,
		remoteVersion: null,
		localWorkerSpecs: [...WORKER_SPEC_VERSIONS],
		remoteWorkerSpecs: null,
		detail: null,
		checks,
		targets: [],
		resources: null,
	};
	const script = buildPreflightScript(node, projectRoot);
	const result = await runCommandVector(sshBinary, buildSshArgs(node, script), { timeoutMs, maxOutputBytes: 128_000 });
	if (result.exitCode !== 0 || !result.stdout.split("\n").some((line) => line.trim() === PREFLIGHT_MARKER)) {
		const stderr = result.stderr.trim().split("\n").slice(-1)[0] ?? "";
		record.detail = `unreachable (ssh exit ${result.exitCode}${stderr.length > 0 ? `: ${stderr}` : ""})`;
		return record;
	}
	checks.reachable = true;
	const lines = result.stdout.split("\n").map((line) => line.trim());
	record.targets = await probeTargets(node, targets, sshBinary, checkedAt);
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
	checks.stateDirWritable = lines.includes("state=ok") || lines.includes("state=creatable");
	// The probe script is generated locally and always echoes `clioCoder=`, so
	// no remote version can answer with another spelling.
	const clioValue = lines.find((line) => line.startsWith("clioCoder="))?.slice("clioCoder=".length) ?? "missing";
	if (clioValue !== "missing" && clioValue !== "unverified-entry") {
		checks.clioPresent = true;
		record.remoteVersion = parseSemver(clioValue);
		checks.versionMatch = record.remoteVersion !== null && record.remoteVersion === parseSemver(localVersion);
	}
	// The package version alone misses two builds of one version that write
	// different specs, so a node that reports its spec versions must read every
	// one this build writes. A build older than the report (released 0.6.2)
	// still reads the hook-free version this build sends for a dispatch without
	// extension hooks, so it passes as hook-free only, and a hooked dispatch
	// fails over to another node at dispatch time. A custom entry has no CLI to
	// ask; its version command stands.
	const specValue = lines.find((line) => line.startsWith("workerSpecs="))?.slice("workerSpecs=".length) ?? "";
	let specMismatch: string | null = null;
	if (specValue !== "unverified-entry") {
		record.remoteWorkerSpecs = parseWorkerSpecs(specValue);
		if (record.remoteWorkerSpecs !== null) specMismatch = workerSpecMismatch(record.remoteWorkerSpecs);
		else
			record.note = `the node's worker does not report the spec versions it reads (a build older than this one), so it counts as reading version ${WORKER_SPEC_HOOKLESS_VERSION} only; dispatches carrying extension hooks (version ${WORKER_SPEC_VERSION}) will not run on this node and go to another node`;
	}
	const packageMatch = checks.versionMatch;
	if (specMismatch !== null) checks.versionMatch = false;
	const failures: string[] = [];
	if (!checks.pathParity)
		failures.push(
			`project root ${projectRoot} missing on node (provide shared storage or a matching clean checkout at this path)`,
		);
	if (clioValue === "unverified-entry")
		failures.push("custom worker entry needs clioCoderVersionCommand printing its exact Clio version");
	else if (!checks.clioPresent)
		failures.push("clio-coder not found on remote PATH (set fleet.nodes[].clioCoderEntry or install clio-coder)");
	else if (!packageMatch) {
		failures.push(
			`clio-coder version mismatch (local ${parseSemver(localVersion) ?? localVersion}, remote ${record.remoteVersion ?? "unknown"})`,
		);
	} else if (specMismatch !== null) failures.push(specMismatch);
	if (!checks.stateDirWritable) failures.push("remote clio-coder state dir is not writable");
	record.ok = failures.length === 0;
	record.detail = failures.length > 0 ? failures.join("; ") : null;
	return record;
}
