import { match, rejects, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { BusChannels } from "../../src/core/bus-events.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import type { ConfigContract } from "../../src/domains/config/contract.js";
import { createContextBundle } from "../../src/domains/context/extension.js";
import { type ContextContract, renderPromptContext, serializeClioMd } from "../../src/domains/context/index.js";
import { createPromptsBundle } from "../../src/domains/prompts/extension.js";
import type { PromptsContract } from "../../src/domains/prompts/index.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import { createTurnContext } from "../../src/interactive/turn-context.js";
import type { TurnMiddleware } from "../../src/interactive/turn-middleware.js";
import { type AgentRuntime, createTurnState } from "../../src/interactive/turn-state.js";

import { isolateClioEnv } from "../harness/scratch-env.js";

function writePromptSources(root: string, version: "ONE" | "TWO" | "THREE", clioRepo: boolean): void {
	writeFileSync(
		join(root, "CLIO-CODER.md"),
		serializeClioMd({
			projectName: `Snapshot ${version}`,
			identity: `HANDBOOK_${version}`,
			conventions: [`CONTEXT_${version}`],
			invariants: [`INVARIANT_${version}`],
		}),
	);
	mkdirSync(join(root, ".clio-coder", "rules"), { recursive: true });
	writeFileSync(join(root, ".clio-coder", "rules", "base.md"), `RULE_${version}\n`);
	writeFileSync(join(root, ".clio-coder", "rules", "scoped.md"), `---\npaths:\n  - src/**\n---\nSCOPED_${version}\n`);
	writeFileSync(
		join(root, ".clio-coder", "profile.yaml"),
		`responsePosture: ${version === "ONE" ? "concise" : version === "TWO" ? "balanced" : "thorough"}\n`,
	);

	const clioMarker = join(root, "src", "worker", "entry.ts");
	if (clioRepo) {
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ name: "@iowarp/clio-coder", repository: "https://github.com/iowarp/clio-coder" }),
		);
		mkdirSync(join(root, ".git"), { recursive: true });
		for (const path of [
			join(root, "src", "entry", "orchestrator.ts"),
			clioMarker,
			join(root, "src", "domains", "prompts", "fragments", "identity", "clio.md"),
		]) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, "// marker\n");
		}
	} else {
		rmSync(clioMarker, { force: true });
	}
}

function runtime(): AgentRuntime {
	return {
		targetId: "local",
		runtimeId: "llama.cpp",
		wireModelId: "model-one",
		runtimeResolution: {
			capabilityDecisions: { tools: true },
			contextWindowDetails: { effectiveContextWindow: 32_768, contextWindowSource: "loaded" },
		},
		agent: {
			state: {
				systemPrompt: "",
				thinkingLevel: "off",
				messages: [],
				tools: [],
			},
		},
	} as unknown as AgentRuntime;
}

describe("session prompt source snapshot", { concurrency: false }, () => {
	it("freezes real bundle disk inputs across production cache misses and refreshes at explicit boundaries", async () => {
		const originalCwd = process.cwd();
		const scratch = mkdtempSync(join(tmpdir(), "clio-prompt-snapshot-"));
		const bus = createSafeEventBus();
		let sessionId = "snapshot-session-one";
		let compileCalls = 0;
		writePromptSources(scratch, "ONE", true);
		process.chdir(scratch);

		const config: ConfigContract = {
			get: () => structuredClone(DEFAULT_SETTINGS),
			onChange: () => () => {},
		};
		const agents = {
			revision: () => 1,
			listSpecs: () => [],
		} as unknown as AgentsContract;
		const context = { renderPromptContext } as unknown as ContextContract;
		const domainContext: DomainContext = {
			bus,
			getContract(name) {
				if (name === "config") return config as never;
				if (name === "agents") return agents as never;
				if (name === "context") return context as never;
				return undefined;
			},
		};
		const bundle = createPromptsBundle(domainContext);
		await bundle.extension.start();
		const prompts: PromptsContract = {
			...bundle.contract,
			async compileSessionPrompt(input) {
				compileCalls += 1;
				return bundle.contract.compileSessionPrompt(input);
			},
		};
		const turn = createTurnContext({
			state: createTurnState("off"),
			getSettings: () => structuredClone(DEFAULT_SETTINGS),
			providers: { getRuntime: () => undefined } as unknown as ProvidersContract,
			prompts,
			session: {
				current: () => ({
					id: sessionId,
					cwd: scratch,
					cwdHash: "snapshot",
					createdAt: "2026-09-01T00:00:00.000Z",
					endedAt: null,
					model: "model-one",
					target: "local",
					clioCoderVersion: "0.4.2",
					piMonoVersion: "0.84.0",
					platform: "test",
					nodeVersion: process.version,
				}),
				appendEntry: (entry: unknown) => entry,
			} as never,
			middleware: {} as TurnMiddleware,
			emitNotice: () => {},
		});
		const agentRuntime = runtime();

		try {
			const first = await turn.ensureSessionPrompt(agentRuntime);
			await turn.ensureSessionPrompt(agentRuntime);
			strictEqual(compileCalls, 1, "an unchanged production identity must reuse the compile");
			match(first?.systemPrompt ?? "", /HANDBOOK_ONE/u);
			match(first?.systemPrompt ?? "", /RULE_ONE/u);
			match(first?.systemPrompt ?? "", /Response posture: concise/u);
			match(first?.systemPrompt ?? "", /# Clio Source Tree/u);

			writePromptSources(scratch, "TWO", false);
			turn.addWorkingContextPaths(["src/feature.ts"]);
			const workingContextMiss = await turn.ensureSessionPrompt(agentRuntime);
			strictEqual(compileCalls, 2, "working-context membership must recompile");
			match(workingContextMiss?.systemPrompt ?? "", /SCOPED_ONE/u);
			strictEqual(workingContextMiss?.systemPrompt.includes("SCOPED_TWO"), false);

			agentRuntime.wireModelId = "model-two";
			const unrelatedMiss = await turn.ensureSessionPrompt(agentRuntime);
			strictEqual(compileCalls, 3, "a wire-model change must re-enter the real compiler");
			match(unrelatedMiss?.systemPrompt ?? "", /Model: model-two/u);
			match(unrelatedMiss?.systemPrompt ?? "", /HANDBOOK_ONE/u);
			match(unrelatedMiss?.systemPrompt ?? "", /RULE_ONE/u);
			match(unrelatedMiss?.systemPrompt ?? "", /Response posture: concise/u);
			match(unrelatedMiss?.systemPrompt ?? "", /# Clio Source Tree/u);
			strictEqual(unrelatedMiss?.systemPrompt.includes("HANDBOOK_TWO"), false);

			const beforeInvalidation = prompts.inputEpoch();
			bus.emit(BusChannels.ConfigHotReload, {
				diff: { hotReload: ["context.prompt"], nextTurn: [], restartRequired: [] },
				settings: structuredClone(DEFAULT_SETTINGS),
			});
			const afterInvalidation = prompts.inputEpoch();
			strictEqual(beforeInvalidation === afterInvalidation, false, "config invalidation must advance the real epoch");
			const invalidated = await turn.ensureSessionPrompt(agentRuntime);
			strictEqual(compileCalls, 4);
			match(invalidated?.systemPrompt ?? "", /HANDBOOK_TWO/u);
			match(invalidated?.systemPrompt ?? "", /RULE_TWO/u);
			match(invalidated?.systemPrompt ?? "", /SCOPED_TWO/u);
			match(invalidated?.systemPrompt ?? "", /Response posture: balanced/u);
			strictEqual(invalidated?.systemPrompt.includes("# Clio Source Tree"), false);

			writePromptSources(scratch, "THREE", false);
			sessionId = "snapshot-session-two";
			const nextSession = await turn.ensureSessionPrompt(agentRuntime);
			strictEqual(compileCalls, 5, "a new session identity must capture a new source snapshot");
			match(nextSession?.systemPrompt ?? "", /HANDBOOK_THREE/u);
			match(nextSession?.systemPrompt ?? "", /RULE_THREE/u);
			match(nextSession?.systemPrompt ?? "", /SCOPED_THREE/u);
			match(nextSession?.systemPrompt ?? "", /Response posture: thorough/u);
		} finally {
			turn.dispose();
			await bundle.extension.stop?.();
			process.chdir(originalCwd);
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});

async function contextPromptFixture() {
	const isolated = await isolateClioEnv("clio-context-prompt-");
	const originalCwd = process.cwd();
	const cwd = join(isolated.dir, "workspace");
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "fresh-context", type: "module" }));
	writeFileSync(join(cwd, "src", "index.ts"), "export function freshContext() { return true; }\n");
	process.chdir(cwd);
	const bus = createSafeEventBus();
	const config = { get: () => structuredClone(DEFAULT_SETTINGS), onChange: () => () => {} };
	const domainContext: DomainContext = {
		bus,
		getContract(name) {
			if (name === "config") return config as never;
			if (name === "context") return context.contract as never;
			return undefined;
		},
	};
	const context = createContextBundle(domainContext);
	const prompts = createPromptsBundle(domainContext);
	await context.extension.start();
	await prompts.extension.start();
	const turn = createTurnContext({
		state: createTurnState("off"),
		getSettings: config.get,
		providers: { getRuntime: () => undefined } as unknown as ProvidersContract,
		prompts: prompts.contract,
		session: { current: () => ({ id: "live-context-session", cwd }), appendEntry: (entry: unknown) => entry } as never,
		middleware: {} as TurnMiddleware,
		emitNotice: () => {},
	});
	const agentRuntime = runtime();
	return {
		cwd,
		context: context.contract,
		prompts: prompts.contract,
		agentRuntime,
		async prompt(workspace = cwd) {
			process.chdir(workspace);
			return (await turn.ensureSessionPrompt(agentRuntime))?.systemPrompt ?? "";
		},
		async close() {
			turn.dispose();
			await prompts.extension.stop?.();
			await context.extension.stop?.();
			process.chdir(originalCwd);
			isolated.restore();
		},
	};
}

function writeRefreshHandbook(cwd: string): void {
	writeFileSync(
		join(cwd, "CLIO-CODER.md"),
		serializeClioMd({
			projectName: "Fresh context",
			identity: "LIVE_HANDBOOK",
			conventions: [],
			invariants: [],
			sections: [{ title: "Context retrieval", body: "OLD_NAVIGATION" }],
		}),
	);
}

describe("explicit context operations refresh the running prompt", { concurrency: false }, () => {
	it("loads a newly initialized handbook through the existing turn cache", async () => {
		const f = await contextPromptFixture();
		try {
			const before = await f.prompt();
			const result = await f.context.runBootstrap({ cwd: f.cwd });
			strictEqual(result.summary.action, "wrote");
			strictEqual(existsSync(join(f.cwd, "CLIO-CODER.md")), true);
			const after = await f.prompt();
			strictEqual(after === before, false, "successful init must replace the cached session prompt");
			strictEqual(after.includes(renderPromptContext(f.cwd).clioMd?.projectName ?? "MISSING_HANDBOOK"), true);
			strictEqual(await f.prompt(), after, "the refreshed prompt is stable on the next turn");
		} finally {
			await f.close();
		}
	});

	it("refreshes curated handbook content while keeping other workspace snapshots frozen", async () => {
		const f = await contextPromptFixture();
		try {
			writeRefreshHandbook(f.cwd);
			strictEqual((await f.prompt()).includes("OLD_NAVIGATION"), true);
			const other = join(f.cwd, "..", "other");
			mkdirSync(other);
			writePromptSources(other, "ONE", false);
			const otherBefore = await f.prompt(other);
			writePromptSources(other, "TWO", false);
			const result = await f.context.runContextRefresh({ cwd: join(f.cwd, "src", "..") });
			strictEqual(result.clioMd, "updated");
			strictEqual(readFileSync(join(f.cwd, "CLIO-CODER.md"), "utf8").includes("OLD_NAVIGATION"), false);
			strictEqual(
				await f.prompt(other),
				otherBefore,
				"an explicit refresh in another workspace must preserve this snapshot",
			);
			const after = await f.prompt();
			strictEqual(after.includes("OLD_NAVIGATION"), false, "the current session must load the curated handbook");
			strictEqual(after.includes("LIVE_HANDBOOK"), true);
		} finally {
			await f.close();
		}
	});

	it("refreshes inherited handbooks in descendant sessions without thawing sibling workspaces", async () => {
		const f = await contextPromptFixture();
		try {
			const child = join(f.cwd, "src");
			const sibling = `${f.cwd}-sibling`;
			mkdirSync(sibling);
			writePromptSources(sibling, "ONE", false);
			const siblingBefore = await f.prompt(sibling);
			const before = await f.prompt(child);
			await f.context.runBootstrap({ cwd: f.cwd });
			const initialized = await f.prompt(child);
			strictEqual(initialized === before, false, "parent init must refresh a child session with no previous handbook");
			writeRefreshHandbook(f.cwd);
			await f.context.runContextRefresh({ cwd: f.cwd });
			strictEqual((await f.prompt(child)).includes("LIVE_HANDBOOK"), true);
			writePromptSources(sibling, "TWO", false);
			await f.context.runContextClear({ cwd: f.cwd, all: true, confirmContext: () => true, confirmAll: () => true });
			strictEqual((await f.prompt(child)).includes("LIVE_HANDBOOK"), false);
			strictEqual(await f.prompt(sibling), siblingBefore, "a sibling sharing the workspace path prefix must stay frozen");
		} finally {
			await f.close();
		}
	});

	it("keeps snapshot read failures from blocking clear or masking its original failure", async () => {
		const f = await contextPromptFixture();
		try {
			writeRefreshHandbook(f.cwd);
			await f.prompt();
			const deepRoot = join(f.cwd, "too-deep");
			const exceedEnumerationLimit = () =>
				mkdirSync(join(deepRoot, ...Array<string>(66).fill("nested")), { recursive: true });
			exceedEnumerationLimit();
			strictEqual((await f.context.runContextClear({ cwd: f.cwd, confirmContext: () => false })).action, "cancelled");
			const originalFailure = new Error("original clear failure");
			await rejects(
				f.context.runContextClear({
					cwd: f.cwd,
					confirmContext: () => {
						throw originalFailure;
					},
				}),
				(error) => error === originalFailure,
			);
			rmSync(deepRoot, { recursive: true });
			await f.prompt();
			await rejects(
				f.context.runContextClear({
					cwd: f.cwd,
					all: true,
					confirmContext: () => true,
					confirmAll: () => true,
					io: {
						stdout: () => {
							exceedEnumerationLimit();
							throw originalFailure;
						},
						stderr: () => {},
					},
				}),
				(error) => error === originalFailure,
			);
			rmSync(deepRoot, { recursive: true });
			strictEqual(
				(await f.prompt()).includes("LIVE_HANDBOOK"),
				false,
				"an unreadable post-write view must conservatively invalidate the old snapshot",
			);
		} finally {
			await f.close();
		}
	});

	it("keeps preview, cancelled clear, and failures before writes from thawing ordinary edits", async () => {
		const f = await contextPromptFixture();
		try {
			writePromptSources(f.cwd, "ONE", false);
			const before = await f.prompt();
			const epoch = f.prompts.inputEpoch();
			writePromptSources(f.cwd, "TWO", false);
			strictEqual((await f.context.runBootstrap({ cwd: f.cwd, preview: true })).summary.action, "previewed");
			strictEqual((await f.context.runContextClear({ cwd: f.cwd, confirmContext: () => false })).action, "cancelled");
			const fail = () => {
				throw new Error("before writes");
			};
			await rejects(
				f.context.runBootstrap({
					cwd: f.cwd,
					onProgress: (event) => {
						if (event.phase === "scan") fail();
					},
				}),
				/before writes/u,
			);
			await rejects(
				f.context.runContextRefresh({
					cwd: f.cwd,
					onProgress: (event) => {
						if (event.phase === "codewiki") fail();
					},
				}),
				/before writes/u,
			);
			await rejects(f.context.runContextClear({ cwd: f.cwd, confirmContext: fail }), /before writes/u);
			strictEqual(f.prompts.inputEpoch(), epoch);
			f.agentRuntime.wireModelId = "model-two";
			const after = await f.prompt();
			strictEqual(after.includes("HANDBOOK_ONE"), true);
			strictEqual(after.includes("HANDBOOK_TWO"), false);
			strictEqual(before.includes("HANDBOOK_ONE"), true);
		} finally {
			await f.close();
		}
	});

	it("recaptures explicit init and refresh even when they preserve handbook bytes", async () => {
		const f = await contextPromptFixture();
		try {
			writePromptSources(f.cwd, "ONE", false);
			strictEqual((await f.prompt()).includes("HANDBOOK_ONE"), true);
			writePromptSources(f.cwd, "TWO", false);
			strictEqual((await f.context.runContextRefresh({ cwd: f.cwd })).clioMd, "unchanged");
			strictEqual((await f.prompt()).includes("HANDBOOK_TWO"), true);
			writePromptSources(f.cwd, "THREE", false);
			strictEqual((await f.context.runBootstrap({ cwd: f.cwd })).summary.action, "preserved");
			const after = await f.prompt();
			strictEqual(after.includes("HANDBOOK_THREE"), true);
			strictEqual(after.includes("RULE_THREE"), true);
		} finally {
			await f.close();
		}
	});

	it("removes cleared handbook and index markers from the existing session", async () => {
		const f = await contextPromptFixture();
		try {
			await f.context.runBootstrap({ cwd: f.cwd });
			writeRefreshHandbook(f.cwd);
			strictEqual((await f.prompt()).includes("LIVE_HANDBOOK"), true);
			const preserved = await f.context.runContextClear({
				cwd: f.cwd,
				all: true,
				confirmContext: () => true,
				confirmAll: () => false,
			});
			strictEqual(preserved.removed.includes("CLIO-CODER.md"), false);
			const indexCleared = await f.prompt();
			strictEqual(indexCleared.includes("LIVE_HANDBOOK"), true);
			strictEqual(indexCleared.includes("<codewiki>available"), false);
			const result = await f.context.runContextClear({
				cwd: f.cwd,
				all: true,
				confirmContext: () => true,
				confirmAll: () => true,
			});
			strictEqual(result.removed.includes("CLIO-CODER.md"), true);
			const after = await f.prompt();
			strictEqual(after.includes("LIVE_HANDBOOK"), false);
			strictEqual(after.includes("<codewiki>available"), false);
		} finally {
			await f.close();
		}
	});

	for (const operation of ["init", "refresh", "clear"] as const) {
		it(`reloads actual disk context when ${operation} fails after publishing changes`, async () => {
			const f = await contextPromptFixture();
			try {
				if (operation !== "init") writeRefreshHandbook(f.cwd);
				const before = await f.prompt();
				const fail = () => {
					throw new Error("after writes");
				};
				if (operation === "init") {
					await rejects(
						f.context.runBootstrap({
							cwd: f.cwd,
							onProgress: (event) => {
								if (event.phase === "state" && event.status === "started") fail();
							},
						}),
						/after writes/u,
					);
					strictEqual(existsSync(join(f.cwd, "CLIO-CODER.md")), true);
				} else if (operation === "refresh") {
					await rejects(
						f.context.runContextRefresh({
							cwd: f.cwd,
							onProgress: (event) => {
								if (event.phase === "state") fail();
							},
						}),
						/after writes/u,
					);
					strictEqual(readFileSync(join(f.cwd, "CLIO-CODER.md"), "utf8").includes("OLD_NAVIGATION"), false);
				} else {
					await rejects(
						f.context.runContextClear({
							cwd: f.cwd,
							all: true,
							confirmContext: () => true,
							confirmAll: () => true,
							io: { stdout: fail, stderr: () => {} },
						}),
						/after writes/u,
					);
					strictEqual(existsSync(join(f.cwd, "CLIO-CODER.md")), false);
				}
				const after = await f.prompt();
				strictEqual(after === before, false, "a failure after disk publication must not retain obsolete project context");
				strictEqual(after.includes("OLD_NAVIGATION"), false);
				if (operation === "clear") strictEqual(after.includes("LIVE_HANDBOOK"), false);
				if (operation === "init")
					strictEqual(after.includes(renderPromptContext(f.cwd).clioMd?.projectName ?? "MISSING_HANDBOOK"), true);
			} finally {
				await f.close();
			}
		});
	}
});
