import { readSettings, SettingsValidationError, updateSettings, validateSettings } from "../core/config.js";
import { initializeClioHome } from "../core/init.js";
import { openAuthStorage } from "../domains/providers/auth/index.js";
import { isOrchestratorEligibleRuntime, resolveAuthTarget } from "../domains/providers/index.js";
import { fingerprintNativeRuntime } from "../domains/providers/probe/fingerprint.js";
import { probeJson } from "../domains/providers/probe/http.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import { targetRootUrl } from "../domains/providers/runtimes/common/local-synth.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../domains/providers/types/target-descriptor.js";
import { ConfigureNavigation, type ConfigurePrompts } from "./configure-prompts.js";
import {
	applyTarget,
	deriveTargetId,
	setOrchestratorPointer,
	setWorkerDefaultPointer,
	targetApiKeyRef,
} from "./configure-target.js";
import { createLifecyclePresenter } from "./lifecycle-presenter.js";
import { credentialWriteFailed, printPlaintextCredentialWarning } from "./shared.js";

interface Connection {
	runtime: RuntimeDescriptor;
	target: TargetDescriptor;
	existing: TargetDescriptor | undefined;
	probe: ProbeResult;
	models: string[];
}

function endpointUrl(value: string): string {
	const url = new URL(value.includes("://") ? value : `http://${value}`);
	if (!["http:", "https:"].includes(url.protocol) || !url.hostname)
		throw new Error("Use an http:// or https:// endpoint URL.");
	if (url.username || url.password)
		throw new Error("Enter the endpoint without credentials; Clio asks for a key when needed.");
	return url.toString().replace(/\/$/u, "");
}

/** Probe only the endpoint the user entered; new endpoints never inherit another provider's key. */
async function connect(url: string, key: string | undefined): Promise<Connection> {
	const settings = readSettings();
	const registry = getRuntimeRegistry();
	const matches = settings.targets.filter((target) => {
		const runtime = registry.get(target.runtime);
		if (!target.url || !runtime || !isOrchestratorEligibleRuntime(runtime)) return false;
		try {
			return endpointUrl(target.url) === url;
		} catch {
			return false;
		}
	});
	const existing = matches.find((target) => target.id === settings.chat.target) ?? matches[0];
	let runtime = existing ? registry.get(existing.runtime) : null;
	let token = key;
	if (existing && runtime && token === undefined) {
		const auth = await openAuthStorage().resolveForTarget(resolveAuthTarget(existing, runtime), {
			includeFallback: false,
		});
		token = auth.apiKey;
	}
	const ctx: ProbeContext = { credentialsPresent: new Set(), httpTimeoutMs: 5000, authToken: token ?? "" };
	if (!runtime) {
		const root = targetRootUrl({ id: "quick", runtime: "openai-compat", url }) ?? url;
		const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
		const native = await fingerprintNativeRuntime(root, headers);
		let id = native?.runtimeId ?? "openai-compat";
		if (!native) {
			const info = await probeJson<{ data?: Array<{ model_name?: unknown; model_info?: unknown }> }>({
				url: `${root}/v1/model/info`,
				headers,
				timeoutMs: 1000,
			});
			if (info.ok && info.data?.data?.some((row) => typeof row.model_name === "string" && row.model_info !== undefined))
				id = "litellm";
		}
		runtime = registry.get(id);
	}
	if (!runtime) throw new Error("No compatible runtime is available. Open Settings → Targets & Auth.");
	const target: TargetDescriptor = existing
		? structuredClone(existing)
		: {
				id: deriveTargetId(runtime.id, settings.targets),
				runtime: runtime.id,
				url,
			};
	let probe = (await runtime.probe?.(target, ctx)) ?? {
		ok: false,
		error: "This connection does not support endpoint checks.",
	};
	let models = probe.ok ? (probe.models ?? (await runtime.probeModels?.(target, ctx)) ?? []) : [];
	// An Anthropic-only server can expose the same /v1/models path but require x-api-key.
	if (!existing && runtime.id === "openai-compat" && !probe.ok && /HTTP (401|403|404)/u.test(probe.error ?? "")) {
		const anthropic = registry.get("anthropic-compat");
		if (anthropic) {
			const candidate = { ...target, runtime: anthropic.id };
			const catalog = (await anthropic.probeModels?.(candidate, ctx)) ?? [];
			if (catalog.length > 0) {
				runtime = anthropic;
				target.runtime = anthropic.id;
				target.id = deriveTargetId(anthropic.id, settings.targets);
				models = catalog;
				probe = { ok: true, models };
			}
		}
	}
	models = [...new Set(models)].filter((id) => probe.modelCapabilities?.[id]?.chat !== false);
	return { runtime, target, existing, probe, models };
}

/** URL → key only if required → model only if several → Connect. No settings questionnaire. */
export async function runQuickConnect(prompts: ConfigurePrompts): Promise<"connected" | "back" | "quit"> {
	const initial = readSettings();
	const first = initial.targets.length === 0;
	const current = initial.targets.find((target) => target.id === initial.chat.target);
	let url = current?.url ?? "";
	let key: string | undefined;
	let connection: Connection | undefined;
	let model = "";
	let step: "url" | "key" | "model" | "save" = "url";
	let askedKey = false;
	let optionalKey = false;
	let notice = "";
	const presenter = createLifecyclePresenter({ stream: prompts.output });
	for (;;) {
		prompts.clearScreen();
		presenter.header("Quick Connect", "configure");
		presenter.note("Connect one model to power Clio. Change other settings whenever you need them.");
		if (notice) {
			presenter.warn(notice);
			notice = "";
		}
		try {
			if (step === "url") {
				presenter.note("LM Studio: localhost:1234 · Ollama: localhost:11434");
				const answer = await prompts.text("Endpoint URL", url);
				if (!answer) {
					notice = "Enter the endpoint URL shown by your model server or API provider.";
					continue;
				}
				try {
					url = endpointUrl(answer);
				} catch (error) {
					notice = error instanceof Error ? error.message : String(error);
					continue;
				}
				key = undefined;
				askedKey = false;
				connection = undefined;
			} else if (step === "key") {
				presenter.note(`Endpoint: ${url}`);
				if (optionalKey)
					presenter.note("Some APIs publish models publicly but require a key for chat. Leave blank for a keyless server.");
				key = (await prompts.text("API key (saved locally when you choose Connect)", "", true)) || undefined;
				if (!key && !optionalKey) {
					notice = "Enter a key, or press Escape to change the endpoint.";
					continue;
				}
				askedKey = true;
			}
			if (step === "url" || step === "key") {
				presenter.note("Checking the endpoint and reading its model list…");
				connection = await connect(url, key);
				if (!connection.probe.ok) {
					if (connection.probe.authFailed || /HTTP (401|403)/u.test(connection.probe.error ?? "")) {
						optionalKey = false;
						notice = key
							? "The endpoint rejected that key. Try again, or Escape to go back."
							: "This endpoint needs an API key.";
						step = "key";
					} else {
						notice = `Could not connect: ${connection.probe.error ?? "no reply"}. Check the URL and that the server is running.`;
						step = "url";
					}
					continue;
				}
				if (
					!connection.existing &&
					!askedKey &&
					connection.runtime.auth === "api-key" &&
					connection.runtime.tier !== "local-native"
				) {
					optionalKey = true;
					step = "key";
					continue;
				}
				if (connection.models.length === 0) {
					notice =
						"The endpoint offered no chat models. Load a model and retry. Servers without model discovery can use Settings → Targets & Auth.";
					step = "url";
					continue;
				}
				const preferred =
					connection.existing?.id === initial.chat.target ? initial.chat.model : connection.target.defaultModel;
				model = preferred && connection.models.includes(preferred) ? preferred : (connection.models[0] ?? "");
				step = connection.models.length === 1 ? "save" : "model";
				continue;
			}
			if (!connection) {
				step = "url";
				continue;
			}
			if (step === "model") {
				presenter.note(`Connected: ${url} (${connection.runtime.displayName})`);
				model = await prompts.choose("Choose the model for Clio", connection.models, model, true);
				if (!connection.models.includes(model)) {
					notice = "Choose a model from the endpoint's live list.";
					continue;
				}
				step = "save";
				continue;
			}
			presenter.fields([
				["Endpoint", url],
				["Model", model],
				["Connection", "live model discovery passed"],
			]);
			presenter.note(
				first
					? "Ready with recommended defaults: workspace edits, approval for unrecognized commands, one worker, $5 tracked session budget."
					: "Use this model for chat. Your other settings and role assignments stay in place.",
			);
			const choice = await prompts.choose("Ready to connect", ["Connect", "Back"], "Connect");
			if (choice !== "Connect") throw new ConfigureNavigation("back");
			const descriptor = structuredClone(connection.target);
			if (!connection.existing) descriptor.defaultModel = model;
			if (key) {
				descriptor.auth = { ...descriptor.auth, apiKeyRef: targetApiKeyRef(descriptor.id, readSettings().targets) };
				delete descriptor.auth.apiKeyEnvVar;
			}
			const apply = (settings: ReturnType<typeof readSettings>) => {
				const target = settings.targets.find((entry) => entry.id === descriptor.id);
				if (JSON.stringify(target) !== JSON.stringify(connection?.existing))
					throw new Error("This target changed during setup. Reopen Quick Connect to keep those changes.");
				applyTarget(settings, descriptor);
				setOrchestratorPointer(settings, descriptor, model);
				if (first && !settings.fleet.default.target) setWorkerDefaultPointer(settings, descriptor, model);
			};
			const preview = readSettings();
			apply(preview);
			const validated = validateSettings(preview);
			if (validated.issues.length) throw new SettingsValidationError(validated.issues);
			initializeClioHome();
			if (key && descriptor.auth?.apiKeyRef) {
				const auth = openAuthStorage();
				auth.setApiKey(descriptor.auth.apiKeyRef, key);
				if (credentialWriteFailed(auth, "The key was not saved; connection settings were not changed."))
					throw new Error("The key could not be saved. Check permissions on the credentials file and retry.");
				printPlaintextCredentialWarning();
			}
			updateSettings(apply);
			presenter.done(`Connected: ${descriptor.id} / ${model}`);
			presenter.commandAdvice("Start Clio:", "clio-coder");
			return "connected";
		} catch (error) {
			if (!(error instanceof ConfigureNavigation)) {
				notice = error instanceof Error ? error.message : String(error);
				step = "url";
				continue;
			}
			if (error.kind === "quit" || step === "url") {
				presenter.done("Quick Connect cancelled; connection settings not saved.");
				return error.kind;
			}
			step =
				step === "save" && (connection?.models.length ?? 0) > 1
					? "model"
					: step === "model" || step === "save"
						? askedKey
							? "key"
							: "url"
						: "url";
		}
	}
}
