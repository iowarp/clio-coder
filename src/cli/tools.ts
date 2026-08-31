import { describeYaziProfile, inspectCurrentYaziProfile, resetYaziProfile } from "../domains/mux/index.js";
import {
	describeResolution,
	findPinnedTool,
	installTool,
	PINNED_TOOLS,
	type ToolStatus,
	toolStatus,
	toolStatuses,
} from "../domains/toolchain/index.js";
import { formatColumns, printError, printOk } from "./shared.js";

const HELP = `clio-coder tools <command>

Manage the external terminal programs Clio can drive. Every one of them is
optional: Clio works without them and only uses one when it is present. Each is
pinned to an exact upstream version and checksum, and a copy already on PATH
wins over Clio's own as long as it clears the pinned minimum.

Commands:
  clio-coder tools list [--json]           the pinned table and where each resolves
  clio-coder tools status <id> [--json] [--reset-profile]  one tool in detail
  clio-coder tools install <id> [--force] [--json]  download, verify, and vendor a tool

Downloads happen only here. Nothing on a startup path fetches anything.
`;

interface Parsed {
	command?: string;
	positional: string[];
	json: boolean;
	force: boolean;
	resetProfile: boolean;
	help: boolean;
}

export async function runToolsCommand(argv: ReadonlyArray<string> = []): Promise<number> {
	let parsed: Parsed;
	try {
		parsed = parse(argv);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		process.stderr.write(HELP);
		return 2;
	}
	if (parsed.help || parsed.command === undefined) {
		process.stdout.write(HELP);
		return parsed.help ? 0 : 2;
	}

	switch (parsed.command) {
		case "list":
			if (parsed.resetProfile) return invalidResetProfile();
			return listTools(parsed.json);
		case "status":
			return statusTool(parsed.positional[0], parsed.json, parsed.resetProfile);
		case "install":
			if (parsed.resetProfile) return invalidResetProfile();
			return installOne(parsed.positional[0], parsed.force, parsed.json);
		default:
			printError(`unknown tools command: ${parsed.command}`);
			process.stderr.write(HELP);
			return 2;
	}
}

function parse(argv: ReadonlyArray<string>): Parsed {
	const out: Parsed = { positional: [], json: false, force: false, resetProfile: false, help: false };
	for (const arg of argv) {
		if (!out.command && !arg.startsWith("-")) {
			out.command = arg;
			continue;
		}
		switch (arg) {
			case "--json":
				out.json = true;
				break;
			case "--force":
			case "-f":
				out.force = true;
				break;
			case "--reset-profile":
				out.resetProfile = true;
				break;
			case "--help":
			case "-h":
				out.help = true;
				break;
			default:
				if (arg.startsWith("-")) throw new Error(`unknown flag: ${arg}`);
				out.positional.push(arg);
		}
	}
	return out;
}

function listTools(json: boolean): number {
	const statuses = toolStatuses();
	if (json) {
		process.stdout.write(`${JSON.stringify(statuses.map(jsonShape), null, 2)}\n`);
		return 0;
	}
	const rows = statuses.map((status) => [
		status.id,
		status.version,
		status.license,
		status.resolution.source,
		describeResolution(status),
	]);
	process.stdout.write(formatColumns([["TOOL", "PIN", "LICENSE", "SOURCE", "RESOLVED"], ...rows]));
	return 0;
}

function invalidResetProfile(): number {
	printError("--reset-profile is only valid with `tools status yazi`");
	return 2;
}

function statusTool(id: string | undefined, json: boolean, resetProfile: boolean): number {
	if (id === undefined) {
		printError("usage: clio-coder tools status <id>");
		return 2;
	}
	const entry = findPinnedTool(id);
	if (entry === null) {
		printError(`unknown tool: ${id} (known: ${PINNED_TOOLS.map((row) => row.id).join(", ")})`);
		return 2;
	}
	if (resetProfile && id !== "yazi") return invalidResetProfile();
	if (resetProfile) resetYaziProfile();
	const status = toolStatus(entry);
	const profile = id === "yazi" ? inspectCurrentYaziProfile() : null;
	if (json) {
		process.stdout.write(
			`${JSON.stringify({ ...jsonShape(status), ...(profile ? { profile, profileReset: resetProfile } : {}) }, null, 2)}\n`,
		);
		return 0;
	}
	const lines = [
		`${entry.id} ${entry.version} (${entry.license})`,
		`  ${entry.summary}`,
		`  homepage    ${entry.homepage}`,
		`  binaries    ${entry.binaries.join(", ")}`,
		`  PATH floor  ${entry.minimumVersion}`,
		`  platform    ${status.platform ?? `${process.platform}-${process.arch}`}${status.supported ? "" : " (no pinned asset)"}`,
		`  vendor dir  ${status.installDir}${status.installed ? "" : " (not installed)"}`,
		`  resolves to ${describeResolution(status)}`,
		...(profile
			? [
					`  profile     ${describeYaziProfile(profile)}`,
					...(resetProfile ? ["  profile reset; next open regenerates it"] : []),
				]
			: []),
	];
	process.stdout.write(`${lines.join("\n")}\n`);
	return 0;
}

async function installOne(id: string | undefined, force: boolean, json: boolean): Promise<number> {
	if (id === undefined) {
		printError("usage: clio-coder tools install <id>");
		return 2;
	}
	if (findPinnedTool(id) === null) {
		printError(`unknown tool: ${id} (known: ${PINNED_TOOLS.map((row) => row.id).join(", ")})`);
		return 2;
	}
	const result = await installTool(id, {
		force,
		...(json ? {} : { onProgress: (message: string) => process.stderr.write(`  ${message}\n`) }),
	});
	if (json) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return result.ok ? 0 : 1;
	}
	if (!result.ok) {
		printError(result.message);
		return 1;
	}
	printOk(result.message);
	for (const path of result.documents) process.stdout.write(`  license  ${path}\n`);
	return 0;
}

/** The JSON surface, flattened so a script does not have to walk the resolution. */
function jsonShape(status: ToolStatus): Record<string, unknown> {
	return {
		id: status.id,
		version: status.version,
		license: status.license,
		platform: status.platform,
		supported: status.supported,
		installed: status.installed,
		installDir: status.installDir,
		source: status.resolution.source,
		binaryPath: status.resolution.binaryPath,
		foundVersion: status.resolution.version,
		minimumVersion: status.resolution.entry?.minimumVersion ?? null,
		pathCandidate: status.resolution.pathCandidate,
		detail: describeResolution(status),
	};
}
