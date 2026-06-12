import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type {
	AuthStatus,
	EndpointStatus,
	ProvidersContract,
	RuntimeDescriptor,
} from "../../src/domains/providers/index.js";
import { type CapabilityFlags, EMPTY_CAPABILITIES } from "../../src/domains/providers/index.js";
import { applySettingChange } from "../../src/interactive/overlays/settings.js";
import {
	applyTargetsHubUseAction,
	buildTargetAuthMap,
	buildTargetHubUseSettings,
	formatProbeAllNotice,
	formatProbeNotice,
	formatTargetsHubBodyLines,
	sortTargetStatuses,
	toggleExpandedTarget,
} from "../../src/interactive/providers-overlay.js";

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");

function plain(value: string): string {
	return value.replace(ANSI_PATTERN, "");
}

function plainLines(lines: readonly string[]): string[] {
	return lines.map(plain);
}

function caps(overrides: Partial<CapabilityFlags> = {}): CapabilityFlags {
	return {
		...EMPTY_CAPABILITIES,
		chat: true,
		contextWindow: 8192,
		maxTokens: 4096,
		...overrides,
	};
}

function runtime(id: string, overrides: Partial<RuntimeDescriptor> = {}): RuntimeDescriptor {
	return {
		id,
		displayName: id,
		kind: "http",
		apiFamily: "openai-completions",
		auth: "api-key",
		defaultCapabilities: caps(),
		synthesizeModel: () => ({ id, provider: id }) as never,
		...overrides,
	};
}

function status(
	id: string,
	overrides: {
		runtime?: RuntimeDescriptor | null;
		runtimeId?: string;
		displayName?: string;
		auth?: RuntimeDescriptor["auth"];
		url?: string | null;
		defaultModel?: string;
		wireModels?: string[];
		available?: boolean;
		reason?: string;
		health?: EndpointStatus["health"];
		capabilities?: CapabilityFlags;
		discoveredModels?: string[];
	} = {},
): EndpointStatus {
	const rt =
		overrides.runtime === undefined
			? runtime(overrides.runtimeId ?? `${id}-runtime`, {
					displayName: overrides.displayName ?? overrides.runtimeId ?? `${id}-runtime`,
					auth: overrides.auth ?? "api-key",
				})
			: overrides.runtime;
	return {
		endpoint: {
			id,
			runtime: rt?.id ?? overrides.runtimeId ?? `${id}-runtime`,
			...(overrides.url === null ? {} : { url: overrides.url ?? `http://${id}.test` }),
			defaultModel: overrides.defaultModel ?? `${id}-model`,
			...(overrides.wireModels ? { wireModels: overrides.wireModels } : {}),
		},
		runtime: rt,
		available: overrides.available ?? true,
		reason: overrides.reason ?? "ready",
		health: overrides.health ?? { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: 42 },
		capabilities: overrides.capabilities ?? caps(),
		discoveredModels: overrides.discoveredModels ?? [],
	};
}

function authStatus(input: Partial<AuthStatus> & Pick<AuthStatus, "source">): AuthStatus {
	return {
		providerId: input.providerId ?? "provider",
		available: input.available ?? true,
		credentialType: input.credentialType ?? null,
		source: input.source,
		detail: input.detail ?? null,
	};
}

describe("contracts/targets hub", () => {
	it("formats compact rows with health, auth summaries, active target, and current model", () => {
		const statuses = [
			status("dynamo", {
				displayName: "LM Studio",
				defaultModel: "nemotron-cascade-2-30b-a3b-i1",
				health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: 57 },
			}),
			status("down-target", {
				displayName: "OpenAI Compat",
				health: { status: "down", lastCheckAt: null, lastError: "refused", latencyMs: null },
				available: false,
				reason: "connection refused",
			}),
			status("no-url", {
				auth: "none",
				url: null,
				displayName: "No Auth Runtime",
				health: { status: "unknown", lastCheckAt: null, lastError: null, latencyMs: null },
			}),
			status("oauth-target", {
				auth: "oauth",
				displayName: "OAuth Runtime",
				health: { status: "degraded", lastCheckAt: null, lastError: "slow", latencyMs: 301 },
			}),
			status("env-target", {
				displayName: "Env Runtime",
				defaultModel: "env-default",
			}),
		];
		const authById = new Map<string, AuthStatus>([
			["dynamo", authStatus({ source: "stored-api-key", providerId: "lmstudio", credentialType: "api_key" })],
			["down-target", authStatus({ source: "none", providerId: "cloud", available: false })],
			["no-url", authStatus({ source: "not-required", providerId: "local" })],
			["oauth-target", authStatus({ source: "stored-oauth", providerId: "oauth", credentialType: "oauth" })],
			["env-target", authStatus({ source: "environment", providerId: "env", detail: "OPENAI_API_KEY" })],
		]);
		const providers = {
			auth: {
				statusForTarget: (endpoint: EndpointStatus["endpoint"]) => {
					const found = authById.get(endpoint.id);
					if (!found) throw new Error(`missing auth fixture for ${endpoint.id}`);
					return found;
				},
			},
		} as unknown as ProvidersContract;
		const authMap = buildTargetAuthMap(statuses, providers);

		strictEqual(authMap.get("dynamo")?.summary, "api-key");
		strictEqual(authMap.get("dynamo")?.detail, "store:api_key:lmstudio");
		strictEqual(authMap.get("down-target")?.summary, "disconnected");
		strictEqual(authMap.get("oauth-target")?.summary, "oauth");
		strictEqual(authMap.get("env-target")?.summary, "env");
		strictEqual(authMap.get("no-url")?.summary, "none");

		const lines = plainLines(
			formatTargetsHubBodyLines(
				statuses,
				{
					selectedId: "dynamo",
					activeEndpointId: "dynamo",
					activeModelId: "current-live-model",
					authByEndpoint: authMap,
				},
				132,
			),
		);

		const active = lines.find((line) => line.includes("dynamo"));
		ok(active, "active target row exists");
		ok(active.includes("▸ dynamo"), active);
		ok(active.includes("active"), active);
		ok(active.includes("LM Studio"), active);
		ok(active.includes("● ok 57ms"), active);
		ok(active.includes("api-key"), active);
		ok(active.includes("current-live-model"), active);

		const down = lines.find((line) => line.includes("down-target"));
		ok(down, "down target row exists");
		ok(down.includes("○ down -"), down);
		ok(down.includes("disconnected"), down);

		const oauth = lines.find((line) => line.includes("oauth-target"));
		ok(oauth?.includes("oauth"), oauth);

		const env = lines.find((line) => line.includes("env-target"));
		ok(env?.includes("env"), env);
	});

	it("sorts the active target first, then healthy targets, then the rest by id", () => {
		const rows = [
			status("zeta", { health: { status: "down", lastCheckAt: null, lastError: null, latencyMs: null } }),
			status("alpha"),
			status("beta", { health: { status: "down", lastCheckAt: null, lastError: null, latencyMs: null } }),
			status("gamma"),
		];

		deepStrictEqual(
			sortTargetStatuses(rows, "beta").map((row) => row.endpoint.id),
			["beta", "alpha", "gamma", "zeta"],
		);
	});

	it("renders expanded details as a superset of the old target dump fields", () => {
		const noUrl = status("no-url", {
			url: null,
			displayName: "Local Runtime",
			available: false,
			reason: "missing auth",
			health: { status: "unknown", lastCheckAt: null, lastError: null, latencyMs: null },
			capabilities: caps({ tools: true, reasoning: true, vision: true, contextWindow: 32000 }),
			discoveredModels: ["m1", "m2", "m3", "m4", "m5"],
		});
		const authByEndpoint = new Map([["no-url", { summary: "env", detail: "env:LOCAL_KEY" }]]);

		const rendered = plainLines(
			formatTargetsHubBodyLines(
				[noUrl],
				{
					selectedId: "no-url",
					expandedId: "no-url",
					authByEndpoint,
				},
				120,
			),
		).join("\n");

		ok(rendered.includes("no-url"), rendered);
		ok(rendered.includes("Local Runtime"), rendered);
		ok(rendered.includes("url: (no url)"), rendered);
		ok(rendered.includes("runtime: no-url-runtime  Local Runtime"), rendered);
		ok(rendered.includes("health: unknown  latency: -"), rendered);
		ok(rendered.includes("auth: env:LOCAL_KEY"), rendered);
		ok(rendered.includes("caps: 32000ctx  4096max  tools+reasoning+vision"), rendered);
		ok(rendered.includes("unavailable: missing auth"), rendered);
		ok(rendered.includes("models: m1, m2, m3, m4 (+1)"), rendered);
	});

	it("keeps a single expanded row at a time", () => {
		const first = status("first", { url: "http://first.test" });
		const second = status("second", { url: "http://second.test" });
		let expanded: string | null = null;

		expanded = toggleExpandedTarget(expanded, "first");
		strictEqual(expanded, "first");
		expanded = toggleExpandedTarget(expanded, "second");
		strictEqual(expanded, "second");

		const rendered = plainLines(
			formatTargetsHubBodyLines([first, second], {
				selectedId: "second",
				expandedId: expanded,
			}),
		).join("\n");

		ok(!rendered.includes("url: http://first.test"), rendered);
		ok(rendered.includes("url: http://second.test"), rendered);
	});

	it("uses the same settings mutation as applySettingChange for orchestrator target changes", () => {
		const current = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
		current.targets = [
			{ id: "target-a", runtime: "openai-compat", url: "http://a.test", defaultModel: "model-a" },
			{ id: "target-b", runtime: "openai-compat", url: "http://b.test", defaultModel: "model-b" },
		];
		current.orchestrator = { target: "target-a", model: "stale-model", thinkingLevel: "off" };

		const expected = structuredClone(current) as ClioSettings;
		applySettingChange(expected, "orchestrator.target", "target-b");

		deepStrictEqual(buildTargetHubUseSettings(current, "target-b"), expected);

		const writes: ClioSettings[] = [];
		const returned = applyTargetsHubUseAction("target-b", {
			getSettings: () => current,
			writeSettings: (next) => {
				writes.push(next);
			},
		});
		const written = writes[0];

		deepStrictEqual(written, expected);
		deepStrictEqual(returned, expected);
		notStrictEqual(written, current);
		ok(written);
		strictEqual(written.orchestrator.target, "target-b");
		strictEqual(written.orchestrator.model, "model-b");
	});

	it("formats probe completion notices with health and latency, and probe-all with target count", () => {
		const healthy = status("dynamo", {
			health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: 31 },
		});
		strictEqual(formatProbeNotice(healthy), "probed dynamo (ok 31ms)");

		const down = status("mini", {
			health: { status: "down", lastCheckAt: null, lastError: "refused", latencyMs: null },
		});
		strictEqual(formatProbeNotice(down), "probed mini (down -)");

		strictEqual(formatProbeAllNotice(1), "probed 1 target");
		strictEqual(formatProbeAllNotice(2), "probed 2 targets");
	});
});
