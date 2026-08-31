/**
 * Bounded adapter for Clio Coder's offline model and worker-routing inventories.
 *
 * The browser cannot supply argv. Model inspection explicitly stays offline,
 * while profiles and bindings use Clio Coder's read-only JSON listings. Only routing
 * identifiers and typed capability facts cross the protocol; raw warnings,
 * provider configuration, URLs, credentials, environment, and paths do not.
 */

import { resolve } from "node:path";
import { ClioReadCommandError, ClioReadCommandRunner } from "./clio-read-command.ts";
import {
	MAX_WIRE_ROUTING_BINDINGS,
	MAX_WIRE_ROUTING_MODELS,
	MAX_WIRE_ROUTING_PROFILES,
	THINKING_LEVELS,
	type WireRoutingBinding,
	type WireRoutingBindingCollection,
	type WireRoutingInspection,
	type WireRoutingModel,
	type WireRoutingModelCapability,
	type WireRoutingModelCollection,
	type WireRoutingModelResidency,
	type WireRoutingProfile,
	type WireRoutingProfileCollection,
} from "./src/protocol.ts";

export const DEFAULT_ROUTING_INSPECT_TIMEOUT_MS = 12_000;
export const MAX_ROUTING_INSPECT_STDOUT_BYTES = 2 * 1024 * 1024;
export const MAX_ROUTING_INSPECT_STDERR_BYTES = 64 * 1024;
const MAX_RAW_ROUTING_ITEMS = 2_048;
const MAX_ROUTING_NUMBER = 10_000_000_000;
const encoder = new TextEncoder();

export interface ClioRoutingInspector {
	inspect(trustedRoot: string): Promise<WireRoutingInspection>;
}

export interface ClioCliRoutingInspectorOptions {
	readonly executable?: string;
	/** Test/development prefix only. Browser commands can never influence argv. */
	readonly prefixArgs?: readonly string[];
	readonly timeoutMs?: number;
	readonly maximumStdoutBytes?: number;
	readonly maximumStderrBytes?: number;
	readonly now?: () => number;
	readonly log?: (message: string) => void;
}

export class ClioRoutingProjectionError extends Error {
	override readonly name = "ClioRoutingProjectionError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isOneOf<const T extends readonly string[]>(value: unknown, choices: T): value is T[number] {
	return typeof value === "string" && choices.includes(value as T[number]);
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

const ROUTING_LOCATION_PREFIX =
	/^(?:(?:https?|file|ftp|ssh):|[a-z][a-z0-9+.-]*:\/\/|~?[\\/]|\.{1,2}[\\/]|[a-z]:[\\/])/iu;

function exactRoutingText(value: unknown, maximumBytes: number): string | null {
	const text = exactText(value, maximumBytes);
	if (text === null || ROUTING_LOCATION_PREFIX.test(text) || text.includes("\\")) return null;
	return text;
}

function optionalRoutingText(value: unknown, maximumBytes: number): string | null | undefined {
	if (value === undefined || value === null) return null;
	return exactRoutingText(value, maximumBytes) ?? undefined;
}

function boundedInteger(value: unknown): number | null {
	return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_ROUTING_NUMBER
		? value as number
		: null;
}

const CAPABILITY_MARKS = [
	["C", "chat"],
	["T", "tools"],
	["R", "reasoning"],
	["V", "vision"],
	["E", "embeddings"],
	["K", "rerank"],
	["F", "fim"],
] as const satisfies readonly (readonly [string, WireRoutingModelCapability])[];

function projectCapabilities(value: unknown): readonly WireRoutingModelCapability[] | null {
	if (typeof value !== "string" || value.length !== CAPABILITY_MARKS.length) return null;
	const capabilities: WireRoutingModelCapability[] = [];
	for (let index = 0; index < CAPABILITY_MARKS.length; index += 1) {
		const pair = CAPABILITY_MARKS[index];
		if (!pair) return null;
		const [mark, capability] = pair;
		const valueMark = value[index];
		if (valueMark === mark) capabilities.push(capability);
		else if (valueMark !== "-") return null;
	}
	return capabilities;
}

const RAW_MODEL_STATES = ["-", "loaded", "loading", "unloaded", "unknown"] as const;

function projectResidency(value: unknown): WireRoutingModelResidency | null {
	if (!isOneOf(value, RAW_MODEL_STATES)) return null;
	return value === "-" ? "not-reported" : value;
}

type ProjectedModelRow =
	| Readonly<{ kind: "empty"; targetId: string }>
	| Readonly<{ kind: "model"; model: WireRoutingModel }>;

function projectModelRow(value: unknown): ProjectedModelRow | null {
	if (!isRecord(value)) return null;
	const targetId = exactRoutingText(value.targetId, 128);
	const runtimeId = exactRoutingText(value.runtimeId, 128);
	const modelId = exactRoutingText(value.modelId, 256);
	const capabilities = projectCapabilities(value.caps);
	const contextWindow = boundedInteger(value.contextWindow);
	const maxOutputTokens = boundedInteger(value.maxTokens);
	const residency = projectResidency(value.state);
	if (
		targetId === null || runtimeId === null || modelId === null || capabilities === null || contextWindow === null ||
		maxOutputTokens === null || residency === null || typeof value.reasoning !== "boolean" ||
		value.reasoning !== capabilities.includes("reasoning")
	) return null;
	if (modelId === "(no models)") return { kind: "empty", targetId };
	return {
		kind: "model",
		model: { targetId, runtimeId, modelId, capabilities, contextWindow, maxOutputTokens, residency },
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

export function projectRoutingModels(value: unknown): WireRoutingModelCollection {
	if (!Array.isArray(value) || value.length > MAX_RAW_ROUTING_ITEMS) {
		throw new ClioRoutingProjectionError("Clio Coder returned an invalid offline model listing.");
	}
	const candidates = value.map(projectModelRow).filter((row): row is ProjectedModelRow => row !== null);
	const modelCandidates = candidates.filter((row): row is Extract<ProjectedModelRow, { kind: "model" }> =>
		row.kind === "model"
	).map((row) => row.model);
	const emptyTargets = new Set(
		candidates.filter((row): row is Extract<ProjectedModelRow, { kind: "empty" }> => row.kind === "empty").map((row) =>
			row.targetId
		),
	);
	const projected = uniqueBy(modelCandidates, (model) => `${model.targetId}\u001f${model.modelId}`);
	const items = projected.slice(0, MAX_WIRE_ROUTING_MODELS);
	return {
		availability: "available",
		items,
		truncated: candidates.length !== value.length || projected.length !== modelCandidates.length ||
			projected.length > items.length,
		emptyTargetCount: emptyTargets.size,
	};
}

function projectProfile(value: unknown): WireRoutingProfile | null {
	if (!isRecord(value)) return null;
	const name = exactRoutingText(value.name, 128);
	const target = optionalRoutingText(value.target, 128);
	const runtime = optionalRoutingText(value.runtime, 128);
	const model = optionalRoutingText(value.model, 256);
	if (
		name === null || target === undefined || runtime === undefined || model === undefined ||
		!isOneOf(value.thinkingLevel, THINKING_LEVELS)
	) return null;
	return { name, target, runtime, model, thinkingLevel: value.thinkingLevel };
}

export function projectRoutingProfiles(value: unknown): WireRoutingProfileCollection {
	if (!Array.isArray(value) || value.length > MAX_RAW_ROUTING_ITEMS) {
		throw new ClioRoutingProjectionError("Clio Coder returned an invalid worker profile listing.");
	}
	const candidates = value.map(projectProfile).filter((profile): profile is WireRoutingProfile => profile !== null);
	const projected = uniqueBy(candidates, (profile) => profile.name);
	const items = projected.slice(0, MAX_WIRE_ROUTING_PROFILES);
	return {
		availability: "available",
		items,
		truncated: candidates.length !== value.length || projected.length !== candidates.length ||
			projected.length > items.length,
	};
}

function projectBinding(value: unknown): WireRoutingBinding | null {
	if (!isRecord(value)) return null;
	const agentId = exactRoutingText(value.agentId, 128);
	const profile = exactRoutingText(value.profile, 128);
	const target = optionalRoutingText(value.target, 128);
	const model = optionalRoutingText(value.model, 256);
	if (
		agentId === null || profile === null || target === undefined || model === undefined ||
		(value.warning !== null && value.warning !== "missing profile")
	) return null;
	const resolved = value.warning === null;
	if (!resolved && (target !== null || model !== null)) return null;
	return { agentId, profile, target, model, resolved };
}

export function projectRoutingBindings(value: unknown): WireRoutingBindingCollection {
	if (!Array.isArray(value) || value.length > MAX_RAW_ROUTING_ITEMS) {
		throw new ClioRoutingProjectionError("Clio Coder returned an invalid agent profile binding listing.");
	}
	const candidates = value.map(projectBinding).filter((binding): binding is WireRoutingBinding => binding !== null);
	const projected = uniqueBy(candidates, (binding) => binding.agentId);
	const items = projected.slice(0, MAX_WIRE_ROUTING_BINDINGS);
	return {
		availability: "available",
		items,
		truncated: candidates.length !== value.length || projected.length !== candidates.length ||
			projected.length > items.length,
	};
}

function failedModels(): WireRoutingModelCollection {
	return { availability: "failed", items: [], truncated: false, emptyTargetCount: 0 };
}

function failedProfiles(): WireRoutingProfileCollection {
	return { availability: "failed", items: [], truncated: false };
}

function failedBindings(): WireRoutingBindingCollection {
	return { availability: "failed", items: [], truncated: false };
}

function failureCode(error: unknown): string {
	if (error instanceof ClioReadCommandError) return error.code;
	if (error instanceof ClioRoutingProjectionError) return "invalid-shape";
	return "internal";
}

export class ClioCliRoutingInspector implements ClioRoutingInspector {
	readonly #runner: ClioReadCommandRunner;
	readonly #now: () => number;
	readonly #log: (message: string) => void;

	constructor(options: ClioCliRoutingInspectorOptions = {}) {
		this.#runner = new ClioReadCommandRunner({
			executable: options.executable,
			prefixArgs: options.prefixArgs,
			timeoutMs: options.timeoutMs ?? DEFAULT_ROUTING_INSPECT_TIMEOUT_MS,
			maximumStdoutBytes: options.maximumStdoutBytes ?? MAX_ROUTING_INSPECT_STDOUT_BYTES,
			maximumStderrBytes: options.maximumStderrBytes ?? MAX_ROUTING_INSPECT_STDERR_BYTES,
		});
		this.#now = options.now ?? Date.now;
		this.#log = options.log ?? (() => undefined);
	}

	async #collection<T>(
		root: string,
		label: string,
		args: readonly string[],
		project: (value: unknown) => T,
		failed: () => T,
	): Promise<T> {
		try {
			return project(await this.#runner.runJson(root, args));
		} catch (error) {
			this.#log(`Clio Coder ${label} routing inspection failed (${failureCode(error)}).`);
			return failed();
		}
	}

	async inspect(trustedRoot: string): Promise<WireRoutingInspection> {
		const root = resolve(trustedRoot);
		const [models, profiles, bindings] = await Promise.all([
			this.#collection(
				root,
				"offline model",
				["models", "--json", "--offline"],
				projectRoutingModels,
				failedModels,
			),
			this.#collection(
				root,
				"worker profile",
				["targets", "profile", "list", "--json"],
				projectRoutingProfiles,
				failedProfiles,
			),
			this.#collection(
				root,
				"agent profile binding",
				["targets", "profile", "bindings", "--json"],
				projectRoutingBindings,
				failedBindings,
			),
		]);
		return { inspectedAt: new Date(this.#now()).toISOString(), models, profiles, bindings };
	}
}
