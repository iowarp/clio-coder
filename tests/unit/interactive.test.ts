import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ProviderListEntry, ProvidersContract } from "../../src/domains/providers/contract.js";
import { scopedSegment } from "../../src/interactive/footer-panel.js";
import {
	ALT_M,
	BUILTIN_SLASH_COMMANDS,
	CTRL_L,
	CTRL_P,
	SHIFT_CTRL_P,
	SHIFT_TAB,
	parseSlashCommand,
	routeInteractiveKey,
} from "../../src/interactive/index.js";
import { buildModelItems } from "../../src/interactive/overlays/model-selector.js";
import { buildScopedModelItems } from "../../src/interactive/overlays/scoped-models.js";

function makeProviders(list: ProviderListEntry[]): ProvidersContract {
	return {
		list: () => list,
		getAdapter: () => null,
		probeAll: async () => {},
		probeEndpoints: async () => {},
		probeAllLive: async () => {},
		probeEndpointsLive: async () => {},
		credentials: {
			hasKey: () => false,
			set: () => {},
			remove: () => {},
		},
	};
}

function listEntry(id: string, status: "healthy" | "degraded" | "down" | "unknown"): ProviderListEntry {
	return {
		id: id as ProviderListEntry["id"],
		displayName: id,
		tier: "sdk",
		available: true,
		reason: "",
		health: {
			providerId: id,
			status,
			lastCheckAt: null,
			lastError: null,
			latencyMs: null,
		},
	};
}

describe("slash-commands registry", () => {
	it("covers every dispatchable SlashCommand kind exactly once", () => {
		const expected = new Set([
			"quit",
			"help",
			"run",
			"run-usage",
			"providers",
			"cost",
			"receipts",
			"receipt-verify",
			"receipt-usage",
			"thinking",
			"model",
			"scoped-models",
		]);
		const owned = new Map<string, string>();
		for (const entry of BUILTIN_SLASH_COMMANDS) {
			for (const kind of entry.kinds) {
				const prior = owned.get(kind);
				strictEqual(prior, undefined, `kind ${kind} owned by ${prior} and ${entry.name}`);
				owned.set(kind, entry.name);
			}
		}
		for (const kind of expected) {
			ok(owned.has(kind), `kind ${kind} missing from registry`);
		}
		strictEqual(owned.size, expected.size, `unexpected kinds: ${[...owned.keys()].join(",")}`);
	});

	it("parses /model as the model kind", () => {
		deepStrictEqual(parseSlashCommand("/model"), { kind: "model" });
	});

	it("parses trimmed /model with surrounding whitespace", () => {
		deepStrictEqual(parseSlashCommand("  /model  "), { kind: "model" });
	});

	it("rejects /model arguments as unknown", () => {
		strictEqual(parseSlashCommand("/model gpt-5").kind, "unknown");
	});

	it("/thinking still routes through the registry", () => {
		deepStrictEqual(parseSlashCommand("/thinking"), { kind: "thinking" });
	});

	it("parses /scoped-models as the scoped-models kind", () => {
		deepStrictEqual(parseSlashCommand("/scoped-models"), { kind: "scoped-models" });
	});
});

describe("routeInteractiveKey", () => {
	const noopDeps = {
		cycleMode: () => {},
		cycleThinking: () => {},
		requestShutdown: () => {},
		requestSuper: () => {},
		toggleDispatchBoard: () => {},
		openModelSelector: () => {},
		cycleScopedModelForward: () => {},
		cycleScopedModelBackward: () => {},
	};

	it("Shift+Tab triggers cycleThinking and not cycleMode", () => {
		let thinking = 0;
		let mode = 0;
		const consumed = routeInteractiveKey(SHIFT_TAB, {
			...noopDeps,
			cycleThinking: () => {
				thinking += 1;
			},
			cycleMode: () => {
				mode += 1;
			},
		});
		strictEqual(consumed, true);
		strictEqual(thinking, 1);
		strictEqual(mode, 0);
	});

	it("Alt+M triggers cycleMode and not cycleThinking", () => {
		let thinking = 0;
		let mode = 0;
		const consumed = routeInteractiveKey(ALT_M, {
			...noopDeps,
			cycleThinking: () => {
				thinking += 1;
			},
			cycleMode: () => {
				mode += 1;
			},
		});
		strictEqual(consumed, true);
		strictEqual(mode, 1);
		strictEqual(thinking, 0);
	});

	it("Ctrl+L triggers openModelSelector", () => {
		let opened = 0;
		const consumed = routeInteractiveKey(CTRL_L, {
			...noopDeps,
			openModelSelector: () => {
				opened += 1;
			},
		});
		strictEqual(consumed, true);
		strictEqual(opened, 1);
	});

	it("Ctrl+P triggers cycleScopedModelForward only", () => {
		let fwd = 0;
		let back = 0;
		const consumed = routeInteractiveKey(CTRL_P, {
			...noopDeps,
			cycleScopedModelForward: () => {
				fwd += 1;
			},
			cycleScopedModelBackward: () => {
				back += 1;
			},
		});
		strictEqual(consumed, true);
		strictEqual(fwd, 1);
		strictEqual(back, 0);
	});

	it("Shift+Ctrl+P triggers cycleScopedModelBackward only", () => {
		let fwd = 0;
		let back = 0;
		const consumed = routeInteractiveKey(SHIFT_CTRL_P, {
			...noopDeps,
			cycleScopedModelForward: () => {
				fwd += 1;
			},
			cycleScopedModelBackward: () => {
				back += 1;
			},
		});
		strictEqual(consumed, true);
		strictEqual(back, 1);
		strictEqual(fwd, 0);
	});
});

describe("model-selector buildModelItems", () => {
	it("emits one row per static catalog model with health + price markers", () => {
		const providers = makeProviders([listEntry("anthropic", "healthy")]);
		const { items, refs } = buildModelItems({
			settings: structuredClone(DEFAULT_SETTINGS),
			providers,
		});
		ok(items.length > 0, "expected at least one item");
		const row = items.find((i) => i.value.startsWith("anthropic/"));
		ok(row, "expected an anthropic row");
		ok(row.label.startsWith("●"), `expected healthy glyph, got ${row.label}`);
		ok(row.description?.includes("k"), `expected ctxK in description, got ${row.description}`);
		const anthropicRef = refs.find((r) => r.providerId === "anthropic");
		ok(anthropicRef, "expected a parallel ref for anthropic");
		strictEqual(anthropicRef.endpoint, undefined);
	});

	it("marks scoped models with a star", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.provider.scope = ["anthropic/claude-sonnet-4-6"];
		const providers = makeProviders([listEntry("anthropic", "healthy")]);
		const { items } = buildModelItems({ settings, providers });
		const scoped = items.find((i) => i.value === "anthropic/claude-sonnet-4-6");
		ok(scoped, "expected a row for the scoped model");
		ok(scoped.label.includes("★"), `expected star marker, got ${scoped.label}`);
	});

	it("renders local-engine endpoints when defaultModel is set", () => {
		const providers = makeProviders([
			{
				...listEntry("llamacpp", "healthy"),
				tier: "native",
				endpoints: [
					{
						name: "mini",
						url: "http://192.168.86.141:8080",
						defaultModel: "Qwen3.6-35B",
						probe: { name: "mini", url: "http://192.168.86.141:8080", ok: true },
					},
				],
			},
		]);
		const { items, refs } = buildModelItems({
			settings: structuredClone(DEFAULT_SETTINGS),
			providers,
		});
		const row = items.find((i) => i.value === "llamacpp/mini/Qwen3.6-35B");
		ok(row, "expected a llamacpp endpoint row");
		const ref = refs.find((r) => r.providerId === "llamacpp" && r.modelId === "Qwen3.6-35B");
		ok(ref);
		strictEqual(ref.endpoint, "mini");
	});

	it("skips local-engine endpoints without a defaultModel", () => {
		const providers = makeProviders([
			{
				...listEntry("llamacpp", "unknown"),
				tier: "native",
				endpoints: [{ name: "orphan", url: "http://nope" }],
			},
		]);
		const { items } = buildModelItems({
			settings: structuredClone(DEFAULT_SETTINGS),
			providers,
		});
		ok(!items.some((i) => i.value.startsWith("llamacpp/orphan")));
	});
});

describe("scoped-models buildScopedModelItems", () => {
	it("emits [x] for entries resolved by the current scope", () => {
		const items = buildScopedModelItems(["anthropic/claude-sonnet-4-6"]);
		const row = items.find((i) => i.value === "anthropic/claude-sonnet-4-6");
		ok(row);
		ok(row.label.startsWith("[x]"), `expected [x] marker, got ${row.label}`);
		const other = items.find((i) => i.value.startsWith("openai/"));
		ok(other);
		ok(other.label.startsWith("[ ]"), `expected [ ] marker, got ${other.label}`);
	});

	it("treats empty scope as nothing selected", () => {
		const items = buildScopedModelItems([]);
		ok(items.every((i) => i.label.startsWith("[ ]")));
	});
});

describe("footer scopedSegment", () => {
	it("returns null when scope is empty", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		strictEqual(scopedSegment(settings), null);
	});

	it("renders scoped:N/M with the active orchestrator index", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.provider.scope = ["anthropic/claude-sonnet-4-6", "openai/gpt-5"];
		settings.orchestrator.provider = "openai";
		settings.orchestrator.model = "gpt-5";
		strictEqual(scopedSegment(settings), "scoped:2/2");
	});

	it("renders N as `-` when the orchestrator target is not in scope", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.provider.scope = ["anthropic/claude-sonnet-4-6"];
		settings.orchestrator.provider = "google";
		settings.orchestrator.model = "gemini-2.5-pro";
		const seg = scopedSegment(settings);
		ok(seg?.startsWith("scoped:-/"), `expected scoped:-/…, got ${seg}`);
	});
});
