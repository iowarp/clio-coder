import path from "node:path";
import { readCiRunCommands } from "../../core/ci-commands.js";
import { SAFE_EXEC_DEFAULT_TIMEOUT_MS } from "../../core/safe-exec.js";
import { isVerificationScriptName } from "../../core/verification-scripts.js";
import { type DeclaredCheck, defaultVerifyTimeoutMs } from "./catalog.js";
import {
	cargoProposals,
	cmakeProposals,
	discoverTaskRunnerEntriesAtRoot,
	goProposals,
	pythonProposals,
	type RawProposal,
	regularFileText,
	shellLikeArgv,
	slug,
	type VerifierAvailability,
	type VerifierProvenance,
} from "./toolchain.js";

/**
 * Checks the verify tool derives from what a repository already declares when
 * it has no package.json script or catalog entry for the job: Python runners
 * (uv-aware), Cargo, Go, CMake test presets, Makefile and justfile
 * verification targets, and the repository scripts its CI runs. Agents in
 * Python repositories called verify, got `package.json not found`, and stopped
 * testing; these checks give them the project's own command instead.
 *
 * Every check is an exact argv read from a file in the workspace. The safety
 * policy engine resolves a verify call through the same function, so the argv
 * it scans is the argv the tool runs; a model-supplied check string that names
 * no derived check runs nothing.
 */

/** What discovery reads, named in the error an agent gets when nothing is found. */
export const TOOLCHAIN_DISCOVERY_SOURCES =
	"package.json scripts, .clio-coder/verifiers.yaml, pyproject.toml/pytest.ini/setup.cfg/tox.ini/noxfile.py, " +
	"tests/ or test/ with test_*.py modules, uv.lock, Makefile and justfile targets, Cargo.toml, go.mod, " +
	"CMakePresets.json test presets, and scripts run by .github/workflows, .gitlab-ci.yml, .circleci or azure-pipelines";

/**
 * What verify tells the main agent when a workspace declares and derives no check. Finding none is the workspace's
 * verification status, so the finish contract settles on it instead of asking for a limitation.
 */
export const NO_CHECKS_DECLARED_NOTE =
	"No checks declared is a fact about this workspace, not a limitation: say so in your answer and do not record a limitation for it. If the repository documents a test command, run it through bash.";

/** A derived check and the argv prefix model-supplied `args` extend; absent means the check takes none. */
export interface ToolchainCheck extends DeclaredCheck {
	argsBase?: string[];
	provenance: VerifierProvenance;
	availability?: VerifierAvailability;
}

const SHELL_TOKEN_RE = /[|&;<>`$(){}*?]/u;

function fromProposal(proposal: RawProposal, id: string, argsBase: string[] | undefined): ToolchainCheck {
	return {
		id,
		description: proposal.description,
		command: [...proposal.command],
		cwd: proposal.cwd,
		timeoutMs:
			proposal.timeoutMs === SAFE_EXEC_DEFAULT_TIMEOUT_MS
				? defaultVerifyTimeoutMs(id, proposal.command)
				: proposal.timeoutMs,
		tags: [...proposal.tags],
		source: { kind: "toolchain", path: proposal.provenance.path },
		kind: "command",
		provenance: { ...proposal.provenance },
		...(proposal.availability ? { availability: proposal.availability } : {}),
		...(argsBase !== undefined ? { argsBase } : {}),
	};
}

function familyTag(name: string): string | null {
	if (!isVerificationScriptName(name)) return null;
	const separator = name.search(/[:.-]/u);
	return separator === -1 ? name : name.slice(0, separator);
}

/** Repository scripts a CI step runs directly: `scripts/gate.sh` or `sh scripts/gate.sh`, nothing compound. */
function ciScriptProposals(workspaceRoot: string): RawProposal[] {
	const proposals: RawProposal[] = [];
	for (const command of readCiRunCommands(workspaceRoot)) {
		const argv = shellLikeArgv(command);
		if (argv instanceof Error || argv.some((token) => SHELL_TOKEN_RE.test(token))) continue;
		const scriptIndex = argv[0] === "sh" || argv[0] === "bash" ? 1 : 0;
		const script = argv[scriptIndex];
		if (script === undefined || !script.includes("/") || path.isAbsolute(script)) continue;
		const text = regularFileText(path.join(workspaceRoot, script), workspaceRoot);
		if (typeof text !== "string") continue;
		const stem = path.basename(script).replace(/\.[^.]+$/u, "");
		const family = familyTag(stem);
		proposals.push({
			preferredId: `ci-${slug(stem, "script")}`,
			description: `Run ${argv.join(" ")}, as CI does`,
			command: argv,
			cwd: ".",
			timeoutMs: SAFE_EXEC_DEFAULT_TIMEOUT_MS,
			tags: family !== null && family !== "ci" ? ["ci", family] : ["ci"],
			provenance: { kind: "ci-step", path: script, detail: `CI step '${command}'`, authority: "project-declared" },
		});
	}
	return proposals;
}

/** Makefile and justfile targets whose names are verification words: test, lint, check, typecheck, format, build, ci. */
function taskRunnerProposals(workspaceRoot: string, diagnostics: string[]): RawProposal[] {
	const proposals: RawProposal[] = [];
	for (const entry of discoverTaskRunnerEntriesAtRoot(workspaceRoot, diagnostics)) {
		const family = familyTag(entry.id);
		if (family === null) continue;
		const runner = entry.kind === "make-target" ? "make" : "just";
		proposals.push({
			preferredId: `${runner}-${slug(entry.id, "target")}`,
			description: `Run ${entry.detail}`,
			command: [...entry.command],
			cwd: ".",
			timeoutMs: SAFE_EXEC_DEFAULT_TIMEOUT_MS,
			tags: [runner, family],
			provenance: { kind: entry.kind, path: entry.path, detail: entry.detail, authority: "project-declared" },
		});
	}
	return proposals;
}

/**
 * The argv prefix model arguments extend. unittest discovery takes a pattern,
 * not a module, so `args` switch it to `python -m unittest <modules>`; make
 * targets and CI scripts take no arguments at all.
 */
function argsBaseFor(proposal: RawProposal): string[] | undefined {
	const command = proposal.command;
	const unittest = command.indexOf("unittest");
	if (unittest !== -1 && command[unittest + 1] === "discover") return command.slice(0, unittest + 1);
	if (command[0] === "make" || proposal.preferredId.startsWith("ci-")) return undefined;
	return [...command];
}

/** Every check the toolchain files derive; a file discovery had to skip lands in diagnostics. */
export function discoverToolchainChecks(workspaceRoot: string, diagnostics: string[] = []): ToolchainCheck[] {
	const proposals = [
		...pythonProposals(workspaceRoot, diagnostics),
		...cargoProposals(workspaceRoot, diagnostics),
		...goProposals(workspaceRoot, diagnostics),
		...cmakeProposals(workspaceRoot, diagnostics).filter((proposal) => proposal.tags.includes("test")),
		...taskRunnerProposals(workspaceRoot, diagnostics),
		...ciScriptProposals(workspaceRoot),
	];
	const checks: ToolchainCheck[] = [];
	const seenCommands = new Set<string>();
	const seenIds = new Set<string>(["frontend"]);
	for (const proposal of proposals) {
		const identity = JSON.stringify(proposal.command);
		if (seenCommands.has(identity)) continue;
		seenCommands.add(identity);
		let id = slug(proposal.preferredId, "check");
		for (let suffix = 2; seenIds.has(id); suffix += 1) id = `${slug(proposal.preferredId, "check")}-${suffix}`;
		seenIds.add(id);
		checks.push(fromProposal(proposal, id, argsBaseFor(proposal)));
	}
	return checks;
}

interface UnittestOption {
	short?: string;
	long?: string;
	/** The value the option takes, as its argparse `type` checks it; absent for a flag. */
	value?: "text" | "int";
}

/**
 * `python -m unittest`'s argparse options (Python 3.12). `-h` is left out because help exits 0 having run no test, so
 * the rejection mirror refuses it and the prefixes that resolve to it.
 */
const UNITTEST_OPTIONS: ReadonlyArray<UnittestOption> = [
	{ short: "-v", long: "--verbose" },
	{ short: "-q", long: "--quiet" },
	{ long: "--locals" },
	{ long: "--durations", value: "int" },
	{ short: "-f", long: "--failfast" },
	{ short: "-c", long: "--catch" },
	{ short: "-b", long: "--buffer" },
	{ short: "-k", value: "text" },
];
const UNITTEST_DISCOVER_OPTIONS: ReadonlyArray<UnittestOption> = [
	...UNITTEST_OPTIONS,
	{ short: "-s", long: "--start-directory", value: "text" },
	{ short: "-p", long: "--pattern", value: "text" },
	{ short: "-t", long: "--top-level-directory", value: "text" },
];
/** Python's `int()` over a string: optional surrounding space and sign, digits with single underscores between. */
const PYTHON_INT = /^\s*[+-]?\p{Nd}+(?:_\p{Nd}+)*\s*$/u;
const ARGPARSE_NEGATIVE_NUMBER = /^-\d+$|^-\d*\.\d+$/u;

type ParsedArg =
	| { kind: "positional" }
	| { kind: "option"; option: UnittestOption; explicit: string | null }
	| { kind: "cluster"; options: ReadonlyArray<UnittestOption>; explicit: string | null }
	| { kind: "rejected" };

/** How argparse reads one argument against these options: `_parse_optional` with `allow_abbrev`, then short clusters. */
function parseUnittestArg(arg: string, options: ReadonlyArray<UnittestOption>): ParsedArg {
	if (!arg.startsWith("-") || arg === "-") return { kind: "positional" };
	const positionalLike = ARGPARSE_NEGATIVE_NUMBER.test(arg) || arg.includes(" ");
	if (arg.startsWith("--")) {
		const equals = arg.indexOf("=");
		const name = equals === -1 ? arg : arg.slice(0, equals);
		const explicit = equals === -1 ? null : arg.slice(equals + 1);
		const exact = options.find((option) => option.long === name);
		if (exact !== undefined) return { kind: "option", option: exact, explicit };
		// `--help` is among argparse's candidates, so a prefix of it is ambiguous or help, never another option.
		const candidates = [...options.flatMap((option) => (option.long ? [option.long] : [])), "--help"].filter((long) =>
			long.startsWith(name),
		);
		if (candidates.length === 1 && candidates[0] !== "--help") {
			const option = options.find((entry) => entry.long === candidates[0]);
			if (option !== undefined) return { kind: "option", option, explicit };
		}
		return candidates.length === 0 && positionalLike ? { kind: "positional" } : { kind: "rejected" };
	}
	// A short option, its `=value` or attached value, or a cluster of flags that may end in one value option.
	const first = options.find((option) => option.short === arg.slice(0, 2));
	if (first === undefined) return positionalLike ? { kind: "positional" } : { kind: "rejected" };
	if (arg.length === 2) return { kind: "option", option: first, explicit: null };
	if (arg[2] === "=" && first.value !== undefined) return { kind: "option", option: first, explicit: arg.slice(3) };
	const cluster: UnittestOption[] = [];
	for (let index = 1; index < arg.length; index += 1) {
		const option = options.find((entry) => entry.short === `-${arg[index]}`);
		if (option === undefined) return { kind: "rejected" };
		cluster.push(option);
		if (option.value !== undefined) {
			const rest = arg.slice(index + 1);
			return { kind: "cluster", options: cluster, explicit: rest.length > 0 ? rest : null };
		}
	}
	return { kind: "cluster", options: cluster, explicit: null };
}

/**
 * The first argument `python -m unittest` would reject with its exit 2 usage error, or null, read the way its argparse
 * parser reads them. The options are a closed, stdlib-defined set, so an unsupported one is refused before running:
 * `-p` belongs to `discover` alone, and the runner's usage error was sealed as a failing validation that held a merge
 * (L10). Where argparse's own positional quirks would still reject a form this accepts, the run's exit 2 is checked
 * against the runner's parser after the fact.
 */
function unsupportedUnittestArg(args: ReadonlyArray<string>): string | null {
	const discover = args[0]?.toLowerCase() === "discover";
	const options = discover ? UNITTEST_DISCOVER_OPTIONS : UNITTEST_OPTIONS;
	let positionals = 0;
	for (let index = discover ? 1 : 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (arg === "--") {
			positionals += args.length - index - 1;
			break;
		}
		const parsed = parseUnittestArg(arg, options);
		if (parsed.kind === "rejected") return arg;
		if (parsed.kind === "positional") {
			positionals += 1;
			continue;
		}
		const option = parsed.kind === "option" ? parsed.option : parsed.options[parsed.options.length - 1];
		if (option?.value === undefined) {
			// A flag takes no value: argparse refuses `--verbose=x` and `-v=x`.
			if (parsed.explicit !== null) return arg;
			continue;
		}
		let value = parsed.explicit;
		if (value === null) {
			const next = args[index + 1];
			// A separate value must not itself read as an option, as `-k -p` does.
			if (next === undefined || next === "--" || parseUnittestArg(next, options).kind !== "positional") return arg;
			value = next;
			index += 1;
		}
		if (option.value === "int" && !PYTHON_INT.test(value)) return parsed.explicit === null ? `${arg} ${value}` : arg;
	}
	// discover takes at most start, pattern and top as positionals.
	return discover && positionals > 3 ? (args[args.length - 1] ?? "discover") : null;
}

/**
 * Why verify refuses to run this argv, or null. Resolution keeps the argv so the safety scan judges what the model
 * sent; the tool refuses it before spawning, naming the forms the runner accepts so the retry is a correct one.
 */
export function unsupportedRunnerArgs(check: ToolchainCheck, argv: ReadonlyArray<string>): string | null {
	const base = check.argsBase;
	if (base?.at(-1) !== "unittest" || argv.length <= base.length || base.some((arg, index) => argv[index] !== arg))
		return null;
	const rejected = unsupportedUnittestArg(argv.slice(base.length));
	if (rejected === null) return null;
	const flag = check.command.indexOf("-s");
	const start = (flag === -1 ? undefined : check.command[flag + 1]) ?? ".";
	return (
		`check '${check.id}' runs \`${base.join(" ")} <args>\`, which does not accept '${rejected}'; nothing ran. ` +
		`Accepted args: test names (module, module.Class, module.Class.test_method, or a file path such as ${start}/test_x.py) with -v, -q, -f, -c, -b, --locals, -k PATTERN or --durations N (an integer); ` +
		`or "discover" first, which also takes -s DIR, -p PATTERN and -t DIR, e.g. args: ["discover", "-s", "${start}", "-p", "test_x.py"]. ` +
		"Retry with one of these forms, or with no args for the whole suite."
	);
}

/** The argv a derived check runs with model-supplied arguments, or why the check refuses them. */
export function toolchainArgv(check: ToolchainCheck, extraArgs: ReadonlyArray<string>): string[] | Error {
	if (extraArgs.length === 0) return [...check.command];
	if (check.argsBase === undefined) return new Error(`check '${check.id}' takes no arguments`);
	return [...check.argsBase, ...extraArgs];
}
