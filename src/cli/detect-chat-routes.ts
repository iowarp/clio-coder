import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { ClioSettings } from "../core/config.js";
import { settingsPath, updateSettings } from "../core/config.js";
import { openAuthStorage, resolveAuthTarget, targetRequiresAuth } from "../domains/providers/auth/index.js";
import { isOrchestratorEligibleRuntime } from "../domains/providers/eligibility.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../domains/providers/runtimes/builtins.js";
import { buildProviderSupportEntry } from "../domains/providers/support.js";
import type { RuntimeDescriptor } from "../domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../domains/providers/types/target-descriptor.js";
import {
	applyTarget,
	buildDescriptor,
	DEFAULT_PORTS,
	defaultUrlFor,
	deriveTargetId,
	preferredModelFor,
	setOrchestratorPointer,
} from "./configure-target.js";

export interface DetectedChatRoute {
	source: string;
	runtime: RuntimeDescriptor;
	target: TargetDescriptor;
	model?: string;
}

/** Passive discovery only: one deadline, fixed loopback addresses, no redirects or credentials. */
async function localModels(): Promise<Map<string, string>> {
	const models = new Map<string, string>();
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<void>((resolve) => {
		timer = setTimeout(() => {
			controller.abort();
			resolve();
		}, 400);
	});
	const urls = new Set(
		Object.keys(DEFAULT_PORTS).map((id) => `${defaultUrlFor(id)}${id === "ollama" ? "/api/tags" : "/v1/models"}`),
	);
	try {
		await Promise.race([
			deadline,
			Promise.all(
				[...urls].map(async (url) => {
					try {
						const response = await fetch(url, { signal: controller.signal, redirect: "error" });
						if (!response.ok) return;
						const body = (await response.json()) as { data?: { id?: string }[]; models?: { name?: string }[] };
						const model = url.endsWith("/api/tags") ? body.models?.[0]?.name : body.data?.[0]?.id;
						if (!controller.signal.aborted && typeof model === "string" && model.trim()) {
							models.set(new URL(url).origin, model);
						}
					} catch {
						// An absent, slow, or incompatible local server is not a route.
					}
				}),
			),
		]);
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
	return models;
}

export async function detectChatRoutes(settings: Readonly<ClioSettings>): Promise<DetectedChatRoute[]> {
	const registry = getRuntimeRegistry();
	registerBuiltinRuntimes(registry);
	const auth = openAuthStorage();
	const routes: DetectedChatRoute[] = [];
	const runtimes = registry
		.list()
		.filter((runtime) => isOrchestratorEligibleRuntime(runtime) && runtime.defaultCapabilities.chat);
	const curatedModel = (runtime: RuntimeDescriptor) => {
		const support = buildProviderSupportEntry(runtime);
		return preferredModelFor({ models: support.modelHints, source: "catalog" }, support);
	};
	for (const target of settings.targets) {
		const runtime = runtimes.find((entry) => entry.id === target.runtime);
		if (!runtime) continue;
		if (
			targetRequiresAuth(target, runtime) &&
			!auth.statusForTarget(resolveAuthTarget(target, runtime), { includeFallback: false }).available
		)
			continue;
		const model = target.defaultModel ?? curatedModel(runtime);
		routes.push({ source: `settings (${target.id})`, runtime, target, ...(model ? { model } : {}) });
	}
	for (const runtime of runtimes) {
		const env = runtime.credentialsEnvVar;
		const model = curatedModel(runtime);
		if (runtime.auth !== "api-key" || !env || !process.env[env]?.trim() || runtime.gatewayUrl) continue;
		const target = buildDescriptor(runtime, deriveTargetId(runtime.id, settings.targets), {
			...(model ? { model } : {}),
			apiKeyEnv: env,
		});
		routes.push({ source: env, runtime, target, ...(model ? { model } : {}) });
	}
	for (const runtime of runtimes) {
		const provider = runtime.oauthProviderId ?? runtime.id;
		const credential = auth.get(provider);
		const model = curatedModel(runtime);
		if (!credential || runtime.gatewayUrl || (runtime.auth !== "api-key" && runtime.auth !== "oauth")) continue;
		if ((credential.type === "oauth") !== (runtime.auth === "oauth")) continue;
		const target = buildDescriptor(runtime, deriveTargetId(runtime.id, settings.targets), {
			...(model ? { model } : {}),
			...(credential.type === "oauth" ? { oauthProfile: provider } : { apiKeyRef: provider }),
		});
		routes.push({
			source: `Clio stored ${credential.type === "oauth" ? "login" : "API key"} (${provider})`,
			runtime,
			target,
			...(model ? { model } : {}),
		});
	}
	const served = await localModels();
	for (const [id] of Object.entries(DEFAULT_PORTS)) {
		const runtime = runtimes.find((entry) => entry.id === id);
		const url = defaultUrlFor(id);
		const model = served.get(url);
		if (!runtime || !model) continue;
		const target = buildDescriptor(runtime, deriveTargetId(id, settings.targets), { url, model });
		routes.push({ source: url, runtime, target, model });
	}
	return routes;
}

/** A broken saved chat choice remains the user's choice; the fallback lives in the boot snapshot. */
export function useDetectedChatRoute(
	settings: Readonly<ClioSettings>,
	route: DetectedChatRoute & { model: string },
): { settings: ClioSettings; persisted: boolean } {
	const apply = (draft: ClioSettings) => {
		applyTarget(draft, route.target);
		setOrchestratorPointer(draft, route.target, route.model);
	};
	let persisted = false;
	if (!settings.chat.target) {
		const keepSavedRoute = Symbol("keep saved route");
		try {
			updateSettings((draft) => {
				// Normalization clears dangling target ids; the raw choice still belongs to the user.
				const saved = parseYaml(readFileSync(settingsPath(), "utf8")) as { chat?: { target?: unknown } } | null;
				if (draft.chat.target || saved?.chat?.target) throw keepSavedRoute;
				apply(draft);
			});
			persisted = true;
		} catch (error) {
			if (error !== keepSavedRoute) throw error;
		}
	}
	const session = structuredClone(settings);
	apply(session);
	return { settings: session, persisted };
}
