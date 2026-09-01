import { spawnSync } from "node:child_process";
import { readSettings } from "../../core/config.js";
import { readClioVersion, resolvePackageRoot } from "../../core/package-root.js";
import type { RunReceipt } from "../dispatch/types.js";
import type { EvalServingConfigurationV1 } from "./schema/serving.js";
import type { EvalSuiteTargetV2 } from "./schema/suite.js";
import type { EvalClioProvenance, EvalEnvironmentProvenance } from "./types.js";

export interface EvalProvenanceOptions {
	entry?: string;
	commit?: string | null;
}

export interface EvalServingObservation {
	targetId: string;
	runtimeId: string | null;
	modelId: string | null;
	thinkingLevel: string | null;
	compiledPromptHash: string | null;
}

export function evalClioProvenance(options: EvalProvenanceOptions = {}): EvalClioProvenance {
	return {
		version: readClioVersion(),
		commit: options.commit === undefined ? currentClioCommit() : options.commit,
		entry: options.entry ?? process.argv[1] ?? "unknown",
	};
}

export function evalEnvironmentProvenance(): EvalEnvironmentProvenance {
	return {
		platform: `${process.platform}-${process.arch}`,
		node: process.version,
	};
}

/** Capture serving identity after the matrix has run while a local server is awake. */
export async function evalServingConfiguration(
	targets: ReadonlyArray<EvalSuiteTargetV2>,
	observations: ReadonlyArray<EvalServingObservation>,
): Promise<EvalServingConfigurationV1> {
	const targetId = targets.length === 1 ? (targets[0]?.id ?? "unknown") : "multiple";
	const configured = configuredTarget(targetId);
	const target = targets.length === 1 ? targets[0] : undefined;
	const runtimeId = consensus(observations.map((entry) => entry.runtimeId)) ?? configured?.runtime ?? null;
	const modelId =
		consensus(observations.map((entry) => entry.modelId)) ?? target?.model ?? configured?.defaultModel ?? null;
	const props = configured?.url === undefined ? null : await readServingProps(configured.url, modelId);
	return {
		targetId,
		runtimeId,
		modelId,
		serverBuild: props?.serverBuild ?? null,
		total_slots: props?.totalSlots ?? null,
		thinkingLevel: consensus(observations.map((entry) => entry.thinkingLevel)) ?? target?.thinking ?? null,
		compiledPromptHash: consensus(observations.map((entry) => entry.compiledPromptHash)),
	};
}

export function evalServingObservationFrom(
	target: EvalSuiteTargetV2,
	receipt: RunReceipt | null,
	compiledPromptHashes: ReadonlyArray<string>,
): EvalServingObservation {
	const compiledPromptHash =
		receipt?.staticCompositionHash ?? receipt?.compiledPromptHash ?? consensus(compiledPromptHashes);
	return {
		targetId: receipt?.targetId ?? target.id,
		runtimeId: receipt?.runtimeId ?? null,
		modelId: receipt?.wireModelId ?? target.model ?? null,
		thinkingLevel: receipt?.runtimeResolution?.effectiveThinkingLevel ?? target.thinking ?? null,
		compiledPromptHash,
	};
}

function currentClioCommit(): string | null {
	const result = spawnSync("git", ["rev-parse", "HEAD"], {
		cwd: resolvePackageRoot(),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 1000,
	});
	if (result.status !== 0 || typeof result.stdout !== "string") return null;
	const value = result.stdout.trim();
	return value.length > 0 ? value : null;
}

interface ConfiguredServingTarget {
	runtime: string;
	url?: string;
	defaultModel?: string;
}

function configuredTarget(targetId: string): ConfiguredServingTarget | null {
	try {
		const target = readSettings().targets.find((entry) => entry.id === targetId);
		if (target === undefined) return null;
		return {
			runtime: target.runtime,
			...(target.url === undefined ? {} : { url: target.url }),
			...(target.defaultModel === undefined ? {} : { defaultModel: target.defaultModel }),
		};
	} catch {
		return null;
	}
}

async function readServingProps(
	targetUrl: string,
	modelId: string | null,
): Promise<{ serverBuild: string | null; totalSlots: number | null } | null> {
	const root = targetUrl.replace(/\/+$/u, "").replace(/\/v1$/u, "");
	try {
		const response = await fetch(`${root}/props`, { signal: AbortSignal.timeout(5_000) });
		if (!response.ok) return null;
		const value: unknown = await response.json();
		if (!isRecord(value)) return null;
		const totalSlots = positiveInteger(value.total_slots) ?? (await readServingSlots(root, modelId));
		return {
			serverBuild: typeof value.build_info === "string" && value.build_info.length > 0 ? value.build_info : null,
			totalSlots,
		};
	} catch {
		return null;
	}
}

async function readServingSlots(root: string, modelId: string | null): Promise<number | null> {
	if (modelId === null) return null;
	try {
		const query = new URLSearchParams({ model: modelId });
		const response = await fetch(`${root}/slots?${query}`, { signal: AbortSignal.timeout(5_000) });
		if (!response.ok) return null;
		const value: unknown = await response.json();
		return Array.isArray(value) && value.length > 0 ? value.length : null;
	} catch {
		return null;
	}
}

function consensus(values: ReadonlyArray<string | null>): string | null {
	const known = [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
	return known.length === 1 ? (known[0] ?? null) : null;
}

function positiveInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
