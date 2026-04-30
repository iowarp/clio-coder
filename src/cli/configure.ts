import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { type ClioSettings, readSettings, settingsPath, writeSettings } from "../core/config.js";
import { initializeClioHome } from "../core/init.js";
import { openAuthStorage } from "../domains/providers/auth/index.js";
import { credentialsPresent } from "../domains/providers/credentials.js";
import {
	buildProviderSupportEntry,
	configuredEndpointsForRuntime,
	defaultModelForRuntime,
	listKnownModelsForRuntime,
	listProviderSupportEntries,
	type ProviderSupportEntry,
	resolveRuntimeAuthTarget,
	supportGroupLabel,
} from "../domains/providers/index.js";
import { fingerprintNativeRuntime } from "../domains/providers/probe/fingerprint.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../domains/providers/runtimes/builtins.js";
import type { EndpointDescriptor } from "../domains/providers/types/endpoint-descriptor.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../domains/providers/types/runtime-descriptor.js";
import { createDelayedManualCodeInput } from "./oauth-manual-input.js";
import { printError, printOk } from "./shared.js";

const HELP = `clio configure

Configure model targets for chat and worker dispatch.

Usage:
  clio configure                   interactive wizard
  clio configure --list            list target runtimes (user-facing only)
  clio configure --list --all      list every registered runtime including aliases
  clio configure --id <targetId> [flags] --runtime <runtimeId>

Non-interactive flags:
  --id <targetId>                  target id to register (required when non-interactive)
  --runtime <runtimeId>            runtime to use when registering non-interactively
  --url <host>                     target base URL (http(s):// or ws://)
  --model <wireModelId>            default model id for this target
  --orchestrator-model <id>        model to use when setting chat default
  --worker-model <id>              model to use when setting worker default
                                   (mutually exclusive with --worker-profile)
  --worker-profile <name>          save this target as a named worker profile
  --worker-profile-model <id>      model to use for --worker-profile
  --api-key-env <VAR>              read API key from this env var at call time
  --api-key <literal>              store API key in credentials.yaml
  --gateway                        mark the target as a gateway
  --set-orchestrator               use this target for chat
  --set-worker-default             use this target for workers
  --context-window <N>             capability override
  --max-tokens <N>                 output token capability override
  --reasoning <true|false>         capability override
`;

const DEFAULT_PORTS: Record<string, number> = {
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
	workerModel?: string;
	workerProfile?: string;
	workerProfileModel?: string;
	apiKeyEnv?: string;
	apiKey?: string;
	gateway: boolean;
	setOrchestrator: boolean;
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
		gateway: false,
		setOrchestrator: false,
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
			case "--worker-model":
				out.workerModel = need();
				break;
			case "--worker-profile":
				out.workerProfile = need();
				break;
			case "--worker-profile-model":
				out.workerProfileModel = need();
				break;
			case "--api-key-env":
				out.apiKeyEnv = need();
				break;
			case "--api-key":
				out.apiKey = need();
				break;
			case "--gateway":
				out.gateway = true;
				break;
			case "--set-orchestrator":
				out.setOrchestrator = true;
				break;
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

function printRuntimeList(includeHidden: boolean): void {
	const settings = readSettings();
	const auth = openAuthStorage();
	let lastGroup: ProviderSupportEntry["group"] | null = null;
	for (const entry of listProviderSupportEntries(getRuntimeRegistry().list(), { includeHidden })) {
		if (entry.group !== lastGroup) {
			if (lastGroup !== null) process.stdout.write("\n");
			lastGroup = entry.group;
			process.stdout.write(`${supportGroupLabel(entry.group)}:\n`);
		}
		const runtime = getRuntimeRegistry().get(entry.runtimeId);
		const endpointCount = configuredEndpointsForRuntime(settings, entry.runtimeId).length;
		const status =
			runtime && entry.connectable
				? auth.statusForTarget(resolveRuntimeAuthTarget(runtime), { includeFallback: false })
				: null;
		const authLabel =
			runtime?.auth === "cli"
				? "cli"
				: runtime?.auth === "oauth"
					? status?.available
						? "connected"
						: "login"
					: runtime?.auth === "api-key"
						? status?.available
							? "credential"
							: "needs-key"
						: runtime?.kind === "subprocess"
							? "cli"
							: (runtime?.auth ?? "none");
		const modelLabel =
			entry.modelHints.length > 0
				? entry.modelHints.slice(0, 2).join(", ")
				: (defaultModelForRuntime(entry.runtimeId) ?? "-");
		process.stdout.write(
			`  ${entry.runtimeId.padEnd(22)} ${entry.label.padEnd(20)} ${authLabel.padEnd(11)} targets=${String(endpointCount).padEnd(3)} models=${modelLabel}\n`,
		);
	}
}

function deriveEndpointId(runtimeId: string, existing: ReadonlyArray<EndpointDescriptor>): string {
	const base = runtimeId;
	const taken = new Set(existing.map((e) => e.id));
	if (!taken.has(base)) return base;
	for (let i = 2; i < 1000; i++) {
		const candidate = `${base}-${i}`;
		if (!taken.has(candidate)) return candidate;
	}
	return `${base}-${Date.now()}`;
}

function buildProbeContext(): ProbeContext {
	return {
		credentialsPresent: credentialsPresent(),
		httpTimeoutMs: 5000,
	};
}

async function runtimeProbe(runtime: RuntimeDescriptor, endpoint: EndpointDescriptor): Promise<ProbeResult | null> {
	if (typeof runtime.probe !== "function") return null;
	try {
		return await runtime.probe(endpoint, buildProbeContext());
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

async function runtimeProbeModels(runtime: RuntimeDescriptor, endpoint: EndpointDescriptor): Promise<string[]> {
	if (typeof runtime.probeModels !== "function") return [];
	try {
		return await runtime.probeModels(endpoint, buildProbeContext());
	} catch {
		return [];
	}
}

function applyEndpoint(settings: ClioSettings, descriptor: EndpointDescriptor): void {
	const idx = settings.endpoints.findIndex((e) => e.id === descriptor.id);
	if (idx >= 0) settings.endpoints[idx] = descriptor;
	else settings.endpoints.push(descriptor);
}

function setOrchestratorPointer(settings: ClioSettings, descriptor: EndpointDescriptor, model?: string | null): void {
	settings.orchestrator.endpoint = descriptor.id;
	settings.orchestrator.model = model ?? descriptor.defaultModel ?? null;
}

function setWorkerDefaultPointer(settings: ClioSettings, descriptor: EndpointDescriptor, model?: string | null): void {
	settings.workers.default.endpoint = descriptor.id;
	settings.workers.default.model = model ?? descriptor.defaultModel ?? null;
}

function setWorkerProfilePointer(
	settings: ClioSettings,
	name: string,
	descriptor: EndpointDescriptor,
	model?: string | null,
): void {
	const trimmed = name.trim();
	if (trimmed.length === 0) throw new Error("worker profile name must be non-empty");
	settings.workers.profiles[trimmed] = {
		endpoint: descriptor.id,
		model: model ?? descriptor.defaultModel ?? null,
		thinkingLevel: "off",
	};
}

function printSummary(settings: ClioSettings, descriptor: EndpointDescriptor, probe: ProbeResult | null): void {
	process.stdout.write(`\nsaved target ${descriptor.id} (runtime=${descriptor.runtime})\n`);
	if (descriptor.url) process.stdout.write(`  url        ${descriptor.url}\n`);
	if (descriptor.defaultModel) process.stdout.write(`  model      ${descriptor.defaultModel}\n`);
	if (descriptor.auth?.apiKeyEnvVar) process.stdout.write(`  apiKeyEnv  ${descriptor.auth.apiKeyEnvVar}\n`);
	if (descriptor.gateway) process.stdout.write("  gateway    true\n");
	if (probe) {
		const line = probe.ok
			? `probe ok${probe.latencyMs !== undefined ? ` (${probe.latencyMs}ms)` : ""}${probe.serverVersion ? ` ${probe.serverVersion}` : ""}`
			: `probe failed: ${probe.error ?? "unknown"}`;
		process.stdout.write(`  ${line}\n`);
	}
	if (settings.orchestrator.endpoint === descriptor.id) process.stdout.write("  orchestrator target\n");
	if (settings.workers.default.endpoint === descriptor.id) process.stdout.write("  worker default\n");
	for (const [name, profile] of Object.entries(settings.workers.profiles)) {
		if (profile.endpoint === descriptor.id) process.stdout.write(`  worker profile ${name}\n`);
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
		contextWindow?: number;
		maxTokens?: number;
		reasoning?: boolean;
	},
): EndpointDescriptor {
	const descriptor: EndpointDescriptor = { id, runtime: runtime.id };
	if (parts.url) descriptor.url = parts.url;
	const wireModels =
		parts.wireModels?.filter((value, index, all) => value.trim().length > 0 && all.indexOf(value) === index) ?? [];
	if (parts.model) descriptor.defaultModel = parts.model;
	else {
		const firstWireModel = wireModels[0];
		if (firstWireModel) descriptor.defaultModel = firstWireModel;
	}
	const auth: NonNullable<EndpointDescriptor["auth"]> = {};
	if (parts.apiKeyEnv) auth.apiKeyEnvVar = parts.apiKeyEnv;
	if (parts.apiKeyRef) auth.apiKeyRef = parts.apiKeyRef;
	if (parts.oauthProfile) auth.oauthProfile = parts.oauthProfile;
	if (Object.keys(auth).length > 0) descriptor.auth = auth;
	if (wireModels.length > 0) descriptor.wireModels = wireModels;
	if (parts.gateway) descriptor.gateway = true;
	const caps: NonNullable<EndpointDescriptor["capabilities"]> = {};
	if (parts.contextWindow !== undefined) caps.contextWindow = parts.contextWindow;
	if (parts.maxTokens !== undefined) caps.maxTokens = parts.maxTokens;
	if (parts.reasoning !== undefined) caps.reasoning = parts.reasoning;
	if (Object.keys(caps).length > 0) descriptor.capabilities = caps;
	return descriptor;
}

function describeAuthStatus(runtime: RuntimeDescriptor): string {
	if (runtime.auth === "cli") return "native CLI auth";
	const status = openAuthStorage().statusForTarget(resolveRuntimeAuthTarget(runtime), { includeFallback: false });
	if (!status.available) return "not connected";
	if (status.source === "environment") return `environment${status.detail ? ` (${status.detail})` : ""}`;
	if (status.source === "stored-api-key") return "stored api key";
	if (status.source === "stored-oauth") return "stored oauth";
	return status.source;
}

async function loginOAuthRuntime(rl: ReturnType<typeof createInterface>, runtime: RuntimeDescriptor): Promise<boolean> {
	const auth = openAuthStorage();
	const manualCodeInput = createDelayedManualCodeInput(
		rl,
		"Paste verification code if browser callback does not complete automatically: ",
	);
	try {
		await auth.login(runtime.id, {
			onAuth: ({ url, instructions }) => {
				process.stdout.write(`\nOpen: ${url}\n`);
				if (instructions) process.stdout.write(`${instructions}\n`);
				process.stdout.write("Waiting for the browser callback. A manual code prompt will appear if needed.\n");
			},
			onPrompt: async (prompt) => {
				const answer = await rl.question(`${prompt.message}${prompt.allowEmpty ? " " : ": "}`);
				return prompt.allowEmpty ? answer : answer.trim();
			},
			onManualCodeInput: manualCodeInput.onManualCodeInput,
			onProgress: (message) => {
				process.stderr.write(`${message}\n`);
			},
		});
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
	endpoint: EndpointDescriptor,
	existing?: EndpointDescriptor,
): Promise<string[]> {
	const known = listKnownModelsForRuntime(runtime.id);
	if (known.length > 0) return known;
	const discovered = runtime.kind === "http" ? await runtimeProbeModels(runtime, endpoint) : [];
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

async function runNonInteractive(runtime: RuntimeDescriptor, args: ParsedArgs): Promise<number> {
	if (!args.id) {
		printError("--id is required when passing flags non-interactively");
		return 2;
	}
	if (args.workerProfileModel !== undefined && args.workerProfile === undefined) {
		printError("--worker-profile-model requires --worker-profile");
		return 2;
	}
	if (args.workerProfile !== undefined && args.workerProfile.trim().length === 0) {
		printError("--worker-profile must be non-empty");
		return 2;
	}
	if (args.workerProfile !== undefined && args.workerModel !== undefined) {
		printError(
			"--worker-model and --worker-profile conflict; use --worker-profile-model for the profile, or drop --worker-profile to set the worker default",
		);
		return 2;
	}
	const settings = readSettings();
	const auth = openAuthStorage();
	const support = buildProviderSupportEntry(runtime);
	const existing = settings.endpoints.find((e) => e.id === args.id);
	if (existing && existing.runtime !== runtime.id) {
		printError(`target ${args.id} already exists with runtime ${existing.runtime}`);
		return 2;
	}
	let url: string | undefined = args.url ? normalizeUrl(args.url, runtime.id) : existing?.url;
	if (!url && support.supportsCustomUrl) {
		url = defaultUrlFor(runtime.id);
	}
	if (url && runtime.id === "openai-compat") {
		const fingerprint = await fingerprintNativeRuntime(url);
		if (fingerprint) {
			process.stdout.write(
				`note: detected ${fingerprint.displayName} at ${url}; consider \`clio targets convert ${args.id} --runtime ${fingerprint.runtimeId}\` for proper resident-model lifecycle\n`,
			);
		}
	}
	const authStatus = auth.statusForTarget(resolveRuntimeAuthTarget(runtime), { includeFallback: false });
	const apiKeyEnv = args.apiKeyEnv ?? existing?.auth?.apiKeyEnvVar;
	const apiKeyRef =
		runtime.auth === "api-key" && (args.apiKey || existing?.auth?.apiKeyRef || authStatus.source === "stored-api-key")
			? runtime.id
			: undefined;
	const oauthProfile = runtime.auth === "oauth" ? (existing?.auth?.oauthProfile ?? runtime.id) : undefined;
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
		...(args.contextWindow !== undefined ? { contextWindow: args.contextWindow } : {}),
		...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
		...(args.reasoning !== undefined ? { reasoning: args.reasoning } : {}),
	});
	const wireModels = await resolveSupportedWireModels(runtime, seed, existing);
	const descriptor = buildDescriptor(runtime, args.id, {
		...(url !== undefined ? { url } : {}),
		...((args.model ?? existing?.defaultModel ?? support.defaultModel ?? wireModels[0])
			? { model: args.model ?? existing?.defaultModel ?? support.defaultModel ?? wireModels[0] }
			: {}),
		...(wireModels.length > 0 ? { wireModels } : {}),
		...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
		...(apiKeyRef !== undefined ? { apiKeyRef } : {}),
		...(oauthProfile !== undefined ? { oauthProfile } : {}),
		gateway: args.gateway || existing?.gateway === true,
		...(args.contextWindow !== undefined ? { contextWindow: args.contextWindow } : {}),
		...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
		...(args.reasoning !== undefined ? { reasoning: args.reasoning } : {}),
	});
	if (args.apiKey) auth.setApiKey(runtime.id, args.apiKey);
	applyEndpoint(settings, descriptor);
	const setOrchestrator = args.setOrchestrator || args.orchestratorModel !== undefined;
	const setWorkerDefault = args.setWorkerDefault || (args.workerProfile === undefined && args.workerModel !== undefined);
	if (setOrchestrator)
		setOrchestratorPointer(settings, descriptor, args.orchestratorModel ?? descriptor.defaultModel ?? null);
	if (setWorkerDefault)
		setWorkerDefaultPointer(settings, descriptor, args.workerModel ?? descriptor.defaultModel ?? null);
	if (args.workerProfile !== undefined) {
		setWorkerProfilePointer(
			settings,
			args.workerProfile,
			descriptor,
			args.workerProfileModel ?? descriptor.defaultModel ?? null,
		);
	}
	writeSettings(settings);
	const probe = await runtimeProbe(runtime, descriptor);
	printSummary(settings, descriptor, probe);
	if (
		runtime.auth === "oauth" &&
		!auth.statusForTarget(resolveRuntimeAuthTarget(runtime), { includeFallback: false }).available
	) {
		process.stdout.write(
			`note: authenticate ${runtime.id} with \`clio auth login ${runtime.id}\` before using this target\n`,
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
	process.stdout.write("\nSupported runtimes:\n");
	let lastGroup: ProviderSupportEntry["group"] | null = null;
	for (const [index, entry] of entries.entries()) {
		if (entry.group !== lastGroup) {
			lastGroup = entry.group;
			process.stdout.write(`  ${supportGroupLabel(entry.group)}:\n`);
		}
		process.stdout.write(`    ${String(index + 1).padStart(2)}. ${entry.runtimeId.padEnd(22)} ${entry.summary}\n`);
	}
	for (;;) {
		const answer = await ask(rl, "\nSelection (number or runtime id)", entries[0]?.runtimeId ?? "");
		if (answer === null) return null;
		if (answer.length === 0) continue;
		const numeric = Number(answer);
		if (Number.isInteger(numeric) && numeric >= 1 && numeric <= entries.length) {
			const picked = entries[numeric - 1];
			if (picked) {
				const runtime = registry.get(picked.runtimeId);
				if (runtime) return runtime;
			}
		}
		const match = registry.get(answer);
		if (match) return match;
		process.stderr.write(`unknown runtime id: ${answer}\n`);
	}
}

async function maybeSteerToNativeRuntime(
	rl: ReturnType<typeof createInterface>,
	currentRuntime: RuntimeDescriptor,
	url: string,
): Promise<RuntimeDescriptor> {
	if (currentRuntime.id !== "openai-compat") return currentRuntime;
	const fingerprint = await fingerprintNativeRuntime(url);
	if (!fingerprint) return currentRuntime;
	const native = getRuntimeRegistry().get(fingerprint.runtimeId);
	if (!native) return currentRuntime;
	process.stdout.write(`\nDetected ${fingerprint.displayName} at ${url}.\n`);
	const switchIt = await askYesNo(rl, `Use ${fingerprint.runtimeId} runtime instead of openai-compat?`, true);
	if (!switchIt) return currentRuntime;
	process.stdout.write(`Using ${fingerprint.runtimeId} runtime.\n`);
	return native;
}

async function runInteractive(
	rl: ReturnType<typeof createInterface>,
	preselectedRuntime: RuntimeDescriptor | null,
	defaults: ParsedArgs,
): Promise<number> {
	let runtime = preselectedRuntime ?? (await pickRuntime(rl));
	if (!runtime) {
		printError("configuration cancelled");
		return 0;
	}
	const auth = openAuthStorage();
	const settings = readSettings();
	let support = buildProviderSupportEntry(runtime);
	const initialRuntimeId = runtime.id;
	const existingForRuntime = configuredEndpointsForRuntime(settings, initialRuntimeId);
	const existing =
		(defaults.id
			? settings.endpoints.find((entry) => entry.id === defaults.id && entry.runtime === initialRuntimeId)
			: null) ??
		existingForRuntime[0] ??
		null;
	if (existingForRuntime.length > 0) {
		process.stdout.write(`\nExisting targets for ${runtime.id}:\n`);
		for (const endpoint of existingForRuntime) {
			process.stdout.write(`  - ${endpoint.id}${endpoint.defaultModel ? ` (${endpoint.defaultModel})` : ""}\n`);
		}
	}
	process.stdout.write(`\nSelected runtime: ${runtime.id} (${support.summary})\n`);
	process.stdout.write(`Connection: ${describeAuthStatus(runtime)}\n`);
	if (support.modelHints.length > 0) {
		process.stdout.write(`Known models: ${support.modelHints.slice(0, 4).join(", ")}\n`);
	}
	const suggestedId = defaults.id ?? existing?.id ?? deriveEndpointId(runtime.id, settings.endpoints);
	const idInput = await ask(rl, "Target id", suggestedId);
	if (idInput === null || idInput.length === 0) {
		printError("target id is required");
		return 2;
	}
	const endpointId = idInput;

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
		runtime.auth === "oauth" ? (existing?.auth?.oauthProfile ?? runtime.id) : undefined;
	const authStatus = auth.statusForTarget(resolveRuntimeAuthTarget(runtime), { includeFallback: false });
	if (runtime.auth === "api-key") {
		const defaultSource =
			authStatus.source === "stored-api-key"
				? "keep"
				: authStatus.source === "environment" || existing?.auth?.apiKeyEnvVar
					? "env"
					: "stored";
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
			const envAnswer = await ask(rl, "Env var name", envDefault);
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
		oauthProfile = runtime.id;
	}

	let model: string | undefined = defaults.model;
	let wireModels: string[] = existing?.wireModels ? [...existing.wireModels] : [];
	const tentative = buildDescriptor(runtime, endpointId, {
		...(url !== undefined ? { url } : {}),
		...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
		...(apiKeyRef !== undefined ? { apiKeyRef } : {}),
		...(oauthProfile !== undefined ? { oauthProfile } : {}),
		gateway: defaults.gateway,
		...(defaults.contextWindow !== undefined ? { contextWindow: defaults.contextWindow } : {}),
		...(defaults.maxTokens !== undefined ? { maxTokens: defaults.maxTokens } : {}),
		...(defaults.reasoning !== undefined ? { reasoning: defaults.reasoning } : {}),
	});

	if (runtime.kind === "http") {
		wireModels = await resolveSupportedWireModels(runtime, tentative, existing ?? undefined);
	}
	model = model ?? existing?.defaultModel ?? support.defaultModel ?? wireModels[0];
	if (wireModels.length > 0) {
		process.stdout.write("\nSelectable models:\n");
		for (const [index, wireModel] of wireModels.entries()) {
			process.stdout.write(`  ${index + 1}. ${wireModel}${wireModel === model ? "  [default]" : ""}\n`);
		}
		const pickedModel = await askModelChoice(rl, "Default target model", wireModels, model);
		if (pickedModel === null) return 0;
		if (pickedModel.length > 0) model = pickedModel;
	} else if (!model) {
		const manual = await ask(rl, "Default model id (blank to leave empty)", "");
		if (manual && manual.length > 0) model = manual;
	}

	const gatewayDefault = defaults.gateway || existing?.gateway === true;
	const gatewayAnswer = gatewayDefault ? true : await askYesNo(rl, "Mark as gateway?", false);

	const descriptor = buildDescriptor(runtime, endpointId, {
		...(url !== undefined ? { url } : {}),
		...(model !== undefined ? { model } : {}),
		...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
		...(apiKeyRef !== undefined ? { apiKeyRef } : {}),
		...(oauthProfile !== undefined ? { oauthProfile } : {}),
		...(wireModels.length > 0 ? { wireModels } : {}),
		gateway: gatewayAnswer,
		...(defaults.contextWindow !== undefined ? { contextWindow: defaults.contextWindow } : {}),
		...(defaults.maxTokens !== undefined ? { maxTokens: defaults.maxTokens } : {}),
		...(defaults.reasoning !== undefined ? { reasoning: defaults.reasoning } : {}),
	});
	if (apiKeyLiteral) auth.setApiKey(runtime.id, apiKeyLiteral);

	const probe = await runtimeProbe(runtime, descriptor);
	if (probe) {
		const line = probe.ok
			? `probe ok${probe.latencyMs !== undefined ? ` (${probe.latencyMs}ms)` : ""}${probe.serverVersion ? ` ${probe.serverVersion}` : ""}`
			: `probe failed: ${probe.error ?? "unknown"}`;
		process.stdout.write(`\n${line}\n`);
		if (!probe.ok) {
			const keepAnyway = await askYesNo(rl, "save target anyway?", true);
			if (!keepAnyway) {
				printError("aborted; settings not changed");
				return 0;
			}
		}
	}

	const setOrchestrator = defaults.setOrchestrator
		? true
		: await askYesNo(rl, "use as orchestrator (chat) target?", !settings.orchestrator.endpoint);
	const setWorkerDefault = defaults.setWorkerDefault
		? true
		: await askYesNo(rl, "use as worker default?", !settings.workers.default.endpoint);
	const orchestratorModel = setOrchestrator
		? (defaults.orchestratorModel ??
			(await askModelChoice(
				rl,
				"Orchestrator model",
				wireModels,
				settings.orchestrator.endpoint === endpointId ? (settings.orchestrator.model ?? model) : model,
			)))
		: undefined;
	if (orchestratorModel === null) return 0;
	const workerModel = setWorkerDefault
		? (defaults.workerModel ??
			(await askModelChoice(
				rl,
				"Worker model",
				wireModels,
				settings.workers.default.endpoint === endpointId ? (settings.workers.default.model ?? model) : model,
			)))
		: undefined;
	if (workerModel === null) return 0;

	applyEndpoint(settings, descriptor);
	if (setOrchestrator) setOrchestratorPointer(settings, descriptor, orchestratorModel);
	if (setWorkerDefault) setWorkerDefaultPointer(settings, descriptor, workerModel);
	writeSettings(settings);

	printSummary(settings, descriptor, probe);
	printOk(`target ${endpointId} saved`);
	return 0;
}

export function runTargetRemove(id: string): number {
	const settings = readSettings();
	const before = settings.endpoints.length;
	settings.endpoints = settings.endpoints.filter((e) => e.id !== id);
	if (settings.endpoints.length === before) {
		printError(`no target with id ${id}`);
		return 1;
	}
	if (settings.orchestrator.endpoint === id) {
		settings.orchestrator.endpoint = null;
		settings.orchestrator.model = null;
	}
	if (settings.workers.default.endpoint === id) {
		settings.workers.default.endpoint = null;
		settings.workers.default.model = null;
	}
	for (const [name, profile] of Object.entries(settings.workers.profiles)) {
		if (profile.endpoint === id) delete settings.workers.profiles[name];
	}
	settings.scope = settings.scope.filter((entry) => {
		const [head] = entry.split("/");
		return head !== id;
	});
	writeSettings(settings);
	printOk(`removed target ${id}`);
	return 0;
}

export function runTargetRename(oldId: string, newId: string): number {
	if (oldId === newId) {
		printError("old and new id are identical");
		return 2;
	}
	const settings = readSettings();
	if (settings.endpoints.some((e) => e.id === newId)) {
		printError(`target id already exists: ${newId}`);
		return 2;
	}
	const target = settings.endpoints.find((e) => e.id === oldId);
	if (!target) {
		printError(`no target with id ${oldId}`);
		return 1;
	}
	target.id = newId;
	if (settings.orchestrator.endpoint === oldId) settings.orchestrator.endpoint = newId;
	if (settings.workers.default.endpoint === oldId) settings.workers.default.endpoint = newId;
	for (const profile of Object.values(settings.workers.profiles)) {
		if (profile.endpoint === oldId) profile.endpoint = newId;
	}
	settings.scope = settings.scope.map((entry) => {
		const [head, ...rest] = entry.split("/");
		if (head !== oldId) return entry;
		return rest.length === 0 ? newId : `${newId}/${rest.join("/")}`;
	});
	writeSettings(settings);
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
			"`clio configure` accepts flags, not positional runtimes. Use `clio auth login <runtime>` first when authentication is needed, then `clio configure --runtime <runtimeId> ...`.",
		);
		return 2;
	}

	const runtimeId = args.runtime;
	let runtime: RuntimeDescriptor | null = null;
	if (runtimeId) {
		runtime = getRuntimeRegistry().get(runtimeId);
		if (!runtime) {
			printError(`unknown runtime id: ${runtimeId}`);
			process.stdout.write("run `clio configure --list` to see registered runtimes\n");
			return 2;
		}
	}
	const nonInteractive =
		runtime !== null &&
		(args.id !== undefined ||
			args.url !== undefined ||
			args.model !== undefined ||
			args.workerProfile !== undefined ||
			args.workerProfileModel !== undefined ||
			args.apiKey !== undefined ||
			args.apiKeyEnv !== undefined ||
			args.gateway ||
			args.setOrchestrator ||
			args.setWorkerDefault ||
			args.contextWindow !== undefined ||
			args.maxTokens !== undefined ||
			args.reasoning !== undefined);

	if (nonInteractive && runtime) return runNonInteractive(runtime, args);

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
