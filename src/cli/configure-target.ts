/**
 * Everything `clio-coder configure` knows about building one target, with no
 * prompting in it.
 *
 * This was the middle of configure.ts. It moved out when the first-run wizard
 * became its own screen flow: both the wizard and the flag-driven path resolve
 * a URL, probe it, decide what the model list is, and write the same pointers,
 * and the alternative to a shared module was a circular import between the two
 * files that prompt.
 */
import chalk from "chalk";

import type { ClioSettings } from "../core/config.js";
import { openAuthStorage, resolveAuthTarget, targetRequiresAuth } from "../domains/providers/auth/index.js";
import { getCatalogModelForRuntime } from "../domains/providers/catalog.js";
import { credentialsPresent } from "../domains/providers/credentials.js";
import {
	isOrchestratorEligibleRuntime,
	listKnownModelsForRuntime,
	type ProviderSupportEntry,
	readTargetModelSnapshot,
	recordTargetModelSnapshot,
	resolveRuntimeAuthTarget,
} from "../domains/providers/index.js";
import { probeCapabilitiesForModel } from "../domains/providers/model-capabilities.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import type {
	ProbeContext,
	ProbeModelStatus,
	ProbeResult,
	RuntimeDescriptor,
} from "../domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../domains/providers/types/target-descriptor.js";
import type { ConfigureCategory } from "./configure-layout.js";
import { type LiveModelInventory, validateModelChoice } from "./validate-model.js";

const DEFAULT_PORTS: Record<string, number> = {
	llamacpp: 8080,
	"llamacpp-anthropic": 8080,
	"llamacpp-completion": 8080,
	"llamacpp-embed": 8080,
	"llamacpp-rerank": 8080,
	"lmstudio-native": 1234,
	lmstudio: 1234,
	"ollama-native": 11434,
	vllm: 8000,
	sglang: 30000,
	"lemonade-anthropic": 8000,
	lemonade: 8000,
	"anthropic-compat": 8000,
	"openai-compat": 8000,
	litellm: 4000,
};

function trimTrailing(url: string): string {
	return url.endsWith("/") && url.length > 1 ? url.slice(0, -1) : url;
}

export function normalizeUrl(input: string, runtimeId: string): string {
	const trimmed = input.trim();
	if (trimmed.length === 0) return defaultUrlFor(runtimeId);
	const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
	let withScheme = hasScheme ? trimmed : `http://${trimmed}`;
	if (runtimeId === "lmstudio") withScheme = withScheme.replace(/^ws:/u, "http:").replace(/^wss:/u, "https:");
	try {
		const parsed = new URL(withScheme);
		if (!hasScheme && !parsed.port && DEFAULT_PORTS[runtimeId]) {
			parsed.port = String(DEFAULT_PORTS[runtimeId]);
		}
		return trimTrailing(parsed.toString());
	} catch {
		return trimTrailing(withScheme);
	}
}

export function defaultUrlFor(runtimeId: string): string {
	const port = DEFAULT_PORTS[runtimeId];
	return port ? `http://127.0.0.1:${port}` : "http://127.0.0.1:8080";
}

export function deriveTargetId(runtimeId: string, existing: ReadonlyArray<TargetDescriptor>): string {
	const base = runtimeId;
	const taken = new Set(existing.map((e) => e.id));
	if (!taken.has(base)) return base;
	for (let i = 2; i < 1000; i++) {
		const candidate = `${base}-${i}`;
		if (!taken.has(candidate)) return candidate;
	}
	return `${base}-${Date.now()}`;
}

async function buildProbeContext(runtime?: RuntimeDescriptor, target?: TargetDescriptor): Promise<ProbeContext> {
	const probeCtx: ProbeContext = {
		credentialsPresent: credentialsPresent(),
		httpTimeoutMs: 5000,
	};
	if (!runtime || !target || !targetRequiresAuth(target, runtime)) return probeCtx;
	try {
		const resolution = await openAuthStorage().resolveForTarget(resolveAuthTarget(target, runtime), {
			includeFallback: false,
		});
		if (resolution.apiKey) probeCtx.authToken = resolution.apiKey;
	} catch {
		// Let the runtime's probe report its own missing-auth diagnostic.
	}
	return probeCtx;
}

function runtimeKnownModelsFor(runtimeId: string): ReadonlyArray<string> {
	return listKnownModelsForRuntime(runtimeId);
}

function catalogContextWindowFor(runtime: RuntimeDescriptor, modelId: string): number | null {
	const catalogModel = getCatalogModelForRuntime(runtime.id, modelId);
	if (typeof catalogModel?.contextWindow === "number" && catalogModel.contextWindow > 0) {
		return catalogModel.contextWindow;
	}
	if (runtimeKnownModelsFor(runtime.id).includes(modelId) && runtime.defaultCapabilities.contextWindow > 0) {
		return runtime.defaultCapabilities.contextWindow;
	}
	return null;
}

/**
 * Check the resolved model against the catalog where there is one and against
 * the target's own list where there is not. A runtime with no catalog used to
 * pass any string here while the same command had a live list that ruled it
 * out, so the target saved as `ok` and failed on its first
 * turn. Without a catalog or a live list there is nothing to check against, and
 * the note says so rather than implying the id was verified.
 */
export function validateResolvedModel(
	runtime: RuntimeDescriptor,
	target: Pick<TargetDescriptor, "id" | "url">,
	modelId: string | undefined,
	force: boolean,
	inventory: WireModelInventory,
): boolean {
	if (!modelId) return true;
	const knownModels = runtimeKnownModelsFor(runtime.id);
	const live = inventory.source === "probe" ? liveInventoryFor(target, inventory) : undefined;
	const validation = validateModelChoice({ runtimeId: runtime.id, modelId, knownModels, live, force });
	if (!validation.ok) {
		process.stderr.write(`error: ${validation.reason}\n`);
		return false;
	}
	if (validation.warning) process.stderr.write(`warning: ${validation.warning}\n`);
	if (knownModels.length === 0 && live === undefined && runtime.kind === "http") {
		process.stderr.write(
			`warning: could not verify model '${modelId}': ${target.url ?? `target '${target.id}'`} returned no model list; it is saved as written\n`,
		);
	}
	return true;
}

/** The same check without the stderr diagnostics, for a screen that owns its own rail. */
export function modelChoiceRefusal(
	runtime: RuntimeDescriptor,
	target: { id: string; url?: string | undefined },
	modelId: string,
	inventory: WireModelInventory,
): string | null {
	const live = inventory.source === "probe" ? liveInventoryFor(target, inventory) : undefined;
	const validation = validateModelChoice({
		runtimeId: runtime.id,
		modelId,
		knownModels: runtimeKnownModelsFor(runtime.id),
		live,
		force: false,
	});
	return validation.ok ? null : validation.reason;
}

export function validateContextWindowOverride(
	runtime: RuntimeDescriptor,
	modelId: string | undefined,
	contextWindow: number | undefined,
	force: boolean,
): boolean {
	if (contextWindow === undefined || !modelId) return true;
	const catalogMax = catalogContextWindowFor(runtime, modelId);
	if (catalogMax === null || contextWindow <= catalogMax) return true;
	const message = `--context-window ${contextWindow} exceeds catalog max ${catalogMax} for model '${modelId}'`;
	if (!force) {
		process.stderr.write(`error: ${message}. Use --force to override.\n`);
		return false;
	}
	process.stderr.write(`warning: ${message}\n`);
	return true;
}

export async function runtimeProbe(
	runtime: RuntimeDescriptor,
	target: TargetDescriptor,
	authToken?: string,
): Promise<ProbeResult | null> {
	if (typeof runtime.probe !== "function") return null;
	try {
		const context = await buildProbeContext(runtime, target);
		return await runtime.probe(target, authToken === undefined ? context : { ...context, authToken });
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

async function runtimeProbeModels(
	runtime: RuntimeDescriptor,
	target: TargetDescriptor,
	authToken?: string,
): Promise<string[]> {
	if (typeof runtime.probeModels !== "function") return [];
	try {
		const context = await buildProbeContext(runtime, target);
		return await runtime.probeModels(target, authToken === undefined ? context : { ...context, authToken });
	} catch {
		return [];
	}
}

export function applyTarget(settings: ClioSettings, descriptor: TargetDescriptor): void {
	const idx = settings.targets.findIndex((e) => e.id === descriptor.id);
	if (idx >= 0) settings.targets[idx] = descriptor;
	else settings.targets.push(descriptor);
}

export function setOrchestratorPointer(
	settings: ClioSettings,
	descriptor: TargetDescriptor,
	model?: string | null,
): void {
	const runtime = getRuntimeRegistry().get(descriptor.runtime);
	if (!runtime) {
		throw new Error(
			`cannot use target '${descriptor.id}' as orchestrator target because runtime '${descriptor.runtime}' is not registered`,
		);
	}
	if (!isOrchestratorEligibleRuntime(runtime)) {
		throw new Error(
			`cannot use target '${descriptor.id}' as orchestrator target because runtime '${runtime.id}' is not an HTTP/native runtime`,
		);
	}
	settings.chat.target = descriptor.id;
	settings.chat.model = model ?? descriptor.defaultModel ?? null;
}

export function setWorkerDefaultPointer(
	settings: ClioSettings,
	descriptor: TargetDescriptor,
	model?: string | null,
): void {
	settings.fleet.default.target = descriptor.id;
	settings.fleet.default.model = model ?? descriptor.defaultModel ?? null;
}

export function setBackgroundPointer(
	settings: ClioSettings,
	descriptor: TargetDescriptor,
	model?: string | null,
): void {
	const runtime = getRuntimeRegistry().get(descriptor.runtime);
	if (!runtime || !isOrchestratorEligibleRuntime(runtime)) {
		throw new Error(
			`cannot use target '${descriptor.id}' as background target because runtime '${descriptor.runtime}' is not an HTTP/native runtime`,
		);
	}
	settings.context.memory.target = descriptor.id;
	settings.context.memory.model = model ?? descriptor.defaultModel ?? null;
}

export function assertOrchestratorReplacementEligible(settings: ClioSettings, descriptor: TargetDescriptor): void {
	if (settings.chat.target !== descriptor.id && settings.context.memory.target !== descriptor.id) return;
	const role = settings.chat.target === descriptor.id ? "orchestrator" : "background";
	const runtime = getRuntimeRegistry().get(descriptor.runtime);
	if (!runtime) {
		throw new Error(
			`cannot update ${role} target '${descriptor.id}' because runtime '${descriptor.runtime}' is not registered`,
		);
	}
	if (!isOrchestratorEligibleRuntime(runtime)) {
		throw new Error(`cannot update ${role} target '${descriptor.id}' to non-HTTP/native runtime '${runtime.id}'`);
	}
}

export function setWorkerProfilePointer(
	settings: ClioSettings,
	name: string,
	descriptor: TargetDescriptor,
	model?: string | null,
): void {
	const trimmed = name.trim();
	if (trimmed.length === 0) throw new Error("fleet profile name must be non-empty");
	settings.fleet.profiles[trimmed] = {
		target: descriptor.id,
		model: model ?? descriptor.defaultModel ?? null,
		thinkingLevel: "off",
	};
}

/**
 * Whether a target that was probed successfully still has no context window to
 * work from, in which case it will run against the runtime descriptor's
 * placeholder. Callers say so at the moment the target is written, because the
 * alternative is a plausible-looking number the operator never chose and the
 * server never claimed.
 */
export function contextWindowUndiscovered(descriptor: TargetDescriptor, probe: ProbeResult | null): boolean {
	if (!probe?.ok) return false;
	if (typeof descriptor.capabilities?.contextWindow === "number" && descriptor.capabilities.contextWindow > 0) {
		return false;
	}
	const discovered = probeCapabilitiesForModel(
		{
			target: descriptor,
			probeCapabilities: probe.discoveredCapabilities ?? null,
			probeModelCapabilities: probe.modelCapabilities ?? null,
			probeModelId: probe.capabilityModelId ?? null,
		},
		descriptor.defaultModel,
	);
	return !(typeof discovered?.contextWindow === "number" && discovered.contextWindow > 0);
}

export function warnUndiscoveredContextWindow(descriptor: TargetDescriptor, probe: ProbeResult | null): void {
	if (!contextWindowUndiscovered(descriptor, probe)) return;
	process.stdout.write(
		"  warning: the target reported no context window; Clio will use the runtime default as a guess. Set one with --context-window.\n",
	);
}

/** Whether the chosen model is one Clio will send a thinking level to. */
export function modelSupportsThinking(
	runtime: RuntimeDescriptor,
	descriptor: TargetDescriptor,
	probe: ProbeResult | null,
): boolean {
	const discovered = probe
		? probeCapabilitiesForModel(
				{
					target: descriptor,
					probeCapabilities: probe.discoveredCapabilities ?? null,
					probeModelCapabilities: probe.modelCapabilities ?? null,
					probeModelId: probe.capabilityModelId ?? null,
				},
				descriptor.defaultModel,
			)
		: null;
	if (typeof discovered?.reasoning === "boolean") return discovered.reasoning;
	if (typeof descriptor.capabilities?.reasoning === "boolean") return descriptor.capabilities.reasoning;
	return runtime.defaultCapabilities.reasoning === true;
}

/**
 * What the probe read, as opposed to whether it connected.
 *
 * A health check can pass while every enrichment read behind it returns
 * nothing, and reporting that as `probe ok` makes it indistinguishable from a
 * full read. That is how a target gets blessed at configure time and then
 * fails on the first turn. Naming the gap is the difference between a user who
 * knows to look now and one who finds out from a raw 404 later.
 */
export function probeReadings(probe: ProbeResult): string[] {
	const readings: string[] = [];
	if (probe.models && probe.models.length > 0) readings.push(`${probe.models.length} models`);
	if (probe.serverVersion) readings.push(probe.serverVersion);
	if (probe.discoveredCapabilities && Object.keys(probe.discoveredCapabilities).length > 0) {
		readings.push("capabilities");
	}
	return readings;
}

/** The probe result as the lines a user reads, cause and next step included. */
export function probeLines(descriptor: TargetDescriptor, probe: ProbeResult): string[] {
	const latency = probe.latencyMs !== undefined ? ` (${probe.latencyMs}ms)` : "";
	if (!probe.ok) {
		const where = descriptor.url ? ` ${descriptor.url}` : "";
		return [
			`probe failed${latency}:${where} ${probe.error ?? "unknown"}`,
			`  check the server is running and reachable, then re-run: clio-coder configure --id ${descriptor.id} --url <url>`,
		];
	}
	const readings = probeReadings(probe);
	if (readings.length > 0) return [`probe ok${latency} ${readings.join(", ")}`];
	return [
		`probe reachable${latency}, but the target answered no model list and no version`,
		"  Clio cannot verify the model id or the context window from here and will send both as written.",
		"  re-read them once the server serves them with: clio-coder targets --probe",
	];
}

export interface DescriptorParts {
	url?: string;
	model?: string;
	apiKeyEnv?: string;
	apiKeyRef?: string;
	oauthProfile?: string;
	gateway?: boolean;
	lifecycle?: TargetDescriptor["lifecycle"];
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	lmstudio?: TargetDescriptor["lmstudio"];
}

export function buildDescriptor(runtime: RuntimeDescriptor, id: string, parts: DescriptorParts): TargetDescriptor {
	const descriptor: TargetDescriptor = { id, runtime: runtime.id };
	if (parts.url) descriptor.url = parts.url;
	if (parts.model) descriptor.defaultModel = parts.model;
	const auth: NonNullable<TargetDescriptor["auth"]> = {};
	if (parts.apiKeyEnv) auth.apiKeyEnvVar = parts.apiKeyEnv;
	if (parts.apiKeyRef) auth.apiKeyRef = parts.apiKeyRef;
	if (parts.oauthProfile) auth.oauthProfile = parts.oauthProfile;
	if (Object.keys(auth).length > 0) descriptor.auth = auth;
	if (parts.gateway) descriptor.gateway = true;
	if (parts.lifecycle) descriptor.lifecycle = parts.lifecycle;
	const caps: NonNullable<TargetDescriptor["capabilities"]> = {};
	if (parts.contextWindow !== undefined) caps.contextWindow = parts.contextWindow;
	if (parts.maxTokens !== undefined) caps.maxTokens = parts.maxTokens;
	if (parts.reasoning !== undefined) caps.reasoning = parts.reasoning;
	if (Object.keys(caps).length > 0) descriptor.capabilities = caps;
	if (parts.lmstudio) descriptor.lmstudio = parts.lmstudio;
	return descriptor;
}

export function describeAuthStatus(runtime: RuntimeDescriptor): string {
	const status = openAuthStorage().statusForTarget(resolveRuntimeAuthTarget(runtime), { includeFallback: false });
	// This describes a credential, not a network state. It is printed before the
	// wizard has asked for a URL, so `not connected` read as a connection that
	// had already been tried and failed.
	if (!status.available) return "none stored";
	if (status.source === "environment") return `environment${status.detail ? ` (${status.detail})` : ""}`;
	if (status.source === "stored-api-key") return "stored api key";
	if (status.source === "stored-oauth") return "stored oauth";
	return status.source;
}

/**
 * The model ids a target can be configured with, and where they came from.
 * `probe` is the only source that says anything about the server in front of
 * us right now; `catalog` is static provider knowledge, and `existing` is the
 * list a previous configure recorded, which the server may no longer match.
 */
export interface WireModelInventory {
	models: string[];
	source: "catalog" | "probe" | "cache" | "legacy" | "none";
	/** Per-model load state when the probe reported it. */
	modelStates?: Readonly<Record<string, ProbeModelStatus>> | undefined;
}

/**
 * Every id the runtime would resolve. LM Studio lists a loaded model under its
 * instance id and keeps the model key only in the state map, and the request
 * path accepts either, so both count as advertised.
 */
function advertisedModelIds(inventory: Pick<WireModelInventory, "models" | "modelStates">): string[] {
	const ids = [...inventory.models];
	for (const id of Object.keys(inventory.modelStates ?? {})) if (!ids.includes(id)) ids.push(id);
	return ids;
}

function residentModelIds(modelStates: WireModelInventory["modelStates"]): string[] {
	return Object.entries(modelStates ?? {})
		.filter(([, status]) => status.state === "loaded" || status.state === "loading")
		.map(([id]) => id);
}

function liveInventoryFor(
	target: { id: string; url?: string | undefined },
	inventory: WireModelInventory,
): LiveModelInventory {
	return {
		targetId: target.id,
		url: target.url,
		models: advertisedModelIds(inventory),
		resident: residentModelIds(inventory.modelStates),
	};
}

export async function resolveSupportedWireModels(
	runtime: RuntimeDescriptor,
	target: TargetDescriptor,
	existing?: TargetDescriptor,
	authToken?: string,
): Promise<WireModelInventory> {
	const known = listKnownModelsForRuntime(runtime.id);
	if (known.length > 0) return { models: known, source: "catalog" };
	if (runtime.kind === "http") {
		// The full probe carries load state alongside the ids; a runtime that
		// lists models only through probeModels still gets its ids checked.
		const probe = await runtimeProbe(runtime, target, authToken);
		if (probe?.ok && probe.models && probe.models.length > 0) {
			recordTargetModelSnapshot(target, probe.models);
			return { models: [...probe.models], source: "probe", modelStates: probe.modelStates };
		}
		const discovered = await runtimeProbeModels(runtime, target, authToken);
		if (discovered.length > 0) {
			recordTargetModelSnapshot(target, discovered);
			return { models: discovered, source: "probe" };
		}
	}
	const cached = readTargetModelSnapshot(target);
	if (cached && cached.models.length > 0) return { models: [...cached.models], source: "cache" };
	if (existing?.wireModels && existing.wireModels.length > 0) {
		recordTargetModelSnapshot(target, existing.wireModels);
		return { models: [...existing.wireModels], source: "legacy" };
	}
	return { models: [], source: "none" };
}

/** Why a target offered no model list, in the words the screen shows. */
export function inventoryGap(runtime: RuntimeDescriptor, target: { url?: string | undefined }): string {
	if (runtime.kind !== "http") return `${runtime.id} does not list its models; type the id the provider documents`;
	return `${target.url ?? runtime.id} answered no model list; type the id the server serves`;
}

const LOCAL_APP_RUNTIME_IDS: ReadonlySet<string> = new Set(["ollama-native", "lmstudio"]);

// Generic protocol-compatible runtimes. They are classified local-http (they
// carry a probe and no cloud catalog entry), but a hosted endpoint such as
// Inception/Mercury is exactly an OpenAI-compatible cloud API, so the wizard
// also surfaces them under the Cloud API path.
export const PROTOCOL_COMPAT_RUNTIME_IDS: ReadonlySet<string> = new Set(["openai-compat", "anthropic-compat"]);

export function runtimesForCategory(
	entries: ReadonlyArray<ProviderSupportEntry>,
	category: ConfigureCategory,
): ProviderSupportEntry[] {
	switch (category) {
		case "local-app":
			return entries.filter((entry) => LOCAL_APP_RUNTIME_IDS.has(entry.runtimeId));
		case "local-http":
			return entries.filter((entry) => entry.group === "local-http" && !LOCAL_APP_RUNTIME_IDS.has(entry.runtimeId));
		case "chatgpt":
			return entries.filter((entry) => entry.runtimeId === "openai-codex");
		case "cloud-api": {
			const byLabel = (a: ProviderSupportEntry, b: ProviderSupportEntry) =>
				a.label.localeCompare(b.label) || a.runtimeId.localeCompare(b.runtimeId);
			const named = entries
				.filter((entry) => entry.group === "cloud-api")
				.slice()
				.sort(byLabel);
			// Surface the generic OpenAI/Anthropic-compatible runtimes here too,
			// shown last and under the cloud heading rather than their native group.
			const compat = entries
				.filter((entry) => PROTOCOL_COMPAT_RUNTIME_IDS.has(entry.runtimeId))
				.map((entry) => ({ ...entry, group: "cloud-api" as const }))
				.sort(byLabel);
			return [...named, ...compat];
		}
		case "all":
			return entries.slice();
	}
}

/** The rail prefix the interactive prompts draw on, matching the presenter's. */
export function railPrefix(plain: boolean): string {
	return plain ? "  " : `${chalk.cyan("│")}  `;
}
