/**
 * Bounded adapters for Clio Coder's public read-only resource catalogs.
 *
 * The upstream JSON shapes contain fields that must not become browser data:
 * skill bodies and hashes, native user paths, arbitrary diagnostics, source
 * URLs, and a verification check's exact argument vector. This module projects
 * only the small inventory needed by the graphical catalog. Each command fails
 * independently so one damaged catalog cannot hide the others.
 */

import { resolve } from "node:path";
import { ClioReadCommandError, ClioReadCommandRunner } from "./clio-read-command.ts";
import {
	CATALOG_AGENT_AUDIENCES,
	CATALOG_AGENT_CAPABILITIES,
	CATALOG_AGENT_CATEGORIES,
	CATALOG_AGENT_LATENCIES,
	CATALOG_AGENT_SOURCES,
	CATALOG_AUDIT_STATES,
	CATALOG_CONTEXT_TIERS,
	CATALOG_EXTENSION_RESOURCE_KINDS,
	CATALOG_EXTENSION_SCOPES,
	CATALOG_LIBRARY_KINDS,
	CATALOG_LIBRARY_ORIGINS,
	CATALOG_RESOURCE_SCOPES,
	CATALOG_SKILL_SOURCES,
	CATALOG_VERIFIER_AUTHORITIES,
	CATALOG_VERIFIER_BLOCKS,
	CATALOG_VERIFIER_DISCOVERY,
	CATALOG_VERIFIER_ORIGINS,
	CATALOG_VERIFIER_REJECTIONS,
	CATALOG_VERIFIER_RUNNERS,
	CATALOG_VERIFIER_SIGNALS,
	MAX_WIRE_CATALOG_AGENTS,
	MAX_WIRE_CATALOG_EXTENSIONS,
	MAX_WIRE_CATALOG_LABELS,
	MAX_WIRE_CATALOG_LIBRARY_ENTRIES,
	MAX_WIRE_CATALOG_SKILLS,
	MAX_WIRE_CATALOG_VERIFIER_TAGS,
	MAX_WIRE_CATALOG_VERIFIERS,
	type WireCatalogAgent,
	type WireCatalogAgentCollection,
	type WireCatalogExtension,
	type WireCatalogExtensionCollection,
	type WireCatalogInspection,
	type WireCatalogLibraryCollection,
	type WireCatalogLibraryEntry,
	type WireCatalogSkill,
	type WireCatalogSkillCollection,
	type WireCatalogVerifier,
	type WireCatalogVerifierCollection,
} from "./src/protocol.ts";

export const DEFAULT_CATALOG_INSPECT_TIMEOUT_MS = 12_000;
export const MAX_CATALOG_INSPECT_STDOUT_BYTES = 2 * 1024 * 1024;
export const MAX_CATALOG_INSPECT_STDERR_BYTES = 64 * 1024;
const MAX_RAW_CATALOG_ITEMS = 2_048;
const MAX_CATALOG_NUMBER = 1_000_000;
const encoder = new TextEncoder();

export interface ClioCatalogInspector {
	inspect(trustedRoot: string): Promise<WireCatalogInspection>;
}

export interface ClioCliCatalogInspectorOptions {
	readonly executable?: string;
	/** Test/development prefix only. Browser commands can never influence argv. */
	readonly prefixArgs?: readonly string[];
	readonly timeoutMs?: number;
	readonly maximumStdoutBytes?: number;
	readonly maximumStderrBytes?: number;
	readonly now?: () => number;
	readonly log?: (message: string) => void;
}

export class ClioCatalogProjectionError extends Error {
	override readonly name = "ClioCatalogProjectionError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isOneOf<const T extends readonly string[]>(value: unknown, choices: T): value is T[number] {
	return typeof value === "string" && choices.includes(value as T[number]);
}

function integer(value: unknown): number | null {
	return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_CATALOG_NUMBER
		? value as number
		: null;
}

function exactText(value: unknown, maximumBytes: number): string | null {
	if (typeof value !== "string" || value.length === 0 || value.trim() !== value) return null;
	if (encoder.encode(value).byteLength > maximumBytes) return null;
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code <= 0x1f || code === 0x7f) return null;
	}
	return value;
}

function truncateUtf8(value: string, maximumBytes: number): string {
	if (encoder.encode(value).byteLength <= maximumBytes) return value;
	const marker = "…";
	const markerBytes = encoder.encode(marker).byteLength;
	let output = "";
	let bytes = 0;
	for (const character of value) {
		const characterBytes = encoder.encode(character).byteLength;
		if (bytes + characterBytes + markerBytes > maximumBytes) break;
		output += character;
		bytes += characterBytes;
	}
	return `${output.trimEnd()}${marker}`;
}

function description(value: unknown): string | null {
	if (typeof value !== "string") return null;
	// The control characters are the point: this is the projection that keeps a
	// terminal escape or a NUL out of a description bound for the browser.
	// deno-lint-ignore no-control-regex
	const normalized = value.replaceAll(/[\u0000-\u001f\u007f\s]+/gu, " ").trim();
	if (normalized.length === 0) return null;
	return truncateUtf8(normalized, 512);
}

function labels(value: unknown): readonly string[] | null {
	// The wire type has no per-agent label truncation marker, so reject an
	// over-wide row rather than silently presenting an incomplete binding list.
	if (!Array.isArray(value) || value.length > MAX_WIRE_CATALOG_LABELS) return null;
	const projected: string[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		const label = exactText(entry, 64);
		if (label === null) return null;
		if (seen.has(label)) continue;
		seen.add(label);
		projected.push(label);
	}
	return projected;
}

function projectAgent(value: unknown): WireCatalogAgent | null {
	if (!isRecord(value) || !isRecord(value.budget) || !isRecord(value.resultContract)) return null;
	const id = exactText(value.id, 128);
	const name = exactText(value.name, 128);
	const summary = description(value.description);
	const version = integer(value.version);
	const tags = labels(value.tags);
	const skills = labels(value.skills);
	const tools = labels(value.tools);
	const toolCalls = integer(value.budget.toolCalls);
	const readReserve = integer(value.budget.readReserve);
	const resultKind = exactText(value.resultContract.kind, 128);
	if (
		id === null || name === null || summary === null || version === null || tags === null || skills === null ||
		tools === null || toolCalls === null || readReserve === null || resultKind === null ||
		typeof value.budget.synthesis !== "boolean" || !isOneOf(value.source, CATALOG_AGENT_SOURCES) ||
		!isOneOf(value.audience, CATALOG_AGENT_AUDIENCES) || !isOneOf(value.category, CATALOG_AGENT_CATEGORIES) ||
		!isOneOf(value.capabilityClass, CATALOG_AGENT_CAPABILITIES) ||
		!isOneOf(value.latencyClass, CATALOG_AGENT_LATENCIES) ||
		!isOneOf(value.projectContextTier, CATALOG_CONTEXT_TIERS)
	) return null;
	let maximumToolCalls: number | null = null;
	let maximumReadReserve: number | null = null;
	if (value.budget.maximum !== undefined) {
		if (!isRecord(value.budget.maximum)) return null;
		maximumToolCalls = integer(value.budget.maximum.toolCalls);
		maximumReadReserve = integer(value.budget.maximum.readReserve);
		if (maximumToolCalls === null || maximumReadReserve === null) return null;
	}
	return {
		id,
		name,
		description: summary,
		version,
		source: value.source,
		audience: value.audience,
		category: value.category,
		capability: value.capabilityClass,
		latency: value.latencyClass,
		contextTier: value.projectContextTier,
		tags,
		skills,
		tools,
		resultKind,
		budget: {
			toolCalls,
			readReserve,
			synthesis: value.budget.synthesis,
			maximumToolCalls,
			maximumReadReserve,
		},
	};
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string): readonly T[] {
	const unique = new Map<string, T>();
	for (const item of items) {
		const itemKey = key(item);
		if (!unique.has(itemKey)) unique.set(itemKey, item);
	}
	return [...unique.values()];
}

export function projectAgentCatalog(value: unknown): WireCatalogAgentCollection {
	if (!Array.isArray(value) || value.length > MAX_RAW_CATALOG_ITEMS) {
		throw new ClioCatalogProjectionError("Clio Coder returned an invalid agent catalog.");
	}
	const candidates = value.map(projectAgent).filter((entry): entry is WireCatalogAgent => entry !== null);
	const projected = uniqueBy(candidates, (entry) => entry.id);
	const items = projected.slice(0, MAX_WIRE_CATALOG_AGENTS);
	return {
		availability: "available",
		items,
		truncated: candidates.length !== value.length || projected.length !== candidates.length ||
			projected.length > items.length,
		issueCount: 0,
	};
}

function diagnosticCount(value: unknown): number | null {
	return Array.isArray(value) && value.length <= MAX_CATALOG_NUMBER ? value.length : null;
}

function projectSkill(value: unknown): WireCatalogSkill | null {
	if (!isRecord(value)) return null;
	const name = exactText(value.name, 128);
	const summary = description(value.description);
	const precedence = integer(value.precedence);
	const issueCount = diagnosticCount(value.diagnostics);
	if (
		name === null || summary === null || precedence === null || issueCount === null ||
		!isOneOf(value.scope, CATALOG_RESOURCE_SCOPES) || !isOneOf(value.source, CATALOG_SKILL_SOURCES) ||
		typeof value.trusted !== "boolean" || typeof value.disableModelInvocation !== "boolean"
	) return null;
	return {
		name,
		description: summary,
		scope: value.scope,
		source: value.source,
		trusted: value.trusted,
		precedence,
		modelInvocable: !value.disableModelInvocation,
		issueCount,
	};
}

export function projectSkillCatalog(value: unknown): WireCatalogSkillCollection {
	if (!isRecord(value) || !Array.isArray(value.skills) || value.skills.length > MAX_RAW_CATALOG_ITEMS) {
		throw new ClioCatalogProjectionError("Clio Coder returned an invalid skill catalog.");
	}
	const issues = diagnosticCount(value.diagnostics);
	if (issues === null) throw new ClioCatalogProjectionError("Clio Coder returned invalid skill catalog diagnostics.");
	const candidates = value.skills.map(projectSkill).filter((entry): entry is WireCatalogSkill => entry !== null);
	const projected = uniqueBy(candidates, (entry) => entry.name);
	const items = projected.slice(0, MAX_WIRE_CATALOG_SKILLS);
	return {
		availability: "available",
		items,
		truncated: candidates.length !== value.skills.length || projected.length !== candidates.length ||
			projected.length > items.length,
		issueCount: issues,
	};
}

function projectLibraryEntry(value: unknown): WireCatalogLibraryEntry | null {
	if (!isRecord(value)) return null;
	const name = exactText(value.name, 128);
	const summary = description(value.description);
	const version = value.version === undefined ? null : exactText(value.version, 64);
	const category = value.category === undefined ? null : exactText(value.category, 64);
	const audit = value.audit === undefined ? "not-reported" : value.audit;
	if (
		name === null || summary === null || (value.version !== undefined && version === null) ||
		(value.category !== undefined && category === null) || !isOneOf(value.kind, CATALOG_LIBRARY_KINDS) ||
		!isOneOf(value.origin, CATALOG_LIBRARY_ORIGINS) || !isOneOf(audit, CATALOG_AUDIT_STATES)
	) return null;
	return {
		kind: value.kind,
		name,
		description: summary,
		version,
		category,
		origin: value.origin,
		audit,
	};
}

export function projectLibraryCatalog(value: unknown): WireCatalogLibraryCollection {
	if (!isRecord(value) || !Array.isArray(value.entries) || value.entries.length > MAX_RAW_CATALOG_ITEMS) {
		throw new ClioCatalogProjectionError("Clio Coder returned an invalid library catalog.");
	}
	const issues = diagnosticCount(value.diagnostics);
	if (issues === null) throw new ClioCatalogProjectionError("Clio Coder returned invalid library catalog diagnostics.");
	const candidates = value.entries.map(projectLibraryEntry).filter((
		entry,
	): entry is WireCatalogLibraryEntry => entry !== null);
	const projected = uniqueBy(candidates, (entry) => `${entry.kind}:${entry.name}`);
	const items = projected.slice(0, MAX_WIRE_CATALOG_LIBRARY_ENTRIES);
	return {
		availability: "available",
		items,
		truncated: candidates.length !== value.entries.length || projected.length !== candidates.length ||
			projected.length > items.length,
		issueCount: issues,
	};
}

function projectExtension(value: unknown): WireCatalogExtension | null {
	if (!isRecord(value)) return null;
	const rawResources = value.resources;
	if (!isRecord(rawResources)) return null;
	const id = exactText(value.id, 128);
	const name = exactText(value.name, 128);
	const version = exactText(value.version, 64);
	const summary = description(value.description);
	const issueCount = diagnosticCount(value.diagnostics);
	if (
		id === null || name === null || version === null || summary === null || issueCount === null ||
		!isOneOf(value.scope, CATALOG_EXTENSION_SCOPES) || typeof value.enabled !== "boolean" ||
		typeof value.effective !== "boolean"
	) return null;
	const overriddenBy = value.overriddenBy === undefined || value.overriddenBy === null
		? null
		: isOneOf(value.overriddenBy, CATALOG_EXTENSION_SCOPES)
		? value.overriddenBy
		: null;
	if (value.overriddenBy !== undefined && value.overriddenBy !== null && overriddenBy === null) return null;
	if (!value.effective) {
		if (value.scope !== "user" || overriddenBy !== "project") return null;
	} else if (overriddenBy !== null) return null;
	const rawResourceKinds = Object.keys(rawResources);
	if (
		rawResourceKinds.length > CATALOG_EXTENSION_RESOURCE_KINDS.length ||
		rawResourceKinds.some((kind) =>
			!isOneOf(kind, CATALOG_EXTENSION_RESOURCE_KINDS) || exactText(rawResources[kind], 4_096) === null
		)
	) return null;
	const resources = CATALOG_EXTENSION_RESOURCE_KINDS.filter((kind) => Object.hasOwn(rawResources, kind));
	return {
		id,
		name,
		version,
		description: summary,
		scope: value.scope,
		enabled: value.enabled,
		effective: value.effective,
		overriddenBy,
		resources,
		issueCount,
	};
}

export function projectExtensionCatalog(value: unknown): WireCatalogExtensionCollection {
	if (!isRecord(value) || !Array.isArray(value.extensions) || value.extensions.length > MAX_RAW_CATALOG_ITEMS) {
		throw new ClioCatalogProjectionError("Clio Coder returned an invalid extension catalog.");
	}
	const candidates = value.extensions.map(projectExtension).filter((
		entry,
	): entry is WireCatalogExtension => entry !== null);
	const projected = uniqueBy(candidates, (entry) => `${entry.scope}:${entry.id}`);
	const items = projected.slice(0, MAX_WIRE_CATALOG_EXTENSIONS);
	const issueCount = items.reduce((total, item) => total + item.issueCount, 0);
	if (issueCount > MAX_CATALOG_NUMBER) {
		throw new ClioCatalogProjectionError("Clio Coder returned too many extension diagnostics.");
	}
	return {
		availability: "available",
		items,
		truncated: candidates.length !== value.extensions.length || projected.length !== candidates.length ||
			projected.length > items.length,
		issueCount,
	};
}

const VERIFIER_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;
const VERIFIER_TAG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const VERIFIER_LOCATION_PATTERN = /^(root|checks\[\d{1,3}\])(\.[a-zA-Z]{1,32}(\[\d{1,3}\])?)?$/;
const MAX_VERIFIER_TIMEOUT_MS = 900_000;

function projectVerifier(value: unknown): WireCatalogVerifier | null {
	if (!isRecord(value)) return null;
	const id = exactText(value.id, 64);
	const summary = description(value.description);
	const argumentCount = integer(value.argumentCount);
	const timeoutMs = integer(value.timeoutMs);
	if (
		id === null || summary === null || argumentCount === null || timeoutMs === null || timeoutMs === 0 ||
		timeoutMs > MAX_VERIFIER_TIMEOUT_MS || !VERIFIER_ID_PATTERN.test(id) ||
		!isOneOf(value.origin, CATALOG_VERIFIER_ORIGINS) || !isOneOf(value.signal, CATALOG_VERIFIER_SIGNALS) ||
		!isOneOf(value.authority, CATALOG_VERIFIER_AUTHORITIES) || !isOneOf(value.runner, CATALOG_VERIFIER_RUNNERS) ||
		typeof value.runsAtRepositoryRoot !== "boolean" || typeof value.argvFixed !== "boolean"
	) return null;
	// A package-script check is the one origin verify does not pin, and the one
	// origin package.json can have produced. Both directions are refused here so
	// a harness that changes either stops crossing rather than crossing wrong.
	if (value.argvFixed === (value.origin === "package-script")) return null;
	if ((value.origin === "package-script") !== (value.signal === "package-script")) return null;
	if (value.signal === "manual-entry") return null;
	if (value.origin !== "proposed" && value.authority !== "project-declared") return null;
	if (!Array.isArray(value.tags) || value.tags.length > MAX_WIRE_CATALOG_VERIFIER_TAGS) return null;
	const tags: string[] = [];
	for (const entry of value.tags) {
		const tag = exactText(entry, 32);
		if (tag === null || !VERIFIER_TAG_PATTERN.test(tag) || tags.includes(tag)) return null;
		tags.push(tag);
	}
	return {
		id,
		description: summary,
		origin: value.origin,
		signal: value.signal,
		authority: value.authority,
		runner: value.runner,
		argumentCount,
		runsAtRepositoryRoot: value.runsAtRepositoryRoot,
		argvFixed: value.argvFixed,
		timeoutMs,
		tags,
	};
}

/**
 * Project the fixed verifier read.
 *
 * This projection drops no row silently. A check that fails any of its shape
 * rules fails the whole snapshot, because a check plane that looks complete
 * while a check was refused is the wrong answer for a surface whose job is to
 * say what this project verifies with.
 */
export function projectVerifierCatalog(value: unknown): WireCatalogVerifierCollection {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.checks)) {
		throw new ClioCatalogProjectionError("Clio Coder returned an invalid verifier inventory.");
	}
	if (value.checks.length > MAX_RAW_CATALOG_ITEMS) {
		throw new ClioCatalogProjectionError("Clio Coder returned too many verifier checks.");
	}
	const issueCount = integer(value.diagnosticCount);
	if (
		issueCount === null || typeof value.catalogPresent !== "boolean" || typeof value.checksTruncated !== "boolean" ||
		!isOneOf(value.discovery, CATALOG_VERIFIER_DISCOVERY) ||
		(value.blockedBy !== null && !isOneOf(value.blockedBy, CATALOG_VERIFIER_BLOCKS)) ||
		(value.catalogValid !== null && typeof value.catalogValid !== "boolean") ||
		(value.rejection !== null && !isOneOf(value.rejection, CATALOG_VERIFIER_REJECTIONS))
	) throw new ClioCatalogProjectionError("Clio Coder returned an invalid verifier inventory.");
	const rejectedAt = value.rejectedAt === null ? null : exactText(value.rejectedAt, 64);
	if (value.rejectedAt !== null && (rejectedAt === null || !VERIFIER_LOCATION_PATTERN.test(rejectedAt))) {
		throw new ClioCatalogProjectionError("Clio Coder reported a verifier rejection outside the catalog schema.");
	}
	const projected = value.checks.map(projectVerifier);
	if (projected.some((check) => check === null)) {
		throw new ClioCatalogProjectionError("Clio Coder returned a verifier check the boundary refuses.");
	}
	const items = (projected as WireCatalogVerifier[]).slice(0, MAX_WIRE_CATALOG_VERIFIERS);
	return {
		availability: "available",
		items,
		truncated: value.checksTruncated || items.length !== projected.length,
		issueCount,
		discovery: value.discovery,
		blockedBy: value.blockedBy,
		catalogPresent: value.catalogPresent,
		catalogValid: value.catalogValid,
		rejection: value.rejection,
		rejectedAt,
	};
}

function failedVerifierCollection(): WireCatalogVerifierCollection {
	// A failed adapter knows nothing about the catalog, so it claims nothing:
	// "we could not read this" and "you have no catalog" are different states.
	return {
		availability: "failed",
		items: [],
		truncated: false,
		issueCount: 0,
		discovery: "blocked",
		blockedBy: "unclassified",
		catalogPresent: false,
		catalogValid: null,
		rejection: null,
		rejectedAt: null,
	};
}

interface FailedCatalogCollection {
	readonly availability: "failed";
	readonly items: readonly never[];
	readonly truncated: false;
	readonly issueCount: 0;
}

function failedCollection(): FailedCatalogCollection {
	return { availability: "failed", items: [], truncated: false, issueCount: 0 };
}

function failureCode(error: unknown): string {
	if (error instanceof ClioReadCommandError) return error.code;
	if (error instanceof ClioCatalogProjectionError) return "invalid-shape";
	return "internal";
}

export class ClioCliCatalogInspector implements ClioCatalogInspector {
	readonly #runner: ClioReadCommandRunner;
	readonly #now: () => number;
	readonly #log: (message: string) => void;

	constructor(options: ClioCliCatalogInspectorOptions = {}) {
		this.#runner = new ClioReadCommandRunner({
			executable: options.executable,
			prefixArgs: options.prefixArgs,
			timeoutMs: options.timeoutMs ?? DEFAULT_CATALOG_INSPECT_TIMEOUT_MS,
			maximumStdoutBytes: options.maximumStdoutBytes ?? MAX_CATALOG_INSPECT_STDOUT_BYTES,
			maximumStderrBytes: options.maximumStderrBytes ?? MAX_CATALOG_INSPECT_STDERR_BYTES,
		});
		this.#now = options.now ?? Date.now;
		this.#log = options.log ?? (() => undefined);
	}

	async #collection<T>(
		root: string,
		label: string,
		args: readonly string[],
		project: (value: unknown) => T,
	): Promise<T | ReturnType<typeof failedCollection>> {
		try {
			return project(await this.#runner.runJson(root, args));
		} catch (error) {
			this.#log(`Clio Coder ${label} catalog inspection failed (${failureCode(error)}).`);
			return failedCollection();
		}
	}

	async #verifiers(root: string): Promise<WireCatalogVerifierCollection> {
		try {
			return projectVerifierCatalog(await this.#runner.runJson(root, ["verifiers", "inspect", "--json"]));
		} catch (error) {
			this.#log(`Clio Coder verifier catalog inspection failed (${failureCode(error)}).`);
			return failedVerifierCollection();
		}
	}

	async inspect(trustedRoot: string): Promise<WireCatalogInspection> {
		const root = resolve(trustedRoot);
		const [agents, skills, library, extensions, verifiers] = await Promise.all([
			this.#collection(root, "agent", ["agents", "--json"], projectAgentCatalog),
			this.#collection(root, "skill", ["skills", "list", "--json"], projectSkillCatalog),
			this.#collection(root, "library", ["library", "list", "--json"], projectLibraryCatalog),
			this.#collection(root, "extension", ["extensions", "list", "--all", "--json"], projectExtensionCatalog),
			this.#verifiers(root),
		]);
		return {
			inspectedAt: new Date(this.#now()).toISOString(),
			agents,
			skills,
			library,
			extensions,
			verifiers,
		};
	}
}
