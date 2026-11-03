import { dirname, resolve, sep } from "node:path";
import { canonicalizePath } from "../core/path-canonical.js";
import { readLayeredSettings, settingsSourceFor } from "../core/settings-layers.js";
import { clioStateDir } from "../core/xdg.js";
import { exportToFile, isDay, summarizeDataset } from "../domains/system-one/recorder/index.js";
import type { SiteId } from "../domains/system-one/types.js";
import { SITE_IDS } from "../domains/system-one/types.js";
import { systemOneRecordingLabel } from "../domains/telemetry/consent.js";
import { telemetryRoot } from "../domains/telemetry/index.js";
import { formatColumns, printError, printNote } from "./shared.js";

const HELP = `clio-coder systemone status
clio-coder systemone use <engine> [--scope user|project]
clio-coder systemone off [--scope user|project]
clio-coder systemone check <engine> --live
clio-coder systemone export --out <file> [--since <YYYY-MM-DD>] [--site <site>]

System One is experimental and off until you choose an engine: jev, memory, main,
a declared engine or a target. Its decision engines answer typed questions about the
operator's request, tool calls, tool results and finished turns; sites, keys and
cuts may change between releases. In research telemetry mode with
telemetry.research.systemOneDataset and content consent for the workspace, every
call and what followed it is kept in the session's telemetry journal as redacted
research content, which telemetry retention expires like any other.

status   what each site will do and why, whether recording is on, and what the dataset holds
use      choose the engine for every active site; the default scope is user, and a project
         write goes to .clio-coder/settings.local.yaml. /systemone sets task and session
         scope inside a session, and run --systemone sets one run
off      mask every site, per-site entries included
check    send one content-free decision to a hosted or self-hosted engine and report the
         build that answered, which is the only check that verifies a build
export   write one JSON line per decision to a local file, joined with the full text
         of its questions and every outcome recorded for it

Flags:
  --scope <scope>     user or project
  --live              required by check, because it sends a request
  --out <file>        destination of the export (required, replaced atomically)
  --since <day>       skip samples recorded before this UTC day
  --site <site>       only this site: ${SITE_IDS.join(", ")}
`;

interface ParsedArgs {
	command?: string;
	name?: string;
	scope?: "user" | "project";
	live?: boolean;
	out?: string;
	since?: string;
	site?: SiteId;
	help: boolean;
}

function flagValue(argv: ReadonlyArray<string>, index: number, flag: string, what: string): string {
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("-")) throw new Error(`${flag} requires ${what}`);
	return value;
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
	const out: ParsedArgs = { help: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === undefined) continue;
		if (out.command === undefined && !arg.startsWith("-")) {
			out.command = arg;
			continue;
		}
		if ((out.command === "use" || out.command === "check") && out.name === undefined && !arg.startsWith("-")) {
			out.name = arg;
			continue;
		}
		switch (arg) {
			case "--help":
			case "-h":
				out.help = true;
				break;
			case "--live":
				out.live = true;
				break;
			case "--scope": {
				const scope = flagValue(argv, i, arg, "user or project");
				if (scope === "task" || scope === "session") {
					throw new Error(`${scope} scope belongs to a session: use /systemone there, or run --systemone for one run`);
				}
				if (scope !== "user" && scope !== "project") throw new Error(`--scope expects user or project, got ${scope}`);
				out.scope = scope;
				i += 1;
				break;
			}
			case "--out":
				out.out = flagValue(argv, i, arg, "a file path");
				i += 1;
				break;
			case "--since": {
				const day = flagValue(argv, i, arg, "a day as YYYY-MM-DD");
				if (!isDay(day)) throw new Error(`--since expects a day as YYYY-MM-DD, got ${day}`);
				out.since = day;
				i += 1;
				break;
			}
			case "--site": {
				const site = flagValue(argv, i, arg, `one of ${SITE_IDS.join(", ")}`);
				if (!(SITE_IDS as ReadonlyArray<string>).includes(site)) {
					throw new Error(`--site expects one of ${SITE_IDS.join(", ")}, got ${site}`);
				}
				out.site = site as SiteId;
				i += 1;
				break;
			}
			default:
				throw new Error(`unknown flag: ${arg}`);
		}
	}
	return out;
}

async function runStatus(): Promise<number> {
	const layered = readLayeredSettings(process.cwd());
	const { settings } = layered;
	const { describeStatus, formatStatus } = await import("../domains/system-one/status.js");
	const { credentialAvailable } = await import("../domains/providers/credentials.js");
	const recordingLabel = systemOneRecordingLabel(settings, process.cwd());
	const status = describeStatus({
		settings,
		settingsOrigin: settingsSourceFor(layered.sources, "systemOne.use"),
		hasCredential: credentialAvailable,
		recording: recordingLabel !== "record off",
	});
	process.stdout.write(`${formatStatus(status).join("\n")}\n\n`);
	const summary = await summarizeDataset(clioStateDir());
	const rows: string[][] = [
		["record", recordingLabel.replace(/^record /, "")],
		[
			"samples",
			summary.decisions + summary.outcomes === 0
				? "none"
				: `decision ${summary.decisions}, outcome ${summary.outcomes} across ${summary.sessions} session${summary.sessions === 1 ? "" : "s"} (${summary.oldest} to ${summary.newest})`,
		],
	];
	process.stdout.write(formatColumns(rows));
	return 0;
}

async function runUse(use: string, scope: "user" | "project"): Promise<number> {
	const { writeSystemOneUse } = await import("../entry/system-one-settings.js");
	writeSystemOneUse(process.cwd(), scope, use);
	process.stdout.write(`System One ${use === "off" ? "off" : use} at ${scope} scope\n`);
	return runStatus();
}

/** One content-free decision. A passive check proves an endpoint answers, never which build would answer. */
async function runCheck(name: string): Promise<number> {
	const settings = readLayeredSettings(process.cwd()).settings;
	const { effectiveSystemOne, resolveChoice } = await import("../domains/system-one/selection.js");
	const resolved = resolveChoice(settings, name);
	if (resolved.kind !== "engine") {
		printError(resolved.kind === "unavailable" ? resolved.problem : `'${name}' is not an engine`);
		return 1;
	}
	if (resolved.engine.kind !== "systemone") {
		printError(`${name} is an LLM route; a live build check for one arrives with calibration`);
		return 1;
	}
	const live = effectiveSystemOne({ ...settings, systemOne: { ...settings.systemOne, sites: { consult: name } } }, name);
	const { BUILTIN_RUNTIMES } = await import("../domains/providers/runtimes/builtins.js");
	const { openAuthStorage, resolveAuthTarget } = await import("../domains/providers/auth/index.js");
	const { credentialAvailable } = await import("../domains/providers/credentials.js");
	const { createSystemOne, yesNo } = await import("../domains/system-one/index.js");
	const { consultSite } = await import("../domains/system-one/sites/consult.js");
	const auth = openAuthStorage();
	const systemOne = createSystemOne({
		settings: () => live,
		providers: {
			getTarget: (id: string) => live.targets.find((entry) => entry.id === id) ?? null,
			getRuntime: (id: string) => BUILTIN_RUNTIMES.find((runtime) => runtime.id === id) ?? null,
			auth: {
				resolveForTarget: (
					target: Parameters<typeof resolveAuthTarget>[0],
					runtime: Parameters<typeof resolveAuthTarget>[1],
					options?: { signal?: AbortSignal },
				) => auth.resolveForTarget(resolveAuthTarget(target, runtime), options ?? {}),
			},
		} as never,
		// This process registers no runtime, so the set holds exactly the keys this runtime declares.
		credentialsPresent: () =>
			new Set(
				BUILTIN_RUNTIMES.flatMap((runtime) =>
					runtime.credentialsEnvVar !== undefined && credentialAvailable(runtime.id, runtime.credentialsEnvVar)
						? [runtime.credentialsEnvVar]
						: [],
				),
			),
	});
	let failure = "the engine gave no answer";
	const verdict = await systemOne.run(
		consultSite({ check: yesNo("Is 2 greater than 1?", "It is greater", "It is not greater") }),
		{ state: { check: "build identity" }, files: {} },
		{ onFailure: (reason) => (failure = reason) },
	);
	const requested = resolved.engine.model ?? "target default";
	if (verdict === null) {
		printError(`${name} (${requested}): ${failure}; nothing is verified`);
		return 1;
	}
	const { FITTED_CUTS } = await import("../domains/system-one/calibration.js");
	const { IDENTITY_LIMIT } = await import("../domains/system-one/status.js");
	const matches = verdict.build === requested;
	const measured = Object.hasOwn(FITTED_CUTS, verdict.build);
	process.stdout.write(
		`${name}: requested ${requested}, answered as ${verdict.build} in ${verdict.latencyMs} ms\n` +
			`${matches ? "the answering name matches" : "the answering name differs, so no measurement for the requested build applies"}; ` +
			`${measured ? "this build has measured cuts" : "this build has no measured cuts, so it sends nothing"}\n${IDENTITY_LIMIT}\n`,
	);
	return matches ? 0 : 1;
}

async function runExport(parsed: ParsedArgs): Promise<number> {
	if (parsed.out === undefined) {
		printError("export requires --out <file>");
		process.stderr.write(HELP);
		return 2;
	}
	const destination = resolve(parsed.out);
	const parent = canonicalizePath(dirname(destination));
	const telemetry = canonicalizePath(telemetryRoot(clioStateDir())) ?? telemetryRoot(clioStateDir());
	if (parent === null) {
		printError("--out could not be checked against the telemetry directory");
		return 2;
	}
	if (parent === telemetry || parent.startsWith(`${telemetry}${sep}`)) {
		printError("--out must not point into the telemetry directory");
		return 2;
	}
	// The file holds redacted state, but redaction is best effort and the operator's own requests are in it.
	// Rows are streamed to the temp file, so a large dataset is never one string.
	const result = await exportToFile(destination, {
		stateDir: clioStateDir(),
		...(parsed.since !== undefined ? { since: parsed.since } : {}),
		...(parsed.site !== undefined ? { site: parsed.site } : {}),
	});
	process.stdout.write(
		`exported ${result.decisions} decision${result.decisions === 1 ? "" : "s"} from ${result.sessions} session${result.sessions === 1 ? "" : "s"} to ${destination}\n`,
	);
	if (result.decisions === 0) printNote("no decisions matched; the file is empty.");
	if (result.missingSpecs > 0) {
		printNote(`${result.missingSpecs} question spec${result.missingSpecs === 1 ? "" : "s"} missing from their samples.`);
	}
	if (result.unreadableRows > 0)
		printNote(`${result.unreadableRows} unreadable sample${result.unreadableRows === 1 ? "" : "s"} skipped.`);
	return 0;
}

export async function runSystemOneCommand(argv: ReadonlyArray<string>): Promise<number> {
	let parsed: ParsedArgs;
	try {
		parsed = parseArgs(argv);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		process.stderr.write(HELP);
		return 2;
	}
	if (parsed.help) {
		process.stdout.write(HELP);
		return 0;
	}
	const known = ["status", "export", "use", "off", "check"];
	if (parsed.command === undefined || !known.includes(parsed.command)) {
		if (parsed.command !== undefined) printError(`unknown systemone command: ${parsed.command}`);
		process.stderr.write(HELP);
		return 2;
	}
	if ((parsed.command === "use" || parsed.command === "check") && parsed.name === undefined) {
		printError(`${parsed.command} requires an engine`);
		process.stderr.write(HELP);
		return 2;
	}
	if (parsed.command === "check" && parsed.live !== true) {
		printError("check sends a request, so it requires --live");
		return 2;
	}
	try {
		if (parsed.command === "use") return await runUse(parsed.name as string, parsed.scope ?? "user");
		if (parsed.command === "off") return await runUse("off", parsed.scope ?? "user");
		if (parsed.command === "check") return await runCheck(parsed.name as string);
		return parsed.command === "status" ? await runStatus() : await runExport(parsed);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 1;
	}
}
