import { doesNotMatch, match, ok } from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/index.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { ModelOverlayView, type ModelRow } from "../../src/interactive/overlays/model-selector.js";
import { clioTheme, GLYPH } from "../../src/interactive/theme/index.js";

function selectableModelRow(): ModelRow {
	const caps = { ...EMPTY_CAPABILITIES, chat: true, tools: true };
	return {
		value: "next-target/next-model",
		target: "next-target",
		model: "next-model",
		runtimeName: "Contract runtime",
		runtimeShortName: "Contract",
		runtimeId: "contract-runtime",
		apiFamily: "openai-completions",
		bucket: "local",
		source: "configured",
		authText: "ready",
		available: true,
		reason: "",
		healthToken: "success",
		healthText: "healthy",
		caps,
		capabilityDecisions: {
			chat: true,
			tools: true,
			reasoning: false,
			vision: false,
			streaming: true,
			contextWindow: 32768,
			maxTokens: 8192,
		},
		thinking: "off",
		streaming: true,
		badges: "T",
		context: "32kctx",
		maxTokens: "8k",
		active: false,
		scoped: false,
		visibleByDefault: true,
		selectable: true,
	};
}

test("model picker uses state marks and target health without origin or health glyphs", () => {
	const models = [
		{ ...selectableModelRow(), model: "active-model", value: "active", active: true },
		{ ...selectableModelRow(), model: "favorite-model", value: "favorite", favorite: true },
		{ ...selectableModelRow(), model: "recent-model", value: "recent", recent: true },
		{ ...selectableModelRow(), model: "scoped-model", value: "scoped", scoped: true },
		{ ...selectableModelRow(), model: "default-model", value: "default", defaultModel: true },
	];
	for (const width of [60, 80, 120, 200]) {
		const view = new ModelOverlayView(
			models,
			{
				totalModels: 5_000_000,
				targets: 120_000,
				localModels: 2_000_000,
				cloudModels: 3_000_000,
				activeRef: "active-model",
			},
			() => {},
			undefined,
			() => {},
		);
		const rows = view.render(width);
		const plain = rows.map(stripTerminalSequences);
		match(plain.find((line) => line.includes("active-model") && !line.includes("current")) ?? "", /✓ active-model/);
		match(plain.find((line) => line.includes("favorite-model")) ?? "", /★ favorite-model/);
		match(plain.find((line) => line.includes("recent-model")) ?? "", /↺ recent-model/);
		for (const id of ["scoped", "default"]) {
			view.setSelectedValue(id);
			match(view.render(width).map(stripTerminalSequences).join("\n"), new RegExp(`${id} next-target`));
		}
		doesNotMatch(plain.join("\n"), /[◆◇●◐○]/u);
		if (width === 60) match(plain[0] ?? "", /…$/u);
		ok(
			rows.some((line) => line.includes(clioTheme().fgSequence("success"))),
			"target carries health color",
		);
		for (const line of rows) {
			ok(visibleWidth(line) <= width);
			const clean = line.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
			ok([...clean].every((char) => char.charCodeAt(0) >= 32 && (char.charCodeAt(0) < 127 || char.charCodeAt(0) > 159)));
		}
		view.dispose();
	}
});

test("model cell fits wide graphemes without cutting the distinguishing suffix", () => {
	const row = { ...selectableModelRow(), model: `${"研究".repeat(30)}-FINAL`, active: true };
	const view = new ModelOverlayView(
		[row],
		{ totalModels: 1, targets: 1, localModels: 1, cloudModels: 0, activeRef: "" },
		() => {},
		undefined,
		() => {},
	);
	try {
		for (const width of [60, 80, 120, 200]) {
			const line = view
				.render(width)
				.map(stripTerminalSequences)
				.find((text) => text.startsWith(GLYPH.cursor));
			ok(line);
			ok(visibleWidth(line) <= width);
			match(line, /-FINAL/);
		}
	} finally {
		view.dispose();
	}
});
