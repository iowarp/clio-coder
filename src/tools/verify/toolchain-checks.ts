import path from "node:path";
import { readCiRunCommands } from "../../core/ci-commands.js";
import { SAFE_EXEC_DEFAULT_TIMEOUT_MS } from "../../core/safe-exec.js";
import { isVerificationScriptName } from "../../core/verification-scripts.js";
import type { DeclaredCheck } from "./catalog.js";
import {
	cargoProposals,
	cmakeProposals,
	discoverDeclaredProjectEntriesAtRoot,
	goProposals,
	pythonProposals,
	type RawProposal,
	regularFileText,
	shellLikeArgv,
	slug,
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

export const TOOLCHAIN_SOURCE_PATH = "(repository toolchain)";

/** What discovery reads, named in the error an agent gets when nothing is found. */
export const TOOLCHAIN_DISCOVERY_SOURCES =
	"package.json scripts, .clio-coder/verifiers.yaml, pyproject.toml/pytest.ini/setup.cfg/tox.ini/noxfile.py, " +
	"tests/ or test/ with test_*.py modules, uv.lock, Makefile and justfile targets, Cargo.toml, go.mod, " +
	"CMakePresets.json test presets, and scripts run by .github/workflows, .gitlab-ci.yml, .circleci or azure-pipelines";

/** A derived check and the argv prefix model-supplied `args` extend; absent means the check takes none. */
export interface ToolchainCheck extends DeclaredCheck {
	argsBase?: string[];
}

const SHELL_TOKEN_RE = /[|&;<>`$(){}*?]/u;

function fromProposal(proposal: RawProposal, id: string, argsBase: string[] | undefined): ToolchainCheck {
	return {
		id,
		description: proposal.description,
		command: [...proposal.command],
		cwd: proposal.cwd,
		timeoutMs: proposal.timeoutMs,
		tags: [...proposal.tags],
		source: { kind: "toolchain", path: proposal.provenance.path },
		kind: "command",
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
function taskRunnerProposals(workspaceRoot: string): RawProposal[] {
	const proposals: RawProposal[] = [];
	for (const entry of discoverDeclaredProjectEntriesAtRoot(workspaceRoot)) {
		if (entry.kind === "package-script") continue;
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

export function discoverToolchainChecks(workspaceRoot: string): ToolchainCheck[] {
	const diagnostics: string[] = [];
	const proposals = [
		...pythonProposals(workspaceRoot, diagnostics),
		...cargoProposals(workspaceRoot, diagnostics),
		...goProposals(workspaceRoot, diagnostics),
		...cmakeProposals(workspaceRoot, diagnostics).filter((proposal) => proposal.tags.includes("test")),
		...taskRunnerProposals(workspaceRoot),
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

/** The argv a derived check runs with model-supplied arguments, or why the check refuses them. */
export function toolchainArgv(check: ToolchainCheck, extraArgs: ReadonlyArray<string>): string[] | Error {
	if (extraArgs.length === 0) return [...check.command];
	if (check.argsBase === undefined) return new Error(`check '${check.id}' takes no arguments`);
	return [...check.argsBase, ...extraArgs];
}
