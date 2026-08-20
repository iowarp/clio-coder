import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import { ModelOverlayView, type ModelRow } from "../../src/interactive/overlays/model-selector.js";

const stripAnsi = (lines: string[]): string => stripTerminalSequences(lines.join("\n"));

function modelRow(target: string, model: string, overrides: Partial<ModelRow> = {}): ModelRow {
	return {
		value: `${target}/${model}`,
		target,
		model,
		runtimeName: "OpenAI-compatible API",
		runtimeShortName: "OpenAI-compatible",
		runtimeId: "openai-completions",
		apiFamily: "openai",
		bucket: "cloud",
		source: "configured",
		authText: "environment",
		available: true,
		reason: "",
		healthGlyph: "●",
		healthText: "healthy 12ms",
		caps: {} as ModelRow["caps"],
		badges: "TR",
		context: "128kctx",
		maxTokens: "16k",
		active: false,
		scoped: false,
		visibleByDefault: true,
		selectable: true,
		...overrides,
	};
}

function modelView(rows: ModelRow[]): ModelOverlayView {
	return new ModelOverlayView(
		rows,
		{
			totalModels: rows.length,
			targets: new Set(rows.map((row) => row.target)).size,
			localModels: rows.filter((row) => row.bucket === "local").length,
			cloudModels: rows.filter((row) => row.bucket === "cloud").length,
			activeRef: "",
		},
		() => {},
		undefined,
		() => {},
	);
}

function search(view: ModelOverlayView, query: string): void {
	for (const character of query) view.handleInput(character);
}

describe("contracts/model selector fuzzy search", () => {
	it("finds and ranks a model in a 40-entry wireModels-style list", () => {
		const rows = Array.from({ length: 40 }, (_, index) =>
			modelRow("science", index === 31 ? "qwen3.6-coder-35b-a3b" : `catalog-model-${String(index + 1).padStart(2, "0")}`),
		);
		const view = modelView(rows);

		search(view, "qwen coder");

		strictEqual(view.selectedValue(), "science/qwen3.6-coder-35b-a3b");
		const rendered = view.render(100).join("\n");
		ok(rendered.includes("1/40 models"), rendered);
	});

	it("ranks a direct target/model ref ahead of the same ref proxied as a model id", () => {
		const view = modelView([
			modelRow("openrouter", "openai/gpt-5"),
			modelRow("openai-lab", "gpt-5-mini"),
			modelRow("openai", "gpt-5"),
		]);

		search(view, "openai/gpt-5");

		strictEqual(view.selectedValue(), "openai/gpt-5");
	});

	it("matches ordered subsequences across a model id", () => {
		const view = modelView([modelRow("local", "deepseek-r1-14b"), modelRow("local", "qwen3.6-coder-35b-a3b")]);

		search(view, "q3cd35");

		strictEqual(view.selectedValue(), "local/qwen3.6-coder-35b-a3b");
	});

	it("keeps Clio availability facts searchable", () => {
		const view = modelView([
			modelRow("ready", "model-a"),
			modelRow("offline", "model-b", {
				available: false,
				authText: "disconnected",
				healthText: "down: connection refused",
			}),
		]);

		search(view, "disconnected");

		strictEqual(view.selectedValue(), "offline/model-b");
	});
});

describe("contracts/model selector row layout", () => {
	it("keeps a gutter between a full-width model id and the ctx column", () => {
		// The real catalog carries ids long enough to fill the model column
		// exactly, which used to render "…-distilled-i1262kctx" with no separator.
		const view = modelView([
			modelRow("zbook", "qwen3.5-35b-a3b-claude-4.6-opus-reasoning-distilled-i1", { context: "262kctx" }),
			modelRow("zbook", "short-id", { context: "262kctx" }),
		]);

		for (const line of stripAnsi(view.render(94)).split("\n")) {
			const at = line.indexOf("262kctx");
			if (at < 0) continue;
			strictEqual(line[at - 1], " ", `the ctx figure keeps a leading space, got: ${line}`);
		}
	});

	it("holds the ctx column at one stop across ids of every length", () => {
		const view = modelView([
			modelRow("zbook", "a", { context: "262kctx" }),
			modelRow("zbook", "qwen3.5-35b-a3b-claude-4.6-opus-reasoning-distilled-i1", { context: "262kctx" }),
		]);

		const offsets = stripAnsi(view.render(94))
			.split("\n")
			.map((line) => line.indexOf("262kctx"))
			.filter((at) => at >= 0);
		strictEqual(offsets.length, 2, "both rows render their ctx figure");
		strictEqual(offsets[0], offsets[1], "the ctx column does not move with the model id length");
	});
});
