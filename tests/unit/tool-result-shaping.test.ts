import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { ToolNames } from "../../src/core/tool-names.js";
import { readTool } from "../../src/tools/read.js";
import type { ToolSpec } from "../../src/tools/registry.js";
import { shapeToolResult } from "../../src/tools/result-shaping.js";

function spec(name: ToolSpec["name"], maxBytes: number): ToolSpec {
	return {
		name,
		description: "test tool",
		parameters: Type.Object({}),
		baseActionClass: "read",
		metadata: {
			objective: "test objective",
			uiLabel: String(name),
			retrySafety: "idempotent",
			costLatency: "local_fast",
			resultSizePolicy: {
				kind: "summary",
				maxBytes,
				followUpHint: "narrow the request",
			},
		},
		run: async () => ({ kind: "ok", output: "" }),
	};
}

describe("tool result shaping", () => {
	it("bounds large bash outputs with result-size metadata", () => {
		const result = shapeToolResult(spec(ToolNames.Bash, 128), { kind: "ok", output: "x".repeat(1000) });

		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		ok(result.output.includes("[tool result truncated]"), result.output);
		ok(result.output.includes("narrow the request"), result.output);
		strictEqual((result.details?.resultSize as { truncated?: unknown } | undefined)?.truncated, true);
	});

	it("bounds large grep errors with result-size metadata", () => {
		const result = shapeToolResult(spec(ToolNames.Grep, 128), { kind: "error", message: "match\n".repeat(300) });

		strictEqual(result.kind, "error");
		if (result.kind !== "error") return;
		ok(result.message.includes("[tool result truncated]"), result.message);
		strictEqual((result.details?.resultSize as { truncated?: unknown } | undefined)?.truncated, true);
	});

	it("read large-line fallback stays tool-native and does not recommend bash", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-read-large-line-"));
		try {
			const file = join(root, "large-line.txt");
			writeFileSync(file, "x".repeat(80_000), "utf8");

			const result = await readTool.run({ path: file });

			strictEqual(result.kind, "ok");
			if (result.kind !== "ok") return;
			ok(result.output.includes("Line 1 is"), result.output);
			ok(result.output.includes("Showing the UTF-8 prefix"), result.output);
			ok(!/\bbash\b/i.test(result.output), result.output);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
