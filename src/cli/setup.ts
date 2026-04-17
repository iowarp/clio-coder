import { renameSync, writeFileSync } from "node:fs";
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
import { parseFlags, printError, printHeader, printOk } from "./shared.js";

type SetupPresetId = "mini" | "dynamo" | "ollama" | "openai-compat";

interface SetupPreset {
	id: SetupPresetId;
	engine: LocalEngineId;
	label: string;
	description: string;
	endpointName: string;
	defaultUrl: string;
	switchHint: string;
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
		switchHint: "clio setup dynamo",
	},
	{
		id: "dynamo",
		engine: "lmstudio",
		label: "dynamo",
		description: "LM Studio on http://127.0.0.1:1234",
		endpointName: "dynamo",
		defaultUrl: "http://127.0.0.1:1234",
		switchHint: "clio setup mini",
	},
	{
		id: "ollama",
		engine: "ollama",
		label: "ollama",
		description: "Ollama on http://127.0.0.1:11434",
		endpointName: "local",
		defaultUrl: "http://127.0.0.1:11434",
		switchHint: "clio setup",
	},
	{
		id: "openai-compat",
		engine: "openai-compat",
		label: "openai-compatible",
		description: "a custom /v1 endpoint on http://127.0.0.1:8000",
		endpointName: "local",
		defaultUrl: "http://127.0.0.1:8000",
		switchHint: "clio setup",
	},
] as const;

const PRESET_BY_ID = new Map(SETUP_PRESETS.map((preset) => [preset.id, preset]));
const PRESET_ALIASES = new Map<string, SetupPresetId>([
	["mini", "mini"],
	["llamacpp", "mini"],
	["dynamo", "dynamo"],
	["lmstudio", "dynamo"],
	["ollama", "ollama"],
	["openai-compat", "openai-compat"],
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
  clio setup mini
  clio setup dynamo
  clio setup ollama
  clio setup openai-compat

Guided setup bootstraps Clio's config, probes local endpoints when possible,
and writes provider + model defaults for both interactive chat and workers.
`;

function schemaError(candidate: unknown): string {
	const first = [...Value.Errors(SettingsSchema, candidate)][0];
	return `${first?.path ?? "(root)"}: ${first?.message ?? "unknown schema error"}`;
}

function ensureSettingsValid(candidate: unknown): asserts candidate is ClioSettings {
	if (Value.Check(SettingsSchema, candidate)) return;
	throw new Error(schemaError(candidate));
}

function describeTarget(settings: Readonly<ClioSettings>): string | null {
	const providerId = settings.orchestrator.provider?.trim() ?? settings.workers.default.provider?.trim();
	const endpointName = settings.orchestrator.endpoint?.trim() ?? settings.workers.default.endpoint?.trim();
	const modelId = settings.orchestrator.model?.trim() ?? settings.workers.default.model?.trim();
	if (!providerId || !modelId) return null;
	return endpointName ? `${providerId}/${endpointName}/${modelId}` : `${providerId}/${modelId}`;
}

function presetFromSettings(settings: Readonly<ClioSettings>): SetupPreset | null {
	const providerId = settings.orchestrator.provider?.trim() ?? settings.workers.default.provider?.trim();
	const endpointName = settings.orchestrator.endpoint?.trim() ?? settings.workers.default.endpoint?.trim();
	if (!providerId) return null;
	return (
		SETUP_PRESETS.find(
			(preset) => preset.engine === providerId && (!endpointName || preset.endpointName === endpointName),
		) ?? null
	);
}

function presetFromArg(raw: string | undefined): SetupPreset | null {
	if (!raw) return null;
	const presetId = PRESET_ALIASES.get(raw.trim());
	return presetId ? (PRESET_BY_ID.get(presetId) ?? null) : null;
}

function timestampSuffix(): string {
	return new Date().toISOString().replaceAll(":", "-");
}

function uniqueEnabledRuntimes(existing: ReadonlyArray<string>, engine: LocalEngineId): string[] {
	return Array.from(new Set(["native", ...existing, engine]));
}

function defaultSetupPreset(): SetupPreset {
	const preset = PRESET_BY_ID.get("mini");
	if (!preset) throw new Error("setup presets are missing the mini preset");
	return preset;
}

function currentModelForPreset(settings: Readonly<ClioSettings>, preset: SetupPreset): string | undefined {
	const candidates = [
		settings.providers[preset.engine]?.endpoints?.[preset.endpointName]?.default_model,
		settings.orchestrator.provider === preset.engine && settings.orchestrator.endpoint === preset.endpointName
			? settings.orchestrator.model
			: undefined,
		settings.workers.default.provider === preset.engine && settings.workers.default.endpoint === preset.endpointName
			? settings.workers.default.model
			: undefined,
	];
	return candidates.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function selectDefaultModel(models: ReadonlyArray<string>, preferred: string | undefined): string | undefined {
	const trimmedPreferred = preferred?.trim();
	if (trimmedPreferred && models.includes(trimmedPreferred)) return trimmedPreferred;
	return models[0];
}

function seedSwitchPreset(settings: ClioSettings, selectedPreset: SetupPreset): string | null {
	const alternateId = selectedPreset.id === "mini" ? "dynamo" : selectedPreset.id === "dynamo" ? "mini" : null;
	if (!alternateId) return null;
	const alternate = PRESET_BY_ID.get(alternateId);
	if (!alternate) return null;
	const providerConfig = settings.providers[alternate.engine];
	if (providerConfig?.endpoints?.[alternate.endpointName]) return null;
	settings.providers[alternate.engine].endpoints[alternate.endpointName] = { url: alternate.defaultUrl };
	return `${alternate.engine}/${alternate.endpointName} -> ${alternate.defaultUrl}`;
}

async function ask(rl: ReturnType<typeof createInterface>, label: string, defaultValue?: string): Promise<string> {
	const suffix = defaultValue && defaultValue.length > 0 ? `${chalk.dim(`[${defaultValue}]`)} ` : "";
	try {
		const answer = await rl.question(`${label} ${suffix}`);
		const trimmed = answer.trim();
		if (trimmed.length > 0) return trimmed;
		return defaultValue ?? "";
	} catch {
		throw new Error("setup cancelled");
	}
}

async function choosePreset(rl: ReturnType<typeof createInterface>, defaultPreset: SetupPreset): Promise<SetupPreset> {
	process.stdout.write("\nChoose a local engine:\n");
	for (const [index, preset] of SETUP_PRESETS.entries()) {
		const recommended = preset.id === "mini" ? " (recommended)" : "";
		process.stdout.write(`  ${index + 1}. ${preset.label.padEnd(18)} ${preset.description}${recommended}\n`);
	}
	process.stdout.write("\n");
	while (true) {
		const answer = await ask(rl, "Selection", String(SETUP_PRESETS.indexOf(defaultPreset) + 1));
		const numeric = Number(answer);
		if (Number.isInteger(numeric) && numeric >= 1 && numeric <= SETUP_PRESETS.length) {
			return SETUP_PRESETS[numeric - 1] as SetupPreset;
		}
		const preset = presetFromArg(answer);
		if (preset) return preset;
		printError(`unknown selection: ${answer}`);
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
		if (!["y", "yes"].includes(answer.toLowerCase())) {
			throw new Error("setup cancelled");
		}
		const backupPath = `${path}.bak-${timestampSuffix()}`;
		renameSync(path, backupPath);
		writeFileSync(path, DEFAULT_SETTINGS_YAML, { encoding: "utf8", mode: 0o644 });
		printOk(`restored ${path} and kept the old file at ${backupPath}`);
		const restored = readSettings();
		ensureSettingsValid(restored);
		return restored;
	}
}

async function probePresetEndpoint(preset: SetupPreset, spec: EndpointSpec): Promise<EndpointProbeResult | null> {
	try {
		const adapter = LOCAL_ADAPTERS[preset.engine];
		const [result] = await adapter.probeEndpoints({
			[preset.endpointName]: spec,
		});
		return result ?? null;
	} catch (err) {
		return {
			name: preset.endpointName,
			url: spec.url,
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

function renderProbe(result: EndpointProbeResult | null): void {
	if (!result) {
		process.stdout.write(`${chalk.yellow("probe:")} skipped\n`);
		return;
	}
	if (!result.ok) {
		process.stdout.write(`${chalk.yellow("probe:")} ${result.error ?? "endpoint unreachable"}\n`);
		return;
	}
	const models = result.models ?? [];
	const summary = models.length === 0 ? "connected, no models reported" : `${models.length} model(s) detected`;
	process.stdout.write(`${chalk.green("probe:")} ${summary} at ${result.url}\n`);
	if (models.length > 0) {
		process.stdout.write(`  models: ${models.join(", ")}\n`);
	}
}

export async function runSetupCommand(argv: ReadonlyArray<string>): Promise<number> {
	const { flags, positional } = parseFlags([...argv]);
	if (flags.has("help") || flags.has("h")) {
		process.stdout.write(HELP);
		return 0;
	}

	if (positional.length > 1) {
		printError("usage: clio setup [mini|dynamo|ollama|openai-compat]");
		return 2;
	}

	const presetArg = positional[0];
	const presetFromCli = presetFromArg(presetArg);
	if (presetArg && !presetFromCli) {
		printError(`unknown setup preset: ${presetArg}`);
		process.stdout.write(HELP);
		return 2;
	}

	const install = initializeClioHome();
	printHeader("clio setup");
	process.stdout.write(`settings ${settingsPath()}\n`);
	if (install.touchedSettings) {
		printOk("created a fresh settings.yaml template");
	}

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const settings = await loadSettingsWithRepair(rl);
		const currentTarget = describeTarget(settings);
		process.stdout.write(`${currentTarget ? `current ${currentTarget}` : "current not configured yet"}\n`);

		const preset = presetFromCli ?? (await choosePreset(rl, presetFromSettings(settings) ?? defaultSetupPreset()));
		const existingEndpoint = settings.providers[preset.engine]?.endpoints?.[preset.endpointName];

		process.stdout.write(`\nConfiguring ${preset.engine}/${preset.endpointName}.\n`);
		const url = trimTrailingSlash(await ask(rl, "Endpoint URL", existingEndpoint?.url?.trim() || preset.defaultUrl));
		if (url.length === 0) {
			printError("endpoint URL is required");
			return 1;
		}

		let apiKey = existingEndpoint?.api_key;
		if (preset.engine === "openai-compat" || (existingEndpoint?.api_key?.trim().length ?? 0) > 0) {
			const next = await ask(rl, "API key (leave blank for none)", apiKey ?? "");
			apiKey = next.trim().length > 0 ? next.trim() : undefined;
		}

		const { api_key: _droppedKey, ...existingRest } = existingEndpoint ?? {};
		const nextEndpoint: EndpointSpec = {
			...existingRest,
			url,
			...(apiKey ? { api_key: apiKey } : {}),
		};

		process.stdout.write("\nProbing endpoint...\n");
		const probe = await probePresetEndpoint(preset, nextEndpoint);
		renderProbe(probe);

		const detectedModels = probe?.ok ? (probe.models ?? []) : [];
		const defaultModel = selectDefaultModel(detectedModels, currentModelForPreset(settings, preset));
		const modelId = (
			await ask(
				rl,
				detectedModels.length > 0 ? "Model id" : "Model id (required; probe could not auto-detect one)",
				defaultModel,
			)
		).trim();
		if (modelId.length === 0) {
			printError("model id is required");
			return 1;
		}

		nextEndpoint.default_model = modelId;
		settings.providers[preset.engine].endpoints[preset.endpointName] = nextEndpoint;
		settings.provider = {
			active: preset.engine,
			model: modelId,
		};
		settings.orchestrator = {
			provider: preset.engine,
			endpoint: preset.endpointName,
			model: modelId,
		};
		settings.workers.default = {
			provider: preset.engine,
			endpoint: preset.endpointName,
			model: modelId,
		};
		settings.runtimes.enabled = uniqueEnabledRuntimes(settings.runtimes.enabled, preset.engine);
		const seededSwitch = seedSwitchPreset(settings, preset);
		ensureSettingsValid(settings);
		writeSettings(settings);

		process.stdout.write("\n");
		printOk(`saved ${preset.engine}/${preset.endpointName}/${modelId}`);
		process.stdout.write(`chat target   ${preset.engine}/${preset.endpointName}/${modelId}\n`);
		process.stdout.write(`worker target ${preset.engine}/${preset.endpointName}/${modelId}\n`);
		process.stdout.write(`settings      ${settingsPath()}\n`);
		if (seededSwitch) {
			process.stdout.write(`saved later   ${seededSwitch}\n`);
		}

		process.stdout.write("\nNext:\n");
		process.stdout.write("  clio providers\n");
		process.stdout.write("  clio\n");
		process.stdout.write('  clio run scout "summarize the repo layout"\n');
		process.stdout.write(`  switch later with: ${preset.switchHint}\n`);
		if (probe && !probe.ok) {
			process.stdout.write(`  if the server was offline, re-run: clio setup ${preset.id}\n`);
		}
		process.stdout.write("\n");
		return 0;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message === "setup cancelled") {
			printError("setup cancelled");
			return 1;
		}
		throw err;
	} finally {
		rl.close();
	}
}
