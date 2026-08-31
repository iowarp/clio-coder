import { describeYaziProfile, inspectCurrentYaziProfile, resetYaziProfile } from "../domains/mux/index.js";
import {
	describeFloorRejection,
	describeResolution,
	findPinnedTool,
	installedToolVersions,
	installRemedy,
	installTool,
	PINNED_TOOLS,
	removeTool,
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
  clio-coder tools remove <id> [--json]    delete every vendored version of a tool

Downloads happen only here. Nothing on a startup path fetches anything.

An install keeps one version directory per tool: once the pinned version is in
place, versions it superseded are pruned. Removal touches nothing outside
<data>/tools/<id> and needs no confirmation, since every byte under it is
re-downloadable from the checksum-pinned registry.
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
		case "remove":
			if (parsed.resetProfile) return invalidResetProfile();
			return removeOne(parsed.positional[0], parsed.json);
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

/**
 * The one refusal an unknown id gets, from every verb.
 *
 * It names the tools that do exist, because the whole error an operator makes
 * here is a name: `tools remove herd` and `tools remove tmux` want different
 * answers, and the registry list gives both of them one.
 */
function unknownTool(id: string): number {
	printError(`unknown tool: ${id} (known: ${PINNED_TOOLS.map((row) => row.id).join(", ")})`);
	return 2;
}

function statusTool(id: string | undefined, json: boolean, resetProfile: boolean): number {
	if (id === undefined) {
		printError("usage: clio-coder tools status <id>");
		return 2;
	}
	const entry = findPinnedTool(id);
	if (entry === null) {
		return unknownTool(id);
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
	const rejection = describeFloorRejection(status);
	const installedVersions = installedToolVersions(entry.id);
	const lines = [
		`${entry.id} ${entry.version} (${entry.license})`,
		`  ${entry.summary}`,
		`  homepage    ${entry.homepage}`,
		`  binaries    ${entry.binaries.join(", ")}`,
		`  PATH floor  ${entry.minimumVersion}`,
		`  platform    ${status.platform ?? `${process.platform}-${process.arch}`}${status.supported ? "" : " (no pinned asset)"}`,
		`  vendor dir  ${status.installDir}${status.installed ? "" : " (not installed)"}`,
		`  vendored    ${installedVersions.length === 0 ? "nothing" : installedVersions.join(", ")}`,
		`  resolves to ${describeResolution(status)}`,
		// Spelled out on its own line as well as inside the resolution sentence,
		// because a rejected PATH copy is the one thing an operator reads this
		// command to understand and the sentence above may be about something else.
		...(rejection === null
			? []
			: [
					`  floor       rejected: ${rejection}`,
					...(status.resolution.source === "none" && status.supported ? [`  remedy      ${installRemedy(entry.id)}`] : []),
				]),
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
		return unknownTool(id);
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
	for (const version of result.pruned) process.stdout.write(`  pruned   ${id} ${version}\n`);
	return 0;
}

/**
 * Delete a tool's vendored install.
 *
 * The two answers an operator can act on are "there was nothing there" and
 * "these versions are gone", and both are exit 0: the state they asked for
 * holds either way. Only an id the registry does not know is a usage error,
 * because that is the one case where nothing was inspected at all.
 */
function removeOne(id: string | undefined, json: boolean): number {
	if (id === undefined) {
		printError("usage: clio-coder tools remove <id>");
		return 2;
	}
	if (findPinnedTool(id) === null) return unknownTool(id);
	const result = removeTool(id);
	if (json) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return result.ok ? 0 : 1;
	}
	if (!result.ok) {
		printError(result.message);
		return 1;
	}
	printOk(result.message);
	if (result.removed.length > 0) {
		process.stdout.write(`  reinstall with \`clio-coder tools install ${id}\`\n`);
	}
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
		// A script deciding whether to warn about a floor rejection should not have
		// to parse `detail` for it, so the rejection and the command that answers
		// it are their own fields. `remedy` is null exactly where installing would
		// change nothing: already vendored, or no asset for this platform.
		floorRejection: describeFloorRejection(status),
		remedy: status.resolution.source === "none" && status.supported ? installRemedy(status.id) : null,
		installedVersions: installedToolVersions(status.id),
		detail: describeResolution(status),
	};
}
