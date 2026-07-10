import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { runContextRefresh } from "../../src/domains/context/refresh.js";
import {
	type BootstrapGenerationState,
	readClioState,
	statePath,
	writeClioState,
} from "../../src/domains/context/state.js";

const scratchRoots: string[] = [];
const fingerprint = { treeHash: "a".repeat(64), gitHead: null, loc: 0 };
const completeBootstrapState: BootstrapGenerationState = {
	mode: "scout",
	parserOutcome: "parsed",
	structuredOutputMode: "prompt-parser",
	runId: "run-1",
	targetId: "local",
	wireModelId: "model-1",
	runtimeId: "ollama-native",
	runtimeKind: "native",
	thinkingLevel: "off",
	tokenCount: 42,
	toolCalls: 3,
	durationMs: 1250,
	promptBytes: 4096,
	outputBytes: 1024,
};

afterEach(() => {
	for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratchProject(): string {
	const cwd = mkdtempSync(join(tmpdir(), "clio-context-state-"));
	scratchRoots.push(cwd);
	mkdirSync(join(cwd, ".clio"), { recursive: true });
	return cwd;
}

function writeRawBootstrapState(cwd: string, lastBootstrap: unknown): void {
	writeFileSync(statePath(cwd), `${JSON.stringify({ version: 1, fingerprint, lastBootstrap }, null, 2)}\n`, "utf8");
}

describe("contracts/context-state", () => {
	it("round-trips bounded bootstrap generation telemetry", () => {
		const cwd = scratchProject();

		writeClioState(cwd, { version: 1, fingerprint, lastBootstrap: completeBootstrapState });

		deepStrictEqual(readClioState(cwd)?.lastBootstrap, completeBootstrapState);
	});

	it("preserves bootstrap generation telemetry across a context refresh", async () => {
		const cwd = scratchProject();
		writeClioState(cwd, { version: 1, fingerprint, lastBootstrap: completeBootstrapState });

		await runContextRefresh({ cwd });

		deepStrictEqual(readClioState(cwd)?.lastBootstrap, completeBootstrapState);
	});

	it("rejects malformed or unbounded bootstrap generation telemetry", () => {
		const cwd = scratchProject();
		const valid = { mode: "heuristic", parserOutcome: "not-run" };
		const invalid: ReadonlyArray<unknown> = [
			{ ...valid, mode: "model" },
			{ ...valid, parserOutcome: "unknown" },
			{ ...valid, structuredOutputMode: "grammar" },
			{ ...valid, fallbackReason: " " },
			{ ...valid, fallbackReason: "x".repeat(4097) },
			{ ...valid, runId: "" },
			{ ...valid, runtimeKind: "\t" },
			{ ...valid, tokenCount: -1 },
			{ ...valid, toolCalls: 1.5 },
			{ ...valid, durationMs: Number.MAX_SAFE_INTEGER + 1 },
			{ ...valid, promptBytes: null },
			{ ...valid, unexpected: "unbounded" },
		];

		for (const value of invalid) {
			writeRawBootstrapState(cwd, value);
			strictEqual(readClioState(cwd), null, `accepted invalid telemetry: ${JSON.stringify(value)}`);
		}
	});
});
