import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { isMap, isSeq, parseDocument, stringify, type YAMLMap } from "yaml";
import { resolveSafeCwd, SAFE_EXEC_DEFAULT_TIMEOUT_MS } from "../../core/safe-exec.js";
import { isVerificationScriptName } from "../../core/verification-scripts.js";
import { compareCodepoints } from "../../domains/evidence/ordering.js";
import type { ToolResult } from "../registry.js";
import {
	type DeclaredCheck,
	PROJECT_VERIFIER_CATALOG_CAPS,
	PROJECT_VERIFIER_CATALOG_RELATIVE_PATH,
	PROJECT_VERIFIER_CATALOG_VERSION,
	parseProjectVerifierCatalogText,
} from "./catalog.js";
import { verifyTool } from "./index.js";
import { discoverDeclaredChecksAtRoot } from "./scripts.js";

export type VerifierProposalAuthority = "project-declared" | "toolchain-defined";

export type VerifierSignalKind =
	| "package-script"
	| "project-catalog"
	| "cargo"
	| "cmake-preset"
	| "python-runner"
	| "go-module"
	| "validation-contract"
	| "manual-entry";

export interface VerifierProvenance {
	kind: VerifierSignalKind;
	path: string;
	detail: string;
	authority: VerifierProposalAuthority;
}

export interface AuthoringCheck {
	id: string;
	description: string;
	command: string[];
	cwd: string;
	timeoutMs: number;
	tags: string[];
	provenance: VerifierProvenance;
	state: "active" | "existing" | "proposed" | "manual";
	/** The id this check has in the on-disk catalog, so a rename still edits its node in place. */
	catalogId?: string;
}

export interface VerifierAuthoringDiscovery {
	ok: true;
	workspaceRoot: string;
	catalogPath: string;
	activeChecks: AuthoringCheck[];
	existingChecks: AuthoringCheck[];
	proposals: AuthoringCheck[];
	diagnostics: string[];
	manualEntry: string;
	/** The catalog file as found, when one exists; revisions are written into it in place. */
	catalogText?: string;
}

export interface VerifierAuthoringDiscoveryError {
	ok: false;
	reason: string;
	manualEntry: string;
}

export type VerifierAuthoringDiscoveryResult = VerifierAuthoringDiscovery | VerifierAuthoringDiscoveryError;

export interface VerifierDraft {
	workspaceRoot: string;
	catalogPath: string;
	activeChecks: AuthoringCheck[];
	checks: AuthoringCheck[];
	diagnostics: string[];
	manualEntry: string;
	catalogText?: string;
}

export type VerifierRevision =
	| { kind: "add"; check: Omit<AuthoringCheck, "state" | "provenance">; provenance?: VerifierProvenance }
	| {
			kind: "edit";
			id: string;
			changes: Partial<Pick<AuthoringCheck, "description" | "command" | "cwd" | "timeoutMs" | "tags">>;
	  }
	| { kind: "rename"; id: string; newId: string }
	| { kind: "remove"; id: string };

export type VerifierDraftValidation =
	| { ok: true; text: string; checks: AuthoringCheck[] }
	| { ok: false; reason: string; text: string };

export type VerifierRevisionResult =
	| { ok: true; draft: VerifierDraft; diagnostics: string[] }
	| { ok: false; draft: VerifierDraft; reason: string };

export type VerifierAuthoringDecision =
	| { kind: "confirm"; dryRunCheckIds?: string[] }
	| { kind: "reject" }
	| { kind: "revise"; revisions: VerifierRevision[] };

export interface VerifierAuthoringDecisionContext {
	draft: VerifierDraft;
	preview: string;
	validation: VerifierDraftValidation;
	revision: number;
}

export interface VerifierDryRunResult {
	id: string;
	result: ToolResult;
}

export type VerifierAuthoringWorkflowResult =
	| { status: "invalid"; reason: string; wrote: boolean; path?: string; preview?: string }
	| { status: "rejected"; wrote: false; preview: string; diagnostics: string[] }
	| {
			status: "written";
			wrote: true;
			path: string;
			preview: string;
			diagnostics: string[];
			dryRuns: VerifierDryRunResult[];
	  };

export interface VerifierAuthoringWorkflowOptions {
	workspaceRoot?: string;
	includeProposals?: boolean;
	initialRevisions?: VerifierRevision[];
	/**
	 * The operator already authorized writing (`--yes`), so the review is a
	 * pre-write authority preview and must not claim nothing will be written.
	 */
	confirmed?: boolean;
	decide: (context: VerifierAuthoringDecisionContext) => VerifierAuthoringDecision | Promise<VerifierAuthoringDecision>;
	runCheck?: (id: string) => Promise<ToolResult>;
}

interface RawProposal {
	preferredId: string;
	description: string;
	command: string[];
	cwd: string;
	timeoutMs: number;
	tags: string[];
	provenance: VerifierProvenance;
}

const DECLARED_FILE_CAP_BYTES = 1024 * 1024;
const VALIDATION_CONTRACT_PATHS = [
	".clio-coder/validation.yaml",
	".clio-coder/validation.yml",
	"validation.yaml",
	"validation.yml",
] as const;

function manualEntryInstruction(): string {
	return (
		"No unambiguous declared command was found. Add one explicitly with " +
		'`clio-coder verifiers add --id <id> --description <text> --command \'["executable","arg"]\'`; `--command` is an exact JSON argv array. Review the preview, then rerun with `--yes`.'
	);
}

function cloneCheck(check: AuthoringCheck): AuthoringCheck {
	return {
		...check,
		command: [...check.command],
		tags: [...check.tags],
		provenance: { ...check.provenance },
	};
}

function relativePath(workspaceRoot: string, filePath: string): string {
	const relative = path.relative(workspaceRoot, filePath);
	return relative.length === 0 ? "." : relative.split(path.sep).join("/");
}

function regularFileText(filePath: string, workspaceRoot: string): string | null | Error {
	if (!existsSync(filePath)) return null;
	try {
		const realRoot = realpathSync(workspaceRoot);
		const realFilePath = realpathSync(filePath);
		resolveSafeCwd(realFilePath, realRoot);
		const stats = statSync(realFilePath);
		if (!stats.isFile()) return new Error("path is not a regular file");
		if (stats.size > DECLARED_FILE_CAP_BYTES) {
			return new Error(`file exceeds the ${DECLARED_FILE_CAP_BYTES}-byte discovery cap`);
		}
		return readFileSync(realFilePath, "utf8");
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
}

function slug(value: string, fallback: string): string {
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z0-9._:-]+/gu, "-")
		.replace(/^[^a-z0-9]+/u, "")
		.replace(/[-.:]+$/u, "");
	return normalized.length > 0 ? normalized : fallback;
}

function boundedId(base: string, suffix = ""): string {
	const cap = PROJECT_VERIFIER_CATALOG_CAPS.idBytes - Buffer.byteLength(suffix, "utf8");
	let result = "";
	for (const character of base) {
		if (Buffer.byteLength(result + character, "utf8") > cap) break;
		result += character;
	}
	result = result.replace(/[-.:]+$/u, "");
	return `${result.length > 0 ? result : "check"}${suffix}`;
}

/** Allocate the same stable suffix for the same ordered set of occupied IDs. */
export function deterministicVerifierId(preferredId: string, occupied: ReadonlySet<string>): string {
	const base = boundedId(slug(preferredId, "check"));
	if (!occupied.has(base) && base !== "frontend") return base;
	for (let index = 2; index <= PROJECT_VERIFIER_CATALOG_CAPS.checks + 2; index += 1) {
		const suffix = `-${index}`;
		const candidate = boundedId(base, suffix);
		if (!occupied.has(candidate) && candidate !== "frontend") return candidate;
	}
	throw new Error(`cannot allocate a deterministic ID for '${preferredId}' within the catalog cap`);
}

function rawProposalSort(left: RawProposal, right: RawProposal): number {
	return (
		compareCodepoints(left.provenance.path, right.provenance.path) ||
		compareCodepoints(left.provenance.detail, right.provenance.detail) ||
		compareCodepoints(left.preferredId, right.preferredId) ||
		compareCodepoints(JSON.stringify(left.command), JSON.stringify(right.command))
	);
}

function checkIdentity(check: Pick<AuthoringCheck, "command" | "cwd">): string {
	return JSON.stringify([check.cwd, check.command]);
}

function sourceProvenance(workspaceRoot: string, check: DeclaredCheck): VerifierProvenance {
	if (check.source.kind === "package.json") {
		return {
			kind: "package-script",
			path: relativePath(workspaceRoot, check.source.path),
			detail: `package.json script '${check.id}'`,
			authority: "project-declared",
		};
	}
	return {
		kind: "project-catalog",
		path: PROJECT_VERIFIER_CATALOG_RELATIVE_PATH,
		detail: `existing catalog check '${check.id}'`,
		authority: "project-declared",
	};
}

function projectedCheck(workspaceRoot: string, check: DeclaredCheck): AuthoringCheck {
	return {
		id: check.id,
		description: check.description,
		command: [...check.command],
		cwd: check.cwd,
		timeoutMs: check.timeoutMs,
		tags: [...check.tags],
		provenance: sourceProvenance(workspaceRoot, check),
		state: check.source.kind === "package.json" ? "active" : "existing",
		...(check.source.kind === "package.json" ? {} : { catalogId: check.id }),
	};
}

function cargoProposals(workspaceRoot: string, diagnostics: string[]): RawProposal[] {
	const relative = "Cargo.toml";
	const text = regularFileText(path.join(workspaceRoot, relative), workspaceRoot);
	if (text === null) return [];
	if (text instanceof Error) {
		diagnostics.push(`${relative}: ${text.message}; Cargo discovery skipped.`);
		return [];
	}
	const workspace = /^\s*\[workspace(?:\]|\.)/mu.test(text);
	const packageManifest = /^\s*\[package\]/mu.test(text);
	if (!workspace && !packageManifest) {
		diagnostics.push(`${relative}: no [package] or [workspace] declaration was found; Cargo discovery skipped.`);
		return [];
	}
	return [
		{
			preferredId: "cargo-test",
			description: workspace ? "Run the Cargo workspace tests" : "Run the Cargo package tests",
			command: workspace ? ["cargo", "test", "--workspace"] : ["cargo", "test"],
			cwd: ".",
			timeoutMs: SAFE_EXEC_DEFAULT_TIMEOUT_MS,
			tags: ["rust", "test"],
			provenance: {
				kind: "cargo",
				path: relative,
				detail: workspace ? "Cargo [workspace] manifest" : "Cargo package manifest",
				authority: "toolchain-defined",
			},
		},
	];
}

function cmakeProposals(workspaceRoot: string, diagnostics: string[]): RawProposal[] {
	const relative = "CMakePresets.json";
	const text = regularFileText(path.join(workspaceRoot, relative), workspaceRoot);
	if (text === null) return [];
	if (text instanceof Error) {
		diagnostics.push(`${relative}: ${text.message}; CMake preset discovery skipped.`);
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch (error) {
		diagnostics.push(`${relative}: invalid JSON (${error instanceof Error ? error.message : String(error)}).`);
		return [];
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		diagnostics.push(`${relative}: root is not an object; CMake preset discovery skipped.`);
		return [];
	}
	const record = parsed as Record<string, unknown>;
	const proposals: RawProposal[] = [];
	for (const [field, executable, args, label, tag] of [
		["testPresets", "ctest", ["--preset"], "test", "test"],
		["buildPresets", "cmake", ["--build", "--preset"], "build", "build"],
	] as const) {
		const presets = record[field];
		if (!Array.isArray(presets)) continue;
		for (const preset of presets) {
			if (preset === null || typeof preset !== "object" || Array.isArray(preset)) continue;
			const value = preset as Record<string, unknown>;
			if (value.hidden === true || typeof value.name !== "string" || value.name.length === 0) continue;
			const name = value.name;
			proposals.push({
				preferredId: `cmake-${label}-${slug(name, "preset")}`,
				description: `Run CMake ${label} preset '${name}'`,
				command: [executable, ...args, name],
				cwd: ".",
				timeoutMs: SAFE_EXEC_DEFAULT_TIMEOUT_MS,
				tags: ["cmake", tag],
				provenance: {
					kind: "cmake-preset",
					path: relative,
					detail: `${field} entry '${name}'`,
					authority: "toolchain-defined",
				},
			});
		}
	}
	if (proposals.length === 0) diagnostics.push(`${relative}: no visible buildPresets or testPresets were declared.`);
	return proposals;
}

function tomlSections(text: string): Map<string, string[]> {
	const sections = new Map<string, string[]>();
	let active = "";
	for (const line of text.split(/\r?\n/u)) {
		const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u.exec(line);
		if (header?.[1] !== undefined) {
			active = header[1].trim();
			if (!sections.has(active)) sections.set(active, []);
			continue;
		}
		if (active.length > 0) sections.get(active)?.push(line);
	}
	return sections;
}

function declaredScriptName(line: string): string | null {
	const match = /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.:-]+))\s*=\s*(?:"[^"]+"|'[^']+')\s*(?:#.*)?$/u.exec(line);
	return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function pythonProposals(workspaceRoot: string, diagnostics: string[]): RawProposal[] {
	const proposals: RawProposal[] = [];
	const pyprojectPath = "pyproject.toml";
	const pyproject = regularFileText(path.join(workspaceRoot, pyprojectPath), workspaceRoot);
	if (pyproject instanceof Error) diagnostics.push(`${pyprojectPath}: ${pyproject.message}; Python discovery skipped.`);
	if (typeof pyproject === "string") {
		const sections = tomlSections(pyproject);
		for (const [section, module, id, description, tags] of [
			["tool.pytest.ini_options", "pytest", "python-pytest", "Run the declared pytest suite", ["python", "test"]],
			["tool.tox", "tox", "python-tox", "Run the declared tox environments", ["python", "test"]],
			["tool.nox", "nox", "python-nox", "Run the declared nox sessions", ["python", "test"]],
		] as const) {
			if (!sections.has(section)) continue;
			proposals.push({
				preferredId: id,
				description,
				command: ["python", "-m", module],
				cwd: ".",
				timeoutMs: SAFE_EXEC_DEFAULT_TIMEOUT_MS,
				tags: [...tags],
				provenance: {
					kind: "python-runner",
					path: pyprojectPath,
					detail: `[${section}]`,
					authority: "toolchain-defined",
				},
			});
		}
		for (const section of ["project.scripts", "tool.poetry.scripts"]) {
			for (const line of sections.get(section) ?? []) {
				const name = declaredScriptName(line);
				if (name === null || !isVerificationScriptName(name)) continue;
				proposals.push({
					preferredId: `python-${slug(name, "check")}`,
					description: `Run declared Python entry point '${name}'`,
					command: [name],
					cwd: ".",
					timeoutMs: SAFE_EXEC_DEFAULT_TIMEOUT_MS,
					tags: [slug(name.split(/[:.-]/u)[0] ?? "python", "python"), "python"],
					provenance: {
						kind: "python-runner",
						path: pyprojectPath,
						detail: `[${section}] entry '${name}'`,
						authority: "project-declared",
					},
				});
			}
		}
	}

	for (const [relative, marker, module, id, description] of [
		["pytest.ini", null, "pytest", "python-pytest", "Run the declared pytest suite"],
		["tox.ini", null, "tox", "python-tox", "Run the declared tox environments"],
		["noxfile.py", null, "nox", "python-nox", "Run the declared nox sessions"],
		["setup.cfg", /^\s*\[tool:pytest\]/mu, "pytest", "python-pytest", "Run the declared pytest suite"],
	] as const) {
		const text = regularFileText(path.join(workspaceRoot, relative), workspaceRoot);
		if (text === null) continue;
		if (text instanceof Error) {
			diagnostics.push(`${relative}: ${text.message}; Python discovery skipped.`);
			continue;
		}
		if (marker !== null && !marker.test(text)) continue;
		proposals.push({
			preferredId: id,
			description,
			command: ["python", "-m", module],
			cwd: ".",
			timeoutMs: SAFE_EXEC_DEFAULT_TIMEOUT_MS,
			tags: ["python", "test"],
			provenance: {
				kind: "python-runner",
				path: relative,
				detail: `${module} configuration file`,
				authority: "toolchain-defined",
			},
		});
	}
	return proposals;
}

function goProposals(workspaceRoot: string, diagnostics: string[]): RawProposal[] {
	const relative = "go.mod";
	const text = regularFileText(path.join(workspaceRoot, relative), workspaceRoot);
	if (text === null) return [];
	if (text instanceof Error) {
		diagnostics.push(`${relative}: ${text.message}; Go discovery skipped.`);
		return [];
	}
	if (!/^\s*module\s+\S+/mu.test(text)) {
		diagnostics.push(`${relative}: no module directive was found; Go discovery skipped.`);
		return [];
	}
	return [
		{
			preferredId: "go-test",
			description: "Run all Go module tests",
			command: ["go", "test", "./..."],
			cwd: ".",
			timeoutMs: SAFE_EXEC_DEFAULT_TIMEOUT_MS,
			tags: ["go", "test"],
			provenance: {
				kind: "go-module",
				path: relative,
				detail: "Go module directive",
				authority: "toolchain-defined",
			},
		},
	];
}

function shellLikeArgv(command: string): string[] | Error {
	const argv: string[] = [];
	let token = "";
	let quote: "single" | "double" | null = null;
	let tokenStarted = false;
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index] ?? "";
		if (quote === "single") {
			if (character === "'") quote = null;
			else token += character;
			tokenStarted = true;
			continue;
		}
		if (quote === "double") {
			if (character === '"') {
				quote = null;
				continue;
			}
			if (character === "\\") {
				const next = command[index + 1];
				if (next === undefined) return new Error("trailing escape");
				token += next;
				index += 1;
			} else if (character === "$" || character === "`") {
				return new Error(`shell expansion '${character}' is ambiguous`);
			} else {
				token += character;
			}
			tokenStarted = true;
			continue;
		}
		if (/\s/u.test(character)) {
			if (tokenStarted) {
				argv.push(token);
				token = "";
				tokenStarted = false;
			}
			continue;
		}
		if (character === "'") {
			quote = "single";
			tokenStarted = true;
			continue;
		}
		if (character === '"') {
			quote = "double";
			tokenStarted = true;
			continue;
		}
		if (character === "\\") {
			const next = command[index + 1];
			if (next === undefined) return new Error("trailing escape");
			token += next;
			tokenStarted = true;
			index += 1;
			continue;
		}
		if ("|&;<>()`$\n\r".includes(character)) {
			return new Error(`shell operator or expansion '${character}' is ambiguous`);
		}
		token += character;
		tokenStarted = true;
	}
	if (quote !== null) return new Error(`unterminated ${quote}-quoted argument`);
	if (tokenStarted) argv.push(token);
	if (argv.length === 0) return new Error("empty command");
	if ((argv[0] ?? "").includes("=")) return new Error("environment assignments are not argv executables");
	return argv;
}

function validatorArgv(value: unknown): string[] | Error {
	if (typeof value === "string") return shellLikeArgv(value);
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.some((entry) => typeof entry !== "string" || entry.length === 0)
	) {
		return new Error("validator must be a command string or a non-empty argv string array");
	}
	return [...(value as string[])];
}

function validationPreferredId(argv: ReadonlyArray<string>): string {
	const executable = path.basename(argv[0] ?? "check").replace(/\.[^.]+$/u, "");
	const script = argv.find((entry, index) => index > 0 && /\.(?:py|js|mjs|sh)$/u.test(entry));
	const subject = script === undefined ? executable : path.basename(script).replace(/\.[^.]+$/u, "");
	return `validation-${slug(subject, "check")}`;
}

function validationContractProposals(workspaceRoot: string, diagnostics: string[]): RawProposal[] {
	const proposals: RawProposal[] = [];
	for (const relative of VALIDATION_CONTRACT_PATHS) {
		const text = regularFileText(path.join(workspaceRoot, relative), workspaceRoot);
		if (text === null) continue;
		if (text instanceof Error) {
			diagnostics.push(`${relative}: ${text.message}; validation command discovery skipped.`);
			continue;
		}
		const document = parseDocument(text, { prettyErrors: false, strict: true, uniqueKeys: true });
		if (document.errors.length > 0) {
			diagnostics.push(`${relative}: invalid YAML; validation command discovery skipped.`);
			continue;
		}
		let parsed: unknown;
		try {
			parsed = document.toJS({ maxAliasCount: 0 }) as unknown;
		} catch (error) {
			diagnostics.push(`${relative}: invalid YAML (${error instanceof Error ? error.message : String(error)}).`);
			continue;
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
		const validators = (parsed as Record<string, unknown>).validators;
		if (!Array.isArray(validators)) continue;
		for (const [index, validator] of validators.entries()) {
			const record =
				validator !== null && typeof validator === "object" && !Array.isArray(validator)
					? (validator as Record<string, unknown>)
					: null;
			if (record !== null) {
				const typedFields: ReadonlyArray<readonly [string, (value: unknown) => boolean]> = [
					["id", (value: unknown) => typeof value === "string"],
					["description", (value: unknown) => typeof value === "string"],
					["cwd", (value: unknown) => typeof value === "string"],
					["timeoutMs", (value: unknown) => typeof value === "number"],
					["tags", (value: unknown) => Array.isArray(value) && value.every((tag) => typeof tag === "string")],
				];
				const invalidField = typedFields.find(([field, valid]) => Object.hasOwn(record, field) && !valid(record[field]));
				if (invalidField !== undefined) {
					diagnostics.push(
						`${relative}: validators[${index}].${String(invalidField[0])} has an ambiguous type; use manual argv entry.`,
					);
					continue;
				}
			}
			const commandValue = record === null ? validator : record.command;
			const argv = validatorArgv(commandValue);
			if (argv instanceof Error) {
				diagnostics.push(`${relative}: validators[${index}] is ambiguous (${argv.message}); use manual argv entry.`);
				continue;
			}
			const declaredId = typeof record?.id === "string" ? record.id : validationPreferredId(argv);
			const description =
				typeof record?.description === "string"
					? record.description
					: `Run validation contract command ${JSON.stringify(argv)}`;
			const cwd = typeof record?.cwd === "string" ? record.cwd : ".";
			const timeoutMs = typeof record?.timeoutMs === "number" ? record.timeoutMs : SAFE_EXEC_DEFAULT_TIMEOUT_MS;
			const tags = Array.isArray(record?.tags) ? record.tags.filter((tag): tag is string => typeof tag === "string") : [];
			proposals.push({
				preferredId: declaredId,
				description,
				command: argv,
				cwd,
				timeoutMs,
				tags: tags.length > 0 ? tags : ["scientific", "validation"],
				provenance: {
					kind: "validation-contract",
					path: relative,
					detail: `validators[${index}]`,
					authority: "project-declared",
				},
			});
		}
	}
	if (existsSync(path.join(workspaceRoot, "VALIDATION.md"))) {
		diagnostics.push(
			"VALIDATION.md is advisory prose; enter an exact argv vector manually instead of inferring a command.",
		);
	}
	return proposals;
}

function deduplicatedRawProposals(proposals: RawProposal[], diagnostics: string[]): RawProposal[] {
	const seen = new Map<string, RawProposal>();
	for (const proposal of proposals.sort(rawProposalSort)) {
		const identity = checkIdentity(proposal);
		const prior = seen.get(identity);
		if (prior !== undefined) {
			diagnostics.push(
				`${proposal.provenance.path} (${proposal.provenance.detail}) repeats ${prior.provenance.path} (${prior.provenance.detail}); one proposal was kept.`,
			);
			continue;
		}
		seen.set(identity, proposal);
	}
	return [...seen.values()];
}

/** Inspect declared manifests/configuration without writing files or running commands. */
export function discoverVerifierAuthoring(workspaceRoot = process.cwd()): VerifierAuthoringDiscoveryResult {
	const manualEntry = manualEntryInstruction();
	const productionDiscovery = discoverDeclaredChecksAtRoot(workspaceRoot, undefined);
	if (!productionDiscovery.ok) {
		return {
			ok: false,
			reason: `Cannot author over the existing verifier authority: ${productionDiscovery.reason}`,
			manualEntry,
		};
	}
	const activeChecks: AuthoringCheck[] = [];
	const existingChecks: AuthoringCheck[] = [];
	for (const source of productionDiscovery.sources) {
		for (const check of source.checks) {
			const projected = projectedCheck(workspaceRoot, check);
			if (projected.state === "active") activeChecks.push(projected);
			else existingChecks.push(projected);
		}
	}
	activeChecks.sort((left, right) => compareCodepoints(left.id, right.id));
	existingChecks.sort((left, right) => compareCodepoints(left.id, right.id));

	const diagnostics: string[] = [];
	const raw = deduplicatedRawProposals(
		[
			...cargoProposals(workspaceRoot, diagnostics),
			...cmakeProposals(workspaceRoot, diagnostics),
			...pythonProposals(workspaceRoot, diagnostics),
			...goProposals(workspaceRoot, diagnostics),
			...validationContractProposals(workspaceRoot, diagnostics),
		],
		diagnostics,
	);
	const occupied = new Set([...activeChecks, ...existingChecks].map((check) => check.id));
	const represented = new Map(existingChecks.map((check) => [checkIdentity(check), check.id]));
	const proposals: AuthoringCheck[] = [];
	for (const proposal of raw) {
		const priorId = represented.get(checkIdentity(proposal));
		if (priorId !== undefined) {
			diagnostics.push(
				`${proposal.provenance.path} (${proposal.provenance.detail}) is already represented by catalog check '${priorId}'.`,
			);
			continue;
		}
		const normalizedId = boundedId(slug(proposal.preferredId, "check"));
		const id = deterministicVerifierId(proposal.preferredId, occupied);
		if (normalizedId !== proposal.preferredId) {
			diagnostics.push(`Proposed ID '${proposal.preferredId}' was normalized to '${normalizedId}'.`);
		}
		if (id !== normalizedId) {
			diagnostics.push(`Proposed ID '${normalizedId}' collides with declared authority; using '${id}'.`);
		}
		occupied.add(id);
		represented.set(checkIdentity(proposal), id);
		proposals.push({
			id,
			description: proposal.description,
			command: [...proposal.command],
			cwd: proposal.cwd,
			timeoutMs: proposal.timeoutMs,
			tags: [...proposal.tags],
			provenance: { ...proposal.provenance },
			state: "proposed",
		});
	}
	proposals.sort((left, right) => compareCodepoints(left.id, right.id));
	if (activeChecks.length === 0 && existingChecks.length === 0 && proposals.length === 0) {
		diagnostics.push(
			"No package verification script, supported toolchain declaration, or exact validation command was found.",
		);
	}
	const catalogPath = path.join(workspaceRoot, PROJECT_VERIFIER_CATALOG_RELATIVE_PATH);
	const catalogText = regularFileText(catalogPath, workspaceRoot);
	return {
		ok: true,
		workspaceRoot,
		catalogPath,
		activeChecks,
		existingChecks,
		proposals,
		diagnostics,
		manualEntry,
		...(typeof catalogText === "string" ? { catalogText } : {}),
	};
}

export function createVerifierDraft(
	discovery: VerifierAuthoringDiscovery,
	options: { includeProposals?: boolean } = {},
): VerifierDraft {
	return {
		workspaceRoot: discovery.workspaceRoot,
		catalogPath: discovery.catalogPath,
		activeChecks: discovery.activeChecks.map(cloneCheck),
		checks: [...discovery.existingChecks, ...(options.includeProposals === false ? [] : discovery.proposals)]
			.map(cloneCheck)
			.sort((left, right) => compareCodepoints(left.id, right.id)),
		diagnostics: [...discovery.diagnostics],
		manualEntry: discovery.manualEntry,
		...(discovery.catalogText === undefined ? {} : { catalogText: discovery.catalogText }),
	};
}

function catalogEntry({ id, description, command, cwd, timeoutMs, tags }: AuthoringCheck): Record<string, unknown> {
	return { id, description, command: [...command], cwd, timeoutMs, tags: [...tags] };
}

/**
 * A fresh catalog is serialized from the draft. An existing catalog is edited
 * in place: the operator's comments and on-disk order survive, untouched
 * fields keep their bytes, and only changed fields, removed checks, and
 * appended checks move. The parser sorts by id on load, so order on disk is
 * the operator's to keep.
 */
function serializeVerifierDraft(draft: VerifierDraft): string {
	const checks = [...draft.checks].sort((left, right) => compareCodepoints(left.id, right.id));
	const document = draft.catalogText === undefined ? null : parseDocument(draft.catalogText);
	const sequence = document?.get("checks");
	if (document === null || !isSeq(sequence)) {
		return stringify({ version: PROJECT_VERIFIER_CATALOG_VERSION, checks: checks.map(catalogEntry) }, { lineWidth: 0 });
	}
	const nodes = new Map<unknown, YAMLMap>();
	for (const node of sequence.items) if (isMap(node)) nodes.set(node.get("id"), node);
	const kept = new Set<YAMLMap>();
	const appended: unknown[] = [];
	let changed = false;
	for (const check of checks) {
		const entry = catalogEntry(check);
		const node = nodes.get(check.catalogId ?? check.id);
		if (node === undefined) {
			appended.push(document.createNode(entry));
			continue;
		}
		kept.add(node);
		const current = node.toJSON() as Record<string, unknown>;
		for (const [field, value] of Object.entries(entry)) {
			if (JSON.stringify(current[field]) === JSON.stringify(value)) continue;
			node.set(field, value);
			changed = true;
		}
	}
	if (!changed && appended.length === 0 && kept.size === sequence.items.length) return draft.catalogText as string;
	sequence.items = [...sequence.items.filter((node) => isMap(node) && kept.has(node)), ...appended];
	return document.toString({ lineWidth: 0 });
}

/** Validate with the same production parser used by verify(). */
export function validateVerifierDraft(draft: VerifierDraft): VerifierDraftValidation {
	const text = serializeVerifierDraft(draft);
	const parsed = parseProjectVerifierCatalogText(text, draft.workspaceRoot, draft.catalogPath);
	if (!parsed.ok) return { ok: false, reason: parsed.reason, text };
	const activeId = new Map(draft.activeChecks.map((check) => [check.id, check]));
	for (const check of parsed.source?.checks ?? []) {
		const collision = activeId.get(check.id);
		if (collision !== undefined) {
			return {
				ok: false,
				reason:
					`duplicate declared check id '${check.id}' from ${collision.provenance.kind} ` +
					`(${collision.provenance.path}) and project-catalog (${PROJECT_VERIFIER_CATALOG_RELATIVE_PATH})`,
				text,
			};
		}
	}
	const byId = new Map(draft.checks.map((check) => [check.id, check]));
	const checks = (parsed.source?.checks ?? []).map((check) => {
		const original = byId.get(check.id);
		return {
			id: check.id,
			description: check.description,
			command: [...check.command],
			cwd: check.cwd,
			timeoutMs: check.timeoutMs,
			tags: [...check.tags],
			provenance:
				original?.provenance ??
				({
					kind: "manual-entry",
					path: PROJECT_VERIFIER_CATALOG_RELATIVE_PATH,
					detail: `manual check '${check.id}'`,
					authority: "project-declared",
				} satisfies VerifierProvenance),
			state: original?.state ?? "manual",
			...(original?.catalogId === undefined ? {} : { catalogId: original.catalogId }),
		} satisfies AuthoringCheck;
	});
	return { ok: true, text, checks };
}

function cloneDraft(draft: VerifierDraft): VerifierDraft {
	return {
		...draft,
		activeChecks: draft.activeChecks.map(cloneCheck),
		checks: draft.checks.map(cloneCheck),
		diagnostics: [...draft.diagnostics],
	};
}

/** Apply edits to a copy so a collision or schema failure leaves the prior draft intact. */
export function reviseVerifierDraft(
	draft: VerifierDraft,
	revisions: ReadonlyArray<VerifierRevision>,
): VerifierRevisionResult {
	const next = cloneDraft(draft);
	const diagnostics: string[] = [];
	for (const revision of revisions) {
		if (revision.kind === "add") {
			if (next.checks.some((check) => check.id === revision.check.id)) {
				return { ok: false, draft, reason: `Cannot add '${revision.check.id}': that ID already exists.` };
			}
			if (next.activeChecks.some((check) => check.id === revision.check.id)) {
				return { ok: false, draft, reason: `Cannot add '${revision.check.id}': it collides with an active package check.` };
			}
			next.checks.push({
				...revision.check,
				command: [...revision.check.command],
				tags: [...revision.check.tags],
				provenance:
					revision.provenance ??
					({
						kind: "manual-entry",
						path: PROJECT_VERIFIER_CATALOG_RELATIVE_PATH,
						detail: `manual check '${revision.check.id}'`,
						authority: "project-declared",
					} satisfies VerifierProvenance),
				state: "manual",
			});
			diagnostics.push(`Added check '${revision.check.id}'.`);
			continue;
		}
		const index = next.checks.findIndex((check) => check.id === revision.id);
		if (index === -1) return { ok: false, draft, reason: `Check '${revision.id}' does not exist.` };
		const check = next.checks[index];
		if (check === undefined) return { ok: false, draft, reason: `Check '${revision.id}' does not exist.` };
		if (revision.kind === "remove") {
			next.checks.splice(index, 1);
			diagnostics.push(`Removed check '${revision.id}'; its command is no longer executable through the catalog.`);
			continue;
		}
		if (revision.kind === "rename") {
			if (next.checks.some((candidate, candidateIndex) => candidateIndex !== index && candidate.id === revision.newId)) {
				return {
					ok: false,
					draft,
					reason: `Cannot rename '${revision.id}' to '${revision.newId}': that ID already exists.`,
				};
			}
			if (next.activeChecks.some((candidate) => candidate.id === revision.newId)) {
				return {
					ok: false,
					draft,
					reason: `Cannot rename '${revision.id}' to '${revision.newId}': it collides with an active package check.`,
				};
			}
			check.id = revision.newId;
			diagnostics.push(`Renamed check '${revision.id}' to '${revision.newId}'.`);
			continue;
		}
		if (revision.changes.description !== undefined) check.description = revision.changes.description;
		if (revision.changes.command !== undefined) check.command = [...revision.changes.command];
		if (revision.changes.cwd !== undefined) check.cwd = revision.changes.cwd;
		if (revision.changes.timeoutMs !== undefined) check.timeoutMs = revision.changes.timeoutMs;
		if (revision.changes.tags !== undefined) check.tags = [...revision.changes.tags];
		diagnostics.push(`Edited check '${revision.id}' without changing its deterministic ID.`);
	}
	next.checks.sort((left, right) => compareCodepoints(left.id, right.id));
	const validation = validateVerifierDraft(next);
	if (!validation.ok) return { ok: false, draft, reason: validation.reason };
	next.checks = validation.checks;
	next.diagnostics.push(...diagnostics);
	return { ok: true, draft: next, diagnostics };
}

function authorityDescription(check: AuthoringCheck): string {
	if (check.state === "active") {
		return "active package-script authority; verify runs npm with the declared script name and may accept explicit extra argv";
	}
	return (
		`exact catalog authority after confirmation; verify fixes argv, cwd, and timeout through safe-exec ` +
		`(proposal origin: ${check.provenance.authority})`
	);
}

function renderCheck(check: AuthoringCheck, destinationPath: string): string[] {
	return [
		`- ${check.id}`,
		`  path: ${check.state === "active" ? check.provenance.path : destinationPath}`,
		`  source: ${check.provenance.path} (${check.provenance.detail}; ${check.provenance.authority})`,
		`  argv: ${JSON.stringify(check.command)}`,
		`  cwd: ${check.cwd}`,
		`  timeoutMs: ${check.timeoutMs}`,
		`  tags: ${JSON.stringify(check.tags)}`,
		`  effective execution authority: ${authorityDescription(check)}`,
	];
}

export interface VerifierPreviewOptions {
	/** Suppress the unconfirmed-preview footer once the write is authorized. */
	confirmed?: boolean;
}

/** Render an authority review. This function is pure and never executes or writes. */
export function previewVerifierDraft(draft: VerifierDraft, options: VerifierPreviewOptions = {}): string {
	const validation = validateVerifierDraft(draft);
	const lines = [
		"Project verifier authority preview",
		`Catalog path: ${draft.catalogPath}`,
		`Schema validation: ${validation.ok ? "accepted by the production catalog parser" : `rejected (${validation.reason})`}`,
	];
	if (draft.activeChecks.length > 0) {
		lines.push("", "Already executable package checks (not duplicated into the catalog):");
		for (const check of draft.activeChecks) lines.push(...renderCheck(check, draft.catalogPath));
	}
	lines.push("", "Catalog checks after confirmation:");
	if (draft.checks.length === 0) lines.push("(none)");
	else for (const check of draft.checks) lines.push(...renderCheck(check, draft.catalogPath));
	if (draft.diagnostics.length > 0) {
		lines.push("", "Diagnostics:");
		for (const diagnostic of draft.diagnostics) lines.push(`- ${diagnostic}`);
	}
	if (draft.checks.length === 0) {
		lines.push(
			"",
			draft.activeChecks.length === 0
				? draft.manualEntry
				: "No catalog checks are proposed; the package checks above are already executable without a catalog entry.",
		);
	}
	if (options.confirmed !== true) {
		lines.push("", "Preview only: no file has been written and no check has been executed.");
	}
	return lines.join("\n");
}

function writeValidatedDraft(draft: VerifierDraft, validation: Extract<VerifierDraftValidation, { ok: true }>): void {
	const directory = path.dirname(draft.catalogPath);
	mkdirSync(directory, { recursive: true });
	const realRoot = realpathSync(draft.workspaceRoot);
	const realDirectory = realpathSync(directory);
	resolveSafeCwd(realDirectory, realRoot);
	const realCatalogPath = path.join(realDirectory, path.basename(draft.catalogPath));
	const temporaryPath = path.join(
		realDirectory,
		`.${path.basename(draft.catalogPath)}.${process.pid}.${randomUUID()}.tmp`,
	);
	try {
		writeFileSync(temporaryPath, validation.text, { encoding: "utf8", flag: "wx", mode: 0o644 });
		renameSync(temporaryPath, realCatalogPath);
	} catch (error) {
		rmSync(temporaryPath, { force: true });
		throw error;
	}
}

/**
 * Run discovery, any number of pure revisions, confirmation, atomic write, and
 * optional checks. Only the confirm branch can reach the writer or executor.
 */
export async function runVerifierAuthoringWorkflow(
	options: VerifierAuthoringWorkflowOptions,
): Promise<VerifierAuthoringWorkflowResult> {
	const workspaceRoot = options.workspaceRoot ?? process.cwd();
	const discovery = discoverVerifierAuthoring(workspaceRoot);
	if (!discovery.ok) return { status: "invalid", reason: discovery.reason, wrote: false };
	let draft = createVerifierDraft(
		discovery,
		options.includeProposals === undefined ? {} : { includeProposals: options.includeProposals },
	);
	if (options.initialRevisions !== undefined && options.initialRevisions.length > 0) {
		const revised = reviseVerifierDraft(draft, options.initialRevisions);
		if (!revised.ok) return { status: "invalid", reason: revised.reason, wrote: false };
		draft = revised.draft;
	}
	for (let revision = 0; revision <= PROJECT_VERIFIER_CATALOG_CAPS.checks; revision += 1) {
		const validation = validateVerifierDraft(draft);
		const preview = previewVerifierDraft(draft, { confirmed: options.confirmed === true });
		const decision = await options.decide({ draft: cloneDraft(draft), preview, validation, revision });
		if (decision.kind === "reject") {
			return { status: "rejected", wrote: false, preview, diagnostics: [...draft.diagnostics] };
		}
		if (decision.kind === "revise") {
			const revised = reviseVerifierDraft(draft, decision.revisions);
			if (!revised.ok) {
				draft.diagnostics.push(`Revision rejected: ${revised.reason}`);
				continue;
			}
			draft = revised.draft;
			continue;
		}
		if (!validation.ok) return { status: "invalid", reason: validation.reason, wrote: false, preview };
		// Past this point the operator has authorized the write, so the returned
		// review may never claim that no file has been written.
		const authorizedPreview = previewVerifierDraft(draft, { confirmed: true });
		try {
			writeValidatedDraft(draft, validation);
		} catch (error) {
			return {
				status: "invalid",
				reason: `Could not write ${draft.catalogPath}: ${error instanceof Error ? error.message : String(error)}`,
				wrote: false,
				preview: authorizedPreview,
			};
		}
		const loaded = discoverDeclaredChecksAtRoot(workspaceRoot, undefined);
		if (!loaded.ok) {
			return {
				status: "invalid",
				reason: `Catalog was written but production discovery rejected it: ${loaded.reason}`,
				wrote: true,
				path: draft.catalogPath,
				preview: authorizedPreview,
			};
		}
		const dryRuns: VerifierDryRunResult[] = [];
		const runCheck = options.runCheck ?? ((id: string) => verifyTool.run({ check: id }));
		for (const id of decision.dryRunCheckIds ?? []) {
			dryRuns.push({ id, result: await runCheck(id) });
		}
		return {
			status: "written",
			wrote: true,
			path: draft.catalogPath,
			preview: authorizedPreview,
			diagnostics: [...draft.diagnostics],
			dryRuns,
		};
	}
	return {
		status: "invalid",
		reason: `Revision limit of ${PROJECT_VERIFIER_CATALOG_CAPS.checks} exceeded without an operator decision.`,
		wrote: false,
	};
}
