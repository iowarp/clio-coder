import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import type { DeclaredProof } from "../../core/hoare.js";
import { resolveSafeCwd, SAFE_EXEC_DEFAULT_TIMEOUT_MS } from "../../core/safe-exec.js";
import { isProjectVerifierCheckId } from "../../core/verification-scripts.js";
import { compareCodepoints } from "../../domains/evidence/ordering.js";
import { type NumericTolerance, normalizeNumericTolerance } from "./numeric.js";
import { normalizePerfBudget, normalizePerfTolerance, type PerfBudgetSpec } from "./perf.js";
import { parseDeclaredProof } from "./proof.js";
import {
	type DeclaredReproduce,
	normalizeRepeat,
	normalizeReproduce,
	normalizeSeed,
	REPRODUCE_CATALOG_FIELDS,
	type ReproduceSeed,
} from "./reproduce.js";

export const PROJECT_VERIFIER_CATALOG_RELATIVE_PATH = ".clio-coder/verifiers.yaml";
/** The version this build writes. Version 1 files still load; every check there is `kind: command`. */
export const PROJECT_VERIFIER_CATALOG_VERSION = 2;
const SUPPORTED_CATALOG_VERSIONS: ReadonlyArray<number> = [1, PROJECT_VERIFIER_CATALOG_VERSION];

/** Public schema limits. Diagnostics cite these values instead of hiding policy. */
export const PROJECT_VERIFIER_CATALOG_CAPS = Object.freeze({
	fileBytes: 256 * 1024,
	checks: 128,
	idBytes: 64,
	descriptionBytes: 512,
	argvEntries: 64,
	argumentBytes: 4096,
	cwdBytes: 512,
	timeoutMs: 900_000,
	tags: 16,
	tagBytes: 32,
	/** Declared input files of one numeric-compare check. */
	judgedInputs: 64,
	/** Provenance probes of one judged check. */
	provenanceProbes: 8,
});

/**
 * What a check proves. `command` reads the exit code. `numeric-compare` runs
 * the command, parses its stdout as `string -> number | number[]`, and judges
 * it against a reference file under a tolerance. `perf-budget` runs the
 * command and judges its wall time against a budget or a recorded baseline.
 * `reproduce` checks pinned input digests, runs the command in a clean
 * environment with a declared seed, and judges its metrics, their units and
 * their shapes against a reference file or a second clean run.
 */
export type DeclaredCheckKind = "command" | "numeric-compare" | "perf-budget" | "reproduce";

export const DECLARED_CHECK_KINDS: ReadonlyArray<DeclaredCheckKind> = [
	"command",
	"numeric-compare",
	"perf-budget",
	"reproduce",
];

export interface DeclaredNumericCompare {
	/** Repository-relative JSON file of the same shape as the command's stdout. */
	reference: string;
	/**
	 * At least one of `relative`, `absolute`, `ulp`, plus the optional rule
	 * fields `combine` (`all`, the default, or `any`) and `nonFinite` (`fail`,
	 * the default, or `match`), and `keys`, a per-key rule of its own bounds and
	 * `combine`. A catalog that omits the rule fields judges exactly as before
	 * they existed.
	 */
	tolerance: NumericTolerance;
	/**
	 * Repository-relative files the command reads. Each is hashed before the run and again after it: one that
	 * cannot be read fails the check before it runs, and one that changed fails it, so the report names the bytes
	 * the command read.
	 */
	inputs?: string[];
	/** Argv probes run once beside the check and recorded, never gating; see {@link validateProvenance}. */
	provenance?: string[][];
	/** Passed to every run in one environment variable. */
	seed?: ReproduceSeed;
	/** Runs, 1 to 5; absent means 1. Each run is judged against the reference, and the report records their spread. */
	repeat?: number;
}

export interface DeclaredPerfBudget {
	/** Declared bound; exactly one of `budget` and `baseline` is present. */
	budget?: PerfBudgetSpec;
	/** Repository-relative JSON file written by `clio-coder verifiers baseline <id>`. */
	baseline?: string;
	/** Headroom over a recorded baseline; only with `baseline`. */
	tolerance?: { relative?: number };
}

/**
 * `toolchain` checks are derived from build and CI files at call time and never written to a catalog;
 * `task` checks are the gate commands a verifier's dispatched task names (task-gates.ts).
 */
export type DeclaredCheckSourceKind = "package.json" | "project-catalog" | "toolchain" | "task";

export interface DeclaredCheckSourceRef {
	kind: DeclaredCheckSourceKind;
	path: string;
}

/** Canonical projection shared by built-in and project check providers. */
export interface DeclaredCheck {
	id: string;
	description: string;
	command: string[];
	cwd: string;
	timeoutMs: number;
	tags: string[];
	source: DeclaredCheckSourceRef;
	kind: DeclaredCheckKind;
	numeric?: DeclaredNumericCompare;
	perf?: DeclaredPerfBudget;
	reproduce?: DeclaredReproduce;
	proof?: DeclaredProof;
	proofCatalogDigest?: string;
	/**
	 * Repository-relative directory whose subdirectories are the runs of one sweep. A check that declares it judges
	 * one run per call, named `<id>/<run>`, with the run directory appended to its argv; it is never run bare.
	 */
	runs?: string;
}

export interface DeclaredCheckSource extends DeclaredCheckSourceRef {
	checks: DeclaredCheck[];
}

export type ProjectCatalogLoadResult = { ok: true; source: DeclaredCheckSource | null } | { ok: false; reason: string };

const ROOT_FIELDS = new Set(["version", "checks"]);
const CHECK_FIELDS = new Set(["id", "description", "command", "cwd", "timeoutMs", "tags"]);
/**
 * Version 2 adds the kind and its parameters; every one is optional and
 * kind-gated. The numeric tolerance object's own fields (`relative`,
 * `absolute`, `ulp`, `combine`, `nonFinite`, `keys`) are validated by
 * `normalizeNumericTolerance`, so this version admits a `combine`,
 * `nonFinite` or per-key `keys` rule without a catalog version bump: a file
 * that omits them keeps the original single strict-conjunction,
 * non-finite-fails judgement.
 */
const KIND_FIELDS = [
	...new Set(["reference", "tolerance", "budget", "baseline", "provenance", ...REPRODUCE_CATALOG_FIELDS]),
];
const CHECK_FIELDS_V2 = new Set([...CHECK_FIELDS, "kind", "runs", "proof", ...KIND_FIELDS]);
const TAG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SHELL_EXECUTABLES = new Set([
	"bash",
	"cmd",
	"command.com",
	"dash",
	"fish",
	"ksh",
	"powershell",
	"pwsh",
	"sh",
	"tcsh",
	"zsh",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 31 || code === 127) return true;
	}
	return false;
}

function catalogDiagnostic(message: string): ProjectCatalogLoadResult {
	return { ok: false, reason: `${PROJECT_VERIFIER_CATALOG_RELATIVE_PATH}: ${message}` };
}

function unknownFields(record: Record<string, unknown>, allowed: ReadonlySet<string>): string[] {
	return Object.keys(record)
		.filter((key) => !allowed.has(key))
		.sort(compareCodepoints);
}

function relativeCwd(workspaceRoot: string, resolved: string): string {
	const relative = path.relative(workspaceRoot, resolved);
	return relative.length === 0 ? "." : relative.split(path.sep).join("/");
}

interface ProjectVerifierCwdResolution {
	declared: string;
	execution: string;
}

function safelyResolveCatalogCwd(
	rawCwd: string,
	workspaceRoot: string,
	location: string,
): ProjectVerifierCwdResolution | Error {
	if (path.isAbsolute(rawCwd) || path.win32.isAbsolute(rawCwd)) {
		return new Error(`${location} must be repository-relative; absolute cwd '${rawCwd}' is not allowed`);
	}
	let resolved: string;
	try {
		resolved = resolveSafeCwd(rawCwd, workspaceRoot);
	} catch {
		return new Error(`${location} escapes the workspace root: '${rawCwd}'`);
	}
	let realCwd: string;
	try {
		const cwdStat = statSync(resolved);
		if (!cwdStat.isDirectory()) return new Error(`${location} is not a directory: '${rawCwd}'`);
		const realRoot = realpathSync(workspaceRoot);
		realCwd = realpathSync(resolved);
		resolveSafeCwd(realCwd, realRoot);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("escapes workspace root")) {
			return new Error(`${location} escapes the workspace root through a symbolic link: '${rawCwd}'`);
		}
		return new Error(`${location} cannot be resolved as a repository directory: '${rawCwd}' (${message})`);
	}
	return { declared: relativeCwd(workspaceRoot, resolved), execution: realCwd };
}

/**
 * A repository-relative file the check reads or writes at run time. It need
 * not exist when the catalog loads (a baseline is written later), so only the
 * shape is checked: relative, NUL-free, bounded, and unable to escape the root.
 */
function validateRepositoryFile(value: unknown, location: string): string | Error {
	if (typeof value !== "string" || value.length === 0) {
		return new Error(`${location} must be a non-empty repository-relative path`);
	}
	if (value.includes("\0")) return new Error(`${location} must not contain a NUL byte`);
	if (utf8Bytes(value) > PROJECT_VERIFIER_CATALOG_CAPS.cwdBytes) {
		return new Error(`${location} exceeds the ${PROJECT_VERIFIER_CATALOG_CAPS.cwdBytes}-byte cap`);
	}
	if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
		return new Error(`${location} must be repository-relative; absolute path '${value}' is not allowed`);
	}
	const normalized = path.posix.normalize(value.split(path.sep).join("/"));
	if (normalized === ".." || normalized.startsWith("../")) {
		return new Error(`${location} escapes the workspace root: '${value}'`);
	}
	return normalized;
}

/** The repository-relative files a numeric-compare check reads, each a file path named once. */
function validateJudgedInputs(value: unknown, location: string): string[] | Error {
	if (!Array.isArray(value) || value.length === 0) {
		return new Error(`${location} must be a non-empty array of repository-relative file paths`);
	}
	if (value.length > PROJECT_VERIFIER_CATALOG_CAPS.judgedInputs) {
		return new Error(`${location} exceeds the ${PROJECT_VERIFIER_CATALOG_CAPS.judgedInputs}-input cap`);
	}
	const inputs: string[] = [];
	for (const [index, entry] of value.entries()) {
		const at = `${location}[${index}]`;
		const input = validateRepositoryFile(entry, at);
		if (input instanceof Error) return input;
		if (input === "." || input.endsWith("/")) return new Error(`${at} must name a file`);
		if (inputs.includes(input)) return new Error(`${at} duplicates '${input}'`);
		inputs.push(input);
	}
	return inputs;
}

/**
 * Provenance probes: argv vectors under the same rule as a check's command, so no shell runs one. Each runs once
 * beside the check, its exit code, output digest and first output line recorded; a failing probe never gates.
 * An environment variable is recorded by probing it (`[printenv, OMP_NUM_THREADS]`), never by dumping the
 * environment.
 */
function validateProvenance(value: unknown, location: string): string[][] | Error {
	if (!Array.isArray(value) || value.length === 0) {
		return new Error(`${location} must be a non-empty array of argv probes`);
	}
	if (value.length > PROJECT_VERIFIER_CATALOG_CAPS.provenanceProbes) {
		return new Error(`${location} exceeds the ${PROJECT_VERIFIER_CATALOG_CAPS.provenanceProbes}-probe cap`);
	}
	const probes: string[][] = [];
	for (const [index, entry] of value.entries()) {
		const probe = validateCommand(entry, `${location}[${index}]`);
		if (probe instanceof Error) return probe;
		probes.push(probe);
	}
	return probes;
}

/**
 * The kind-specific fields of one check. Version 1 admits no such field, so a
 * version-1 check is always `command`. Under version 2 the kind gates which
 * parameters may appear, and each kind requires its own.
 */
function validateCheckKind(
	value: Record<string, unknown>,
	location: string,
	version: number,
): Pick<DeclaredCheck, "kind" | "numeric" | "perf" | "reproduce"> | Error {
	const kindValue = Object.hasOwn(value, "kind") ? value.kind : "command";
	if (typeof kindValue !== "string" || !(DECLARED_CHECK_KINDS as ReadonlyArray<string>).includes(kindValue)) {
		return new Error(`${location}.kind must be one of ${DECLARED_CHECK_KINDS.join(", ")}`);
	}
	const kind = kindValue as DeclaredCheckKind;
	const present = (field: string): boolean => Object.hasOwn(value, field);
	const accepted: Record<DeclaredCheckKind, ReadonlyArray<string>> = {
		command: [],
		"numeric-compare": ["reference", "tolerance", "inputs", "provenance", "seed", "repeat"],
		"perf-budget": ["budget", "baseline", "tolerance"],
		reproduce: [...REPRODUCE_CATALOG_FIELDS, "provenance"],
	};
	const stray = KIND_FIELDS.filter((field) => present(field) && !accepted[kind].includes(field));
	if (stray.length > 0) return new Error(`${location} kind '${kind}' does not accept ${stray.join(", ")}`);
	if (version === 1 && kind !== "command") return new Error(`${location}.kind requires catalog version 2`);
	if (kind === "command") return { kind };
	const provenance = present("provenance") ? validateProvenance(value.provenance, `${location}.provenance`) : undefined;
	if (provenance instanceof Error) return provenance;
	if (kind === "reproduce") {
		const fields = Object.fromEntries(REPRODUCE_CATALOG_FIELDS.filter(present).map((field) => [field, value[field]]));
		const reproduce = normalizeReproduce(fields, location, validateRepositoryFile);
		if (reproduce instanceof Error) return reproduce;
		return { kind, reproduce: { ...reproduce, ...(provenance !== undefined ? { provenance } : {}) } };
	}
	if (kind === "numeric-compare") {
		if (!present("reference")) return new Error(`${location}.reference is required for kind numeric-compare`);
		if (!present("tolerance")) return new Error(`${location}.tolerance is required for kind numeric-compare`);
		const reference = validateRepositoryFile(value.reference, `${location}.reference`);
		if (reference instanceof Error) return reference;
		const tolerance = normalizeNumericTolerance(value.tolerance);
		if (tolerance instanceof Error) return new Error(`${location}.${tolerance.message}`);
		const inputs = present("inputs") ? validateJudgedInputs(value.inputs, `${location}.inputs`) : undefined;
		if (inputs instanceof Error) return inputs;
		const seed = present("seed") ? normalizeSeed(value.seed, `${location}.seed`) : undefined;
		if (seed instanceof Error) return seed;
		const repeat = present("repeat") ? normalizeRepeat(value.repeat, `${location}.repeat`) : undefined;
		if (repeat instanceof Error) return repeat;
		return {
			kind,
			numeric: {
				reference,
				tolerance,
				...(inputs !== undefined ? { inputs } : {}),
				...(provenance !== undefined ? { provenance } : {}),
				...(seed !== undefined ? { seed } : {}),
				...(repeat !== undefined ? { repeat } : {}),
			},
		};
	}
	if (present("budget") === present("baseline")) {
		return new Error(`${location} kind 'perf-budget' requires exactly one of budget or baseline`);
	}
	if (present("budget")) {
		if (present("tolerance")) return new Error(`${location}.tolerance belongs inside budget when budget is given`);
		const budget = normalizePerfBudget(value.budget);
		if (budget instanceof Error) return new Error(`${location}.${budget.message}`);
		return { kind, perf: { budget } };
	}
	const baseline = validateRepositoryFile(value.baseline, `${location}.baseline`);
	if (baseline instanceof Error) return baseline;
	const perf: DeclaredPerfBudget = { baseline };
	if (present("tolerance")) {
		const tolerance = normalizePerfTolerance(value.tolerance, `${location}.tolerance`);
		if (tolerance instanceof Error) return tolerance;
		perf.tolerance = tolerance;
	}
	return { kind, perf };
}

/** Revalidate a stored catalog cwd and return its canonical in-workspace execution path. */
export function resolveProjectVerifierExecutionCwd(rawCwd: string, workspaceRoot: string): string | Error {
	const resolution = safelyResolveCatalogCwd(rawCwd, workspaceRoot, "project check cwd");
	return resolution instanceof Error ? resolution : resolution.execution;
}

function validateId(value: unknown, location: string): string | Error {
	if (typeof value !== "string" || value.length === 0) return new Error(`${location} must be a non-empty string`);
	if (utf8Bytes(value) > PROJECT_VERIFIER_CATALOG_CAPS.idBytes) {
		return new Error(`${location} exceeds the ${PROJECT_VERIFIER_CATALOG_CAPS.idBytes}-byte cap`);
	}
	if (!isProjectVerifierCheckId(value)) {
		return new Error(`${location} must match /^[a-z0-9][a-z0-9._:-]*$/`);
	}
	if (value === "frontend") return new Error(`${location} uses reserved built-in check id 'frontend'`);
	return value;
}

function validateDescription(value: unknown, location: string): string | Error {
	if (typeof value !== "string" || value.length === 0) return new Error(`${location} must be a non-empty string`);
	if (value.trim() !== value || hasControlCharacter(value)) {
		return new Error(`${location} must be trimmed, single-line text without control characters`);
	}
	if (utf8Bytes(value) > PROJECT_VERIFIER_CATALOG_CAPS.descriptionBytes) {
		return new Error(`${location} exceeds the ${PROJECT_VERIFIER_CATALOG_CAPS.descriptionBytes}-byte cap`);
	}
	return value;
}

function validateCommand(value: unknown, location: string): string[] | Error {
	if (!Array.isArray(value) || value.length === 0) {
		return new Error(`${location} must be a non-empty argv string array; shell command strings are not allowed`);
	}
	if (value.length > PROJECT_VERIFIER_CATALOG_CAPS.argvEntries) {
		return new Error(`${location} exceeds the ${PROJECT_VERIFIER_CATALOG_CAPS.argvEntries}-entry cap`);
	}
	const command: string[] = [];
	for (const [index, entry] of value.entries()) {
		const entryLocation = `${location}[${index}]`;
		if (typeof entry !== "string" || entry.length === 0) {
			return new Error(`${entryLocation} must be a non-empty string`);
		}
		if (entry.includes("\0")) return new Error(`${entryLocation} must not contain a NUL byte`);
		if (utf8Bytes(entry) > PROJECT_VERIFIER_CATALOG_CAPS.argumentBytes) {
			return new Error(`${entryLocation} exceeds the ${PROJECT_VERIFIER_CATALOG_CAPS.argumentBytes}-byte cap`);
		}
		command.push(entry);
	}
	const executable = command[0] ?? "";
	if (/\s/u.test(executable)) {
		return new Error(`${location}[0] must be one executable token, not a shell command string`);
	}
	const executableName = path
		.basename(executable)
		.toLowerCase()
		.replace(/\.exe$/u, "");
	if (SHELL_EXECUTABLES.has(executableName)) {
		return new Error(`${location}[0] may not invoke shell executable '${executable}'`);
	}
	return command;
}

function validateTimeout(value: unknown, location: string): number | Error {
	if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) {
		return new Error(`${location} must be a positive integer number of milliseconds`);
	}
	if (value > PROJECT_VERIFIER_CATALOG_CAPS.timeoutMs) {
		return new Error(`${location} exceeds the ${PROJECT_VERIFIER_CATALOG_CAPS.timeoutMs}ms cap`);
	}
	return value;
}

function validateTags(value: unknown, location: string): string[] | Error {
	if (!Array.isArray(value)) return new Error(`${location} must be an array of bounded tag strings`);
	if (value.length > PROJECT_VERIFIER_CATALOG_CAPS.tags) {
		return new Error(`${location} exceeds the ${PROJECT_VERIFIER_CATALOG_CAPS.tags}-tag cap`);
	}
	const tags: string[] = [];
	const seen = new Set<string>();
	for (const [index, entry] of value.entries()) {
		const entryLocation = `${location}[${index}]`;
		if (typeof entry !== "string" || entry.length === 0) {
			return new Error(`${entryLocation} must be a non-empty string`);
		}
		if (utf8Bytes(entry) > PROJECT_VERIFIER_CATALOG_CAPS.tagBytes) {
			return new Error(`${entryLocation} exceeds the ${PROJECT_VERIFIER_CATALOG_CAPS.tagBytes}-byte cap`);
		}
		if (!TAG_PATTERN.test(entry)) return new Error(`${entryLocation} must match /^[a-z0-9][a-z0-9._-]*$/`);
		if (seen.has(entry)) return new Error(`${location} contains duplicate tag '${entry}'`);
		seen.add(entry);
		tags.push(entry);
	}
	return tags;
}

function sourcePathInsideWorkspace(catalogPath: string, workspaceRoot: string): string | Error {
	try {
		const realRoot = realpathSync(workspaceRoot);
		const realCatalogPath = realpathSync(catalogPath);
		resolveSafeCwd(realCatalogPath, realRoot);
		return realCatalogPath;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return new Error(`catalog file must resolve inside the workspace root (${message})`);
	}
}

export function loadProjectVerifierCatalog(workspaceRoot: string): ProjectCatalogLoadResult {
	const catalogPath = path.join(workspaceRoot, PROJECT_VERIFIER_CATALOG_RELATIVE_PATH);
	if (!existsSync(catalogPath)) return { ok: true, source: null };
	const safeSourcePath = sourcePathInsideWorkspace(catalogPath, workspaceRoot);
	if (safeSourcePath instanceof Error) return catalogDiagnostic(safeSourcePath.message);
	let text: string;
	try {
		const stats = statSync(safeSourcePath);
		if (!stats.isFile()) return catalogDiagnostic("catalog path must be a regular file");
		if (stats.size > PROJECT_VERIFIER_CATALOG_CAPS.fileBytes) {
			return catalogDiagnostic(`file exceeds the ${PROJECT_VERIFIER_CATALOG_CAPS.fileBytes}-byte cap`);
		}
		text = readFileSync(safeSourcePath, "utf8");
	} catch (error) {
		return catalogDiagnostic(`cannot read catalog (${error instanceof Error ? error.message : String(error)})`);
	}
	return parseProjectVerifierCatalogText(text, workspaceRoot, catalogPath);
}

/** Parse catalog text through the production schema and canonical normalizer. */
export function parseProjectVerifierCatalogText(
	text: string,
	workspaceRoot: string,
	catalogPath = path.join(workspaceRoot, PROJECT_VERIFIER_CATALOG_RELATIVE_PATH),
): ProjectCatalogLoadResult {
	const document = parseDocument(text, { prettyErrors: false, strict: true, uniqueKeys: true });
	if (document.errors.length > 0) {
		return catalogDiagnostic(`invalid YAML: ${document.errors.map((error) => error.message).join("; ")}`);
	}
	let parsed: unknown;
	try {
		parsed = document.toJS({ maxAliasCount: 0 }) as unknown;
	} catch (error) {
		return catalogDiagnostic(`invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(parsed)) return catalogDiagnostic("root must be an object with version and checks fields");
	const rootUnknown = unknownFields(parsed, ROOT_FIELDS);
	if (rootUnknown.length > 0) return catalogDiagnostic(`root has unknown field(s): ${rootUnknown.join(", ")}`);
	if (!Object.hasOwn(parsed, "version")) return catalogDiagnostic("root.version is required");
	if (typeof parsed.version !== "number" || !SUPPORTED_CATALOG_VERSIONS.includes(parsed.version)) {
		return catalogDiagnostic(
			`unsupported version ${JSON.stringify(parsed.version)}; supported versions are ${SUPPORTED_CATALOG_VERSIONS.join(" and ")}`,
		);
	}
	const version = parsed.version;
	if (!Object.hasOwn(parsed, "checks")) return catalogDiagnostic("root.checks is required");
	if (!Array.isArray(parsed.checks)) return catalogDiagnostic("root.checks must be an array");
	if (parsed.checks.length > PROJECT_VERIFIER_CATALOG_CAPS.checks) {
		return catalogDiagnostic(`root.checks exceeds the ${PROJECT_VERIFIER_CATALOG_CAPS.checks}-check cap`);
	}

	const sourceRef: DeclaredCheckSourceRef = { kind: "project-catalog", path: catalogPath };
	const checks: DeclaredCheck[] = [];
	const ids = new Map<string, number>();
	for (const [index, value] of parsed.checks.entries()) {
		const location = `checks[${index}]`;
		if (!isRecord(value)) return catalogDiagnostic(`${location} must be an object`);
		const checkUnknown = unknownFields(value, version === 1 ? CHECK_FIELDS : CHECK_FIELDS_V2);
		if (checkUnknown.length > 0) {
			return catalogDiagnostic(`${location} has unknown field(s): ${checkUnknown.join(", ")}`);
		}
		for (const field of CHECK_FIELDS) {
			if (!Object.hasOwn(value, field)) return catalogDiagnostic(`${location}.${field} is required`);
		}

		const id = validateId(value.id, `${location}.id`);
		if (id instanceof Error) return catalogDiagnostic(id.message);
		const duplicateIndex = ids.get(id);
		if (duplicateIndex !== undefined) {
			return catalogDiagnostic(`${location}.id duplicates '${id}' from checks[${duplicateIndex}].id`);
		}
		const description = validateDescription(value.description, `${location}.description`);
		if (description instanceof Error) return catalogDiagnostic(description.message);
		const command = validateCommand(value.command, `${location}.command`);
		if (command instanceof Error) return catalogDiagnostic(command.message);
		if (typeof value.cwd !== "string" || value.cwd.length === 0) {
			return catalogDiagnostic(`${location}.cwd must be a non-empty repository-relative string`);
		}
		if (value.cwd.includes("\0")) return catalogDiagnostic(`${location}.cwd must not contain a NUL byte`);
		if (utf8Bytes(value.cwd) > PROJECT_VERIFIER_CATALOG_CAPS.cwdBytes) {
			return catalogDiagnostic(`${location}.cwd exceeds the ${PROJECT_VERIFIER_CATALOG_CAPS.cwdBytes}-byte cap`);
		}
		const cwdResolution = safelyResolveCatalogCwd(value.cwd, workspaceRoot, `${location}.cwd`);
		if (cwdResolution instanceof Error) return catalogDiagnostic(cwdResolution.message);
		const cwd = cwdResolution.declared;
		const timeoutMs = validateTimeout(value.timeoutMs, `${location}.timeoutMs`);
		if (timeoutMs instanceof Error) return catalogDiagnostic(timeoutMs.message);
		const tags = validateTags(value.tags, `${location}.tags`);
		if (tags instanceof Error) return catalogDiagnostic(tags.message);
		const kindFields = validateCheckKind(value, location, version);
		if (kindFields instanceof Error) return catalogDiagnostic(kindFields.message);
		let proof: DeclaredProof | undefined;
		if (Object.hasOwn(value, "proof")) {
			if (kindFields.kind !== "command" || Object.hasOwn(value, "runs"))
				return catalogDiagnostic(`${location}.proof requires a command check without runs`);
			const parsed = parseDeclaredProof(value.proof);
			if (parsed instanceof Error) return catalogDiagnostic(`${location}.${parsed.message}`);
			proof = parsed;
		}
		let runs: string | undefined;
		if (Object.hasOwn(value, "runs")) {
			// A perf-budget baseline times one fixed command, and a reproduce check runs in a clean environment holding
			// only HEAD or its pinned inputs, where a run's outputs never exist; neither can judge one run of a sweep.
			if (kindFields.kind === "perf-budget" || kindFields.kind === "reproduce") {
				return catalogDiagnostic(`${location} kind '${kindFields.kind}' does not accept runs`);
			}
			const declared = validateRepositoryFile(value.runs, `${location}.runs`);
			if (declared instanceof Error) return catalogDiagnostic(declared.message);
			runs = declared;
		}

		ids.set(id, index);
		checks.push({
			id,
			description,
			command,
			cwd,
			timeoutMs,
			tags,
			source: { ...sourceRef },
			...kindFields,
			...(proof !== undefined ? { proof, proofCatalogDigest: createHash("sha256").update(text).digest("hex") } : {}),
			...(runs !== undefined ? { runs } : {}),
		});
	}
	checks.sort((left, right) => compareCodepoints(left.id, right.id));
	return { ok: true, source: { ...sourceRef, checks } };
}

export function packageDeclaredCheck(id: string, packagePath: string, cwd: string, tags: string[]): DeclaredCheck {
	return {
		id,
		description: `Run package.json script '${id}'.`,
		command: ["npm", "run", id],
		cwd,
		timeoutMs: SAFE_EXEC_DEFAULT_TIMEOUT_MS,
		tags,
		source: { kind: "package.json", path: packagePath },
		kind: "command",
	};
}
