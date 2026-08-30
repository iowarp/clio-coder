/**
 * Project-scoped projection of Clio's experimental cross-session usage report.
 *
 * The upstream JSONL mixes repo-filtered rows with global audit, evidence, and
 * memory facts. The GUI deliberately retains only the rows whose upstream
 * implementation applies `--repo` before aggregation. Suggestions, bash
 * shapes, session/run ids, store paths, and diagnostics never cross the host.
 */

import { resolve } from "node:path";
import { ClioReadCommandError, ClioReadCommandRunner } from "./clio-read-command.ts";
import {
	MAX_WIRE_USAGE_MODELS,
	MAX_WIRE_USAGE_RECIPES,
	MAX_WIRE_USAGE_SKILLS,
	MAX_WIRE_USAGE_TOOLS,
	type WireHistoricalUsageTotals,
	type WireUsageInspection,
	type WireUsageModel,
	type WireUsageOpportunityKind,
	type WireUsageRecipe,
	type WireUsageSkill,
	type WireUsageTool,
} from "./src/protocol.ts";

export const DEFAULT_USAGE_INSPECT_TIMEOUT_MS = 15_000;
export const MAX_USAGE_INSPECT_STDOUT_BYTES = 2 * 1024 * 1024;
export const MAX_USAGE_INSPECT_STDERR_BYTES = 64 * 1024;
export const MAX_USAGE_INSPECT_ROWS = 512;
const MAX_USAGE_NUMBER = 1_000_000_000_000_000;
const encoder = new TextEncoder();

export interface ClioUsageInspector {
	inspect(trustedRoot: string): Promise<WireUsageInspection>;
}

export interface ClioCliUsageInspectorOptions {
	readonly executable?: string;
	/** Test/development prefix only. Browser commands can never influence argv. */
	readonly prefixArgs?: readonly string[];
	readonly timeoutMs?: number;
	readonly maximumStdoutBytes?: number;
	readonly maximumStderrBytes?: number;
	readonly now?: () => number;
	readonly log?: (message: string) => void;
}

export class ClioUsageInspectError extends Error {
	override readonly name = "ClioUsageInspectError";

	constructor(
		readonly code: "not-ready" | "unsupported" | "internal",
		message: string,
	) {
		super(message);
	}
}

export class ClioUsageProjectionError extends Error {
	override readonly name = "ClioUsageProjectionError";
}

function projectionError(message: string): never {
	throw new ClioUsageProjectionError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
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

function timestamp(value: unknown): string | null {
	const text = exactText(value, 128);
	if (text === null) return null;
	const parsed = new Date(text);
	return Number.isNaN(parsed.getTime()) || parsed.toISOString() !== text ? null : text;
}

function count(value: unknown): number | null {
	return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_USAGE_NUMBER
		? value as number
		: null;
}

function positiveCount(value: unknown): number | null {
	const projected = count(value);
	return projected !== null && projected > 0 ? projected : null;
}

function cost(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000 ? value : null;
}

function requiredCount(record: Record<string, unknown>, key: string, label: string): number {
	return count(record[key]) ?? projectionError(`Clio returned an invalid ${label} ${key}.`);
}

function requiredCost(record: Record<string, unknown>, key: string, label: string): number {
	return cost(record[key]) ?? projectionError(`Clio returned an invalid ${label} ${key}.`);
}

function totals(
	record: Record<string, unknown>,
	label: string,
): Omit<WireHistoricalUsageTotals, "turns" | "sideQuestions" | "handoffs"> {
	return {
		apiCalls: requiredCount(record, "apiCalls", label),
		input: requiredCount(record, "input", label),
		output: requiredCount(record, "output", label),
		cacheRead: requiredCount(record, "cacheRead", label),
		cacheWrite: requiredCount(record, "cacheWrite", label),
		reasoning: requiredCount(record, "reasoningTokens", label),
		totalTokens: requiredCount(record, "totalTokens", label),
		costUsd: requiredCost(record, "costUsd", label),
	};
}

function projectTotals(record: Record<string, unknown>): WireHistoricalUsageTotals {
	const originKeys = ["turns", "sideQuestions", "handoffs"] as const;
	const present = originKeys.filter((key) => Object.hasOwn(record, key));
	if (present.length !== 0 && present.length !== originKeys.length) {
		projectionError("Clio returned an incomplete usage origin split.");
	}
	return {
		...totals(record, "usage total"),
		turns: present.length === 0 ? null : requiredCount(record, "turns", "usage total"),
		sideQuestions: present.length === 0 ? 0 : requiredCount(record, "sideQuestions", "usage total"),
		handoffs: present.length === 0 ? 0 : requiredCount(record, "handoffs", "usage total"),
	};
}

function projectModel(record: Record<string, unknown>): WireUsageModel {
	const provider = exactText(record.providerId, 128);
	const model = exactText(record.attributedModelId, 256);
	if (provider === null || model === null) projectionError("Clio returned invalid model usage attribution.");
	return { provider, model, ...totals(record, "model usage") };
}

function projectTool(record: Record<string, unknown>): WireUsageTool {
	const name = exactText(record.tool, 128);
	if (name === null) projectionError("Clio returned an invalid usage tool name.");
	return {
		name,
		calls: requiredCount(record, "count", "tool usage"),
		successful: requiredCount(record, "ok", "tool usage"),
		errors: requiredCount(record, "errors", "tool usage"),
		blocked: requiredCount(record, "blocked", "tool usage"),
	};
}

function limited<T>(items: readonly T[], maximum: number): { items: readonly T[]; truncated: boolean } {
	return { items: items.slice(0, maximum), truncated: items.length > maximum };
}

function setSingleton<T>(current: T | undefined, value: T, label: string): T {
	if (current !== undefined) projectionError(`Clio returned duplicate ${label} rows.`);
	return value;
}

export function projectUsageInspection(rows: readonly unknown[], inspectedAt: string): WireUsageInspection {
	if (rows.length === 0 || rows.length > MAX_USAGE_INSPECT_ROWS || timestamp(inspectedAt) === null) {
		projectionError("Clio returned an invalid usage report frame.");
	}

	let windowFrom: string | undefined;
	let windowTo: string | undefined;
	let sessionCount: number | undefined;
	let sessionsMissing = false;
	let dispatchRunCount: number | undefined;
	let receiptsMissing = false;
	let usageTotals: WireHistoricalUsageTotals | undefined;
	const models = new Map<string, WireUsageModel>();
	const tools = new Map<string, WireUsageTool>();
	const skills = new Map<string, WireUsageSkill>();
	const recipes = new Map<string, WireUsageRecipe>();
	const opportunityCounts = new Map<WireUsageOpportunityKind, number>([
		["workflow-distiller", 0],
		["recipe", 0],
	]);

	for (const value of rows) {
		if (!isRecord(value) || value.schema !== "experimental" || value.windowDays !== 30) {
			projectionError("Clio returned an incompatible experimental usage row.");
		}
		const from = timestamp(value.from);
		const to = timestamp(value.to);
		if (from === null || to === null || Date.parse(from) > Date.parse(to)) {
			projectionError("Clio returned an invalid usage window.");
		}
		if (windowFrom === undefined) {
			windowFrom = from;
			windowTo = to;
		} else if (windowFrom !== from || windowTo !== to) {
			projectionError("Clio returned inconsistent usage windows.");
		}

		if (value.kind === "opportunity") {
			const kind = exactText(value.opportunity, 64);
			if (kind === "workflow-distiller" || kind === "recipe") {
				opportunityCounts.set(kind, (opportunityCounts.get(kind) ?? 0) + 1);
			}
			// Suggestion and evidence strings can contain commands, prompts, and ids.
			continue;
		}
		if (value.kind !== "fact") continue;
		const fact = exactText(value.fact, 64);
		if (fact === null) projectionError("Clio returned an invalid usage fact discriminator.");
		switch (fact) {
			case "sessions": {
				if (sessionsMissing) projectionError("Clio contradicted the session store state.");
				const projected = count(value.value);
				if (projected === null) projectionError("Clio returned an invalid session count.");
				sessionCount = setSingleton(sessionCount, projected, "session count");
				break;
			}
			case "session-store-missing":
				if (sessionsMissing || sessionCount !== undefined) {
					projectionError("Clio contradicted the session store state.");
				}
				sessionsMissing = true;
				break;
			case "dispatch-runs": {
				if (receiptsMissing) projectionError("Clio contradicted the receipt store state.");
				const projected = count(value.value);
				if (projected === null) projectionError("Clio returned an invalid dispatch run count.");
				dispatchRunCount = setSingleton(dispatchRunCount, projected, "dispatch run count");
				break;
			}
			case "receipt-store-missing":
				if (receiptsMissing || dispatchRunCount !== undefined) {
					projectionError("Clio contradicted the receipt store state.");
				}
				receiptsMissing = true;
				break;
			case "tokens":
				usageTotals = setSingleton(usageTotals, projectTotals(value), "token total");
				break;
			case "model-usage": {
				const model = projectModel(value);
				const key = `${model.provider}\u001f${model.model}`;
				if (models.has(key)) projectionError("Clio returned duplicate model usage rows.");
				models.set(key, model);
				break;
			}
			case "top-tool": {
				const tool = projectTool(value);
				if (tools.has(tool.name)) projectionError("Clio returned duplicate tool usage rows.");
				tools.set(tool.name, tool);
				break;
			}
			case "skill-activated":
			case "skill-never-activated": {
				const name = exactText(value.skill, 128);
				if (name === null || skills.has(name)) projectionError("Clio returned invalid or duplicate skill usage rows.");
				const activations = fact === "skill-activated" ? positiveCount(value.activations) : 0;
				if (activations === null) projectionError("Clio returned an invalid skill activation count.");
				skills.set(name, { name, activations, observedInWindow: activations > 0 });
				break;
			}
			case "recipe-used": {
				const agentId = exactText(value.agentId, 128);
				const runs = positiveCount(value.runs);
				if (agentId === null || runs === null || recipes.has(agentId)) {
					projectionError("Clio returned invalid or duplicate recipe usage rows.");
				}
				recipes.set(agentId, { agentId, runs });
				break;
			}
			// These rows are global or contain unsafe identifiers/shapes. They are
			// intentionally not projected even when `--repo` was supplied.
			case "audit-tool-calls":
			case "bash-shape":
			case "failure-tag":
			case "memory":
			case "session-cache":
			default:
				break;
		}
	}

	if (windowFrom === undefined || windowTo === undefined) projectionError("Clio returned no usage window.");
	if (!sessionsMissing && sessionCount === undefined) projectionError("Clio omitted the session store state.");
	if (!receiptsMissing && dispatchRunCount === undefined) projectionError("Clio omitted the receipt store state.");

	const boundedModels = limited(
		[...models.values()].sort((left, right) =>
			right.totalTokens - left.totalTokens || left.model.localeCompare(right.model)
		),
		MAX_WIRE_USAGE_MODELS,
	);
	const boundedTools = limited(
		[...tools.values()].sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name)),
		MAX_WIRE_USAGE_TOOLS,
	);
	const boundedSkills = limited(
		[...skills.values()].sort((left, right) =>
			right.activations - left.activations || left.name.localeCompare(right.name)
		),
		MAX_WIRE_USAGE_SKILLS,
	);
	const boundedRecipes = limited(
		[...recipes.values()].sort((left, right) => right.runs - left.runs || left.agentId.localeCompare(right.agentId)),
		MAX_WIRE_USAGE_RECIPES,
	);

	return {
		inspectedAt,
		schema: "experimental",
		windowDays: 30,
		windowFrom,
		windowTo,
		stores: {
			sessions: sessionsMissing ? "missing" : "available",
			dispatchReceipts: receiptsMissing ? "missing" : "available",
		},
		sessionCount: sessionsMissing ? null : sessionCount ?? null,
		dispatchRunCount: receiptsMissing ? null : dispatchRunCount ?? null,
		totals: usageTotals ?? null,
		models: boundedModels.items,
		modelsTruncated: boundedModels.truncated,
		tools: boundedTools.items,
		toolsTruncated: boundedTools.truncated,
		skills: boundedSkills.items,
		skillsTruncated: boundedSkills.truncated,
		recipes: boundedRecipes.items,
		recipesTruncated: boundedRecipes.truncated,
		opportunities: (["workflow-distiller", "recipe"] as const).map((kind) => ({
			kind,
			count: opportunityCounts.get(kind) ?? 0,
		})),
	};
}

export class ClioCliUsageInspector implements ClioUsageInspector {
	readonly #runner: ClioReadCommandRunner;
	readonly #now: () => number;
	readonly #log: (message: string) => void;

	constructor(options: ClioCliUsageInspectorOptions = {}) {
		this.#runner = new ClioReadCommandRunner({
			executable: options.executable,
			prefixArgs: options.prefixArgs,
			timeoutMs: options.timeoutMs ?? DEFAULT_USAGE_INSPECT_TIMEOUT_MS,
			maximumStdoutBytes: options.maximumStdoutBytes ?? MAX_USAGE_INSPECT_STDOUT_BYTES,
			maximumStderrBytes: options.maximumStderrBytes ?? MAX_USAGE_INSPECT_STDERR_BYTES,
		});
		this.#now = options.now ?? Date.now;
		this.#log = options.log ?? (() => undefined);
	}

	async inspect(trustedRoot: string): Promise<WireUsageInspection> {
		const root = resolve(trustedRoot);
		let rows: readonly unknown[];
		try {
			rows = await this.#runner.runJsonLines(
				root,
				["usage", "report", "--repo", root, "--days", "30", "--json"],
				MAX_USAGE_INSPECT_ROWS,
			);
		} catch (error) {
			if (!(error instanceof ClioReadCommandError)) throw error;
			if (error.code === "spawn") {
				throw new ClioUsageInspectError("not-ready", "The GUI could not start Clio's usage inspector.");
			}
			if (error.code === "timeout") {
				throw new ClioUsageInspectError("not-ready", "Clio's usage inspection did not finish in time.");
			}
			if (error.code === "exit") {
				const unsupported = /(?:unknown|unsupported).{0,32}(?:command|usage)|usage.{0,32}(?:unknown|unsupported)/iu
					.test(error.diagnostic);
				this.#log(`Clio usage inspector exited with code ${error.exitCode ?? "unknown"}.`);
				throw new ClioUsageInspectError(
					unsupported ? "unsupported" : "not-ready",
					unsupported
						? "This Clio version does not provide project usage inspection."
						: "Clio could not inspect usage for this project.",
				);
			}
			throw new ClioUsageInspectError("internal", "Clio returned an invalid or oversized project usage report.");
		}

		try {
			return projectUsageInspection(rows, new Date(this.#now()).toISOString());
		} catch (error) {
			if (!(error instanceof ClioUsageProjectionError)) throw error;
			this.#log("Clio usage projection rejected an incompatible experimental row.");
			throw new ClioUsageInspectError(
				"internal",
				"Clio's experimental usage schema is not compatible with this GUI build.",
			);
		}
	}
}
