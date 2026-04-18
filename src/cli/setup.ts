import { createInterface } from "node:readline/promises";
import { type ClioSettings, readSettings, settingsPath, writeSettings } from "../core/config.js";
import { initializeClioHome } from "../core/init.js";
import type { EndpointDescriptor } from "../domains/providers/types/endpoint-descriptor.js";
import { credentialsPresent, openCredentialStore } from "../domains/providers/credentials.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../domains/providers/runtimes/builtins.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../domains/providers/types/runtime-descriptor.js";
import { printError, printOk } from "./shared.js";

const HELP = `clio setup

Usage:
  clio setup                       interactive wizard
  clio setup --list                list registered runtimes
  clio setup <runtime>             interactive wizard pre-filled with runtime
  clio setup <runtime> --id <endpointId> [flags]
  clio setup --remove <endpointId>
  clio setup --rename <oldId> <newId>

Non-interactive flags:
  --id <endpointId>                endpoint id to register (required when non-interactive)
  --url <host>                     endpoint base url (http(s):// or ws://)
  --model <wireModelId>            default model id for this endpoint
  --api-key-env <VAR>              read api key from this env var at call time
  --api-key <literal>              store api key in credentials.yaml (keyed by runtime id)
  --gateway                        mark the endpoint as a gateway
  --set-orchestrator               point settings.orchestrator at this endpoint
  --set-worker-default             point settings.workers.default at this endpoint
  --context-window <N>             capability override
  --reasoning <true|false>         capability override
`;

const DEFAULT_PORTS: Record<string, number> = {
	llamacpp: 8080,
	"llamacpp-anthropic": 8080,
	"llamacpp-completion": 8080,
	"llamacpp-embed": 8080,
	"llamacpp-rerank": 8080,
	lmstudio: 1234,
	"lmstudio-native": 1234,
	ollama: 11434,
	"ollama-native": 11434,
	vllm: 8000,
	sglang: 30000,
	tgi: 8080,
	aphrodite: 2242,
	tabbyapi: 5000,
	"lemonade-anthropic": 8000,
	lemonade: 8000,
	"litellm-gateway": 4000,
	"openai-compat": 8000,
	koboldcpp: 5001,
	mlc: 8000,
	"mistral-rs": 8000,
	localai: 8080,
};

interface ParsedArgs {
	positional: string[];
	help: boolean;
	list: boolean;
	remove?: string;
	renameOld?: string;
	renameNew?: string;
	id?: string;
	url?: string;
	model?: string;
	apiKeyEnv?: string;
	apiKey?: string;
	gateway: boolean;
	setOrchestrator: boolean;
	setWorkerDefault: boolean;
	contextWindow?: number;
	reasoning?: boolean;
}

function parseSetupArgs(argv: ReadonlyArray<string>): ParsedArgs {
	const out: ParsedArgs = {
		positional: [],
		help: false,
		list: false,
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
			case "--url":
				out.url = need();
				break;
			case "--model":
				out.model = need();
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

function groupByKind(
	runtimes: ReadonlyArray<RuntimeDescriptor>,
): { cloud: RuntimeDescriptor[]; local: RuntimeDescriptor[]; subprocess: RuntimeDescriptor[] } {
	const cloud: RuntimeDescriptor[] = [];
	const local: RuntimeDescriptor[] = [];
	const subprocess: RuntimeDescriptor[] = [];
	for (const r of runtimes) {
		if (r.kind === "subprocess") subprocess.push(r);
		else if (r.auth === "api-key" && !r.probe) cloud.push(r);
		else if (r.kind === "http" && r.probe) local.push(r);
		else cloud.push(r);
	}
	const byId = (a: RuntimeDescriptor, b: RuntimeDescriptor): number => a.id.localeCompare(b.id);
	cloud.sort(byId);
	local.sort(byId);
	subprocess.sort(byId);
	return { cloud, local, subprocess };
}

function printRuntimeList(): void {
	const { cloud, local, subprocess } = groupByKind(getRuntimeRegistry().list());
	process.stdout.write("Cloud (api-key):\n");
	for (const r of cloud) process.stdout.write(`  ${r.id.padEnd(22)} ${r.displayName}\n`);
	process.stdout.write("\nLocal HTTP:\n");
	for (const r of local) process.stdout.write(`  ${r.id.padEnd(22)} ${r.displayName}\n`);
	process.stdout.write("\nSubprocess (CLI agents):\n");
	for (const r of subprocess) process.stdout.write(`  ${r.id.padEnd(22)} ${r.displayName}\n`);
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

function setOrchestratorPointer(settings: ClioSettings, descriptor: EndpointDescriptor): void {
	settings.orchestrator.endpoint = descriptor.id;
	if (descriptor.defaultModel) settings.orchestrator.model = descriptor.defaultModel;
}

function setWorkerDefaultPointer(settings: ClioSettings, descriptor: EndpointDescriptor): void {
	settings.workers.default.endpoint = descriptor.id;
	if (descriptor.defaultModel) settings.workers.default.model = descriptor.defaultModel;
}

function printSummary(settings: ClioSettings, descriptor: EndpointDescriptor, probe: ProbeResult | null): void {
	process.stdout.write(`\nsaved endpoint ${descriptor.id} (runtime=${descriptor.runtime})\n`);
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
	process.stdout.write(`\nsettings written to ${settingsPath()}\n`);
}

function buildDescriptor(
	runtime: RuntimeDescriptor,
	id: string,
	parts: {
		url?: string;
		model?: string;
		apiKeyEnv?: string;
		gateway?: boolean;
		contextWindow?: number;
		reasoning?: boolean;
	},
): EndpointDescriptor {
	const descriptor: EndpointDescriptor = { id, runtime: runtime.id };
	if (parts.url) descriptor.url = parts.url;
	if (parts.model) descriptor.defaultModel = parts.model;
	const auth: NonNullable<EndpointDescriptor["auth"]> = {};
	if (parts.apiKeyEnv) auth.apiKeyEnvVar = parts.apiKeyEnv;
	if (Object.keys(auth).length > 0) descriptor.auth = auth;
	if (parts.gateway) descriptor.gateway = true;
	const caps: NonNullable<EndpointDescriptor["capabilities"]> = {};
	if (parts.contextWindow !== undefined) caps.contextWindow = parts.contextWindow;
	if (parts.reasoning !== undefined) caps.reasoning = parts.reasoning;
	if (Object.keys(caps).length > 0) descriptor.capabilities = caps;
	return descriptor;
}

async function runNonInteractive(runtime: RuntimeDescriptor, args: ParsedArgs): Promise<number> {
	if (!args.id) {
		printError("--id is required when passing flags non-interactively");
		return 2;
	}
	const settings = readSettings();
	const existing = settings.endpoints.find((e) => e.id === args.id);
	if (existing && existing.runtime !== runtime.id) {
		printError(`endpoint ${args.id} already exists with runtime ${existing.runtime}`);
		return 2;
	}
	let url: string | undefined = args.url ? normalizeUrl(args.url, runtime.id) : existing?.url;
	if (!url && runtime.kind === "http" && runtime.auth !== "api-key") {
		url = defaultUrlFor(runtime.id);
	}
	const descriptor = buildDescriptor(runtime, args.id, {
		...(url !== undefined ? { url } : {}),
		...(args.model !== undefined ? { model: args.model } : existing?.defaultModel ? { model: existing.defaultModel } : {}),
		...(args.apiKeyEnv !== undefined ? { apiKeyEnv: args.apiKeyEnv } : existing?.auth?.apiKeyEnvVar ? { apiKeyEnv: existing.auth.apiKeyEnvVar } : {}),
		gateway: args.gateway || existing?.gateway === true,
		...(args.contextWindow !== undefined ? { contextWindow: args.contextWindow } : {}),
		...(args.reasoning !== undefined ? { reasoning: args.reasoning } : {}),
	});
	if (args.apiKey) openCredentialStore().set(runtime.id, args.apiKey);
	applyEndpoint(settings, descriptor);
	if (args.setOrchestrator) setOrchestratorPointer(settings, descriptor);
	if (args.setWorkerDefault) setWorkerDefaultPointer(settings, descriptor);
	writeSettings(settings);
	const probe = await runtimeProbe(runtime, descriptor);
	printSummary(settings, descriptor, probe);
	printOk(`endpoint ${args.id} saved`);
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
	const all = registry.list();
	const { cloud, local, subprocess } = groupByKind(all);
	const ordered: RuntimeDescriptor[] = [...cloud, ...local, ...subprocess];
	process.stdout.write("\nRegistered runtimes:\n");
	process.stdout.write("  Cloud (api-key):\n");
	for (const r of cloud) process.stdout.write(`    ${r.id}\n`);
	process.stdout.write("  Local HTTP:\n");
	for (const r of local) process.stdout.write(`    ${r.id}\n`);
	process.stdout.write("  Subprocess (CLI agents):\n");
	for (const r of subprocess) process.stdout.write(`    ${r.id}\n`);
	for (;;) {
		const answer = await ask(rl, "\nRuntime id");
		if (answer === null) return null;
		if (answer.length === 0) continue;
		const match = ordered.find((r) => r.id === answer);
		if (match) return match;
		process.stderr.write(`unknown runtime id: ${answer}\n`);
	}
}

async function runInteractive(
	rl: ReturnType<typeof createInterface>,
	preselectedRuntime: RuntimeDescriptor | null,
	defaults: ParsedArgs,
): Promise<number> {
	const runtime = preselectedRuntime ?? (await pickRuntime(rl));
	if (!runtime) {
		printError("setup cancelled");
		return 0;
	}
	const settings = readSettings();
	const suggestedId = defaults.id ?? deriveEndpointId(runtime.id, settings.endpoints);
	const idInput = await ask(rl, "Endpoint id", suggestedId);
	if (idInput === null || idInput.length === 0) {
		printError("endpoint id is required");
		return 2;
	}
	const endpointId = idInput;

	let url: string | undefined;
	if (runtime.kind === "http") {
		if (runtime.auth === "api-key" && !runtime.probe) {
			const urlInput = await ask(rl, "Base URL (optional; leave blank for runtime default)", defaults.url ?? "");
			if (urlInput !== null && urlInput.length > 0) url = normalizeUrl(urlInput, runtime.id);
		} else {
			const urlInput = await ask(rl, "Endpoint URL", defaults.url ?? defaultUrlFor(runtime.id));
			if (urlInput === null) return 0;
			url = normalizeUrl(urlInput.length > 0 ? urlInput : defaultUrlFor(runtime.id), runtime.id);
		}
	}

	let apiKeyEnv: string | undefined;
	let apiKeyLiteral: string | undefined;
	if (runtime.auth === "api-key") {
		process.stdout.write("\nAPI key source:\n  1. env var\n  2. stored literal (credentials.yaml)\n");
		const choice = await ask(rl, "Selection", "1");
		if (choice === "2") {
			const literal = await ask(rl, "API key literal (stored in credentials.yaml, mode 0600)");
			if (literal !== null && literal.length > 0) apiKeyLiteral = literal;
		} else {
			const envDefault = defaults.apiKeyEnv ?? runtime.credentialsEnvVar ?? "";
			const envAnswer = await ask(rl, "Env var name", envDefault);
			if (envAnswer !== null && envAnswer.length > 0) apiKeyEnv = envAnswer;
		}
	}

	let model: string | undefined = defaults.model;
	const tentative = buildDescriptor(runtime, endpointId, {
		...(url !== undefined ? { url } : {}),
		...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
		gateway: defaults.gateway,
		...(defaults.contextWindow !== undefined ? { contextWindow: defaults.contextWindow } : {}),
		...(defaults.reasoning !== undefined ? { reasoning: defaults.reasoning } : {}),
	});

	if (!model && runtime.kind === "http") {
		const discovered = await runtimeProbeModels(runtime, tentative);
		if (discovered.length > 0) {
			process.stdout.write("\nDiscovered models:\n");
			for (const [i, id] of discovered.entries()) process.stdout.write(`  ${i + 1}. ${id}\n`);
			const pick = await ask(rl, "Selection (blank to skip)", "1");
			if (pick && pick.length > 0) {
				const n = Number(pick);
				if (Number.isInteger(n) && n >= 1 && n <= discovered.length) model = discovered[n - 1];
			}
		}
		if (!model) {
			const manual = await ask(rl, "Default model id (blank to leave empty)", "");
			if (manual && manual.length > 0) model = manual;
		}
	} else if (!model) {
		const manual = await ask(rl, "Default model id (blank to leave empty)", "");
		if (manual && manual.length > 0) model = manual;
	}

	const gatewayAnswer = defaults.gateway
		? true
		: await askYesNo(rl, "Mark as gateway?", false);

	const descriptor = buildDescriptor(runtime, endpointId, {
		...(url !== undefined ? { url } : {}),
		...(model !== undefined ? { model } : {}),
		...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
		gateway: gatewayAnswer,
		...(defaults.contextWindow !== undefined ? { contextWindow: defaults.contextWindow } : {}),
		...(defaults.reasoning !== undefined ? { reasoning: defaults.reasoning } : {}),
	});

	if (apiKeyLiteral) openCredentialStore().set(runtime.id, apiKeyLiteral);

	const probe = await runtimeProbe(runtime, descriptor);
	if (probe) {
		const line = probe.ok
			? `probe ok${probe.latencyMs !== undefined ? ` (${probe.latencyMs}ms)` : ""}${probe.serverVersion ? ` ${probe.serverVersion}` : ""}`
			: `probe failed: ${probe.error ?? "unknown"}`;
		process.stdout.write(`\n${line}\n`);
		if (!probe.ok) {
			const keepAnyway = await askYesNo(rl, "save endpoint anyway?", true);
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

	applyEndpoint(settings, descriptor);
	if (setOrchestrator) setOrchestratorPointer(settings, descriptor);
	if (setWorkerDefault) setWorkerDefaultPointer(settings, descriptor);
	writeSettings(settings);

	printSummary(settings, descriptor, probe);
	printOk(`endpoint ${endpointId} saved`);
	return 0;
}

function runRemove(id: string): number {
	const settings = readSettings();
	const before = settings.endpoints.length;
	settings.endpoints = settings.endpoints.filter((e) => e.id !== id);
	if (settings.endpoints.length === before) {
		printError(`no endpoint with id ${id}`);
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
	settings.scope = settings.scope.filter((entry) => {
		const [head] = entry.split("/");
		return head !== id;
	});
	writeSettings(settings);
	printOk(`removed endpoint ${id}`);
	return 0;
}

function runRename(oldId: string, newId: string): number {
	if (oldId === newId) {
		printError("old and new id are identical");
		return 2;
	}
	const settings = readSettings();
	if (settings.endpoints.some((e) => e.id === newId)) {
		printError(`endpoint id already exists: ${newId}`);
		return 2;
	}
	const target = settings.endpoints.find((e) => e.id === oldId);
	if (!target) {
		printError(`no endpoint with id ${oldId}`);
		return 1;
	}
	target.id = newId;
	if (settings.orchestrator.endpoint === oldId) settings.orchestrator.endpoint = newId;
	if (settings.workers.default.endpoint === oldId) settings.workers.default.endpoint = newId;
	settings.scope = settings.scope.map((entry) => {
		const [head, ...rest] = entry.split("/");
		if (head !== oldId) return entry;
		return rest.length === 0 ? newId : `${newId}/${rest.join("/")}`;
	});
	writeSettings(settings);
	printOk(`renamed ${oldId} to ${newId}`);
	return 0;
}

export async function runSetupCommand(argv: ReadonlyArray<string>): Promise<number> {
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
		printRuntimeList();
		return 0;
	}
	if (args.remove) return runRemove(args.remove);
	if (args.renameOld && args.renameNew) return runRename(args.renameOld, args.renameNew);

	const runtimeId = args.positional[0];
	let runtime: RuntimeDescriptor | null = null;
	if (runtimeId) {
		runtime = getRuntimeRegistry().get(runtimeId);
		if (!runtime) {
			printError(`unknown runtime id: ${runtimeId}`);
			process.stdout.write("run `clio setup --list` to see registered runtimes\n");
			return 2;
		}
	}

	const nonInteractive =
		runtime !== null &&
		(args.id !== undefined ||
			args.url !== undefined ||
			args.model !== undefined ||
			args.apiKey !== undefined ||
			args.apiKeyEnv !== undefined ||
			args.gateway ||
			args.setOrchestrator ||
			args.setWorkerDefault ||
			args.contextWindow !== undefined ||
			args.reasoning !== undefined);

	if (nonInteractive && runtime) return runNonInteractive(runtime, args);

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return await runInteractive(rl, runtime, args);
	} catch (err) {
		printError(err instanceof Error ? err.message : String(err));
		return 1;
	} finally {
		rl.close();
	}
}
