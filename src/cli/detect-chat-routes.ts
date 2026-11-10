import { readFileSync } from "node:fs";
import { get } from "node:http";
import { userInfo } from "node:os";
import { parse as parseYaml } from "yaml";
import type { ClioSettings } from "../core/config.js";
import { settingsPath, updateSettings } from "../core/config.js";
import { openAuthStorage, resolveAuthTarget, targetRequiresAuth } from "../domains/providers/auth/index.js";
import { detectCopilotLogin } from "../domains/providers/copilot-setup.js";
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

/**
 * One loopback GET, parsed as JSON; a redirect or any other non-2xx reply rejects.
 * node:http destroys a socket that is still connecting when the signal aborts.
 * fetch keeps it until undici's 10 s connect timeout, so on a host where a
 * closed loopback port never answers (WSL2) a cancelled configure sat for
 * 10 s after its last line before the process could exit.
 */
function readLoopbackJson(url: string, signal: AbortSignal): Promise<unknown> {
	return new Promise((resolve, reject) => {
		get(url, { signal }, (response) => {
			const status = response.statusCode ?? 0;
			if (status < 200 || status > 299) {
				response.resume();
				reject(new Error(`status ${status}`));
				return;
			}
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => chunks.push(chunk));
			response.on("error", reject);
			response.on("end", () => {
				try {
					resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
				} catch (err) {
					reject(err);
				}
			});
		}).on("error", reject);
	});
}

/** Passive discovery only: one deadline, fixed loopback addresses, no redirects or credentials. */
async function localModels(readJson: typeof readLoopbackJson): Promise<Map<string, string>> {
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
						const body = (await readJson(url, controller.signal)) as {
							data?: { id?: string }[];
							models?: { name?: string }[];
						};
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

export async function detectChatRoutes(
	settings: Readonly<ClioSettings>,
	readJson: typeof readLoopbackJson = readLoopbackJson,
	{ headless = false }: { headless?: boolean } = {},
): Promise<DetectedChatRoute[]> {
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
	// Headless keeps the Copilot keychain closed and must not send prompts to whoever owns a loopback port.
	if (headless) return routes;
	const copilot = runtimes.find((entry) => entry.id === "copilot-sdk");
	if (copilot && !settings.targets.some((target) => target.runtime === copilot.id)) {
		const login = await detectCopilotLogin(3_000);
		if (login) {
			const target = buildDescriptor(copilot, deriveTargetId(copilot.id, settings.targets), { model: login.model });
			routes.push({
				source: `copilot login (${login.account.login})`,
				runtime: copilot,
				target,
				model: login.model,
			});
		}
	}
	const served = await localModels(readJson);
	// One row per address: several runtimes share a default port, and a server answers as one of them.
	const byOrigin = new Map<string, RuntimeDescriptor[]>();
	for (const id of Object.keys(DEFAULT_PORTS)) {
		const runtime = runtimes.find((entry) => entry.id === id);
		const url = defaultUrlFor(id);
		if (!runtime || !served.has(url)) continue;
		byOrigin.set(url, [...(byOrigin.get(url) ?? []), runtime]);
	}
	for (const [url, sharing] of byOrigin) {
		const model = served.get(url);
		const runtime =
			sharing.length > 1 ? (sharing.find((entry) => entry.id === "openai-compat") ?? sharing[0]) : sharing[0];
		if (!runtime || !model) continue;
		const target = buildDescriptor(runtime, deriveTargetId(runtime.id, settings.targets), { url, model });
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

export interface AdoptedChatRoute {
	route: DetectedChatRoute & { model: string };
	settings: ClioSettings;
	persisted: boolean;
	/** Other environment keys that were found and passed over. */
	alsoFound?: string[];
}

/** One sentence for the route a returning user landed on, the same words on every surface. */
export function describeAdoptedRoute({
	route,
	persisted,
	alsoFound,
}: Pick<AdoptedChatRoute, "route" | "persisted" | "alsoFound">): string {
	const others = alsoFound && alsoFound.length > 0 ? ` Also found: ${alsoFound.join(", ")}.` : "";
	return `Chat: ${route.runtime.id} / ${route.model} from ${route.source}.${others}${persisted ? "" : " Session only; saved chat route unchanged."}`;
}

/** A route found by probing a default loopback port, which any local user can own. */
function isProbedLoopback(route: DetectedChatRoute): boolean {
	return route.target.url !== undefined && route.source === route.target.url;
}

/**
 * The user name owning the socket listening on a loopback port, from Linux's
 * `/proc/net/tcp{,6}`. Undefined when it cannot be read (other platforms).
 */
function loopbackListenerOwner(url: string): string | undefined {
	const port = Number(new URL(url).port);
	if (!port) return undefined;
	const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
	let uid: number | undefined;
	for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n").slice(1)) {
			const fields = line.trim().split(/\s+/);
			// fields: sl, local_address, rem_address, st, tx:rx, tr:when, retrnsmt, uid
			if (fields[3] === "0A" && fields[1]?.endsWith(`:${hexPort}`)) {
				uid = Number(fields[7]);
				break;
			}
		}
		if (uid !== undefined) break;
	}
	if (uid === undefined || !Number.isInteger(uid)) return undefined;
	try {
		if (uid === userInfo().uid) return userInfo().username;
	} catch {
		// Fall through to the passwd lookup.
	}
	try {
		for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
			const [name, , id] = line.split(":");
			if (name && Number(id) === uid) return name;
		}
	} catch {
		// No passwd file to name the owner from.
	}
	return `uid ${uid}`;
}

/** Answers one yes/no question on the operator's terminal. */
type ConfirmRoute = (question: string, defaultYes: boolean) => Promise<boolean>;

/**
 * A returning user's first detected route with a model, taken as their chat route. Null when nothing is found
 * or the operator declines a probed loopback listener. Without `confirm`, a loopback listener is never taken.
 */
export async function adoptDetectedChatRoute(
	settings: Readonly<ClioSettings>,
	confirm?: ConfirmRoute,
): Promise<AdoptedChatRoute | null> {
	// The target dedicated to background memory is not a chat choice anyone made;
	// taking it without asking would put the visible turn on the memory endpoint.
	const memoryTarget = settings.targets.find((entry) => entry.id === settings.context.memory.target);
	const candidates = (await detectChatRoutes(settings)).filter(
		(candidate) =>
			candidate.model &&
			(memoryTarget === undefined ||
				(candidate.target.id !== memoryTarget.id &&
					(memoryTarget.url === undefined || candidate.target.url !== memoryTarget.url))),
	);
	const found = candidates[0];
	if (!found?.model) return null;
	const route = { ...found, model: found.model };
	if (isProbedLoopback(route)) {
		// Any local user can own a default port; every prompt would go to them.
		if (!confirm) return null;
		const owner = process.platform === "linux" ? loopbackListenerOwner(route.source) : undefined;
		let currentUser: string | undefined;
		try {
			currentUser = userInfo().username;
		} catch {
			currentUser = undefined;
		}
		const foreign = owner !== undefined && owner !== currentUser;
		const question = `Use ${route.runtime.id} / ${route.model} at ${route.source} as your chat route?${foreign ? ` The listener belongs to user ${owner}.` : ""}`;
		if (!(await confirm(question, !foreign))) return null;
	}
	const isEnvKey = (candidate: DetectedChatRoute) => candidate.source === candidate.runtime.credentialsEnvVar;
	const alsoFound = isEnvKey(route)
		? [...new Set(candidates.filter((c) => isEnvKey(c) && c.source !== route.source).map((c) => c.source))]
		: [];
	return { route, ...useDetectedChatRoute(settings, route), ...(alsoFound.length > 0 ? { alsoFound } : {}) };
}

export type HeadlessChatRoute =
	| { kind: "none" }
	| { kind: "one"; route: DetectedChatRoute & { model: string }; settings: ClioSettings }
	| { kind: "several"; routes: Array<DetectedChatRoute & { model: string }> };

/**
 * The route a headless run with no saved chat route uses for this run only, from credentialed
 * targets, stored logins and environment keys. Nothing is written and no loopback port is probed;
 * several candidates are never chosen between silently. `targetId` picks one candidate by id.
 */
export async function headlessChatRoute(
	settings: Readonly<ClioSettings>,
	targetId?: string,
): Promise<HeadlessChatRoute> {
	const memoryTarget = settings.context.memory.target;
	const routes: Array<DetectedChatRoute & { model: string }> = [];
	for (const candidate of await detectChatRoutes(settings, readLoopbackJson, { headless: true })) {
		if (!candidate.model || candidate.target.id === memoryTarget) continue;
		const fromSettings = candidate.source.startsWith("settings (");
		// An environment key or stored login for a runtime already offered stands for the same choice.
		if (!fromSettings && routes.some((route) => route.runtime.id === candidate.runtime.id)) continue;
		routes.push({ ...candidate, model: candidate.model });
	}
	const chosen = targetId === undefined ? routes : routes.filter((route) => route.target.id === targetId);
	const route = chosen[0];
	if (!route) return { kind: "none" };
	if (chosen.length > 1) return { kind: "several", routes: chosen };
	const session = structuredClone(settings) as ClioSettings;
	applyTarget(session, route.target);
	setOrchestratorPointer(session, route.target, route.model);
	return { kind: "one", route, settings: session };
}
