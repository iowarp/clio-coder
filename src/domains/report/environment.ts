import { getVersionInfo, inspectInstallation } from "../lifecycle/index.js";
import { carriesPath, isBuiltinRuntimeId } from "../telemetry/index.js";
import {
	isOneOf,
	REPORT_AUTONOMY,
	REPORT_INSTALL_KINDS,
	type ReportAutonomy,
	type ReportInstallKind,
	type ReportSurface,
} from "./vocabulary.js";

/**
 * What a report says about the machine it came from. Every field is a closed value or a fixed shape: no kernel
 * release, locale, timezone, shell, terminal title or environment variable.
 */
export interface ReportEnvironment {
	clioCoder: string;
	/** `process.platform-process.arch`. */
	platform: string;
	/** Node major.minor. */
	node: string;
	install: ReportInstallKind;
	surface: ReportSurface;
	autonomy: ReportAutonomy | null;
	/** A built-in runtime id only; an operator's plugin runtime is a name of their own. */
	runtime: string | null;
	/** Only a model id that names no location. */
	model: string | null;
}

export interface ReportSessionFacts {
	autonomy?: string;
	runtime?: string;
	model?: string;
}

function installKind(): ReportInstallKind {
	try {
		const kind = inspectInstallation().kind;
		return isOneOf(REPORT_INSTALL_KINDS, kind) ? kind : "unknown";
	} catch {
		// A layout that cannot be read is reported as unknown rather than failing the report.
		return "unknown";
	}
}

export function reportEnvironment(surface: ReportSurface, session?: ReportSessionFacts): ReportEnvironment {
	const [major = "0", minor = "0"] = process.versions.node.split(".");
	const runtime = session?.runtime;
	const model = session?.model?.trim();
	return {
		clioCoder: getVersionInfo().clio,
		platform: `${process.platform}-${process.arch}`,
		node: `${major}.${minor}`,
		install: installKind(),
		surface,
		autonomy: isOneOf(REPORT_AUTONOMY, session?.autonomy) ? session.autonomy : null,
		runtime: runtime !== undefined && isBuiltinRuntimeId(runtime) ? runtime : null,
		model: model !== undefined && model.length > 0 && model.length <= 120 && !carriesPath(model) ? model : null,
	};
}
