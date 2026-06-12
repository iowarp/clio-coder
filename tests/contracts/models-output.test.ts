/**
 * `clio models` text-output contract (bt-05 findings 1 and 2): an empty
 * search result must not claim no targets are configured when targets
 * exist, and long model ids must not run into the caps column.
 */

import { match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyModelsMessage, type ModelRow, modelTableLines } from "../../src/cli/models.js";

function row(overrides: Partial<ModelRow>): ModelRow {
	return {
		targetId: "mini",
		runtimeId: "openai-completions",
		modelId: "test-model",
		caps: "CTR----",
		contextWindow: 131_072,
		maxTokens: 8192,
		reasoning: true,
		...overrides,
	};
}

describe("contracts/models-output", () => {
	it("empty search against configured targets reports zero matches, not missing targets", () => {
		const message = emptyModelsMessage({ search: "zzz-no-such-model-xyz" }, 2, 2);
		strictEqual(message, 'no models matched "zzz-no-such-model-xyz" across 2 targets.');
		ok(!message.includes("no targets configured"));
	});

	it("keeps the true no-targets message when nothing is configured", () => {
		const message = emptyModelsMessage({ search: "anything" }, 0, 0);
		strictEqual(message, "no targets configured. run `clio configure` or `clio targets add` to register one.");
	});

	it("an unknown --target id is named instead of claiming no targets exist", () => {
		const message = emptyModelsMessage({ target: "does-not-exist" }, 2, 0);
		strictEqual(message, "no target with id does-not-exist. 2 targets configured.");
	});

	it("singular target count reads naturally", () => {
		const message = emptyModelsMessage({ search: "nope" }, 1, 1);
		strictEqual(message, 'no models matched "nope" across 1 target.');
	});

	it("a long model id stays separable from the caps column", () => {
		const longId = "nvidia-nemotron-3-nano-omni-30b-a3b-reasoning";
		const lines = modelTableLines([
			row({
				targetId: "dynamo",
				runtimeId: "lmstudio-native",
				modelId: longId,
				caps: "CTRV---",
				contextWindow: 1_000_000,
			}),
			row({ modelId: "short-model" }),
		]);
		const longLine = lines[1] ?? "";
		// The id must be followed by whitespace before caps, never concatenated.
		ok(!longLine.includes(`${longId}CTRV---`), `id ran into caps column: ${longLine}`);
		match(longLine, new RegExp(`${longId}\\s{2,}CTRV---`));
		// Every line splits into the same six whitespace-delimited columns.
		for (const line of lines) {
			strictEqual(line.split(/\s{2,}/).length, 6, `unparseable columns: ${line}`);
		}
	});

	it("ids beyond the width cap are truncated with a visible marker", () => {
		const hugeId = `qwen3.5-35b-a3b-claude-4.6-${"x".repeat(60)}-distilled-i1`;
		const lines = modelTableLines([row({ modelId: hugeId, caps: "CTR----" })]);
		const line = lines[1] ?? "";
		ok(!line.includes(hugeId), "over-cap id was not truncated");
		match(line, /\.\.\.\s{2,}CTR----/);
	});

	it("columns align: caps starts at the same offset on every row", () => {
		const lines = modelTableLines([
			row({ caps: "CT-----" }),
			row({ modelId: "another-model-with-a-longer-id", caps: "CTRV---" }),
		]);
		const offsets = [lines[1], lines[2]].map((line) => (line ?? "").search(/\sC[TR-]/));
		strictEqual(offsets[0], offsets[1]);
	});
});
