import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ProviderListEntry, ProvidersContract } from "../../src/domains/providers/contract.js";
import { scopedSegment } from "../../src/interactive/footer-panel.js";
import {
	ALT_M,
	ALT_T,
	BUILTIN_SLASH_COMMANDS,
	CTRL_L,
	CTRL_P,
	SHIFT_CTRL_P,
	SHIFT_TAB,
	parseSlashCommand,
	routeInteractiveKey,
} from "../../src/interactive/index.js";
import { HOTKEYS, formatHotkeysLines } from "../../src/interactive/overlays/hotkeys.js";
import { buildMessagePickerRows, payloadPreview, rowsToItems } from "../../src/interactive/overlays/message-picker.js";
import { buildModelItems } from "../../src/interactive/overlays/model-selector.js";
import { buildScopedModelItems } from "../../src/interactive/overlays/scoped-models.js";
import { buildSessionItems } from "../../src/interactive/overlays/session-selector.js";
import { applySettingChange, buildSettingItems } from "../../src/interactive/overlays/settings.js";

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
			"settings",
			"resume",
			"new",
			"tree",
			"fork",
			"hotkeys",
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

	it("parses /settings as the settings kind", () => {
		deepStrictEqual(parseSlashCommand("/settings"), { kind: "settings" });
	});

	it("parses /resume as the resume kind", () => {
		deepStrictEqual(parseSlashCommand("/resume"), { kind: "resume" });
	});

	it("parses /new as the new kind", () => {
		deepStrictEqual(parseSlashCommand("/new"), { kind: "new" });
	});

	it("parses /hotkeys as the hotkeys kind", () => {
		deepStrictEqual(parseSlashCommand("/hotkeys"), { kind: "hotkeys" });
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
		openTree: () => {},
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

	it("Alt+T triggers openTree only", () => {
		let tree = 0;
		let thinking = 0;
		const consumed = routeInteractiveKey(ALT_T, {
			...noopDeps,
			openTree: () => {
				tree += 1;
			},
			cycleThinking: () => {
				thinking += 1;
			},
		});
		strictEqual(consumed, true);
		strictEqual(tree, 1);
		strictEqual(thinking, 0);
	});
});

describe("message-picker buildMessagePickerRows", () => {
	const makeTurn = (
		id: string,
		kind: "user" | "assistant",
		payload: unknown,
		at = "2026-04-17T12:00:00.000Z",
	): { id: string; parentId: string | null; at: string; kind: "user" | "assistant"; payload: unknown } => ({
		id,
		parentId: null,
		at,
		kind,
		payload,
	});

	it("returns one row per assistant turn and drops user turns", () => {
		const rows = buildMessagePickerRows([
			makeTurn("u1", "user", { text: "hello" }),
			makeTurn("a1", "assistant", { text: "hi there" }),
			makeTurn("u2", "user", { text: "another" }),
			makeTurn("a2", "assistant", { text: "pong" }),
		]);
		strictEqual(rows.length, 2);
		strictEqual(
			rows.every((r) => r.turnId.startsWith("a")),
			true,
		);
	});

	it("orders rows most-recent first", () => {
		const rows = buildMessagePickerRows([
			makeTurn("a1", "assistant", { text: "first" }, "2026-04-17T10:00:00.000Z"),
			makeTurn("a2", "assistant", { text: "second" }, "2026-04-17T11:00:00.000Z"),
			makeTurn("a3", "assistant", { text: "third" }, "2026-04-17T12:00:00.000Z"),
		]);
		deepStrictEqual(
			rows.map((r) => r.turnId),
			["a3", "a2", "a1"],
		);
	});

	it("truncates the preview to the first line with an ellipsis past the width budget", () => {
		const long = "a".repeat(100);
		const rows = buildMessagePickerRows([makeTurn("a1", "assistant", { text: `${long}\nsecond line` })]);
		const preview = rows[0]?.preview ?? "";
		ok(preview.endsWith("…"), `expected ellipsis, got ${JSON.stringify(preview)}`);
		ok(!preview.includes("second line"), "second line must not appear");
		ok(preview.length <= 60, "preview must fit in PREVIEW_WIDTH");
	});

	it("renders (no text) when the payload has no extractable string", () => {
		const rows = buildMessagePickerRows([makeTurn("a1", "assistant", {})]);
		strictEqual(rows[0]?.preview, "(no text)");
	});

	it("rowsToItems shapes each row into a SelectItem with shortId and ISO-minute stamp", () => {
		const items = rowsToItems([
			{
				turnId: "00000000-abcd-7000-8000-aaaaaaaaaaaa",
				shortId: "00000000",
				at: "2026-04-17T12:34:56.789Z",
				preview: "hello",
			},
		]);
		strictEqual(items.length, 1);
		const item = items[0];
		strictEqual(item?.value, "00000000-abcd-7000-8000-aaaaaaaaaaaa");
		ok(item?.label.includes("00000000"), "label must include short id");
		ok(item?.label.includes("hello"), "label must include preview");
		strictEqual(item?.description, "2026-04-17 12:34");
	});
});

describe("message-picker payloadPreview", () => {
	it("returns a raw string payload unchanged", () => {
		strictEqual(payloadPreview("direct text"), "direct text");
	});

	it("extracts payload.text when available", () => {
		strictEqual(payloadPreview({ text: "from text field" }), "from text field");
	});

	it("extracts the first text block from a pi-ai content array", () => {
		strictEqual(
			payloadPreview({
				content: [
					{ type: "tool_use", id: "x" },
					{ type: "text", text: "from content array" },
				],
			}),
			"from content array",
		);
	});

	it("returns empty string for unrecognized shapes", () => {
		strictEqual(payloadPreview(null), "");
		strictEqual(payloadPreview(undefined), "");
		strictEqual(payloadPreview(42), "");
		strictEqual(payloadPreview({ other: "field" }), "");
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

describe("settings overlay", () => {
	it("buildSettingItems exposes the three cycled enums with values arrays", () => {
		const items = buildSettingItems(structuredClone(DEFAULT_SETTINGS));
		const defaultMode = items.find((i) => i.id === "defaultMode");
		ok(defaultMode);
		deepStrictEqual(defaultMode.values, ["default", "advise", "super"]);
		const safety = items.find((i) => i.id === "safetyLevel");
		ok(safety);
		deepStrictEqual(safety.values, ["suggest", "auto-edit", "full-auto"]);
		const thinking = items.find((i) => i.id === "orchestrator.thinkingLevel");
		ok(thinking);
		deepStrictEqual(thinking.values, ["off", "minimal", "low", "medium", "high", "xhigh"]);
	});

	it("buildSettingItems renders free-text rows with currentValue but no values", () => {
		const items = buildSettingItems(structuredClone(DEFAULT_SETTINGS));
		const provider = items.find((i) => i.id === "orchestrator.provider");
		ok(provider);
		strictEqual(provider.currentValue, "(unset)");
		strictEqual(provider.values, undefined);
	});

	it("applySettingChange cycles enum values and ignores invalid input", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		applySettingChange(settings, "defaultMode", "advise");
		strictEqual(settings.defaultMode, "advise");
		applySettingChange(settings, "defaultMode", "bogus");
		strictEqual(settings.defaultMode, "advise");
		applySettingChange(settings, "orchestrator.thinkingLevel", "high");
		strictEqual(settings.orchestrator.thinkingLevel, "high");
		applySettingChange(settings, "orchestrator.thinkingLevel", "definitely-not-a-level");
		strictEqual(settings.orchestrator.thinkingLevel, "high");
	});

	it("applySettingChange ignores free-text ids", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		applySettingChange(settings, "orchestrator.provider", "openai");
		strictEqual(settings.orchestrator.provider, undefined);
	});
});

describe("session-selector buildSessionItems", () => {
	const base = {
		cwd: "/tmp/test",
		cwdHash: "deadbeef",
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: "0.0.0-test",
		piMonoVersion: "0.0.0-test",
		platform: "linux",
		nodeVersion: "v24.0.0",
	} as const;

	it("renders ✓ for ended sessions and ● for still-open ones", () => {
		const items = buildSessionItems([
			{
				...base,
				id: "s-ended-1234",
				createdAt: "2026-04-17T10:00:00.000Z",
				endedAt: "2026-04-17T11:00:00.000Z",
				provider: "anthropic",
				model: "claude-sonnet-4-6",
			},
			{
				...base,
				id: "s-open-5678",
				createdAt: "2026-04-17T12:00:00.000Z",
				endedAt: null,
				provider: null,
				model: null,
			},
		]);
		strictEqual(items.length, 2);
		ok(items[0]?.label.startsWith("✓"), `expected ✓ glyph, got ${items[0]?.label}`);
		ok(items[1]?.label.startsWith("●"), `expected ● glyph, got ${items[1]?.label}`);
		ok(items[0]?.value === "s-ended-1234");
	});

	it("handles empty history", () => {
		deepStrictEqual(buildSessionItems([]), []);
	});
});

describe("hotkeys overlay", () => {
	it("HOTKEYS lists every slash command exposed via the registry", () => {
		const keysWithSlash = new Set(HOTKEYS.filter((h) => h.keys.startsWith("/")).map((h) => h.keys.split(" ")[0]));
		for (const name of ["/help", "/hotkeys", "/model", "/scoped-models", "/settings", "/resume", "/new", "/thinking"]) {
			ok(keysWithSlash.has(name), `hotkeys missing ${name}`);
		}
	});

	it("HOTKEYS lists the Phase 11 keybindings", () => {
		const keyBindings = new Set(HOTKEYS.filter((h) => !h.keys.startsWith("/")).map((h) => h.keys));
		ok(keyBindings.has("Shift+Tab"));
		ok(keyBindings.has("Alt+M"));
		ok(keyBindings.has("Ctrl+L"));
		ok(keyBindings.has("Ctrl+P / Shift+Ctrl+P"));
		ok(keyBindings.has("Ctrl+B"));
		ok(keyBindings.has("Ctrl+D"));
		ok(keyBindings.has("Esc"));
	});

	it("formatHotkeysLines draws a framed table with scope headers", () => {
		const lines = formatHotkeysLines(64);
		ok(lines[0]?.startsWith("┌"));
		ok(lines.at(-1)?.startsWith("└"));
		ok(lines.some((l) => l.includes("GLOBAL")));
		ok(lines.some((l) => l.includes("EDITOR")));
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
