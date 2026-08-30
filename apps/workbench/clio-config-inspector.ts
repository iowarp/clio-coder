/**
 * Bounded adapter for the public, read-only `clio-coder config inspect --json`
 * command. The command's raw graph is intentionally much richer than the
 * renderer contract: it may contain settings, native user paths, diagnostics,
 * and arbitrary category details. This module is the one-way projection that
 * keeps those values host-side.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { ClioReadCommandError, ClioReadCommandRunner } from "./clio-read-command.ts";
import {
	CONFIG_SETTING_SOURCES,
	CUSTOMIZATION_CATEGORIES,
	CUSTOMIZATION_PRECEDENCE,
	CUSTOMIZATION_RELOAD_CLASSES,
	CUSTOMIZATION_TRUST,
	MAX_WIRE_CONFIG_ISSUE_GROUPS,
	MAX_WIRE_CONFIG_SETTINGS,
	MAX_WIRE_CUSTOMIZATION_ENTRIES,
	MAX_WIRE_CUSTOMIZATION_FACTS,
	type WireConfigInspection,
	type WireConfigIssueCount,
	type WireConfigSetting,
	type WireConfigSettingSource,
	type WireCustomizationCategory,
	type WireCustomizationEntry,
	type WireCustomizationFact,
	type WireProjectPath,
} from "./src/protocol.ts";

export const DEFAULT_CONFIG_INSPECT_TIMEOUT_MS = 12_000;
export const MAX_CONFIG_INSPECT_STDOUT_BYTES = 1024 * 1024;
export const MAX_CONFIG_INSPECT_STDERR_BYTES = 64 * 1024;
const MAX_RAW_SETTINGS = 2_048;
const MAX_RAW_ENTRIES = 2_048;
const MAX_RAW_ISSUES = 512;
const encoder = new TextEncoder();

export interface ClioConfigInspector {
	inspect(trustedRoot: string): Promise<WireConfigInspection>;
}

export interface ClioCliConfigInspectorOptions {
	readonly executable?: string;
	/** Test/development prefix only. Browser commands can never influence argv. */
	readonly prefixArgs?: readonly string[];
	readonly timeoutMs?: number;
	readonly maximumStdoutBytes?: number;
	readonly maximumStderrBytes?: number;
	readonly now?: () => number;
	readonly log?: (message: string) => void;
}

export class ClioConfigInspectError extends Error {
	override readonly name = "ClioConfigInspectError";

	constructor(
		readonly code: "not-ready" | "unsupported" | "internal",
		message: string,
	) {
		super(message);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function boundedInteger(value: unknown): number | null {
	return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function boundedText(value: unknown, maximumBytes: number): string | null {
	if (typeof value !== "string" || value.trim() !== value || value.length === 0) return null;
	if (encoder.encode(value).byteLength > maximumBytes) return null;
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code <= 0x1f || code === 0x7f) return null;
	}
	return value;
}

function isOneOf<const T extends readonly string[]>(value: unknown, choices: T): value is T[number] {
	return typeof value === "string" && choices.includes(value as T[number]);
}

function isInside(root: string, candidate: string): boolean {
	const local = relative(root, candidate);
	return local === "" || (!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`));
}

function projectPath(trustedRoot: string, value: unknown): WireProjectPath | undefined {
	const source = boundedText(value, 4 * 1024);
	if (source === null || !isAbsolute(source)) return undefined;
	const candidate = resolve(source);
	if (!isInside(trustedRoot, candidate)) return undefined;
	const local = relative(trustedRoot, candidate);
	if (local === "") return { segments: [] };
	const segments = local.split(sep);
	if (segments.length > 64) return undefined;
	for (const segment of segments) {
		if (boundedText(segment, 255) === null || segment === "." || segment === "..") return undefined;
	}
	return { segments };
}

const EXACT_SETTING_KEYS = new Set([
	"autonomy",
	"orchestrator.target",
	"orchestrator.model",
	"orchestrator.thinkingLevel",
	"background.target",
	"background.model",
	"background.thinkingLevel",
	"workers.default.target",
	"workers.default.model",
	"workers.default.thinkingLevel",
]);

const SENSITIVE_SETTING_SEGMENT =
	/(?:^|\.)(?:auth|apiKey|api_key|token|secret|password|credential|headers?|cookie|oauth|url|path|command|args|env)(?:\.|$)/iu;

function settingValue(key: string, value: unknown): Pick<WireConfigSetting, "value" | "valueKind"> {
	if (value === null || value === undefined) return { value: "not set", valueKind: "unset" };
	if (SENSITIVE_SETTING_SEGMENT.test(key)) return { value: "configured", valueKind: "configured" };
	if (typeof value === "boolean") return { value: value ? "true" : "false", valueKind: "exact" };
	if (typeof value === "number" && Number.isFinite(value)) return { value: String(value), valueKind: "exact" };
	if (typeof value === "string") {
		const text = boundedText(value, 256);
		if (EXACT_SETTING_KEYS.has(key) && text !== null) return { value: text, valueKind: "exact" };
		return { value: "configured", valueKind: "configured" };
	}
	if (Array.isArray(value)) {
		return { value: `${value.length} ${value.length === 1 ? "item" : "items"}`, valueKind: "collection" };
	}
	if (isRecord(value)) {
		const count = Object.keys(value).length;
		return { value: `${count} ${count === 1 ? "field" : "fields"}`, valueKind: "collection" };
	}
	return { value: "configured", valueKind: "configured" };
}

function projectSetting(value: unknown): WireConfigSetting | null {
	if (!isRecord(value)) return null;
	const key = boundedText(value.key, 256);
	if (key === null || !isOneOf(value.source, CONFIG_SETTING_SOURCES)) return null;
	return { key, source: value.source as WireConfigSettingSource, ...settingValue(key, value.value) };
}

function fact(label: string, value: string): WireCustomizationFact {
	return { label, value };
}

function booleanFact(detail: Record<string, unknown>, key: string, label: string): WireCustomizationFact | null {
	return typeof detail[key] === "boolean" ? fact(label, detail[key] ? "yes" : "no") : null;
}

function integerFact(detail: Record<string, unknown>, key: string, label: string): WireCustomizationFact | null {
	const value = boundedInteger(detail[key]);
	return value === null ? null : fact(label, String(value));
}

function textFact(
	detail: Record<string, unknown>,
	key: string,
	label: string,
	maximumBytes = 128,
): WireCustomizationFact | null {
	const value = boundedText(detail[key], maximumBytes);
	return value === null ? null : fact(label, value);
}

function countFact(detail: Record<string, unknown>, key: string, label: string): WireCustomizationFact | null {
	const value = detail[key];
	if (!Array.isArray(value)) return null;
	return fact(label, String(value.length));
}

function entryFacts(category: WireCustomizationCategory, detailValue: unknown): readonly WireCustomizationFact[] {
	if (!isRecord(detailValue)) return [];
	const candidates: Array<WireCustomizationFact | null> = [];
	switch (category) {
		case "clio-md":
			candidates.push(
				integerFact(detailValue, "layer", "Layer"),
				integerFact(detailValue, "layers", "Layers"),
				textFact(detailValue, "preload", "Preload"),
				integerFact(detailValue, "preloadChars", "Preload characters"),
				integerFact(detailValue, "preloadLines", "Preload lines"),
				booleanFact(detailValue, "preloadNearLimit", "Near limit"),
			);
			break;
		case "rule":
			candidates.push(
				booleanFact(detailValue, "enabled", "Enabled"),
				booleanFact(detailValue, "conditional", "Conditional"),
				countFact(detailValue, "paths", "Path conditions"),
				countFact(detailValue, "excludes", "Exclusions"),
			);
			break;
		case "operator-profile":
			candidates.push(countFact(detailValue, "fields", "Profile fields"));
			break;
		case "hook":
			candidates.push(
				textFact(detailValue, "on", "Event"),
				textFact(detailValue, "kind", "Kind"),
				booleanFact(detailValue, "enabled", "Enabled"),
				countFact(detailValue, "tools", "Tools"),
			);
			break;
		case "extension":
			candidates.push(
				textFact(detailValue, "version", "Version"),
				booleanFact(detailValue, "enabled", "Enabled"),
				booleanFact(detailValue, "effective", "Effective"),
			);
			break;
		case "skill-root":
		case "prompt-root":
			candidates.push(booleanFact(detailValue, "present", "Present"));
			break;
		case "safety":
			candidates.push(textFact(detailValue, "autonomy", "Working freedom"));
			break;
		case "memory":
			candidates.push(
				booleanFact(detailValue, "present", "Present"),
				integerFact(detailValue, "records", "Records"),
			);
			break;
		case "agents":
			candidates.push(
				booleanFact(detailValue, "present", "Present"),
				booleanFact(detailValue, "enabled", "Enabled"),
				integerFact(detailValue, "count", "Entries"),
			);
			break;
		case "settings":
			break;
	}
	return candidates.filter((candidate): candidate is WireCustomizationFact => candidate !== null).slice(
		0,
		MAX_WIRE_CUSTOMIZATION_FACTS,
	);
}

function projectEntry(trustedRoot: string, value: unknown): WireCustomizationEntry | null {
	if (!isRecord(value) || !isOneOf(value.category, CUSTOMIZATION_CATEGORIES)) return null;
	const id = boundedText(value.id, 256);
	const scope = boundedText(value.scope, 128);
	if (id === null || scope === null || !isOneOf(value.reloadClass, CUSTOMIZATION_RELOAD_CLASSES)) return null;
	const sourcePath = projectPath(trustedRoot, value.sourcePath);
	const hashText = boundedText(value.hash, 128);
	const hash = hashText !== null && /^[A-Fa-f0-9]{4,128}$/u.test(hashText) ? hashText : undefined;
	const trust = isOneOf(value.trust, CUSTOMIZATION_TRUST) ? value.trust : undefined;
	const precedence = isOneOf(value.precedence, CUSTOMIZATION_PRECEDENCE) ? value.precedence : undefined;
	const contextCostTokens = boundedInteger(value.contextCostTokens);
	return {
		category: value.category,
		id,
		scope,
		...(sourcePath === undefined ? {} : { sourcePath }),
		...(hash === undefined ? {} : { hash }),
		...(trust === undefined ? {} : { trust }),
		...(precedence === undefined ? {} : { precedence }),
		reloadClass: value.reloadClass,
		...(contextCostTokens === null ? {} : { contextCostTokens }),
		facts: entryFacts(value.category, value.detail),
	};
}

const ISSUE_SURFACES = [
	"settings",
	"clio-md",
	"rule",
	"operator-profile",
	"hook",
	"extension",
	"skill",
	"prompt",
	"agents",
	"safety",
	"memory",
	"other",
] as const;

function issueSurface(value: unknown): (typeof ISSUE_SURFACES)[number] {
	if (typeof value !== "string") return "other";
	const prefix = value.trimStart().split(/[\s:]/u, 1)[0]?.toLocaleLowerCase("en-US") ?? "";
	if (prefix === "rules") return "rule";
	if (prefix === "hooks") return "hook";
	if (prefix === "extensions") return "extension";
	if (prefix === "skills") return "skill";
	if (prefix === "prompts") return "prompt";
	return (ISSUE_SURFACES as readonly string[]).includes(prefix) ? prefix as (typeof ISSUE_SURFACES)[number] : "other";
}

function issueCounts(values: readonly unknown[]): readonly WireConfigIssueCount[] {
	const counts = new Map<string, number>();
	for (const value of values.slice(0, MAX_RAW_ISSUES)) {
		const surface = issueSurface(value);
		counts.set(surface, (counts.get(surface) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort(([left], [right]) => left.localeCompare(right, "en-US"))
		.slice(0, MAX_WIRE_CONFIG_ISSUE_GROUPS)
		.map(([surface, count]) => ({ surface, count }));
}

/**
 * Converts the CLI graph into the only graph shape the renderer may receive.
 * Exported for deterministic redaction and boundary tests.
 */
export function projectConfigInspection(
	value: unknown,
	trustedRoot: string,
	inspectedAt: string,
): WireConfigInspection {
	if (
		!isRecord(value) || !Array.isArray(value.settings) || !Array.isArray(value.entries) || !Array.isArray(value.issues)
	) {
		throw new ClioConfigInspectError("internal", "Clio Coder returned an invalid configuration inspection graph.");
	}
	const root = resolve(trustedRoot);
	const reportedRoot = boundedText(value.cwd, 4 * 1024);
	if (reportedRoot === null || resolve(reportedRoot) !== root) {
		throw new ClioConfigInspectError("internal", "Clio Coder inspected a different project than the GUI requested.");
	}
	if (
		value.settings.length > MAX_RAW_SETTINGS || value.entries.length > MAX_RAW_ENTRIES ||
		value.issues.length > MAX_RAW_ISSUES * 4
	) {
		throw new ClioConfigInspectError(
			"internal",
			"Clio Coder's configuration graph exceeded the GUI's safe shape bound.",
		);
	}
	const projectedSettings = value.settings.map(projectSetting).filter((entry): entry is WireConfigSetting =>
		entry !== null
	);
	const projectedEntries = value.entries.map((entry) => projectEntry(root, entry)).filter((
		entry,
	): entry is WireCustomizationEntry => entry !== null);
	const settings = projectedSettings.slice(0, MAX_WIRE_CONFIG_SETTINGS);
	const entries = projectedEntries.slice(0, MAX_WIRE_CUSTOMIZATION_ENTRIES);
	const counts = issueCounts(value.issues);
	return {
		inspectedAt,
		settings,
		settingsTruncated: projectedSettings.length !== value.settings.length || projectedSettings.length > settings.length,
		entries,
		entriesTruncated: projectedEntries.length !== value.entries.length || projectedEntries.length > entries.length,
		issueCounts: counts,
		issuesTruncated: value.issues.length > MAX_RAW_ISSUES || counts.length >= MAX_WIRE_CONFIG_ISSUE_GROUPS,
	};
}

export class ClioCliConfigInspector implements ClioConfigInspector {
	readonly #runner: ClioReadCommandRunner;
	readonly #now: () => number;
	readonly #log: (message: string) => void;

	constructor(options: ClioCliConfigInspectorOptions = {}) {
		this.#runner = new ClioReadCommandRunner({
			executable: options.executable,
			prefixArgs: options.prefixArgs,
			timeoutMs: options.timeoutMs ?? DEFAULT_CONFIG_INSPECT_TIMEOUT_MS,
			maximumStdoutBytes: options.maximumStdoutBytes ?? MAX_CONFIG_INSPECT_STDOUT_BYTES,
			maximumStderrBytes: options.maximumStderrBytes ?? MAX_CONFIG_INSPECT_STDERR_BYTES,
		});
		this.#now = options.now ?? Date.now;
		this.#log = options.log ?? (() => undefined);
	}

	async inspect(trustedRoot: string): Promise<WireConfigInspection> {
		const root = resolve(trustedRoot);
		let parsed: unknown;
		try {
			parsed = await this.#runner.runJson(root, ["config", "inspect", "--json"]);
		} catch (error) {
			if (!(error instanceof ClioReadCommandError)) throw error;
			if (error.code === "spawn") {
				throw new ClioConfigInspectError("not-ready", "The GUI could not start Clio Coder's configuration inspector.");
			}
			if (error.code === "timeout") {
				throw new ClioConfigInspectError("not-ready", "Clio Coder's configuration inspection did not finish in time.");
			}
			if (error.code === "byte-limit") {
				throw new ClioConfigInspectError(
					"internal",
					"Clio Coder's configuration inspection exceeded the GUI's byte bound.",
				);
			}
			if (error.code === "exit") {
				const unsupported = /(?:unknown|unsupported).{0,32}(?:command|config)|config.{0,32}(?:unknown|unsupported)/iu
					.test(error.diagnostic);
				this.#log(`Clio Coder configuration inspector exited with code ${error.exitCode ?? "unknown"}.`);
				throw new ClioConfigInspectError(
					unsupported ? "unsupported" : "not-ready",
					unsupported
						? "This Clio Coder version does not provide configuration inspection."
						: "Clio Coder could not inspect the effective configuration for this project.",
				);
			}
			if (error.code === "encoding") {
				throw new ClioConfigInspectError("internal", "Clio Coder returned non-text configuration inspection output.");
			}
			if (error.code === "json") {
				throw new ClioConfigInspectError("internal", "Clio Coder returned invalid configuration inspection JSON.");
			}
			throw new ClioConfigInspectError("internal", "The GUI could not read Clio Coder's configuration inspection.");
		}
		return projectConfigInspection(parsed, root, new Date(this.#now()).toISOString());
	}
}
