import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { Value } from "@sinclair/typebox/value";
import chalk from "chalk";
import { type ClioSettings, readSettings, settingsPath, writeSettings } from "../core/config.js";
import { DEFAULT_SETTINGS_YAML, type EndpointSpec } from "../core/defaults.js";
import { initializeClioHome } from "../core/init.js";
import { SettingsSchema } from "../domains/config/schema.js";
import type { LocalEngineId } from "../domains/providers/catalog.js";
import type { EndpointProbeResult } from "../domains/providers/runtime-contract.js";
import { llamacppAdapter } from "../domains/providers/runtimes/llamacpp.js";
import { lmstudioAdapter } from "../domains/providers/runtimes/lmstudio.js";
import { trimTrailingSlash } from "../domains/providers/runtimes/local-http.js";
import { ollamaAdapter } from "../domains/providers/runtimes/ollama.js";
import { openaiCompatAdapter } from "../domains/providers/runtimes/openai-compat.js";
import { parseFlags, printError, printOk } from "./shared.js";

type SetupPresetId = "mini" | "dynamo" | "ollama" | "openai-compat";

interface SetupPreset {
	id: SetupPresetId;
	engine: LocalEngineId;
	label: string;
	description: string;
	endpointName: string;
	defaultUrl: string;
}

interface LocalProbeAdapter {
	probeEndpoints(endpoints: Record<string, EndpointSpec>): Promise<EndpointProbeResult[]>;
}

const SETUP_PRESETS: readonly SetupPreset[] = [
	{
		id: "mini",
		engine: "llamacpp",
		label: "mini",
		description: "llama.cpp on http://127.0.0.1:8080",
		endpointName: "mini",
		defaultUrl: "http://127.0.0.1:8080",
	},
	{
		id: "dynamo",
		engine: "lmstudio",
		label: "dynamo",
		description: "LM Studio on http://127.0.0.1:1234",
		endpointName: "dynamo",
		defaultUrl: "http://127.0.0.1:1234",
	},
	{
		id: "ollama",
		engine: "ollama",
		label: "ollama",
		description: "Ollama on http://127.0.0.1:11434",
		endpointName: "local",
		defaultUrl: "http://127.0.0.1:11434",
	},
	{
		id: "openai-compat",
		engine: "openai-compat",
		label: "openai-compatible",
		description: "a custom /v1 endpoint on http://127.0.0.1:8000",
		endpointName: "local",
		defaultUrl: "http://127.0.0.1:8000",
	},
] as const;

const PRESET_BY_ID = new Map(SETUP_PRESETS.map((preset) => [preset.id, preset]));
function presetForId(id: SetupPresetId): SetupPreset {
	const preset = PRESET_BY_ID.get(id);
	if (!preset) throw new Error(`missing setup preset ${id}`);
	return preset;
}
const PRESET_BY_ENGINE = new Map<LocalEngineId, SetupPreset>([
	["llamacpp", presetForId("mini")],
	["lmstudio", presetForId("dynamo")],
	["ollama", presetForId("ollama")],
	["openai-compat", presetForId("openai-compat")],
]);

const LOCAL_ADAPTERS = {
	llamacpp: llamacppAdapter as LocalProbeAdapter,
	lmstudio: lmstudioAdapter as LocalProbeAdapter,
	ollama: ollamaAdapter as LocalProbeAdapter,
	"openai-compat": openaiCompatAdapter as LocalProbeAdapter,
} satisfies Record<LocalEngineId, LocalProbeAdapter>;

const HELP = `clio setup

Usage:
  clio setup

Guided setup boots configuration, probes local endpoints, and stores provider +
model defaults for both interactive chat and workers.
`;

function schemaError(candidate: unknown): string {
	const first = [...Value.Errors(SettingsSchema, candidate)][0];
	return `${first?.path ?? "(root)"}: ${first?.message ?? "unknown schema error"}`;
}

function ensureSettingsValid(candidate: unknown): asserts candidate is ClioSettings {
	if (Value.Check(SettingsSchema, candidate)) return;
	throw new Error(schemaError(candidate));
}

function timestampSuffix(): string {
	const now = new Date();
	const year = String(now.getUTCFullYear());
	const month = String(now.getUTCMonth() + 1).padStart(2, "0");
	const day = String(now.getUTCDate()).padStart(2, "0");
	const hour = String(now.getUTCHours()).padStart(2, "0");
	const minute = String(now.getUTCMinutes()).padStart(2, "0");
	const second = String(now.getUTCSeconds()).padStart(2, "0");
	return `${year}${month}${day}-${hour}${minute}${second}`;
}

function normalizeEndpointValue(raw: string | undefined): string | undefined {
	const trimmed = raw?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function normalizeEndpointUrl(input: string, defaultUrl: string): string {
	const trimmed = input.trim();
	if (trimmed.length === 0) return trimTrailingSlash(defaultUrl);
	const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
	const withScheme = hasScheme ? trimmed : `http://${trimmed}`;
	try {
		const parsed = new URL(withScheme);
		if (!hasScheme && !parsed.port) {
			const fallbackPort = new URL(defaultUrl).port;
			if (fallbackPort) parsed.port = fallbackPort;
		}
		return trimTrailingSlash(parsed.toString());
	} catch {
		return trimTrailingSlash(withScheme);
	}
}

function endpointKey(engine: LocalEngineId, endpointName: string): string {
	return `${engine}/${endpointName}`;
}

function settingsEqual(a: ClioSettings, b: ClioSettings): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function uniqueEnabledRuntimes(existing: ReadonlyArray<string>, engine: LocalEngineId): string[] {
	return Array.from(new Set(["native", ...existing, engine]));
}

function sanitizeProvider(_settings: Readonly<ClioSettings>, provider?: string): LocalEngineId | undefined {
	return PRESET_BY_ENGINE.has(provider as LocalEngineId) ? (provider as LocalEngineId) : undefined;
}

function hasOrchestratorTarget(settings: Readonly<ClioSettings>): boolean {
	const provider = settings.orchestrator.provider;
	if (!provider) return false;
	if (!sanitizeProvider(settings, provider)) return false;
	return !!settings.orchestrator.endpoint;
}

function formatTargetFor(settings: Readonly<ClioSettings>, kind: "chat" | "worker"): string {
	if (kind === "chat") {
		const provider = settings.orchestrator.provider?.trim();
		const endpoint = settings.orchestrator.endpoint?.trim();
		const model = settings.orchestrator.model?.trim();
		if (!provider || !endpoint) return "not configured";
		const safeProvider = sanitizeProvider(settings, provider);
		if (!safeProvider) return "not configured";
		const url = settings.providers[safeProvider]?.endpoints?.[endpoint]?.url ?? "(not configured)";
		return `${provider}/${endpoint}   ${trimTrailingSlash(url)}   ${model ?? "(not configured)"}`;
	}

	const provider = settings.workers.default.provider?.trim();
	const endpoint = settings.workers.default.endpoint?.trim();
	const model = settings.workers.default.model?.trim();
	if (!provider || !endpoint) return "not configured";
	const safeProvider = sanitizeProvider(settings, provider);
	if (!safeProvider) return "not configured";
	const url = settings.providers[safeProvider]?.endpoints?.[endpoint]?.url ?? "(not configured)";
	return `${provider}/${endpoint}   ${trimTrailingSlash(url)}   ${model ?? "(not configured)"}`;
}

function currentModelForEndpoint(
	settings: Readonly<ClioSettings>,
	preset: SetupPreset,
	endpointName: string,
): string | undefined {
	const direct = normalizeEndpointValue(settings.providers[preset.engine]?.endpoints?.[endpointName]?.default_model);
	if (direct) return direct;
	if (settings.orchestrator.provider === preset.engine && settings.orchestrator.endpoint === endpointName) {
		return normalizeEndpointValue(settings.orchestrator.model);
	}
	if (settings.workers.default.provider === preset.engine && settings.workers.default.endpoint === endpointName) {
		return normalizeEndpointValue(settings.workers.default.model);
	}
	return undefined;
}

async function ask(
	rl: ReturnType<typeof createInterface>,
	label: string,
	defaultValue?: string,
): Promise<string | null> {
	const suffix = defaultValue && defaultValue.length > 0 ? `${chalk.dim(`[${defaultValue}]`)} ` : "";
	try {
		const answer = await rl.question(`${label} ${suffix}`);
		const trimmed = answer.trim();
		if (trimmed.length === 0) return defaultValue ?? "";
		if (trimmed.toLowerCase() === "q" || trimmed.toLowerCase() === "quit") return null;
		return trimmed;
	} catch {
		return null;
	}
}

function parseNumeric(input: string): number | null {
	const value = Number(input);
	if (!Number.isInteger(value)) return null;
	return value;
}

async function askNumeric(
	rl: ReturnType<typeof createInterface>,
	label: string,
	min: number,
	max: number,
	defaultValue: number,
): Promise<number | null> {
	while (true) {
		const answer = await ask(rl, `${label}`, String(defaultValue));
		if (answer === null) return null;
		const numeric = parseNumeric(answer);
		if (numeric !== null && numeric >= min && numeric <= max) return numeric;
		printError(`invalid selection: ${answer}`);
	}
}

async function askYesNo(
	rl: ReturnType<typeof createInterface>,
	label: string,
	defaultValue: boolean,
): Promise<boolean | null> {
	const marker = defaultValue ? "Y/n" : "y/N";
	while (true) {
		const answer = await ask(rl, `${label} [${marker}]`);
		if (answer === null) return null;
		if (answer.length === 0) return defaultValue;
		const lc = answer.toLowerCase();
		if (["y", "yes"].includes(lc)) return true;
		if (["n", "no"].includes(lc)) return false;
		printError(`invalid response: ${answer}`);
	}
}

async function loadSettingsWithRepair(rl: ReturnType<typeof createInterface>): Promise<ClioSettings> {
	try {
		const settings = readSettings();
		ensureSettingsValid(settings);
		return settings;
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		const path = settingsPath();
		printError("settings.yaml is invalid", reason);
		const answer = await ask(rl, `Back up ${path} and restore a clean template?`, "y");
		if (!answer) return readSettings();
		const backupPath = `${path}.bak-${timestampSuffix()}`;
		renameSync(path, backupPath);
		writeFileSync(path, DEFAULT_SETTINGS_YAML, { encoding: "utf8", mode: 0o644 });
		printOk(`restored ${path} and kept the old file at ${backupPath}`);
		const restored = readSettings();
		ensureSettingsValid(restored);
		return restored;
	}
}

async function probePresetEndpoint(preset: SetupPreset, spec: EndpointSpec): Promise<EndpointProbeResult> {
	const adapter = LOCAL_ADAPTERS[preset.engine];
	const started = Date.now();
	try {
		const [result] = await adapter.probeEndpoints({ [preset.endpointName]: spec });
		if (!result) {
			return {
				name: preset.endpointName,
				url: spec.url,
				ok: false,
				latencyMs: Date.now() - started,
				error: "empty probe result",
				models: [],
			};
		}
		return {
			...result,
			name: preset.endpointName,
			url: spec.url,
			latencyMs: result.latencyMs ?? Date.now() - started,
		};
	} catch (err) {
		return {
			name: preset.endpointName,
			url: spec.url,
			ok: false,
			latencyMs: Date.now() - started,
			error: err instanceof Error ? err.message : String(err),
			models: [],
		};
	}
}

function buildEngineCounts(settings: Readonly<ClioSettings>): string[] {
	return SETUP_PRESETS.map((preset) => {
		const count = Object.keys(settings.providers[preset.engine]?.endpoints ?? {}).length;
		return `${preset.label} (${count})`;
	});
}

function listConfiguredEndpoints(
	settings: Readonly<ClioSettings>,
): Array<{ preset: SetupPreset; endpointName: string; spec: EndpointSpec }> {
	const rows: Array<{ preset: SetupPreset; endpointName: string; spec: EndpointSpec }> = [];
	for (const preset of SETUP_PRESETS) {
		for (const [name, spec] of Object.entries(settings.providers[preset.engine]?.endpoints ?? {})) {
			rows.push({ preset, endpointName: name, spec: spec as EndpointSpec });
		}
	}
	return rows;
}

function showStatusSummary(settings: Readonly<ClioSettings>, probeState: Map<string, EndpointProbeResult>): void {
	process.stdout.write(`\nclio setup · settings ${settingsPath()}\n\n`);
	process.stdout.write(`active chat    ${formatTargetFor(settings, "chat")}\n`);
	process.stdout.write(`active worker  ${formatTargetFor(settings, "worker")}\n`);
	process.stdout.write(
		`safety         ${settings.safetyLevel}       budget  $${settings.budget.sessionCeilingUsd}/session       mode  ${settings.defaultMode}\n`,
	);
	process.stdout.write(`runtimes       ${(settings.runtimes.enabled ?? []).join(", ")}\n\n`);

	const endpoints = listConfiguredEndpoints(settings);
	process.stdout.write(`endpoints (${endpoints.length}):\n`);
	if (endpoints.length === 0) {
		process.stdout.write("  (none configured)\n\n");
		return;
	}
	for (const endpoint of endpoints) {
		const key = endpointKey(endpoint.preset.engine, endpoint.endpointName);
		const probe = probeState.get(key);
		let status = "not probed";
		if (probe) {
			status = probe.ok
				? `OK · ${probe.models?.length ?? 0} model${(probe.models?.length ?? 0) === 1 ? "" : "s"} · ${probe.latencyMs ?? 0}ms`
				: `fail · ${probe.error ?? "unknown"}`;
		}
		process.stdout.write(
			`  ${endpoint.preset.engine}/${endpoint.endpointName}  ${trimTrailingSlash(endpoint.spec.url)}   [${status}]\n`,
		);
	}
	process.stdout.write("\n");
}

function renderModelList(models: ReadonlyArray<string>): string {
	if (models.length === 0) return "no models detected";
	return models.map((model, index) => `  ${index + 1}. ${model}`).join("\n");
}

function maybeModel(target?: string | null): { model?: string } {
	const value = normalizeEndpointValue(target ?? undefined);
	if (!value) return {};
	return { model: value };
}

function chooseEndpointName(rl: ReturnType<typeof createInterface>, preset: SetupPreset): Promise<string | null> {
	return ask(rl, "Endpoint name", preset.endpointName);
}

async function actionAddOrEditEndpoint(
	rl: ReturnType<typeof createInterface>,
	settings: ClioSettings,
	probeState: Map<string, EndpointProbeResult>,
): Promise<boolean> {
	process.stdout.write("\nLocal engines:\n");
	const counts = buildEngineCounts(settings);
	for (const [index, preset] of SETUP_PRESETS.entries()) {
		process.stdout.write(`  ${index + 1}. ${preset.label.padEnd(18)} ${counts[index]}\n`);
	}
	const presetChoice = await askNumeric(rl, "Selection", 1, SETUP_PRESETS.length, 1);
	if (presetChoice === null) return false;
	const preset = SETUP_PRESETS[presetChoice - 1];
	if (!preset) return true;

	const existingEntries = Object.entries(settings.providers[preset.engine]?.endpoints ?? {});
	process.stdout.write(`\nConfigured ${preset.engine} endpoints:\n`);
	for (const [index, [name]] of existingEntries.entries()) {
		process.stdout.write(`  ${index + 1}. ${name}\n`);
	}
	process.stdout.write(`  ${existingEntries.length + 1}. add new\n`);
	const endpointChoice = await askNumeric(
		rl,
		"Selection",
		existingEntries.length + 1,
		existingEntries.length + 1,
		existingEntries.length > 0 ? 1 : existingEntries.length + 1,
	);
	if (endpointChoice === null) return false;

	let endpointName = "";
	let endpointSpec: EndpointSpec | null = null;
	if (endpointChoice === existingEntries.length + 1) {
		const inputName = await chooseEndpointName(rl, preset);
		if (inputName === null) return false;
		endpointName = inputName.trim().length > 0 ? inputName.trim() : preset.endpointName;
	} else {
		const picked = existingEntries[endpointChoice - 1];
		if (!picked) return true;
		endpointName = picked[0];
		endpointSpec = picked[1] as EndpointSpec;
	}

	let model = "";
	let probeResult: EndpointProbeResult | null = null;
	let normalizedUrl = endpointSpec?.url ? normalizeEndpointUrl(endpointSpec.url, preset.defaultUrl) : "";
	let useUrlPrompt = !endpointSpec?.url;

	if (endpointSpec?.url) {
		const silentProbe = await probePresetEndpoint({ ...preset, endpointName }, { ...endpointSpec, url: normalizedUrl });
		if (silentProbe.ok) {
			probeResult = silentProbe;
			probeState.set(endpointKey(preset.engine, endpointName), silentProbe);
			const preferred = currentModelForEndpoint(settings, preset, endpointName);
			if (silentProbe.models && silentProbe.models.length > 0) {
				model = preferred && silentProbe.models.includes(preferred) ? preferred : (silentProbe.models[0] ?? "");
			} else {
				model = preferred ?? "";
			}
		} else {
			process.stdout.write(chalk.yellow(`\nprobe failed: ${silentProbe.error ?? "unknown"}\n`));
			const recovery = await askNumeric(rl, "1) retry URL 2) type model manually", 1, 2, 2);
			if (recovery === null) return false;
			if (recovery === 2) {
				const manualModel = await ask(rl, "Model id (required; probe could not auto-detect one)", "");
				if (manualModel === null) return false;
				if (!manualModel.trim()) {
					printError("model id is required");
					return true;
				}
				model = manualModel.trim();
				useUrlPrompt = false;
			}
		}
	}

	while (useUrlPrompt) {
		const answer = await ask(rl, "Endpoint URL", endpointSpec?.url ?? preset.defaultUrl);
		if (answer === null) return false;
		normalizedUrl = normalizeEndpointUrl(answer, preset.defaultUrl);
		if (normalizedUrl !== answer.trim()) {
			process.stdout.write(chalk.dim(`  using ${normalizedUrl}\n`));
		}
		probeResult = await probePresetEndpoint({ ...preset, endpointName }, { ...(endpointSpec ?? {}), url: normalizedUrl });
		if (probeResult.ok) {
			probeState.set(endpointKey(preset.engine, endpointName), probeResult);
			useUrlPrompt = false;
			break;
		}
		process.stdout.write(chalk.yellow(`\nprobe failed: ${probeResult.error ?? "not reachable"}\n`));
		const recovery = await askNumeric(rl, "1) retry URL 2) type model manually", 1, 2, 1);
		if (recovery === null) return false;
		if (recovery === 2) {
			const manualModel = await ask(rl, "Model id (required; probe could not auto-detect one)", "");
			if (manualModel === null) return false;
			if (!manualModel.trim()) {
				printError("model id is required");
				return true;
			}
			model = manualModel.trim();
			useUrlPrompt = false;
			break;
		}
	}

	if (!model && probeResult?.ok && probeResult.models && probeResult.models.length > 0) {
		process.stdout.write(`\nDetected models:\n${renderModelList(probeResult.models)}\n\n`);
		const preferred = currentModelForEndpoint(settings, preset, endpointName);
		const defaultChoice = preferred ? probeResult.models.indexOf(preferred) + 1 : 1;
		const selected = await askNumeric(rl, "Selection", 1, probeResult.models.length, defaultChoice || 1);
		if (selected === null) return false;
		const picked = probeResult.models[selected - 1];
		if (!picked) {
			printError("model id is required");
			return true;
		}
		model = picked;
	}

	if (!model) {
		const manualModel = await ask(rl, "Model id", "");
		if (manualModel === null) return false;
		if (!manualModel.trim()) {
			printError("model id is required");
			return true;
		}
		model = manualModel.trim();
	}

	let apiKey: string | undefined;
	if (preset.engine === "openai-compat") {
		const input = await ask(rl, "API key (leave blank for none)", endpointSpec?.api_key ?? "");
		if (input === null) return false;
		if (input.trim()) apiKey = input.trim();
	}

	settings.providers[preset.engine].endpoints[endpointName] = {
		...(endpointSpec ?? {}),
		url: normalizedUrl,
		...(apiKey ? { api_key: apiKey } : {}),
		default_model: model,
	};
	settings.runtimes.enabled = uniqueEnabledRuntimes(settings.runtimes.enabled, preset.engine);

	const firstUsable = !hasOrchestratorTarget(settings);
	const useForChat = await askYesNo(rl, "use for chat target?", firstUsable);
	if (useForChat === null) return false;
	if (useForChat) {
		settings.orchestrator = {
			provider: preset.engine,
			endpoint: endpointName,
			...maybeModel(model),
		};
		settings.provider = {
			...settings.provider,
			active: preset.engine,
			model,
		};
	}
	const useForWorker = await askYesNo(rl, "use for worker target?", firstUsable);
	if (useForWorker === null) return false;
	if (useForWorker) {
		settings.workers.default = {
			provider: preset.engine,
			endpoint: endpointName,
			...maybeModel(model),
		};
	}
	printOk(`updated ${preset.engine}/${endpointName}`);
	return true;
}

function renderTargetChoices(entries: ReadonlyArray<{ preset: SetupPreset; endpointName: string }>): void {
	for (const [index, entry] of entries.entries()) {
		process.stdout.write(`  ${index + 1}. ${entry.preset.engine}/${entry.endpointName}\n`);
	}
}

async function actionSwitchTarget(rl: ReturnType<typeof createInterface>, settings: ClioSettings): Promise<boolean> {
	const entries = listConfiguredEndpoints(settings);
	if (entries.length === 0) {
		printError("No endpoints configured yet.");
		return true;
	}

	process.stdout.write("\nAvailable endpoints:\n");
	renderTargetChoices(entries);
	const chatChoice = await askNumeric(rl, "Selection for chat", 1, entries.length, 1);
	if (chatChoice === null) return false;
	const chatTarget = entries[chatChoice - 1];
	if (!chatTarget) return true;

	process.stdout.write("\nWorker target:\n");
	process.stdout.write("  0. same as chat\n");
	renderTargetChoices(entries);
	const workerChoice = await askNumeric(rl, "Selection", 0, entries.length, 0);
	if (workerChoice === null) return false;
	const workerTarget = workerChoice === 0 ? chatTarget : entries[workerChoice - 1];
	if (!workerTarget) return true;

	settings.orchestrator = {
		provider: chatTarget.preset.engine,
		endpoint: chatTarget.endpointName,
		...maybeModel(chatTarget.spec.default_model),
	};
	settings.provider = {
		...settings.provider,
		active: chatTarget.preset.engine,
		model: chatTarget.spec.default_model ?? settings.provider?.model ?? null,
	};
	settings.workers.default = {
		provider: workerTarget.preset.engine,
		endpoint: workerTarget.endpointName,
		...maybeModel(workerTarget.spec.default_model),
	};
	return true;
}

async function actionProbeAll(
	_rl: ReturnType<typeof createInterface>,
	settings: Readonly<ClioSettings>,
	probeState: Map<string, EndpointProbeResult>,
): Promise<boolean> {
	const endpoints = listConfiguredEndpoints(settings);
	if (endpoints.length === 0) {
		printError("No endpoints configured yet.");
		return true;
	}
	process.stdout.write("\nProbing all configured endpoints\n");
	for (const endpoint of endpoints) {
		const result = await probePresetEndpoint(
			{ ...endpoint.preset, endpointName: endpoint.endpointName },
			{
				...endpoint.spec,
			},
		);
		const line = result.ok
			? `OK · ${result.models?.length ?? 0} models · ${result.latencyMs ?? 0}ms`
			: `fail · ${result.error ?? "unknown"}`;
		process.stdout.write(
			`  ${endpoint.preset.engine}/${endpoint.endpointName} ${trimTrailingSlash(endpoint.spec.url)} [${line}]\n`,
		);
		probeState.set(endpointKey(endpoint.preset.engine, endpoint.endpointName), result);
	}
	process.stdout.write("\n");
	return true;
}

async function actionSafety(rl: ReturnType<typeof createInterface>, settings: ClioSettings): Promise<boolean> {
	const options = [
		{ value: "suggest", description: "ask for confirmation before edits" },
		{ value: "auto-edit", description: "apply safe edits automatically" },
		{ value: "full-auto", description: "apply edits without prompts" },
	] as const;
	process.stdout.write("\nChoose safety level:\n");
	for (const [index, option] of options.entries()) {
		const marker = option.value === settings.safetyLevel ? " *" : "";
		process.stdout.write(`  ${index + 1}. ${option.value}  ${option.description}${marker}\n`);
	}
	const defaultIndex = Math.max(1, options.findIndex((option) => option.value === settings.safetyLevel) + 1);
	const selected = await askNumeric(rl, "Selection", 1, options.length, defaultIndex);
	if (selected === null) return false;
	const picked = options[selected - 1];
	if (!picked) return true;
	settings.safetyLevel = picked.value;
	return true;
}

async function actionBudget(rl: ReturnType<typeof createInterface>, settings: ClioSettings): Promise<boolean> {
	while (true) {
		const value = await ask(rl, "sessionCeilingUsd", String(settings.budget.sessionCeilingUsd));
		if (value === null) return false;
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			settings.budget.sessionCeilingUsd = parsed;
			break;
		}
		printError("sessionCeilingUsd must be a number");
	}
	while (true) {
		const value = await ask(rl, "concurrency", String(settings.budget.concurrency));
		if (value === null) return false;
		if (value.toLowerCase() === "auto") {
			settings.budget.concurrency = "auto";
			break;
		}
		const parsed = Number(value);
		if (Number.isInteger(parsed) && parsed > 0) {
			settings.budget.concurrency = parsed;
			break;
		}
		printError("concurrency must be 'auto' or a positive integer");
	}
	return true;
}

async function actionOpenSettings(rl: ReturnType<typeof createInterface>, settings: ClioSettings): Promise<boolean> {
	const editor = process.env.EDITOR?.trim() || (process.platform === "win32" ? "notepad" : "vi");
	const path = settingsPath();
	const backupPath = `${path}.backup-${timestampSuffix()}`;
	const previous = readFileSync(path, "utf8");
	writeFileSync(backupPath, previous, { encoding: "utf8", mode: 0o644 });
	const exitCode = await new Promise<number>((resolve, reject) => {
		const child = spawn(editor, [path], { stdio: "inherit" });
		child.once("error", reject);
		child.once("close", (code) => resolve(code ?? 0));
	});
	if (exitCode !== 0) {
		printError(`editor exited with status ${exitCode}`);
		return true;
	}
	try {
		const next = readSettings();
		ensureSettingsValid(next);
		Object.assign(settings, next);
		return true;
	} catch (err) {
		printError("settings.yaml failed validation", err instanceof Error ? err.message : String(err));
		const restore = await askYesNo(rl, `restore backup from ${backupPath}?`, false);
		if (!restore) return true;
		writeFileSync(path, previous, { encoding: "utf8", mode: 0o644 });
		const restored = readSettings();
		Object.assign(settings, restored);
		printOk(`restored ${path}`);
		return true;
	}
}

async function actionReset(
	rl: ReturnType<typeof createInterface>,
	settings: ClioSettings,
	probeState: Map<string, EndpointProbeResult>,
): Promise<boolean> {
	const confirm = await ask(rl, 'type "reset" to confirm', "");
	if (confirm === null) return false;
	if (confirm !== "reset") {
		printError("reset aborted");
		return true;
	}
	const path = settingsPath();
	const backupPath = `${path}.backup-${timestampSuffix()}`;
	renameSync(path, backupPath);
	writeFileSync(path, DEFAULT_SETTINGS_YAML, { encoding: "utf8", mode: 0o644 });
	const updated = readSettings();
	Object.assign(settings, updated);
	probeState.clear();
	printOk(`settings reset. backup written to ${backupPath}`);
	return true;
}

async function promptSaveOnExit(rl: ReturnType<typeof createInterface>, settings: ClioSettings): Promise<void> {
	const onDisk = readSettings();
	if (settingsEqual(settings, onDisk)) {
		return;
	}
	const shouldSave = await askYesNo(rl, "save changes before exit?", false);
	if (!shouldSave) return;
	await writeSettingsAtomically(settings);
}

async function writeSettingsAtomically(settings: ClioSettings): Promise<void> {
	const path = settingsPath();
	const backupPath = `${path}.backup-write-${timestampSuffix()}`;
	let hadExisting = false;
	if (existsSync(path)) {
		hadExisting = true;
		copyFileSync(path, backupPath);
	}
	try {
		writeSettings(settings);
	} catch (err) {
		if (hadExisting) {
			copyFileSync(backupPath, path);
		}
		throw err;
	}
}

export async function runSetupCommand(argv: ReadonlyArray<string>): Promise<number> {
	const { flags, positional } = parseFlags([...argv]);
	if (flags.has("help") || flags.has("h")) {
		process.stdout.write(HELP);
		return 0;
	}
	if (positional.length > 0) {
		printError("usage: clio setup");
		process.stdout.write(HELP);
		return 2;
	}

	initializeClioHome();
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const probeState = new Map<string, EndpointProbeResult>();
	try {
		const settings = await loadSettingsWithRepair(rl);
		let autoAdvanceDone = false;
		while (true) {
			showStatusSummary(settings, probeState);
			if (!hasOrchestratorTarget(settings) && !autoAdvanceDone) {
				autoAdvanceDone = true;
				const continueSession = await actionAddOrEditEndpoint(rl, settings, probeState);
				if (!continueSession) {
					printOk("setup cancelled");
					return 0;
				}
				continue;
			}

			process.stdout.write("what do you want to do?\n");
			process.stdout.write("  1. add or edit an endpoint\n");
			process.stdout.write("  2. switch active chat/worker target\n");
			process.stdout.write("  3. probe all endpoints\n");
			process.stdout.write("  4. safety level (suggest / auto-edit / full-auto)\n");
			process.stdout.write("  5. session budget\n");
			process.stdout.write("  6. open settings.yaml in $EDITOR\n");
			process.stdout.write("  7. reset everything (backs up current settings)\n");
			process.stdout.write("  8. done\n\n");
			const selection = await askNumeric(rl, "selection", 1, 8, 8);
			if (selection === null) {
				await promptSaveOnExit(rl, settings);
				printOk("setup cancelled");
				return 0;
			}

			if (selection === 8) {
				const onDisk = readSettings();
				if (!settingsEqual(settings, onDisk)) {
					await writeSettingsAtomically(settings);
					process.stdout.write("\nNext commands:\n");
					process.stdout.write("  clio providers\n");
					process.stdout.write("  clio\n");
					process.stdout.write('  clio run scout "summarize the repo layout"\n');
				} else {
					printOk("no changes");
				}
				return 0;
			}

			let continueSession = true;
			switch (selection) {
				case 1:
					continueSession = await actionAddOrEditEndpoint(rl, settings, probeState);
					break;
				case 2:
					continueSession = await actionSwitchTarget(rl, settings);
					break;
				case 3:
					continueSession = await actionProbeAll(rl, settings, probeState);
					break;
				case 4:
					continueSession = await actionSafety(rl, settings);
					break;
				case 5:
					continueSession = await actionBudget(rl, settings);
					break;
				case 6:
					continueSession = await actionOpenSettings(rl, settings);
					break;
				case 7:
					continueSession = await actionReset(rl, settings, probeState);
					break;
				default:
					printError(`invalid selection ${selection}`);
			}
			if (!continueSession) {
				printOk("setup cancelled");
				return 0;
			}
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message === "setup cancelled") {
			printError("setup cancelled");
			return 0;
		}
		printError(message);
		return 1;
	} finally {
		rl.close();
	}
}
