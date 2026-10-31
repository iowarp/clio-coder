import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { telemetryRunDirectory, telemetrySessionDirectory } from "../domains/telemetry/paths.js";

type TelemetryTarget =
	| { kind: "session" | "run" | "directory"; id: string; path: string; exists: boolean }
	| { kind: "archive"; path: string };

export function resolveTelemetryTarget(
	stateDir: string,
	target: string,
	scope: "session" | "run" = "session",
	options: { allowBareArchive?: boolean } = {},
): TelemetryTarget {
	if (scope === "run") {
		const path = telemetryRunDirectory(stateDir, target);
		return { kind: "run", id: target, path, exists: statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false };
	}
	if (target.includes("/") || target.includes("\\")) {
		const path = resolve(target);
		const info = statSync(path, { throwIfNoEntry: false });
		return info?.isFile()
			? { kind: "archive", path }
			: { kind: "directory", id: basename(path), path, exists: info?.isDirectory() ?? false };
	}
	const path = telemetrySessionDirectory(stateDir, target);
	const exists = statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
	if (!exists && options.allowBareArchive) {
		const archive = resolve(target);
		if (statSync(archive, { throwIfNoEntry: false })?.isFile()) return { kind: "archive", path: archive };
	}
	return { kind: "session", id: target, path, exists };
}
