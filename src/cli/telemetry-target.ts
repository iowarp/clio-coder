import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { telemetryRunDirectory, telemetrySessionDirectory } from "../domains/telemetry/paths.js";

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
