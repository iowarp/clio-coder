import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { resolveSafeCwd } from "../../core/safe-exec.js";
import { byteLength } from "../../tools/truncate-utf8.js";
import { compareCodepoints } from "../evidence/ordering.js";

/**
 * The one strict loader for the version-1 scientific validation contract.
 * Rigor resolution, verifier authoring, doctor, and the startup hint all read
 * the contract through this module, so a file either parses under one schema
 * or is diagnosed under one vocabulary. Nothing here executes anything: a
 * parsed contract is a requirement statement, and its `validators` stay prose
 * until the project declares matching `.clio-coder/verifiers.yaml` entries.
 */

export const VALIDATION_CONTRACT_VERSION = 1;

/** YAML contract paths in resolution order; the first that exists is the contract. */
export const VALIDATION_CONTRACT_YAML_PATHS: ReadonlyArray<string> = [
	".clio-coder/validation.yaml",
	".clio-coder/validation.yml",
	"validation.yaml",
	"validation.yml",
];

/** Markdown is recognized as present but never parsed and never raises rigor. */
export const VALIDATION_CONTRACT_MARKDOWN_PATH = "VALIDATION.md";

/** Public schema limits. Diagnostics cite these values instead of hiding policy. */
export const VALIDATION_CONTRACT_CAPS = Object.freeze({
	fileBytes: 256 * 1024,
	textBytes: 4096,
	notesBytes: 16 * 1024,
	artifacts: 256,
	validators: 128,
	modules: 64,
	mapEntries: 256,
	mapKeyBytes: 256,
});

export type ValidationRuntimeKind = "local" | "slurm" | "mpi" | "other";

const RUNTIME_KINDS: ReadonlyArray<ValidationRuntimeKind> = ["local", "slurm", "mpi", "other"];

export interface ValidationContractRuntime {
	kind: ValidationRuntimeKind;
	nodes?: number;
	ranks?: number;
	walltime?: string;
	modules?: string[];
}

export interface ValidationNumericalTolerances {
	relative?: number;
	absolute?: number;
	ulp?: number;
}

export interface ValidationContractArtifact {
	path: string;
	format?: string;
	expected_dimensions?: Record<string, number>;
	expected_attributes?: Record<string, string>;
	numerical_tolerances?: ValidationNumericalTolerances;
	preserve?: boolean;
}

export interface ValidationContract {
	version: typeof VALIDATION_CONTRACT_VERSION;
	task?: string;
	runtime?: ValidationContractRuntime;
	artifacts?: ValidationContractArtifact[];
	/** Advisory command prose. Never executed from here. */
	validators?: string[];
	notes?: string;
}

export type ValidationContractLoadResult =
	/** A YAML contract parsed under the version-1 schema. */
	| { ok: true; contract: ValidationContract; path: string }
	/** No contract file at the workspace root. */
	| { ok: true; contract: null }
	/** Only `VALIDATION.md` exists: present, unparsed, advisory. */
	| { ok: true; contract: null; path: string; advisory: true }
	/** A YAML contract exists but does not parse; `reason` names the fault and cites the cap it crossed. */
	| { ok: false; path: string; reason: string };

const ROOT_FIELDS = new Set(["version", "task", "runtime", "artifacts", "validators", "notes"]);
const RUNTIME_FIELDS = new Set(["kind", "nodes", "ranks", "walltime", "modules"]);
const ARTIFACT_FIELDS = new Set([
	"path",
	"format",
	"expected_dimensions",
	"expected_attributes",
	"numerical_tolerances",
	"preserve",
]);
const TOLERANCE_FIELDS = new Set(["relative", "absolute", "ulp"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unknownFields(record: Record<string, unknown>, allowed: ReadonlySet<string>): string[] {
	return Object.keys(record)
		.filter((key) => !allowed.has(key))
		.sort(compareCodepoints);
}

function boundedText(value: unknown, location: string, cap: number): string | Error {
	if (typeof value !== "string" || value.length === 0) return new Error(`${location} must be a non-empty string`);
	if (value.includes("\0")) return new Error(`${location} must not contain a NUL byte`);
	if (byteLength(value) > cap) return new Error(`${location} exceeds the ${cap}-byte cap`);
	return value;
}

function positiveInteger(value: unknown, location: string): number | Error {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		return new Error(`${location} must be a positive integer`);
	}
	return value;
}

function nonNegativeNumber(value: unknown, location: string): number | Error {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return new Error(`${location} must be a finite non-negative number`);
	}
	return value;
}

function boundedStringList(value: unknown, location: string, cap: number): string[] | Error {
	if (!Array.isArray(value)) return new Error(`${location} must be an array of strings`);
	if (value.length > cap) return new Error(`${location} exceeds the ${cap}-entry cap`);
	const items: string[] = [];
	for (const [index, entry] of value.entries()) {
		const text = boundedText(entry, `${location}[${index}]`, VALIDATION_CONTRACT_CAPS.textBytes);
		if (text instanceof Error) return text;
		items.push(text);
	}
	return items;
}

function boundedMap<T>(
	value: unknown,
	location: string,
	validateEntry: (entry: unknown, entryLocation: string) => T | Error,
): Record<string, T> | Error {
	if (!isRecord(value)) return new Error(`${location} must be a map`);
	const keys = Object.keys(value);
	if (keys.length > VALIDATION_CONTRACT_CAPS.mapEntries) {
		return new Error(`${location} exceeds the ${VALIDATION_CONTRACT_CAPS.mapEntries}-entry cap`);
	}
	const out: Record<string, T> = {};
	for (const key of keys.sort(compareCodepoints)) {
		const entryLocation = `${location}.${key}`;
		if (key.length === 0) return new Error(`${location} has an empty key`);
		if (byteLength(key) > VALIDATION_CONTRACT_CAPS.mapKeyBytes) {
			return new Error(`${entryLocation} key exceeds the ${VALIDATION_CONTRACT_CAPS.mapKeyBytes}-byte cap`);
		}
		const entry = validateEntry(value[key], entryLocation);
		if (entry instanceof Error) return entry;
		out[key] = entry;
	}
	return out;
}

function validateRuntime(value: unknown, location: string): ValidationContractRuntime | Error {
	if (!isRecord(value)) return new Error(`${location} must be an object with a kind field`);
	const unknown = unknownFields(value, RUNTIME_FIELDS);
	if (unknown.length > 0) return new Error(`${location} has unknown field(s): ${unknown.join(", ")}`);
	if (!Object.hasOwn(value, "kind")) return new Error(`${location}.kind is required`);
	const kind = value.kind;
	if (typeof kind !== "string" || !(RUNTIME_KINDS as ReadonlyArray<string>).includes(kind)) {
		return new Error(`${location}.kind must be one of ${RUNTIME_KINDS.join(", ")}`);
	}
	const runtime: ValidationContractRuntime = { kind: kind as ValidationRuntimeKind };
	if (Object.hasOwn(value, "nodes")) {
		const nodes = positiveInteger(value.nodes, `${location}.nodes`);
		if (nodes instanceof Error) return nodes;
		runtime.nodes = nodes;
	}
	if (Object.hasOwn(value, "ranks")) {
		const ranks = positiveInteger(value.ranks, `${location}.ranks`);
		if (ranks instanceof Error) return ranks;
		runtime.ranks = ranks;
	}
	if (Object.hasOwn(value, "walltime")) {
		const walltime = boundedText(value.walltime, `${location}.walltime`, VALIDATION_CONTRACT_CAPS.textBytes);
		if (walltime instanceof Error) return walltime;
		runtime.walltime = walltime;
	}
	if (Object.hasOwn(value, "modules")) {
		const modules = boundedStringList(value.modules, `${location}.modules`, VALIDATION_CONTRACT_CAPS.modules);
		if (modules instanceof Error) return modules;
		runtime.modules = modules;
	}
	return runtime;
}

function validateTolerances(value: unknown, location: string): ValidationNumericalTolerances | Error {
	if (!isRecord(value)) return new Error(`${location} must be an object`);
	const unknown = unknownFields(value, TOLERANCE_FIELDS);
	if (unknown.length > 0) return new Error(`${location} has unknown field(s): ${unknown.join(", ")}`);
	const tolerances: ValidationNumericalTolerances = {};
	if (Object.hasOwn(value, "relative")) {
		const relative = nonNegativeNumber(value.relative, `${location}.relative`);
		if (relative instanceof Error) return relative;
		tolerances.relative = relative;
	}
	if (Object.hasOwn(value, "absolute")) {
		const absolute = nonNegativeNumber(value.absolute, `${location}.absolute`);
		if (absolute instanceof Error) return absolute;
		tolerances.absolute = absolute;
	}
	if (Object.hasOwn(value, "ulp")) {
		const ulp = value.ulp;
		if (typeof ulp !== "number" || !Number.isInteger(ulp) || ulp < 0) {
			return new Error(`${location}.ulp must be a non-negative integer`);
		}
		tolerances.ulp = ulp;
	}
	return tolerances;
}

function validateArtifact(value: unknown, location: string): ValidationContractArtifact | Error {
	if (!isRecord(value)) return new Error(`${location} must be an object with a path field`);
	const unknown = unknownFields(value, ARTIFACT_FIELDS);
	if (unknown.length > 0) return new Error(`${location} has unknown field(s): ${unknown.join(", ")}`);
	if (!Object.hasOwn(value, "path")) return new Error(`${location}.path is required`);
	const artifactPath = boundedText(value.path, `${location}.path`, VALIDATION_CONTRACT_CAPS.textBytes);
	if (artifactPath instanceof Error) return artifactPath;
	const artifact: ValidationContractArtifact = { path: artifactPath };
	if (Object.hasOwn(value, "format")) {
		const format = boundedText(value.format, `${location}.format`, VALIDATION_CONTRACT_CAPS.textBytes);
		if (format instanceof Error) return format;
		artifact.format = format;
	}
	if (Object.hasOwn(value, "expected_dimensions")) {
		const dimensions = boundedMap(value.expected_dimensions, `${location}.expected_dimensions`, (entry, entryLocation) =>
			typeof entry === "number" && Number.isInteger(entry) && entry >= 0
				? entry
				: new Error(`${entryLocation} must be a non-negative integer`),
		);
		if (dimensions instanceof Error) return dimensions;
		artifact.expected_dimensions = dimensions;
	}
	if (Object.hasOwn(value, "expected_attributes")) {
		const attributes = boundedMap(value.expected_attributes, `${location}.expected_attributes`, (entry, entryLocation) =>
			typeof entry === "string"
				? boundedText(entry, entryLocation, VALIDATION_CONTRACT_CAPS.textBytes)
				: new Error(`${entryLocation} must be a string`),
		);
		if (attributes instanceof Error) return attributes;
		artifact.expected_attributes = attributes;
	}
	if (Object.hasOwn(value, "numerical_tolerances")) {
		const tolerances = validateTolerances(value.numerical_tolerances, `${location}.numerical_tolerances`);
		if (tolerances instanceof Error) return tolerances;
		artifact.numerical_tolerances = tolerances;
	}
	if (Object.hasOwn(value, "preserve")) {
		if (typeof value.preserve !== "boolean") return new Error(`${location}.preserve must be a boolean`);
		artifact.preserve = value.preserve;
	}
	return artifact;
}

/** Parse contract text under the version-1 schema; `contractPath` only labels the result. */
export function parseValidationContractText(text: string, contractPath: string): ValidationContractLoadResult {
	const invalid = (reason: string): ValidationContractLoadResult => ({ ok: false, path: contractPath, reason });
	const document = parseDocument(text, { prettyErrors: false, strict: true, uniqueKeys: true });
	if (document.errors.length > 0) {
		return invalid(`invalid YAML: ${document.errors.map((error) => error.message).join("; ")}`);
	}
	let parsed: unknown;
	try {
		parsed = document.toJS({ maxAliasCount: 0 }) as unknown;
	} catch (error) {
		return invalid(`invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(parsed)) return invalid("root must be an object with a version field");
	const rootUnknown = unknownFields(parsed, ROOT_FIELDS);
	if (rootUnknown.length > 0) return invalid(`root has unknown field(s): ${rootUnknown.join(", ")}`);
	if (!Object.hasOwn(parsed, "version")) return invalid("root.version is required");
	if (parsed.version !== VALIDATION_CONTRACT_VERSION) {
		return invalid(
			`unsupported version ${JSON.stringify(parsed.version)}; supported version is ${VALIDATION_CONTRACT_VERSION}`,
		);
	}
	const contract: ValidationContract = { version: VALIDATION_CONTRACT_VERSION };
	if (Object.hasOwn(parsed, "task")) {
		const task = boundedText(parsed.task, "root.task", VALIDATION_CONTRACT_CAPS.textBytes);
		if (task instanceof Error) return invalid(task.message);
		contract.task = task;
	}
	if (Object.hasOwn(parsed, "runtime")) {
		const runtime = validateRuntime(parsed.runtime, "root.runtime");
		if (runtime instanceof Error) return invalid(runtime.message);
		contract.runtime = runtime;
	}
	if (Object.hasOwn(parsed, "artifacts")) {
		if (!Array.isArray(parsed.artifacts)) return invalid("root.artifacts must be an array");
		if (parsed.artifacts.length > VALIDATION_CONTRACT_CAPS.artifacts) {
			return invalid(`root.artifacts exceeds the ${VALIDATION_CONTRACT_CAPS.artifacts}-entry cap`);
		}
		const artifacts: ValidationContractArtifact[] = [];
		for (const [index, value] of parsed.artifacts.entries()) {
			const artifact = validateArtifact(value, `artifacts[${index}]`);
			if (artifact instanceof Error) return invalid(artifact.message);
			artifacts.push(artifact);
		}
		contract.artifacts = artifacts;
	}
	if (Object.hasOwn(parsed, "validators")) {
		const validators = boundedStringList(parsed.validators, "root.validators", VALIDATION_CONTRACT_CAPS.validators);
		if (validators instanceof Error) return invalid(validators.message);
		contract.validators = validators;
	}
	if (Object.hasOwn(parsed, "notes")) {
		const notes = boundedText(parsed.notes, "root.notes", VALIDATION_CONTRACT_CAPS.notesBytes);
		if (notes instanceof Error) return invalid(notes.message);
		contract.notes = notes;
	}
	return { ok: true, contract, path: contractPath };
}

function readContractText(absolutePath: string, workspaceRoot: string): string | Error {
	let realPath: string;
	try {
		const realRoot = realpathSync(workspaceRoot);
		realPath = realpathSync(absolutePath);
		resolveSafeCwd(realPath, realRoot);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return new Error(`contract file must resolve inside the workspace root (${message})`);
	}
	try {
		const stats = statSync(realPath);
		if (!stats.isFile()) return new Error("contract path must be a regular file");
		if (stats.size > VALIDATION_CONTRACT_CAPS.fileBytes) {
			return new Error(`file exceeds the ${VALIDATION_CONTRACT_CAPS.fileBytes}-byte cap`);
		}
		return readFileSync(realPath, "utf8");
	} catch (error) {
		return new Error(`cannot read contract (${error instanceof Error ? error.message : String(error)})`);
	}
}

/**
 * Load the workspace's validation contract. The first YAML path in
 * {@link VALIDATION_CONTRACT_YAML_PATHS} that exists is the contract; a
 * `VALIDATION.md` without any YAML is reported present and advisory. Every
 * failure is a value, never a throw, so rigor resolution stays total.
 */
export function loadValidationContract(workspaceRoot: string): ValidationContractLoadResult {
	let contractPath: string | null = null;
	try {
		contractPath =
			VALIDATION_CONTRACT_YAML_PATHS.find((relative) => existsSync(path.join(workspaceRoot, relative))) ?? null;
		if (contractPath === null) {
			if (existsSync(path.join(workspaceRoot, VALIDATION_CONTRACT_MARKDOWN_PATH))) {
				return { ok: true, contract: null, path: VALIDATION_CONTRACT_MARKDOWN_PATH, advisory: true };
			}
			return { ok: true, contract: null };
		}
	} catch (error) {
		return {
			ok: false,
			path: contractPath ?? VALIDATION_CONTRACT_YAML_PATHS[0] ?? "validation.yaml",
			reason: `cannot inspect workspace root (${error instanceof Error ? error.message : String(error)})`,
		};
	}
	const text = readContractText(path.join(workspaceRoot, contractPath), workspaceRoot);
	if (text instanceof Error) return { ok: false, path: contractPath, reason: text.message };
	return parseValidationContractText(text, contractPath);
}

/** One line a diagnostic surface can print for a load result, or null when there is nothing to say. */
export function describeValidationContract(result: ValidationContractLoadResult): string | null {
	if (!result.ok) return `${result.path}: ${result.reason}`;
	if (result.contract === null) {
		return "advisory" in result
			? `${result.path} is advisory prose and does not raise rigor; add a version-1 validation.yaml to raise the default to high`
			: null;
	}
	return null;
}
