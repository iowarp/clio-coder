import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import {
	type ClioSettings,
	readSettings,
	removeTargetFromSettings,
	settingsPath,
	updateSettings,
} from "../core/config.js";
import { initializeClioHome } from "../core/init.js";
import { openAuthStorage, resolveAuthTarget, targetRequiresAuth } from "../domains/providers/auth/index.js";
import { getCatalogModelForRuntime } from "../domains/providers/catalog.js";
import { credentialsPresent } from "../domains/providers/credentials.js";
import {
	buildProviderSupportEntry,
	configuredTargetsForRuntime,
	describeRuntimeModels,
	isOrchestratorEligibleRuntime,
	listKnownModelsForRuntime,
	listProviderSupportEntries,
	type ProviderSupportEntry,
	resolveRuntimeAuthTarget,
	supportGroupLabel,
} from "../domains/providers/index.js";
import { probeCapabilitiesForModel } from "../domains/providers/model-capabilities.js";
import { fingerprintNativeRuntime } from "../domains/providers/probe/fingerprint.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../domains/providers/runtimes/builtins.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../domains/providers/types/target-descriptor.js";
import { registerClioOAuthProviders } from "../engine/oauth.js";
import {
	type ConfigureCategory,
	formatCategoryMenu,
	formatRuntimeList,
	formatRuntimeMenu,
	matchCategoryChoice,
	type RuntimeListRow,
} from "./configure-layout.js";
import { createDelayedManualCodeInput } from "./oauth-manual-input.js";
import { promptOAuthSelection } from "./oauth-select.js";
import { credentialWriteFailed, printError, printOk, printPlaintextCredentialWarning } from "./shared.js";
import { terminalColumns, wrapPlain } from "./text-layout.js";
import { validateModelChoice } from "./validate-model.js";

const HELP = `clio-coder configure

Configure model targets for chat and fleet-agent dispatch.

Usage:
  clio-coder configure                   interactive wizard
  clio-coder configure --list            list target runtimes (user-facing only)
  clio-coder configure --list --all      list every registered runtime including aliases
  clio-coder configure --id <targetId> [flags] --runtime <runtimeId>

Non-interactive flags:
  --id <targetId>                  target id to register (required when non-interactive)
  --runtime <runtimeId>            runtime to use when registering non-interactively
  --url <host>                     target base URL (http(s):// or ws://)
  --model <wireModelId>            default model id for this target
  --orchestrator-model <id>        model to use when setting chat default
  --background-model <id>          model to use for proactive task memory
  --fleet-model <id>               model to use when setting fleet default
                                   (mutually exclusive with --agent-profile)
  --agent-profile <name>           save this target as a named fleet profile
  --agent-profile-model <id>       model to use for --agent-profile
  --api-key-env <VAR>              read API key from this env var at call time
  --api-key <literal>              store API key in credentials.yaml
  --force                          allow a model outside the runtime catalog
  --gateway                        mark the target as a gateway
  --lifecycle <user-managed|clio-managed>
                                  resident model lifecycle policy
  --set-orchestrator               use this target for chat
  --set-background                 use this target for proactive task memory
  --set-fleet-default              use this target for the fleet default
  --context-window <N>             capability override
  --max-tokens <N>                 output token capability override
  --reasoning <true|false>         capability override
`;

const DEFAULT_PORTS: Record<string, number> = {
	llamacpp: 8080,
	"llamacpp-anthropic": 8080,
	"llamacpp-completion": 8080,
	"llamacpp-embed": 8080,
	"llamacpp-rerank": 8080,
	"lmstudio-native": 1234,
	"ollama-native": 11434,
	vllm: 8000,
	sglang: 30000,
	"lemonade-anthropic": 8000,
	lemonade: 8000,
	"anthropic-compat": 8000,
	"openai-compat": 8000,
};

interface ParsedArgs {
	positional: string[];
	help: boolean;
	list: boolean;
	all: boolean;
	remove?: string;
	renameOld?: string;
	renameNew?: string;
	id?: string;
	runtime?: string;
	url?: string;
	model?: string;
	orchestratorModel?: string;
	backgroundModel?: string;
	workerModel?: string;
	workerProfile?: string;
	workerProfileModel?: string;
	apiKeyEnv?: string;
	apiKey?: string;
	force: boolean;
	gateway: boolean;
	lifecycle?: TargetDescriptor["lifecycle"];
	setOrchestrator: boolean;
	setBackground: boolean;
	setWorkerDefault: boolean;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
}

function parseSetupArgs(argv: ReadonlyArray<string>): ParsedArgs {
	const out: ParsedArgs = {
		positional: [],
		help: false,
		list: false,
		all: false,
		force: false,
		gateway: false,
		setOrchestrator: false,
		setBackground: false,
		setWorkerDefault: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] as string;
		const need = (): string => {
			const v = argv[i + 1];
			if (v === undefined) throw new Error(`${a} requires a value`);
			i += 1;
			return v;
		};
		switch (a) {
			case "--help":
			case "-h":
				out.help = true;
				break;
			case "--list":
				out.list = true;
				break;
			case "--all":
				out.all = true;
				break;
			case "--remove":
				out.remove = need();
				break;
			case "--rename":
				out.renameOld = need();
				out.renameNew = need();
				break;
			case "--id":
				out.id = need();
				break;
			case "--runtime":
				out.runtime = need();
				break;
			case "--url":
				out.url = need();
				break;
			case "--model":
				out.model = need();
				break;
			case "--orchestrator-model":
				out.orchestratorModel = need();
				break;
			case "--background-model":
				out.backgroundModel = need();
				break;
			case "--fleet-model":
			case "--worker-model":
				out.workerModel = need();
				break;
			case "--agent-profile":
			case "--worker-profile":
				out.workerProfile = need();
				break;
			case "--agent-profile-model":
			case "--worker-profile-model":
				out.workerProfileModel = need();
				break;
			case "--api-key-env":
				out.apiKeyEnv = need();
				break;
			case "--api-key":
				out.apiKey = need();
				break;
			case "--force":
				out.force = true;
				break;
			case "--gateway":
				out.gateway = true;
				break;
			case "--lifecycle": {
				const v = need();
				if (v !== "user-managed" && v !== "clio-managed") {
					throw new Error("--lifecycle must be user-managed or clio-managed");
				}
				out.lifecycle = v;
				break;
			}
			case "--set-orchestrator":
				out.setOrchestrator = true;
				break;
			case "--set-background":
				out.setBackground = true;
				break;
			case "--set-fleet-default":
			case "--set-worker-default":
				out.setWorkerDefault = true;
				break;
			case "--context-window": {
				const n = Number(need());
				if (!Number.isFinite(n) || n <= 0) throw new Error("--context-window must be a positive number");
				out.contextWindow = Math.floor(n);
				break;
			}
			case "--max-tokens": {
				const n = Number(need());
				if (!Number.isFinite(n) || n <= 0) throw new Error("--max-tokens must be a positive number");
				out.maxTokens = Math.floor(n);
				break;
			}
			case "--reasoning": {
				const v = need().toLowerCase();
				if (v !== "true" && v !== "false") throw new Error("--reasoning must be true or false");
				out.reasoning = v === "true";
				break;
			}
			default:
				if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
				out.positional.push(a);
		}
	}
	return out;
}

function ensureRegistryPopulated(): void {
	registerClioOAuthProviders();
	const registry = getRuntimeRegistry();
	if (registry.list().length === 0) registerBuiltinRuntimes(registry);
}

function trimTrailing(url: string): string {
	return url.endsWith("/") && url.length > 1 ? url.slice(0, -1) : url;
}

function normalizeUrl(input: string, runtimeId: string): string {
	const trimmed = input.trim();
	if (trimmed.length === 0) return defaultUrlFor(runtimeId);
	const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
	const withScheme = hasScheme ? trimmed : `http://${trimmed}`;
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

function defaultUrlFor(runtimeId: string): string {
	const port = DEFAULT_PORTS[runtimeId];
	return port ? `http://127.0.0.1:${port}` : "http://127.0.0.1:8080";
}

const RUNTIME_LIST_CAPTION =
	"every registered runtime. run `clio-coder auth list` for the ones clio authenticates itself; the rest authenticate through their own tool (claude-cli, aws-sdk) or need no credential.";

function printRuntimeList(includeHidden: boolean): void {
	const settings = readSettings();
	const auth = openAuthStorage();
	const rows: RuntimeListRow[] = [];
	for (const entry of listProviderSupportEntries(getRuntimeRegistry().list(), { includeHidden })) {
		const runtime = getRuntimeRegistry().get(entry.runtimeId);
		const status =
			runtime && entry.connectable
				? auth.statusForTarget(resolveRuntimeAuthTarget(runtime), { includeFallback: false })
				: null;
		const authLabel =
			runtime?.auth === "oauth"
				? status?.available
					? "connected"
					: "login"
				: runtime?.auth === "api-key"
					? status?.available
						? "credential"
						: "needs-key"
					: (runtime?.auth ?? "none");
		rows.push({
			group: supportGroupLabel(entry.group),
			runtimeId: entry.runtimeId,
			label: entry.label,
			auth: authLabel,
			targets: configuredTargetsForRuntime(settings, entry.runtimeId).length,
			models: describeRuntimeModels(entry, 2),
		});
	}
	const width = terminalColumns();
	for (const line of formatRuntimeList(rows, width)) {
		process.stdout.write(`${line}\n`);
	}
	// The other half of the pair `clio-coder auth list` names. This table is every
	// registered runtime; that one is the subset Clio holds a credential for,
	// and a user who found a name here and could not find it there was reading
	// two screens that each claimed to be the list of what you can connect.
	for (const line of wrapPlain(RUNTIME_LIST_CAPTION, width)) {
		process.stdout.write(`${line}\n`);
	}
}

function deriveTargetId(runtimeId: string, existing: ReadonlyArray<TargetDescriptor>): string {
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

function validateResolvedModel(runtimeId: string, modelId: string | undefined, force: boolean): boolean {
	if (!modelId) return true;
	const validation = validateModelChoice({
		runtimeId,
		modelId,
		knownModels: runtimeKnownModelsFor(runtimeId),
		force,
	});
	if (!validation.ok) {
		process.stderr.write(`error: ${validation.reason}\n`);
		return false;
	}
	if (validation.warning) process.stderr.write(`warning: ${validation.warning}\n`);
	return true;
}

function validateContextWindowOverride(
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

async function runtimeProbe(runtime: RuntimeDescriptor, target: TargetDescriptor): Promise<ProbeResult | null> {
	if (typeof runtime.probe !== "function") return null;
	try {
		return await runtime.probe(target, await buildProbeContext(runtime, target));
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

async function runtimeProbeModels(runtime: RuntimeDescriptor, target: TargetDescriptor): Promise<string[]> {
	if (typeof runtime.probeModels !== "function") return [];
	try {
		return await runtime.probeModels(target, await buildProbeContext(runtime, target));
	} catch {
		return [];
	}
}

function applyTarget(settings: ClioSettings, descriptor: TargetDescriptor): void {
	const idx = settings.targets.findIndex((e) => e.id === descriptor.id);
	if (idx >= 0) settings.targets[idx] = descriptor;
	else settings.targets.push(descriptor);
}

function setOrchestratorPointer(settings: ClioSettings, descriptor: TargetDescriptor, model?: string | null): void {
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
	settings.orchestrator.target = descriptor.id;
	settings.orchestrator.model = model ?? descriptor.defaultModel ?? null;
}

function setWorkerDefaultPointer(settings: ClioSettings, descriptor: TargetDescriptor, model?: string | null): void {
	settings.workers.default.target = descriptor.id;
	settings.workers.default.model = model ?? descriptor.defaultModel ?? null;
}

function setBackgroundPointer(settings: ClioSettings, descriptor: TargetDescriptor, model?: string | null): void {
	const runtime = getRuntimeRegistry().get(descriptor.runtime);
	if (!runtime || !isOrchestratorEligibleRuntime(runtime)) {
		throw new Error(
			`cannot use target '${descriptor.id}' as background target because runtime '${descriptor.runtime}' is not an HTTP/native runtime`,
		);
	}
	settings.background.target = descriptor.id;
	settings.background.model = model ?? descriptor.defaultModel ?? null;
}

function assertOrchestratorReplacementEligible(settings: ClioSettings, descriptor: TargetDescriptor): void {
	if (settings.orchestrator.target !== descriptor.id && settings.background.target !== descriptor.id) return;
	const role = settings.orchestrator.target === descriptor.id ? "orchestrator" : "background";
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

function setWorkerProfilePointer(
	settings: ClioSettings,
	name: string,
	descriptor: TargetDescriptor,
	model?: string | null,
): void {
	const trimmed = name.trim();
	if (trimmed.length === 0) throw new Error("fleet profile name must be non-empty");
	settings.workers.profiles[trimmed] = {
		target: descriptor.id,
		model: model ?? descriptor.defaultModel ?? null,
		thinkingLevel: "off",
	};
}

/**
 * A target that was probed successfully and still reported no context window
 * will run against the runtime descriptor's placeholder. Say so at the moment
 * the target is written, because the alternative is a plausible-looking number
 * the operator never chose and the server never claimed.
 */
function warnUndiscoveredContextWindow(descriptor: TargetDescriptor, probe: ProbeResult | null): void {
	if (!probe?.ok) return;
	if (typeof descriptor.capabilities?.contextWindow === "number" && descriptor.capabilities.contextWindow > 0) return;
	const discovered = probeCapabilitiesForModel(
		{
			target: descriptor,
			probeCapabilities: probe.discoveredCapabilities ?? null,
			probeModelCapabilities: probe.modelCapabilities ?? null,
			probeModelId: probe.capabilityModelId ?? null,
		},
		descriptor.defaultModel,
	);
	if (typeof discovered?.contextWindow === "number" && discovered.contextWindow > 0) return;
	process.stdout.write(
		"  warning: the target reported no context window; Clio will use the runtime default as a guess. Set one with --context-window.\n",
	);
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
function probeReadings(probe: ProbeResult): string[] {
	const readings: string[] = [];
	if (probe.models && probe.models.length > 0) readings.push(`${probe.models.length} models`);
	if (probe.serverVersion) readings.push(probe.serverVersion);
	if (probe.discoveredCapabilities && Object.keys(probe.discoveredCapabilities).length > 0) {
		readings.push("capabilities");
	}
	return readings;
}

/** The probe result as the lines a user reads, cause and next step included. */
function probeLines(descriptor: TargetDescriptor, probe: ProbeResult): string[] {
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

function printSummary(settings: ClioSettings, descriptor: TargetDescriptor, probe: ProbeResult | null): void {
	process.stdout.write(`\nsaved target ${descriptor.id} (runtime=${descriptor.runtime})\n`);
	if (descriptor.url) process.stdout.write(`  url        ${descriptor.url}\n`);
	if (descriptor.defaultModel) process.stdout.write(`  model      ${descriptor.defaultModel}\n`);
	if (descriptor.auth?.apiKeyEnvVar) process.stdout.write(`  apiKeyEnv  ${descriptor.auth.apiKeyEnvVar}\n`);
	if (descriptor.gateway) process.stdout.write("  gateway    true\n");
	if (descriptor.lifecycle) process.stdout.write(`  lifecycle  ${descriptor.lifecycle}\n`);
	if (probe) {
		for (const line of probeLines(descriptor, probe)) process.stdout.write(`  ${line}\n`);
	}
	warnUndiscoveredContextWindow(descriptor, probe);
	if (settings.orchestrator.target === descriptor.id) process.stdout.write("  orchestrator target\n");
	if (settings.background.target === descriptor.id) process.stdout.write("  background memory target\n");
	if (settings.workers.default.target === descriptor.id) process.stdout.write("  fleet default\n");
	for (const [name, profile] of Object.entries(settings.workers.profiles)) {
		if (profile.target === descriptor.id) process.stdout.write(`  fleet profile ${name}\n`);
	}
	process.stdout.write(`\nsettings written to ${settingsPath()}\n`);
}

function buildDescriptor(
	runtime: RuntimeDescriptor,
	id: string,
	parts: {
		url?: string;
		model?: string;
		wireModels?: string[];
		apiKeyEnv?: string;
		apiKeyRef?: string;
		oauthProfile?: string;
		gateway?: boolean;
		lifecycle?: TargetDescriptor["lifecycle"];
		contextWindow?: number;
		maxTokens?: number;
		reasoning?: boolean;
	},
): TargetDescriptor {
	const descriptor: TargetDescriptor = { id, runtime: runtime.id };
	if (parts.url) descriptor.url = parts.url;
	const wireModels =
		parts.wireModels?.filter((value, index, all) => value.trim().length > 0 && all.indexOf(value) === index) ?? [];
	if (parts.model) descriptor.defaultModel = parts.model;
	else {
		const firstWireModel = wireModels[0];
		if (firstWireModel) descriptor.defaultModel = firstWireModel;
	}
	const auth: NonNullable<TargetDescriptor["auth"]> = {};
	if (parts.apiKeyEnv) auth.apiKeyEnvVar = parts.apiKeyEnv;
	if (parts.apiKeyRef) auth.apiKeyRef = parts.apiKeyRef;
	if (parts.oauthProfile) auth.oauthProfile = parts.oauthProfile;
	if (Object.keys(auth).length > 0) descriptor.auth = auth;
	if (wireModels.length > 0) descriptor.wireModels = wireModels;
	if (parts.gateway) descriptor.gateway = true;
	if (parts.lifecycle) descriptor.lifecycle = parts.lifecycle;
	const caps: NonNullable<TargetDescriptor["capabilities"]> = {};
	if (parts.contextWindow !== undefined) caps.contextWindow = parts.contextWindow;
	if (parts.maxTokens !== undefined) caps.maxTokens = parts.maxTokens;
	if (parts.reasoning !== undefined) caps.reasoning = parts.reasoning;
	if (Object.keys(caps).length > 0) descriptor.capabilities = caps;
	return descriptor;
}

function describeAuthStatus(runtime: RuntimeDescriptor): string {
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

async function loginOAuthRuntime(rl: ReturnType<typeof createInterface>, runtime: RuntimeDescriptor): Promise<boolean> {
	const auth = openAuthStorage();
	if (runtime.authNotice) process.stdout.write(`note: ${runtime.authNotice}\n`);
	const manualCodeInput = createDelayedManualCodeInput(
		rl,
		"Paste verification code if browser callback does not complete automatically: ",
	);
	try {
		await auth.login(runtime.oauthProviderId ?? runtime.id, {
			onAuth: ({ url, instructions }) => {
				process.stdout.write(`\nOpen: ${url}\n`);
				if (instructions) process.stdout.write(`${instructions}\n`);
				process.stdout.write("Waiting for the browser callback. A manual code prompt will appear if needed.\n");
			},
			onDeviceCode: ({ verificationUri, userCode }) => {
				process.stdout.write(`\nOpen: ${verificationUri}\n`);
				process.stdout.write(`Enter code: ${userCode}\n`);
			},
			onPrompt: async (prompt) => {
				const answer = await rl.question(`${prompt.message}${prompt.allowEmpty ? " " : ": "}`);
				return prompt.allowEmpty ? answer : answer.trim();
			},
			onSelect: (prompt) => promptOAuthSelection(rl, prompt),
			onManualCodeInput: manualCodeInput.onManualCodeInput,
			onProgress: (message) => {
				process.stderr.write(`${message}\n`);
			},
		});
		if (credentialWriteFailed(auth, `credential for ${runtime.id} was not stored`)) return false;
		printOk(`authenticated ${runtime.id}`);
		return true;
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return false;
	} finally {
		manualCodeInput.cancel();
	}
}

async function resolveSupportedWireModels(
	runtime: RuntimeDescriptor,
	target: TargetDescriptor,
	existing?: TargetDescriptor,
): Promise<string[]> {
	const known = listKnownModelsForRuntime(runtime.id);
	if (known.length > 0) return known;
	const discovered = runtime.kind === "http" ? await runtimeProbeModels(runtime, target) : [];
	if (discovered.length > 0) return discovered;
	return existing?.wireModels ? [...existing.wireModels] : [];
}

function resolveModelChoice(
	answer: string,
	wireModels: ReadonlyArray<string>,
	defaultValue: string | undefined,
): string | undefined {
	if (answer.length === 0) return defaultValue;
	const numeric = Number(answer);
	if (Number.isInteger(numeric) && numeric >= 1 && numeric <= wireModels.length) {
		return wireModels[numeric - 1];
	}
	return answer;
}

async function askModelChoice(
	rl: ReturnType<typeof createInterface>,
	label: string,
	wireModels: ReadonlyArray<string>,
	defaultValue: string | undefined,
): Promise<string | null> {
	const answer = await ask(rl, `${label} (number or id)`, defaultValue ?? "");
	if (answer === null) return null;
	return resolveModelChoice(answer, wireModels, defaultValue) ?? "";
}

/**
 * A catalog-ordered list has no head worth persisting: openai's first of 38 ids
 * is `gpt-4` because g sorts early, and a target configured without --model
 * used to carry it as the model the operator chose.
 */
function refuseCatalogSeededModel(runtime: RuntimeDescriptor, support: ProviderSupportEntry): void {
	printError(
		`--model is required for ${runtime.id}: its ${support.modelHints.length} model ids come from the pi-ai catalog in name order, which recommends none of them`,
	);
	process.stderr.write(
		`  run \`clio-coder configure --runtime ${runtime.id}\` with no other flags to choose from the full list\n`,
	);
}

async function runNonInteractive(runtime: RuntimeDescriptor, args: ParsedArgs): Promise<number> {
	if (!args.id) {
		printError("--id is required when passing flags non-interactively");
		return 2;
	}
	if (args.workerProfileModel !== undefined && args.workerProfile === undefined) {
		printError("--agent-profile-model requires --agent-profile");
		return 2;
	}
	if (args.workerProfile !== undefined && args.workerProfile.trim().length === 0) {
		printError("--agent-profile must be non-empty");
		return 2;
	}
	if (args.workerProfile !== undefined && args.workerModel !== undefined) {
		printError(
			"--fleet-model and --agent-profile conflict; use --agent-profile-model for the profile, or drop --agent-profile to set the fleet default",
		);
		return 2;
	}
	const settings = readSettings();
	const auth = openAuthStorage();
	const support = buildProviderSupportEntry(runtime);
	const existing = settings.targets.find((e) => e.id === args.id);
	if (existing && existing.runtime !== runtime.id) {
		printError(`target ${args.id} already exists with runtime ${existing.runtime}`);
		return 2;
	}
	let url: string | undefined = args.url ? normalizeUrl(args.url, runtime.id) : existing?.url;
	if (!url && support.supportsCustomUrl) {
		url = defaultUrlFor(runtime.id);
	}
	if (url && (runtime.id === "openai-compat" || runtime.id === "anthropic-compat")) {
		const fingerprint = await fingerprintNativeRuntime(url);
		if (fingerprint) {
			process.stdout.write(
				`note: detected ${fingerprint.displayName} at ${url}; consider \`clio-coder targets convert ${args.id} --runtime ${fingerprint.runtimeId}\` for proper resident-model lifecycle\n`,
			);
		}
	}
	const authStatus = auth.statusForTarget(resolveRuntimeAuthTarget(runtime), { includeFallback: false });
	const apiKeyEnv = args.apiKeyEnv ?? existing?.auth?.apiKeyEnvVar;
	const apiKeyRef =
		runtime.auth === "api-key" && (args.apiKey || existing?.auth?.apiKeyRef || authStatus.source === "stored-api-key")
			? runtime.id
			: undefined;
	const oauthProfile =
		runtime.auth === "oauth" ? (existing?.auth?.oauthProfile ?? runtime.oauthProviderId ?? runtime.id) : undefined;
	const seed = buildDescriptor(runtime, args.id, {
		...(url !== undefined ? { url } : {}),
		...(args.model !== undefined
			? { model: args.model }
			: existing?.defaultModel
				? { model: existing.defaultModel }
				: support.defaultModel
					? { model: support.defaultModel }
					: {}),
		...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
		...(apiKeyRef !== undefined ? { apiKeyRef } : {}),
		...(oauthProfile !== undefined ? { oauthProfile } : {}),
		gateway: args.gateway || existing?.gateway === true,
		...(args.lifecycle !== undefined
			? { lifecycle: args.lifecycle }
			: existing?.lifecycle !== undefined
				? { lifecycle: existing.lifecycle }
				: {}),
		...(args.contextWindow !== undefined ? { contextWindow: args.contextWindow } : {}),
		...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
		...(args.reasoning !== undefined ? { reasoning: args.reasoning } : {}),
	});
	const wireModels = await resolveSupportedWireModels(runtime, seed, existing);
	const model =
		args.model ??
		existing?.defaultModel ??
		support.defaultModel ??
		(support.modelSource === "catalog" ? undefined : wireModels[0]);
	if (model === undefined && support.modelSource === "catalog") {
		refuseCatalogSeededModel(runtime, support);
		return 2;
	}
	if (!validateResolvedModel(runtime.id, model, args.force)) return 2;
	if (!validateContextWindowOverride(runtime, model, args.contextWindow, args.force)) return 2;
	const descriptor = buildDescriptor(runtime, args.id, {
		...(url !== undefined ? { url } : {}),
		...(model ? { model } : {}),
		...(wireModels.length > 0 ? { wireModels } : {}),
		...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
		...(apiKeyRef !== undefined ? { apiKeyRef } : {}),
		...(oauthProfile !== undefined ? { oauthProfile } : {}),
		gateway: args.gateway || existing?.gateway === true,
		...(args.lifecycle !== undefined
			? { lifecycle: args.lifecycle }
			: existing?.lifecycle !== undefined
				? { lifecycle: existing.lifecycle }
				: {}),
		...(args.contextWindow !== undefined ? { contextWindow: args.contextWindow } : {}),
		...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
		...(args.reasoning !== undefined ? { reasoning: args.reasoning } : {}),
	});
	const setOrchestrator = args.setOrchestrator || args.orchestratorModel !== undefined;
	const setBackground = args.setBackground || args.backgroundModel !== undefined;
	if ((setOrchestrator || setBackground) && !isOrchestratorEligibleRuntime(runtime)) {
		printError(
			`cannot use target '${descriptor.id}' as a chat or background target because runtime '${runtime.id}' is not an HTTP/native runtime`,
		);
		return 1;
	}
	try {
		assertOrchestratorReplacementEligible(settings, descriptor);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 1;
	}
	if (args.apiKey) {
		auth.setApiKey(runtime.id, args.apiKey);
		// Bailing here leaves nothing half-done: settings are not touched until
		// applyConfiguration below, so a refused credential write means the whole
		// command changed nothing, which is what the non-zero exit now claims.
		if (credentialWriteFailed(auth, `credential for ${runtime.id} was not stored; target '${descriptor.id}' not saved`))
			return 1;
		printPlaintextCredentialWarning();
	}
	const setWorkerDefault = args.setWorkerDefault || (args.workerProfile === undefined && args.workerModel !== undefined);
	const applyConfiguration = (target: ClioSettings): void => {
		applyTarget(target, descriptor);
		if (setOrchestrator)
			setOrchestratorPointer(target, descriptor, args.orchestratorModel ?? descriptor.defaultModel ?? null);
		if (setBackground) setBackgroundPointer(target, descriptor, args.backgroundModel ?? descriptor.defaultModel ?? null);
		if (setWorkerDefault)
			setWorkerDefaultPointer(target, descriptor, args.workerModel ?? descriptor.defaultModel ?? null);
		if (args.workerProfile !== undefined) {
			setWorkerProfilePointer(
				target,
				args.workerProfile,
				descriptor,
				args.workerProfileModel ?? descriptor.defaultModel ?? null,
			);
		}
	};
	// Apply to the local snapshot for the summary below, then persist the same
	// mutation against the freshest on-disk state under the settings lock so a
	// concurrent session's field-level write-through is never lost.
	applyConfiguration(settings);
	updateSettings(applyConfiguration);
	const probe = await runtimeProbe(runtime, descriptor);
	printSummary(settings, descriptor, probe);
	if (
		runtime.auth === "oauth" &&
		!auth.statusForTarget(resolveRuntimeAuthTarget(runtime), { includeFallback: false }).available
	) {
		process.stdout.write(
			`note: authenticate ${runtime.id} with \`clio-coder auth login ${runtime.id}\` before using this target\n`,
		);
	}
	printOk(`target ${args.id} saved`);
	return 0;
}

async function ask(
	rl: ReturnType<typeof createInterface>,
	label: string,
	defaultValue?: string,
): Promise<string | null> {
	const suffix = defaultValue && defaultValue.length > 0 ? ` [${defaultValue}]` : "";
	try {
		const answer = (await rl.question(`${label}${suffix}: `)).trim();
		if (answer.length === 0) return defaultValue ?? "";
		if (answer.toLowerCase() === "q" || answer.toLowerCase() === "quit") return null;
		return answer;
	} catch {
		return null;
	}
}

async function askYesNo(
	rl: ReturnType<typeof createInterface>,
	label: string,
	defaultValue: boolean,
): Promise<boolean> {
	const marker = defaultValue ? "Y/n" : "y/N";
	for (;;) {
		const answer = await ask(rl, `${label} [${marker}]`);
		if (answer === null) return defaultValue;
		if (answer.length === 0) return defaultValue;
		const lc = answer.toLowerCase();
		if (lc === "y" || lc === "yes") return true;
		if (lc === "n" || lc === "no") return false;
		process.stderr.write(`invalid response: ${answer}\n`);
	}
}

async function pickRuntime(rl: ReturnType<typeof createInterface>): Promise<RuntimeDescriptor | null> {
	const registry = getRuntimeRegistry();
	const entries = listProviderSupportEntries(registry.list());
	return pickRuntimeFromEntries(rl, entries, "\nSupported runtimes:");
}

async function pickRuntimeFromEntries(
	rl: ReturnType<typeof createInterface>,
	entries: ReadonlyArray<ProviderSupportEntry>,
	heading: string,
): Promise<RuntimeDescriptor | null> {
	const registry = getRuntimeRegistry();
	if (entries.length === 0) {
		process.stderr.write("no runtimes available in this category\n");
		return null;
	}
	process.stdout.write(`${heading}\n`);
	const menu = formatRuntimeMenu(
		entries.map((entry) => ({
			group: supportGroupLabel(entry.group),
			runtimeId: entry.runtimeId,
			summary: entry.summary,
		})),
		terminalColumns(),
	);
	for (const line of menu) process.stdout.write(`${line}\n`);
	const allowedIds = new Set(entries.map((entry) => entry.runtimeId));
	// A default here reads as a recommendation, and the only basis this list has
	// for one is the featured flag. Falling back to the first entry made the
	// default whatever sorted first by label, so the bucket that advertises
	// llama.cpp, vLLM, and SGLang offered Antigravity CLI to anyone who pressed
	// Enter. With no featured entry there is no recommendation to make, and Enter
	// asks again rather than choosing on the user's behalf.
	const defaultRuntimeId = entries.find((entry) => entry.featured)?.runtimeId ?? "";
	for (;;) {
		const answer = await ask(rl, "\nSelection (number or runtime id)", defaultRuntimeId);
		if (answer === null) return null;
		if (answer.length === 0) {
			process.stderr.write(`pick a number from 1 to ${entries.length}, or type a runtime id\n`);
			continue;
		}
		const numeric = Number(answer);
		if (Number.isInteger(numeric) && numeric >= 1 && numeric <= entries.length) {
			const picked = entries[numeric - 1];
			if (picked) {
				const runtime = registry.get(picked.runtimeId);
				if (runtime) return runtime;
			}
		}
		if (allowedIds.has(answer)) {
			const match = registry.get(answer);
			if (match) return match;
		}
		process.stderr.write(`unknown runtime id for this category: ${answer}\n`);
	}
}

const LOCAL_APP_RUNTIME_IDS: ReadonlySet<string> = new Set(["ollama-native", "lmstudio-native"]);

// Generic protocol-compatible runtimes. They are classified local-http (they
// carry a probe and no cloud catalog entry), but a hosted endpoint such as
// Inception/Mercury is exactly an OpenAI-compatible cloud API, so the wizard
// also surfaces them under the Cloud API path.
const PROTOCOL_COMPAT_RUNTIME_IDS: ReadonlySet<string> = new Set(["openai-compat", "anthropic-compat"]);

function runtimesForCategory(
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

async function pickCategory(rl: ReturnType<typeof createInterface>): Promise<ConfigureCategory | null> {
	process.stdout.write("\nHow will you connect Clio to a model?\n\n");
	for (const line of formatCategoryMenu(terminalColumns())) process.stdout.write(`${line}\n`);
	for (;;) {
		const answer = await ask(rl, "\nSelection", "1");
		if (answer === null) return null;
		if (answer.length === 0) continue;
		const category = matchCategoryChoice(answer);
		if (category) return category;
		process.stderr.write(`invalid choice: ${answer}\n`);
	}
}

async function pickRuntimeViaCategory(rl: ReturnType<typeof createInterface>): Promise<RuntimeDescriptor | null> {
	const registry = getRuntimeRegistry();
	const allEntries = listProviderSupportEntries(registry.list());
	const category = await pickCategory(rl);
	if (category === null) return null;
	if (category === "all") return pickRuntime(rl);
	const filtered = runtimesForCategory(allEntries, category);
	if (filtered.length === 0) {
		process.stderr.write("no runtimes available for that category; falling back to full list\n");
		return pickRuntime(rl);
	}
	if (category === "chatgpt") {
		const only = filtered[0];
		if (only) {
			const runtime = registry.get(only.runtimeId);
			if (runtime) {
				process.stdout.write(`\nUsing ${runtime.id} (${only.summary}).\n`);
				return runtime;
			}
		}
		return pickRuntime(rl);
	}
	if (filtered.length === 1) {
		const only = filtered[0];
		if (only) {
			const runtime = registry.get(only.runtimeId);
			if (runtime) {
				process.stdout.write(`\nUsing ${runtime.id} (${only.summary}).\n`);
				return runtime;
			}
		}
	}
	const heading =
		category === "local-app" ? "\nLocal apps:" : category === "local-http" ? "\nLocal HTTP servers:" : "\nCloud APIs:";
	return pickRuntimeFromEntries(rl, filtered, heading);
}

async function maybeSteerToNativeRuntime(
	rl: ReturnType<typeof createInterface>,
	currentRuntime: RuntimeDescriptor,
	url: string,
): Promise<RuntimeDescriptor> {
	if (currentRuntime.id !== "openai-compat" && currentRuntime.id !== "anthropic-compat") return currentRuntime;
	const fingerprint = await fingerprintNativeRuntime(url);
	if (!fingerprint) return currentRuntime;
	const native = getRuntimeRegistry().get(fingerprint.runtimeId);
	if (!native) return currentRuntime;
	process.stdout.write(`\nDetected ${fingerprint.displayName} at ${url}.\n`);
	const switchIt = await askYesNo(rl, `Use ${fingerprint.runtimeId} runtime instead of ${currentRuntime.id}?`, true);
	if (!switchIt) return currentRuntime;
	process.stdout.write(`Using ${fingerprint.runtimeId} runtime.\n`);
	return native;
}

async function runInteractive(
	rl: ReturnType<typeof createInterface>,
	preselectedRuntime: RuntimeDescriptor | null,
	defaults: ParsedArgs,
): Promise<number> {
	let runtime = preselectedRuntime ?? (await pickRuntimeViaCategory(rl));
	if (!runtime) {
		printError("configuration cancelled");
		return 0;
	}
	const auth = openAuthStorage();
	const settings = readSettings();
	let support = buildProviderSupportEntry(runtime);
	const initialRuntimeId = runtime.id;
	const existingForRuntime = configuredTargetsForRuntime(settings, initialRuntimeId);
	const existing =
		(defaults.id
			? settings.targets.find((entry) => entry.id === defaults.id && entry.runtime === initialRuntimeId)
			: null) ??
		existingForRuntime[0] ??
		null;
	if (existingForRuntime.length > 0) {
		process.stdout.write(`\nExisting targets for ${runtime.id}:\n`);
		for (const target of existingForRuntime) {
			process.stdout.write(`  - ${target.id}${target.defaultModel ? ` (${target.defaultModel})` : ""}\n`);
		}
	}
	process.stdout.write(`\nSelected runtime: ${runtime.id} (${support.summary})\n`);
	process.stdout.write(`Credentials: ${describeAuthStatus(runtime)}\n`);
	if (support.modelHints.length > 0) {
		process.stdout.write(`Known models: ${describeRuntimeModels(support, 4)}\n`);
	}
	const suggestedId = defaults.id ?? existing?.id ?? deriveTargetId(runtime.id, settings.targets);
	const idInput = await ask(rl, "Target id", suggestedId);
	if (idInput === null || idInput.length === 0) {
		printError("target id is required");
		return 2;
	}
	const targetId = idInput;

	let url: string | undefined = existing?.url;
	if (support.supportsCustomUrl) {
		const urlDefault = defaults.url ?? existing?.url ?? defaultUrlFor(runtime.id);
		const urlInput = await ask(
			rl,
			support.group === "local-http" ? "Target URL" : "Base URL override (blank for runtime default)",
			urlDefault,
		);
		if (urlInput === null) return 0;
		if (urlInput.length > 0) url = normalizeUrl(urlInput, runtime.id);
	} else if (defaults.url) {
		url = normalizeUrl(defaults.url, runtime.id);
	}

	if (url) {
		const steered = await maybeSteerToNativeRuntime(rl, runtime, url);
		if (steered.id !== runtime.id) {
			runtime = steered;
			support = buildProviderSupportEntry(runtime);
		}
	}

	let apiKeyEnv: string | undefined;
	let apiKeyLiteral: string | undefined;
	let apiKeyRef: string | undefined = existing?.auth?.apiKeyRef;
	let oauthProfile: string | undefined =
		runtime.auth === "oauth" ? (existing?.auth?.oauthProfile ?? runtime.oauthProviderId ?? runtime.id) : undefined;
	const authStatus = auth.statusForTarget(resolveRuntimeAuthTarget(runtime), { includeFallback: false });
	if (runtime.auth === "api-key") {
		// Default to the env-var path, which keeps the key off disk. A target that
		// needs no key at all defaults to skip instead: a local llama.cpp server
		// wants no credential, and offering `env` sent the user to an unexplained
		// `Env var name:` with nothing correct to type into it.
		const needsCredential = targetRequiresAuth({ id: targetId, runtime: runtime.id }, runtime);
		const defaultSource =
			authStatus.source === "stored-api-key"
				? "keep"
				: authStatus.source === "environment" || existing?.auth?.apiKeyEnvVar || needsCredential
					? "env"
					: "skip";
		process.stdout.write(
			"\nCredential source: env reads a key from an environment variable, stored writes one to\n" +
				"credentials.yaml, keep leaves the current one alone, skip uses no key at all.\n",
		);
		const choice = await ask(rl, "Credential source [env|stored|keep|skip]", defaultSource);
		if (choice === null) return 0;
		const normalized = choice.trim().toLowerCase();
		if (normalized === "stored") {
			const literal = await ask(rl, "API key literal (stored in credentials.yaml, mode 0600)");
			if (literal !== null && literal.length > 0) {
				apiKeyLiteral = literal;
				apiKeyRef = runtime.id;
			}
		} else if (normalized === "env") {
			const envDefault = defaults.apiKeyEnv ?? existing?.auth?.apiKeyEnvVar ?? runtime.credentialsEnvVar ?? "";
			const envAnswer = await ask(rl, "Env var name (blank for no key)", envDefault);
			if (envAnswer === null) return 0;
			if (envAnswer.length > 0) apiKeyEnv = envAnswer;
			apiKeyRef = undefined;
		} else if (normalized === "keep") {
			apiKeyEnv =
				existing?.auth?.apiKeyEnvVar ?? (authStatus.source === "environment" ? runtime.credentialsEnvVar : undefined);
			apiKeyRef = existing?.auth?.apiKeyRef ?? (authStatus.source === "stored-api-key" ? runtime.id : undefined);
		} else {
			apiKeyEnv = undefined;
			apiKeyRef = undefined;
		}
	}
	if (runtime.auth === "oauth") {
		const connectNow = authStatus.available
			? await askYesNo(rl, `Reconnect ${runtime.displayName}?`, false)
			: await askYesNo(rl, `Connect ${runtime.displayName} now?`, true);
		if (connectNow) {
			const connected = await loginOAuthRuntime(rl, runtime);
			if (!connected) return 1;
		}
		oauthProfile = runtime.oauthProviderId ?? runtime.id;
	}

	let model: string | undefined = defaults.model;
	let wireModels: string[] = existing?.wireModels ? [...existing.wireModels] : [];
	const tentative = buildDescriptor(runtime, targetId, {
		...(url !== undefined ? { url } : {}),
		...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
		...(apiKeyRef !== undefined ? { apiKeyRef } : {}),
		...(oauthProfile !== undefined ? { oauthProfile } : {}),
		gateway: defaults.gateway,
		...(defaults.lifecycle !== undefined
			? { lifecycle: defaults.lifecycle }
			: existing?.lifecycle !== undefined
				? { lifecycle: existing.lifecycle }
				: {}),
		...(defaults.contextWindow !== undefined ? { contextWindow: defaults.contextWindow } : {}),
		...(defaults.maxTokens !== undefined ? { maxTokens: defaults.maxTokens } : {}),
		...(defaults.reasoning !== undefined ? { reasoning: defaults.reasoning } : {}),
	});

	if (runtime.kind === "http") {
		wireModels = await resolveSupportedWireModels(runtime, tentative, existing ?? undefined);
	}
	// The wizard shows the whole list, so a catalog-ordered runtime does not need
	// --model here the way the non-interactive path does. It does need to stop
	// offering the alphabetically first id as though it were the recommended one.
	const catalogOrdered = support.modelSource === "catalog";
	model = model ?? existing?.defaultModel ?? support.defaultModel ?? (catalogOrdered ? undefined : wireModels[0]);
	if (wireModels.length > 0) {
		process.stdout.write("\nSelectable models:\n");
		for (const [index, wireModel] of wireModels.entries()) {
			process.stdout.write(`  ${index + 1}. ${wireModel}${wireModel === model ? "  [default]" : ""}\n`);
		}
		if (!model && catalogOrdered) {
			process.stdout.write(`  listed in pi-ai catalog order, which recommends none of them; pick one.\n`);
		}
		for (;;) {
			const pickedModel = await askModelChoice(rl, "Default target model", wireModels, model);
			if (pickedModel === null) return 0;
			if (pickedModel.length > 0) model = pickedModel;
			if (!model) {
				process.stdout.write("  a model is required: enter a number from the list or a model id.\n");
				continue;
			}
			if (validateResolvedModel(runtime.id, model, defaults.force)) break;
		}
	} else {
		for (;;) {
			if (model && validateResolvedModel(runtime.id, model, defaults.force)) break;
			const manual = await ask(rl, "Default model id (blank to leave empty)", model ?? "");
			if (manual === null) return 0;
			model = manual.length > 0 ? manual : undefined;
			if (!model) break;
		}
	}
	let contextWindowChoice = defaults.contextWindow;
	let reasoningChoice = defaults.reasoning;
	// Generic OpenAI/Anthropic-compatible endpoints have no cloud catalog and
	// their /v1/models rarely reports a context window or reasoning support, so
	// ask for the two capabilities that cannot be probed reliably. Output budget
	// is intentionally not asked: defaults.maxTokens applies globally and is
	// clamped down to the model at request time.
	if (PROTOCOL_COMPAT_RUNTIME_IDS.has(runtime.id)) {
		if (contextWindowChoice === undefined) {
			const cwDefault = existing?.capabilities?.contextWindow ?? runtime.defaultCapabilities.contextWindow;
			const cwAnswer = await ask(
				rl,
				"Context window in tokens (blank for runtime default)",
				cwDefault > 0 ? String(cwDefault) : "",
			);
			if (cwAnswer === null) return 0;
			if (cwAnswer.length > 0) {
				const parsed = Number(cwAnswer);
				if (Number.isInteger(parsed) && parsed > 0) contextWindowChoice = parsed;
				else process.stderr.write(`ignoring invalid context window: ${cwAnswer}\n`);
			}
		}
		if (reasoningChoice === undefined) {
			const reasoningDefault = existing?.capabilities?.reasoning ?? runtime.defaultCapabilities.reasoning === true;
			reasoningChoice = await askYesNo(rl, "Does this model support reasoning / thinking?", reasoningDefault);
		}
	}
	if (!validateContextWindowOverride(runtime, model, contextWindowChoice, defaults.force)) return 2;

	const gatewayDefault = defaults.gateway || existing?.gateway === true;
	const gatewayAnswer = gatewayDefault ? true : await askYesNo(rl, "Mark as gateway?", false);

	const descriptor = buildDescriptor(runtime, targetId, {
		...(url !== undefined ? { url } : {}),
		...(model !== undefined ? { model } : {}),
		...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
		...(apiKeyRef !== undefined ? { apiKeyRef } : {}),
		...(oauthProfile !== undefined ? { oauthProfile } : {}),
		...(wireModels.length > 0 ? { wireModels } : {}),
		gateway: gatewayAnswer,
		...(defaults.lifecycle !== undefined
			? { lifecycle: defaults.lifecycle }
			: existing?.lifecycle !== undefined
				? { lifecycle: existing.lifecycle }
				: {}),
		...(contextWindowChoice !== undefined ? { contextWindow: contextWindowChoice } : {}),
		...(defaults.maxTokens !== undefined ? { maxTokens: defaults.maxTokens } : {}),
		...(reasoningChoice !== undefined ? { reasoning: reasoningChoice } : {}),
	});
	try {
		assertOrchestratorReplacementEligible(settings, descriptor);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 1;
	}
	if (apiKeyLiteral) {
		auth.setApiKey(runtime.id, apiKeyLiteral);
		// As in the non-interactive path: the settings write is still ahead of us,
		// so refusing here leaves the whole wizard run without an effect.
		if (credentialWriteFailed(auth, `credential for ${runtime.id} was not stored; target '${descriptor.id}' not saved`))
			return 1;
		printPlaintextCredentialWarning();
	}

	const probe = await runtimeProbe(runtime, descriptor);
	if (probe) {
		process.stdout.write("\n");
		for (const line of probeLines(descriptor, probe)) process.stdout.write(`${line}\n`);
		if (!probe.ok) {
			const keepAnyway = await askYesNo(rl, "save this target anyway, without a reply from it?", true);
			if (!keepAnyway) {
				printError("aborted; settings not changed");
				return 0;
			}
		}
	}

	const setOrchestrator = !isOrchestratorEligibleRuntime(runtime)
		? false
		: defaults.setOrchestrator
			? true
			: await askYesNo(rl, "use as orchestrator (chat) target?", !settings.orchestrator.target);
	const setWorkerDefault = defaults.setWorkerDefault
		? true
		: await askYesNo(rl, "use as fleet default?", !settings.workers.default.target);
	const setBackground = !isOrchestratorEligibleRuntime(runtime)
		? false
		: defaults.setBackground
			? true
			: await askYesNo(rl, "use as background memory target?", false);
	const orchestratorModel = setOrchestrator
		? (defaults.orchestratorModel ??
			(await askModelChoice(
				rl,
				"Orchestrator model",
				wireModels,
				settings.orchestrator.target === targetId ? (settings.orchestrator.model ?? model) : model,
			)))
		: undefined;
	if (orchestratorModel === null) return 0;
	const workerModel = setWorkerDefault
		? (defaults.workerModel ??
			(await askModelChoice(
				rl,
				"Fleet model",
				wireModels,
				settings.workers.default.target === targetId ? (settings.workers.default.model ?? model) : model,
			)))
		: undefined;
	if (workerModel === null) return 0;
	const backgroundModel = setBackground
		? (defaults.backgroundModel ??
			(await askModelChoice(
				rl,
				"Background memory model",
				wireModels,
				settings.background.target === targetId ? (settings.background.model ?? model) : model,
			)))
		: undefined;
	if (backgroundModel === null) return 0;

	const applyWizardChoice = (target: ClioSettings): void => {
		applyTarget(target, descriptor);
		if (setOrchestrator) setOrchestratorPointer(target, descriptor, orchestratorModel);
		if (setBackground) setBackgroundPointer(target, descriptor, backgroundModel);
		if (setWorkerDefault) setWorkerDefaultPointer(target, descriptor, workerModel);
	};
	applyWizardChoice(settings);
	updateSettings(applyWizardChoice);

	printSummary(settings, descriptor, probe);
	printOk(`target ${targetId} saved`);
	return 0;
}

export function runTargetRemove(id: string): number {
	if (!readSettings().targets.some((e) => e.id === id)) {
		printError(`no target with id ${id}`);
		return 1;
	}
	updateSettings((settings) => {
		removeTargetFromSettings(settings, id);
	});
	printOk(`removed target ${id}`);
	return 0;
}

export function runTargetRename(oldId: string, newId: string): number {
	if (oldId === newId) {
		printError("old and new id are identical");
		return 2;
	}
	const current = readSettings();
	if (current.targets.some((e) => e.id === newId)) {
		printError(`target id already exists: ${newId}`);
		return 2;
	}
	if (!current.targets.some((e) => e.id === oldId)) {
		printError(`no target with id ${oldId}`);
		return 1;
	}
	updateSettings((settings) => {
		const target = settings.targets.find((e) => e.id === oldId);
		if (!target) return;
		target.id = newId;
		if (settings.orchestrator.target === oldId) settings.orchestrator.target = newId;
		if (settings.background.target === oldId) settings.background.target = newId;
		if (settings.workers.default.target === oldId) settings.workers.default.target = newId;
		for (const profile of Object.values(settings.workers.profiles)) {
			if (profile.target === oldId) profile.target = newId;
		}
		settings.scope = settings.scope.map((entry) => {
			const [head, ...rest] = entry.split("/");
			if (head !== oldId) return entry;
			return rest.length === 0 ? newId : `${newId}/${rest.join("/")}`;
		});
	});
	printOk(`renamed ${oldId} to ${newId}`);
	return 0;
}

export async function runConfigureCommand(argv: ReadonlyArray<string>): Promise<number> {
	let args: ParsedArgs;
	try {
		args = parseSetupArgs(argv);
	} catch (err) {
		printError(err instanceof Error ? err.message : String(err));
		process.stdout.write(HELP);
		return 2;
	}
	if (args.help) {
		process.stdout.write(HELP);
		return 0;
	}
	initializeClioHome();
	ensureRegistryPopulated();

	if (args.list) {
		printRuntimeList(args.all);
		return 0;
	}
	if (args.remove) return runTargetRemove(args.remove);
	if (args.renameOld && args.renameNew) return runTargetRename(args.renameOld, args.renameNew);

	if (args.positional.length > 0) {
		printError(
			"`clio-coder configure` accepts flags, not positional runtimes. Use `clio-coder auth login <runtime>` first when authentication is needed, then `clio-coder configure --runtime <runtimeId> ...`.",
		);
		return 2;
	}

	const runtimeId = args.runtime;
	let runtime: RuntimeDescriptor | null = null;
	if (runtimeId) {
		runtime = getRuntimeRegistry().get(runtimeId);
		if (!runtime) {
			printError(`unknown runtime id: ${runtimeId}`);
			process.stdout.write("run `clio-coder configure --list` to see registered runtimes\n");
			return 2;
		}
	}
	const hasTargetSetupFlag =
		args.id !== undefined ||
		args.url !== undefined ||
		args.model !== undefined ||
		args.workerProfile !== undefined ||
		args.workerProfileModel !== undefined ||
		args.apiKey !== undefined ||
		args.apiKeyEnv !== undefined ||
		args.gateway ||
		args.lifecycle !== undefined ||
		args.setOrchestrator ||
		args.setWorkerDefault ||
		args.contextWindow !== undefined ||
		args.maxTokens !== undefined ||
		args.reasoning !== undefined;
	const nonInteractive = runtime !== null && hasTargetSetupFlag;

	if (nonInteractive && runtime) return runNonInteractive(runtime, args);

	// Setup flags were supplied but the non-interactive spec is incomplete
	// (missing --runtime, or a --runtime with no target flags). On a
	// non-interactive stdin the wizard below would read EOF, take the default
	// answers, write the initial settings template, and exit 0 without
	// configuring the requested target. Reject with the missing half instead.
	if ((runtimeId !== undefined || hasTargetSetupFlag) && !input.isTTY) {
		printError(
			runtime === null
				? "--runtime is required when configuring a target non-interactively"
				: "--id is required when passing flags non-interactively",
		);
		return 2;
	}

	const rl = createInterface({ input, output });
	try {
		return await runInteractive(rl, runtime, args);
	} catch (err) {
		printError(err instanceof Error ? err.message : String(err));
		return 1;
	} finally {
		rl.close();
	}
}
