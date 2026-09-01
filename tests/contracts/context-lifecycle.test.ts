import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	applyInitImplications,
	bootstrapInputFromInitOptions,
	validateInitOptions,
} from "../../src/domains/context/init-options.js";
import { runContextRefresh } from "../../src/domains/context/refresh.js";
import { readClioState, writeClioState } from "../../src/domains/context/state.js";
import { assembleWikiTree } from "../../src/domains/context/wiki/assemble.js";
import {
	appendContextSnapshot,
	captureContextSnapshot,
	getLatestContextSnapshot,
	lastLoadedContextWindow,
	reconcileSnapshot,
} from "../../src/domains/session/context-accounting.js";
import type { SessionMeta } from "../../src/domains/session/contract.js";
import type { Usage } from "../../src/engine/types.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

const fingerprint = { treeHash: "a".repeat(64), gitHead: null, loc: 1 };
const generation = {
	mode: "model" as const,
	parserOutcome: "parsed" as const,
	runId: "run-7",
	targetId: "local",
	wireModelId: "model-7",
	tokenCount: 42,
};

function snapshot(turnId: string, source: string, window: number, providerId = "local", modelId = "model-7") {
	return captureContextSnapshot({
		sessionId: "session-1",
		turnId,
		providerId,
		runtimeId: "runtime-1",
		modelId,
		systemPrompt: "system context",
		conversationMessages: [{ role: "user", content: "inspect the repository" }],
		activeToolSchemas: [{ name: "read", description: "read a file", parameters: { type: "object" } }],
		desiredContextWindow: 131_072,
		effectiveContextWindow: window,
		contextWindowSource: source,
		compactionThreshold: 0.8,
	});
}

describe("contracts/context lifecycle", () => {
	let isolated: IsolatedClioEnv;

	beforeEach(async () => {
		isolated = await isolateClioEnv("clio-context-lifecycle-");
	});

	afterEach(() => isolated.restore());

	it("normalizes initialization options before validating and dispatching", () => {
		deepStrictEqual(applyInitImplications({ rewriteClioMd: true }), {
			rewriteClioMd: true,
			applyClioMd: true,
		});
		deepStrictEqual(bootstrapInputFromInitOptions({ rewriteClioMd: true, heuristic: true }), {
			rewriteClioMd: true,
			applyClioMd: true,
		});
		strictEqual(validateInitOptions({ proposeClioMd: true, adopt: true })?.includes("cannot be combined"), true);
		strictEqual(validateInitOptions({ adopt: true }), null);
	});

	it("reconciles estimates to provider usage without losing the original comparison", () => {
		const estimated = snapshot("turn-1", "configured", 100_000);
		const estimateTokens = estimated.estimatedTokens ?? 0;
		const usage = {
			input: estimateTokens + 400,
			output: 25,
			cacheRead: 100,
			cacheWrite: 50,
			totalTokens: estimateTokens + 575,
		} as Usage;
		const reconciled = reconcileSnapshot(estimated, usage);

		strictEqual(reconciled.estimatedTokens, estimateTokens);
		strictEqual(reconciled.reconciledTokens, estimateTokens + 550);
		strictEqual(reconciled.categories.streaming, 25);
		strictEqual(reconciled.sources.total, "reconciled");
		strictEqual(reconciled.divergenceRatio, Math.round(((estimateTokens + 550) / estimateTokens) * 1000) / 1000);
	});

	it("refreshes the index while preserving handbook-generation provenance", async () => {
		const cwd = isolated.dir;
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "context-lifecycle", type: "module" }));
		writeFileSync(join(cwd, "src", "index.ts"), "export const contextLifecycle = true;\n");
		writeClioState(cwd, { version: 1, fingerprint, lastBootstrap: generation });

		const result = await runContextRefresh({ cwd, now: () => new Date("2026-08-31T12:00:00.000Z") });

		strictEqual(result.action, "refreshed");
		strictEqual(result.codewikiEntries, 1);
		deepStrictEqual(readClioState(cwd)?.lastBootstrap, generation);
		strictEqual(readClioState(cwd)?.lastIndexedAt, "2026-08-31T12:00:00.000Z");
	});

	it("resumes from the latest persisted snapshot and bounds loaded-window recall to its target", () => {
		const meta = {
			id: "session-1",
			createdAt: "2026-08-31T12:00:00.000Z",
			cwd: isolated.dir,
			cwdHash: "context-lifecycle",
		} as SessionMeta;
		const first = snapshot("turn-1", "loaded", 65_536);
		const otherModel = snapshot("turn-2", "loaded", 200_000, "local", "other-model");
		const latest = snapshot("turn-3", "probe", 262_144);
		for (const value of [first, otherModel, latest]) appendContextSnapshot(meta, value);

		const resumed = getLatestContextSnapshot(meta);
		strictEqual(resumed?.turnId, "turn-3");
		strictEqual(resumed?.systemPrompt, undefined, "heavy prompt inputs are not duplicated in the ledger");
		strictEqual(lastLoadedContextWindow(meta, "local", "model-7"), 65_536);
		strictEqual(lastLoadedContextWindow(meta, "local", "other-model"), 200_000);
		strictEqual(lastLoadedContextWindow(meta, "remote", "model-7"), null);
	});

	it("writes canonical wiki repair markers and consumes the released marker", () => {
		const wiki = join(isolated.dir, ".clio-coder", "wiki");
		mkdirSync(wiki, { recursive: true });
		const page = join(wiki, "architecture.md");
		writeFileSync(
			page,
			"# Architecture\n\nArchitecture details.\n\n[Missing](missing.md)\n\n<!-- clio:wiki stale marker -->\n",
			"utf8",
		);
		const plan = { version: 1 as const, overview: "", pages: [] };
		assembleWikiTree({ dir: wiki, sourceRoot: isolated.dir, plan });
		const canonical = readFileSync(page, "utf8");
		strictEqual(canonical.includes("<!-- clio-coder:wiki unresolved links: missing.md -->"), true);
		strictEqual(canonical.includes("<!-- clio:wiki"), false);
		assembleWikiTree({ dir: wiki, sourceRoot: isolated.dir, plan });
		strictEqual(readFileSync(page, "utf8"), canonical);
	});
});
