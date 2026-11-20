/**
 * Durable fleet root ownership and the persisted fleet result.
 *
 * A fleet root is driven by one process, the owner. Before that process admits any step it writes a root record
 * naming itself, so `fleet run --detach` can acknowledge a root another process can find, and `fleet wait` and
 * `fleet cancel` can tell a running root from one whose owner died without sealing (`orphaned`). At seal the owner
 * writes the fleet result document (the same one `fleet run --output-format json` prints, exit code included), and a
 * waiter prints that document instead of reconstructing an exit from the journal's seal outcome.
 *
 * Layout under `<state>/fleet-runs/`: `owners/<rootId>.json` and `results/<rootId>.json`. They sit in subdirectories
 * because every reader of the root records (`listFleetRuns`, `resolveFleetRootId`, run history) takes each `*.json`
 * directly under `fleet-runs/` for a root record.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type OwnerIdentity, ownerIdentity, ownerState } from "../../core/process-identity.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { clioStateDir } from "../../core/xdg.js";

export const FLEET_ROOT_PREFIX = "fleet-";

export interface FleetRootRecord {
	version: 1;
	rootId: string;
	playbook: string;
	cwd: string;
	/** The owner's pid and host, repeated from `owner` for readers that want only those. */
	pid: number;
	host: string;
	owner: OwnerIdentity;
	/** What the owner last wrote; `orphaned` is never stored, it is read from a `running` record whose owner is gone. */
	state: "running" | "sealed";
	startedAt: string;
	sealedAt: string | null;
}

/** `running` includes an owner on another host, which cannot be probed from here. */
export type FleetRootState = "running" | "sealed" | "orphaned";

const ROOT_ID_PATTERN = /^fleet-[A-Za-z0-9._-]{1,120}$/;

/** Ids starting `fleet-` name roots; anything else is a run id. */
export function isFleetRootId(id: string): boolean {
	return ROOT_ID_PATTERN.test(id);
}

function fleetRunsDir(): string {
	return join(clioStateDir(), "fleet-runs");
}

function ownerPath(rootId: string): string {
	if (!isFleetRootId(rootId)) throw new Error(`invalid fleet root id '${rootId}'`);
	return join(fleetRunsDir(), "owners", `${rootId}.json`);
}

function resultPath(rootId: string): string {
	if (!isFleetRootId(rootId)) throw new Error(`invalid fleet root id '${rootId}'`);
	return join(fleetRunsDir(), "results", `${rootId}.json`);
}

/** Where a detached owner's stderr goes, beside its root record. */
export function fleetRootLogPath(rootId: string): string {
	if (!isFleetRootId(rootId)) throw new Error(`invalid fleet root id '${rootId}'`);
	return join(fleetRunsDir(), "owners", `${rootId}.log`);
}

function writeRecord(record: FleetRootRecord): void {
	safeResourceWrite(ownerPath(record.rootId), `${JSON.stringify(record, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
}

/** Claim `rootId` for this process. Synchronous, so it lands before the caller admits anything. */
export function writeFleetRootRecord(input: { rootId: string; playbook: string; cwd: string }): FleetRootRecord {
	const owner = ownerIdentity();
	const record: FleetRootRecord = {
		version: 1,
		rootId: input.rootId,
		playbook: input.playbook,
		cwd: input.cwd,
		pid: owner.pid,
		host: owner.host,
		owner,
		state: "running",
		startedAt: new Date().toISOString(),
		sealedAt: null,
	};
	writeRecord(record);
	return record;
}

function readJsonObject(path: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

export function readFleetRootRecord(rootId: string): FleetRootRecord | null {
	if (!isFleetRootId(rootId)) return null;
	const parsed = readJsonObject(ownerPath(rootId));
	if (parsed === null || parsed.version !== 1 || parsed.rootId !== rootId) return null;
	const owner = parsed.owner as Partial<OwnerIdentity> | undefined;
	if (typeof parsed.pid !== "number" || typeof owner?.pid !== "number") return null;
	return parsed as unknown as FleetRootRecord;
}

/**
 * Persist the fleet result, then mark the root sealed. The result goes first, so a reader that sees `sealed` always
 * finds the document.
 */
export function writeFleetResult(rootId: string, document: Readonly<Record<string, unknown>>): void {
	safeResourceWrite(resultPath(rootId), `${JSON.stringify(document)}\n`, { encoding: "utf8", mode: 0o600 });
	const record = readFleetRootRecord(rootId);
	if (record !== null && record.state !== "sealed") {
		writeRecord({ ...record, state: "sealed", sealedAt: new Date().toISOString() });
	}
}

export function readFleetResult(rootId: string): Record<string, unknown> | null {
	if (!isFleetRootId(rootId)) return null;
	return readJsonObject(resultPath(rootId));
}

/** A root with a persisted result is sealed; a running record whose owner is provably gone is orphaned. */
export function fleetRootState(record: FleetRootRecord, hasResult: boolean): FleetRootState {
	if (hasResult || record.state === "sealed") return "sealed";
	return ownerState(record.owner) === "gone" ? "orphaned" : "running";
}

function idsIn(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((name) => name.endsWith(".json"))
			.map((name) => name.slice(0, -".json".length))
			.filter(isFleetRootId);
	} catch {
		return [];
	}
}

/** Every root id this host knows: those with a root record and those with only the older plan record. */
function listFleetRootIds(): string[] {
	return [...new Set([...idsIn(join(fleetRunsDir(), "owners")), ...idsIn(fleetRunsDir())])];
}

/** Exact id first, then every root id the token prefixes. */
export function matchFleetRootIds(token: string): string[] {
	const ids = listFleetRootIds();
	if (ids.includes(token)) return [token];
	return ids.filter((id) => id.startsWith(token));
}
