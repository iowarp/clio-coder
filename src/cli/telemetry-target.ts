import { readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { listSessionsForCwd } from "../domains/session/history.js";
import { resolveSessionTarget } from "../domains/session/names.js";
import {
	telemetryRunDirectory,
	telemetrySessionDirectory,
	telemetrySessionsDirectory,
} from "../domains/telemetry/paths.js";

type TelemetryTarget =
	| { kind: "session" | "run" | "directory"; id: string; path: string; exists: boolean }
	| { kind: "archive"; path: string };

function statTarget(path: string) {
	try {
		return statSync(path, { throwIfNoEntry: false });
	} catch {
		// Readers must still reach the session ledger when the telemetry scope is inaccessible (D3h).
		return undefined;
	}
}

function directoryNames(path: string): string[] {
	try {
		return readdirSync(path, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

/** Every session id the state directory records: session ledgers under any project, and telemetry session scopes. */
function recordedSessionIds(stateDir: string): string[] {
	const sessionsRoot = join(stateDir, "sessions");
	const ids = new Set(directoryNames(telemetrySessionsDirectory(stateDir)));
	for (const project of directoryNames(sessionsRoot)) {
		for (const id of directoryNames(join(sessionsRoot, project))) ids.add(id);
	}
	return [...ids];
}

/**
 * A CLI session selector (convention C13): an exact id, a unique id prefix, or a session name, through
 * `resolveSessionTarget`. The current directory's sessions are tried first, so their names resolve and a prefix
 * means what `--resume` means there; a selector they do not match falls back to every recorded session id. A path
 * is not a selector and comes back unchanged for the caller's own path handling.
 */
export function resolveSessionSelector(
	stateDir: string,
	target: string,
	cwd: string = process.cwd(),
): { id: string } | { miss: string } {
	if (target.includes("/") || target.includes("\\")) return { id: target };
	const recorded = recordedSessionIds(stateDir);
	if (recorded.includes(target)) return { id: target };
	const local = resolveSessionTarget(listSessionsForCwd(cwd), target);
	if ("id" in local || !local.miss.startsWith("no session")) return local;
	return resolveSessionTarget(
		recorded.map((id) => ({ id })),
		target,
	);
}

export function resolveTelemetryTarget(
	stateDir: string,
	target: string,
	scope: "session" | "run" = "session",
	options: { allowBareArchive?: boolean } = {},
): TelemetryTarget {
	if (scope === "run") {
		const path = telemetryRunDirectory(stateDir, target);
		return { kind: "run", id: target, path, exists: statTarget(path)?.isDirectory() ?? false };
	}
	if (target.includes("/") || target.includes("\\")) {
		const path = resolve(target);
		const info = statTarget(path);
		return info?.isFile()
			? { kind: "archive", path }
			: { kind: "directory", id: basename(path), path, exists: info?.isDirectory() ?? false };
	}
	const path = telemetrySessionDirectory(stateDir, target);
	const exists = statTarget(path)?.isDirectory() ?? false;
	if (!exists && options.allowBareArchive) {
		const archive = resolve(target);
		if (statTarget(archive)?.isFile()) return { kind: "archive", path: archive };
	}
	return { kind: "session", id: target, path, exists };
}
