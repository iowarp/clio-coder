import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { canonicalizeExistingPath } from "./path-canonical.js";
import { processAlive, processBirthToken } from "./process-identity.js";
import { safeResourceWrite } from "./safe-resource-write.js";
import { withStateFileLockSync } from "./state-file-lock.js";
import { clioStateDir } from "./xdg.js";

/**
 * Dev extension folders are authored by one session at a time. A session
 * registers each folder it loads here; another live session neither loads it
 * nor lets its model write it. Nothing is shared: a folder two sessions both
 * want belongs to whichever registered first until that process exits.
 */
export interface DevRootRecord {
	owner: string;
	pid: number;
	birthToken: string | null;
	registeredAt: string;
}

interface DevRootFile {
	version: 1;
	roots: Record<string, DevRootRecord>;
}

/** Identifies this process's session for the life of the process, so a restart is a new owner. */
const OWNER = randomUUID();

function registryPath(): string {
	return path.join(clioStateDir(), "extension-dev-roots.json");
}

function alive(record: DevRootRecord): boolean {
	if (!processAlive(record.pid)) return false;
	return record.birthToken === null || processBirthToken(record.pid) === record.birthToken;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRegistry(file: string): DevRootFile {
	const empty: DevRootFile = { version: 1, roots: {} };
	if (!existsSync(file)) return empty;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		// An unreadable registry names no owner, so it restricts nobody; the next write replaces it.
		return empty;
	}
	if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.roots)) return empty;
	const roots: Record<string, DevRootRecord> = {};
	for (const [root, entry] of Object.entries(parsed.roots)) {
		if (
			isRecord(entry) &&
			typeof entry.owner === "string" &&
			typeof entry.pid === "number" &&
			Number.isInteger(entry.pid) &&
			typeof entry.registeredAt === "string"
		)
			roots[root] = {
				owner: entry.owner,
				pid: entry.pid,
				birthToken: typeof entry.birthToken === "string" ? entry.birthToken : null,
				registeredAt: entry.registeredAt,
			};
	}
	return { version: 1, roots };
}

function liveRoots(file: DevRootFile): Record<string, DevRootRecord> {
	return Object.fromEntries(Object.entries(file.roots).filter(([, record]) => alive(record)));
}

/**
 * Claim a dev folder for this session. Refuses, naming the holder, when another
 * live session registered it first. Registering again is idempotent.
 */
export function registerDevRoot(root: string): { ok: true } | { ok: false; heldBy: DevRootRecord } {
	const key = canonicalizeExistingPath(root);
	const file = registryPath();
	return withStateFileLockSync(file, () => {
		const roots = liveRoots(readRegistry(file));
		const held = roots[key];
		if (held !== undefined && held.owner !== OWNER) return { ok: false as const, heldBy: held };
		roots[key] = {
			owner: OWNER,
			pid: process.pid,
			birthToken: processBirthToken(),
			registeredAt: held?.registeredAt ?? new Date().toISOString(),
		};
		safeResourceWrite(file, `${JSON.stringify({ version: 1, roots }, null, 2)}\n`, { encoding: "utf8" });
		return { ok: true as const };
	});
}

/** Drop this session's claims, for one folder or all of them. */
export function releaseDevRoots(root?: string): void {
	const file = registryPath();
	if (!existsSync(file)) return;
	const key = root === undefined ? undefined : canonicalizeExistingPath(root);
	withStateFileLockSync(file, () => {
		const roots = liveRoots(readRegistry(file));
		for (const [candidate, record] of Object.entries(roots))
			if (record.owner === OWNER && (key === undefined || candidate === key)) delete roots[candidate];
		safeResourceWrite(file, `${JSON.stringify({ version: 1, roots }, null, 2)}\n`, { encoding: "utf8" });
	});
}

/** Every folder a live session other than this one holds. Never throws: an unreadable registry holds nothing. */
export function devRootsHeldByOthers(): Array<{ root: string; holder: DevRootRecord }> {
	try {
		const file = registryPath();
		if (!existsSync(file)) return [];
		return Object.entries(liveRoots(readRegistry(file)))
			.filter(([, record]) => record.owner !== OWNER)
			.map(([root, holder]) => ({ root, holder }));
	} catch {
		// The state directory could not be resolved; nothing is registered that this process can see.
		return [];
	}
}
