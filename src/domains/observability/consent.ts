import { readFileSync, realpathSync, statSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { withStateFileLockSync } from "../../core/state-file-lock.js";

/**
 * Research content capture needs the operator's consent per workspace (#434, O6).
 * The record lives in the operator's state directory, keyed by the workspace's
 * real path, so a file committed to a repository can never grant it.
 */
export interface TelemetryConsentEntry {
	workspace: string;
	grantedAt: string;
	grantedBy: { user: string; host: string };
}

export interface TelemetryConsentRead {
	entries: TelemetryConsentEntry[];
	/** An unreadable store grants nothing; the operator repairs or removes it (#434). */
	error: string | null;
}

type ConsentDocument = { version: 1; workspaces: Record<string, Omit<TelemetryConsentEntry, "workspace">> };

function telemetryConsentPath(stateDir: string): string {
	return join(stateDir, "telemetry", "consent.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConsent(text: string): ConsentDocument {
	const value: unknown = JSON.parse(text);
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.workspaces))
		throw new Error("expected {version: 1, workspaces: {...}}");
	for (const [workspace, entry] of Object.entries(value.workspaces)) {
		if (
			!isAbsolute(workspace) ||
			!isRecord(entry) ||
			typeof entry.grantedAt !== "string" ||
			!Number.isFinite(Date.parse(entry.grantedAt)) ||
			!isRecord(entry.grantedBy) ||
			typeof entry.grantedBy.user !== "string" ||
			typeof entry.grantedBy.host !== "string"
		)
			throw new Error(`invalid consent entry for ${workspace}`);
	}
	return value as ConsentDocument;
}

function entriesOf(document: ConsentDocument): TelemetryConsentEntry[] {
	return Object.entries(document.workspaces)
		.map(([workspace, entry]) => ({ workspace, grantedAt: entry.grantedAt, grantedBy: { ...entry.grantedBy } }))
		.sort((a, b) => a.workspace.localeCompare(b.workspace));
}

function readDocument(path: string): ConsentDocument | null {
	try {
		return parseConsent(readFileSync(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export function readTelemetryConsent(stateDir: string): TelemetryConsentRead {
	const path = telemetryConsentPath(stateDir);
	try {
		const document = readDocument(path);
		return { entries: document ? entriesOf(document) : [], error: null };
	} catch (error) {
		return { entries: [], error: `${path}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/** A consent covers its workspace and everything under it, compared by real path. */
export function consentCovering(
	entries: ReadonlyArray<TelemetryConsentEntry>,
	realWorkspace: string,
): TelemetryConsentEntry | null {
	for (const entry of entries) {
		const prefix = entry.workspace.endsWith(sep) ? entry.workspace : `${entry.workspace}${sep}`;
		if (realWorkspace === entry.workspace || realWorkspace.startsWith(prefix)) return entry;
	}
	return null;
}

/** The workspace's real path; consent never attaches to a symlink spelling or a missing directory. */
export function resolveConsentWorkspace(directory: string): string {
	const real = realpathSync(directory);
	if (!statSync(real).isDirectory()) throw new Error(`${real} is not a directory`);
	return real;
}

function mutate<T>(stateDir: string, change: (document: ConsentDocument) => T): T {
	const path = telemetryConsentPath(stateDir);
	return withStateFileLockSync(path, () => {
		// A damaged store is the operator's data: refuse rather than overwrite it.
		const document = readDocument(path) ?? { version: 1, workspaces: {} };
		const result = change(document);
		safeResourceWrite(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
		return result;
	});
}

export function grantTelemetryConsent(
	stateDir: string,
	workspace: string,
	now = new Date(),
): { entry: TelemetryConsentEntry; existed: boolean } {
	return mutate(stateDir, (document) => {
		const existing = document.workspaces[workspace];
		if (existing) return { entry: { workspace, ...existing }, existed: true };
		const granted = { grantedAt: now.toISOString(), grantedBy: { user: userInfo().username, host: hostname() } };
		document.workspaces[workspace] = granted;
		return { entry: { workspace, ...granted }, existed: false };
	});
}

/** Revocation deletes the entry; it does not remove content already captured. */
export function revokeTelemetryConsent(stateDir: string, workspace: string): TelemetryConsentEntry | null {
	return mutate(stateDir, (document) => {
		const existing = document.workspaces[workspace];
		if (!existing) return null;
		delete document.workspaces[workspace];
		return { workspace, ...existing };
	});
}

/**
 * The writer asks on every record, so consent is answered from memory and
 * refreshed on the cold path before each call; a revocation applies from the
 * session's next call (#434).
 */
export function createConsentView(stateDir: string) {
	const path = telemetryConsentPath(stateDir);
	let entries: TelemetryConsentEntry[] = [];
	let stamp: string | null = null;
	const workspaces = new Map<string, Promise<string | null>>();
	return {
		async refresh(): Promise<void> {
			try {
				const info = await stat(path);
				const next = `${info.mtimeMs}:${info.size}:${info.ino}`;
				if (next === stamp) return;
				entries = entriesOf(parseConsent(await readFile(path, "utf8")));
				stamp = next;
			} catch {
				// Missing or damaged consent grants nothing; doctor names a damaged store (#434).
				entries = [];
				stamp = null;
			}
		},
		/** The session's recorded working directory, resolved once per session directory. */
		async sessionWorkspace(sessionDirectory: string): Promise<string | null> {
			let resolved = workspaces.get(sessionDirectory);
			if (!resolved) {
				resolved = readFile(join(sessionDirectory, "meta.json"), "utf8")
					.then(async (text) => {
						const cwd = (JSON.parse(text) as { cwd?: unknown }).cwd;
						return typeof cwd === "string" && isAbsolute(cwd) ? await realpath(cwd) : null;
					})
					.catch(() => null);
				workspaces.set(sessionDirectory, resolved);
			}
			const workspace = await resolved;
			// An unreadable meta grants nothing now and is asked again on the next call.
			if (workspace === null) workspaces.delete(sessionDirectory);
			return workspace;
		},
		covers(realWorkspace: string | null): boolean {
			return realWorkspace !== null && consentCovering(entries, realWorkspace) !== null;
		},
	};
}
