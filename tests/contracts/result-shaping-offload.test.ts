import { ok, strictEqual } from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { Type } from "typebox";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import type { ToolResult, ToolSpec } from "../../src/tools/registry.js";
import { shapeToolResult } from "../../src/tools/result-shaping.js";

const roots: string[] = [];
const savedEnv = {
	CLIO_HOME: process.env.CLIO_HOME,
	CLIO_DATA_DIR: process.env.CLIO_DATA_DIR,
	CLIO_CONFIG_DIR: process.env.CLIO_CONFIG_DIR,
	CLIO_STATE_DIR: process.env.CLIO_STATE_DIR,
	CLIO_CACHE_DIR: process.env.CLIO_CACHE_DIR,
};

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
	restoreEnv("CLIO_HOME", savedEnv.CLIO_HOME);
	restoreEnv("CLIO_DATA_DIR", savedEnv.CLIO_DATA_DIR);
	restoreEnv("CLIO_CONFIG_DIR", savedEnv.CLIO_CONFIG_DIR);
	restoreEnv("CLIO_STATE_DIR", savedEnv.CLIO_STATE_DIR);
	restoreEnv("CLIO_CACHE_DIR", savedEnv.CLIO_CACHE_DIR);
	resetXdgCache();
});

function restoreEnv(key: keyof typeof savedEnv, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

function useStateDir(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-result-shaping-"));
	roots.push(root);
	process.env.CLIO_HOME = root;
	process.env.CLIO_DATA_DIR = join(root, "data");
	process.env.CLIO_CONFIG_DIR = join(root, "config");
	process.env.CLIO_STATE_DIR = join(root, "state");
	process.env.CLIO_CACHE_DIR = join(root, "cache");
	resetXdgCache();
	return process.env.CLIO_STATE_DIR;
}

function mockToolSpec(name: ToolName, maxBytes: number): ToolSpec {
	return {
		name,
		description: "test tool",
		parameters: Type.Object({}),
		baseActionClass: "read",
		metadata: {
			objective: "test objective",
			uiLabel: name,
			retrySafety: "idempotent",
			costLatency: "local_fast",
			resultSizePolicy: {
				kind: "truncate",
				maxBytes,
				followUpHint: "narrow the request",
			},
		},
		run: async () => ({ kind: "ok", output: "" }),
	};
}

function resultSize(result: ToolResult): Record<string, unknown> {
	const candidate = result.details?.resultSize;
	if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
		throw new Error("missing resultSize details");
	}
	return candidate as Record<string, unknown>;
}

function outputText(result: ToolResult): string {
	if (result.kind !== "ok") throw new Error("expected ok result");
	return result.output;
}

function offloadPath(result: ToolResult): string {
	const value = resultSize(result).offloadPath;
	if (typeof value !== "string") throw new Error("missing offloadPath");
	return value;
}

describe("contracts/result-shaping offload", () => {
	it("passes under-cap results through untouched with no scratch file", () => {
		const stateDir = useStateDir();
		const original: ToolResult = { kind: "ok", output: "short output" };

		const shaped = shapeToolResult(mockToolSpec(ToolNames.Bash, 128), original, {
			sessionId: "session-1",
			toolCallId: "call-1",
		});

		strictEqual(shaped, original);
		strictEqual(existsSync(join(stateDir, "scratch")), false);
	});

	it("writes full over-cap output and includes the scratch path in the hint", () => {
		const stateDir = useStateDir();
		const text = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join("\n");

		const shaped = shapeToolResult(
			mockToolSpec(ToolNames.Bash, 64),
			{ kind: "ok", output: text },
			{
				sessionId: "session-1",
				toolCallId: "call-1",
			},
		);

		const path = offloadPath(shaped);
		strictEqual(path, join(stateDir, "scratch", "session-1", "call-1.txt"));
		strictEqual(readFileSync(path, "utf8"), text);
		ok(outputText(shaped).includes("[tool result truncated]"));
		ok(outputText(shaped).includes(`Full output saved to ${path}; read it with offset and limit to inspect the rest.`));
	});

	it("keeps one offload file and path when a shaped result is shaped again", () => {
		const stateDir = useStateDir();
		const text = "x".repeat(1024);
		const spec = mockToolSpec(ToolNames.Bash, 64);

		const first = shapeToolResult(spec, { kind: "ok", output: text }, { sessionId: "session-1", toolCallId: "call-1" });
		const second = shapeToolResult(spec, first, { sessionId: "session-1", toolCallId: "call-1" });

		strictEqual(second, first);
		strictEqual(offloadPath(second), offloadPath(first));
		strictEqual(readdirSync(join(stateDir, "scratch", "session-1")).length, 1);
		strictEqual(outputText(second).match(/Full output saved/g)?.length, 1);
	});

	it("falls back to the old truncation shape when the offload write fails", () => {
		const stateDir = useStateDir();
		mkdirSync(join(stateDir, "scratch"), { recursive: true });
		writeFileSync(join(stateDir, "scratch", "blocked"), "not a directory", "utf8");

		const shaped = shapeToolResult(
			mockToolSpec(ToolNames.Bash, 64),
			{ kind: "ok", output: "x".repeat(1024) },
			{
				sessionId: "blocked",
				toolCallId: "call-1",
			},
		);

		strictEqual(resultSize(shaped).offloadPath, undefined);
		ok(outputText(shaped).includes("[tool result truncated]"));
		ok(outputText(shaped).includes("[narrow the request]"));
		strictEqual(outputText(shaped).includes("Full output saved"), false);
	});

	it("caps oversized scratch dumps at 10MB and records the cut in the last line", () => {
		useStateDir();
		const maxDumpBytes = 10 * 1024 * 1024;
		const text = "a".repeat(maxDumpBytes + 1024);

		const shaped = shapeToolResult(
			mockToolSpec(ToolNames.Bash, 64),
			{ kind: "ok", output: text },
			{
				sessionId: "session-1",
				toolCallId: "call-1",
			},
		);

		const path = offloadPath(shaped);
		const saved = readFileSync(path, "utf8");
		ok(statSync(path).size <= maxDumpBytes);
		ok(saved.endsWith(`[clio scratch output truncated at ${maxDumpBytes} bytes; original size ${text.length} bytes]`));
	});
});
