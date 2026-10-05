import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { parseFrontmatter } from "../../src/domains/agents/frontmatter.js";
import {
	type CompiledSessionPrompt,
	compile,
	compileWorker,
	HEADLESS_SESSION_APPROVAL_SEMANTICS,
	SESSION_APPROVAL_SEMANTICS,
	type SessionPromptInputs,
} from "../../src/domains/prompts/compiler.js";
import type { PromptsContract } from "../../src/domains/prompts/contract.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import { AUTONOMY_LEVELS } from "../../src/domains/safety/autonomy.js";
import { createTurnContext } from "../../src/session-control/turn-context.js";
import type { TurnMiddleware } from "../../src/session-control/turn-middleware.js";
import { type AgentRuntime, createTurnState } from "../../src/session-control/turn-state.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

// A headless `clio-coder run` has no operator: its permission listener denies
// every approval ask at both autonomy levels, a yolo damage-control confirm
// included. The session prompt must say so instead of promising a pause for an
// operator who is not there.
function safetySection(level: string, sessionInputs: Partial<SessionPromptInputs>): string {
	const compiled = compile(loadFragments(), {
		identity: "identity.clio",
		operatingContract: "operating.contract",
		safety: `safety.${level}`,
		sessionInputs: {
			coordinatorCapabilities: [],
			provider: "local",
			model: "stable-model",
			providerSupportsTools: true,
			toolNames: [ToolNames.Bash, ToolNames.Read],
			...sessionInputs,
		},
	});
	const start = compiled.systemPrompt.indexOf(`Autonomy: ${level}.`);
	ok(start >= 0, "the safety section renders");
	return compiled.systemPrompt.slice(start);
}

describe("headless approval wording in the session prompt", () => {
	let env: IsolatedClioEnv;
	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-headless-approval-");
	});
	afterEach(() => env.restore());

	for (const level of AUTONOMY_LEVELS) {
		it(`tells a headless session at ${level} that approval-required calls are denied`, () => {
			const headless = safetySection(level, { headless: true });
			ok(headless.includes(HEADLESS_SESSION_APPROVAL_SEMANTICS), headless);
			ok(!headless.includes(SESSION_APPROVAL_SEMANTICS), headless);
			ok(!/pause for one operator confirmation/.test(headless), headless);
			match(headless, /No operator is attached to this headless run, so approval-required calls are denied/);
			match(headless, /use recognized commands and typed checks, and report what could not run\./);
		});

		it(`keeps the operator-confirmation sentence for an attached session at ${level}`, () => {
			for (const inputs of [{}, { headless: false }]) {
				const interactive = safetySection(level, inputs);
				ok(interactive.includes(SESSION_APPROVAL_SEMANTICS), interactive);
				ok(!interactive.includes(HEADLESS_SESSION_APPROVAL_SEMANTICS), interactive);
			}
		});
	}
});

describe("interactive-only guidance in the session prompt", () => {
	let env: IsolatedClioEnv;
	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-headless-guidance-");
	});
	afterEach(() => env.restore());

	it("leaves docs, settings and operator-control guidance out of a headless session", () => {
		const prompt = (headless: boolean) =>
			compile(loadFragments(), {
				identity: "identity.clio",
				operatingContract: "operating.contract",
				safety: "safety.default",
				sessionInputs: {
					coordinatorCapabilities: ["clio_docs"],
					provider: "local",
					model: "stable-model",
					providerSupportsTools: true,
					toolNames: [ToolNames.Bash, ToolNames.Read, ToolNames.Gateway, ToolNames.Context],
					headless,
				},
			}).systemPrompt;
		const headings = [
			"# Clio Coder documentation routing",
			"# Clio Coder settings routing",
			"# User control and understanding",
		];
		deepStrictEqual(
			headings.map((heading) => prompt(false).includes(heading)),
			[true, true, true],
		);
		deepStrictEqual(
			headings.map((heading) => prompt(true).includes(heading)),
			[false, false, false],
		);
		ok(!prompt(true).includes("# Answering questions about Clio"), "no inline support guidance replaces the routing");
		strictEqual(prompt(true), prompt(true), "the headless prompt is byte-stable");
	});

	it("keeps clause evidence and conditional reproduction tests in unattended prompts only", () => {
		const table = loadFragments();
		const main = (headless: boolean) =>
			compile(table, {
				identity: "identity.clio",
				operatingContract: "operating.contract",
				safety: "safety.default",
				sessionInputs: { coordinatorCapabilities: [], headless },
			}).systemPrompt.replace(/\s+/gu, " ");
		const coderPath = new URL("../../src/domains/agents/builtins/coder.md", import.meta.url);
		const { body } = parseFrontmatter(readFileSync(coderPath, "utf8"), coderPath.pathname);
		const worker = compileWorker(table, {
			providerSupportsTools: false,
			toolNames: [],
			toolPromptHints: [],
			hasCanonicalContext: false,
			hasBoundSkills: false,
			onPermission: "deny",
			persona: { id: "persona.coder", relPath: coderPath.pathname, body, contentHash: "coder", dynamic: false },
		}).systemPrompt.replace(/\s+/gu, " ");
		for (const prompt of [main(true), worker]) {
			match(prompt, /Restate the task as its separate clauses|restating the assigned task as its separate clauses/u);
			match(prompt, /performance and robustness clauses/u);
			match(prompt, /first check whether existing tests cover each clause/u);
			match(prompt, /only when no existing test covers the clause and the task and project instructions allow tests/u);
			match(prompt, /Follow the neighboring tests.*fail on the untouched code/u);
			match(prompt, /map each clause to evidence in your diff or a check you ran/u);
			match(prompt, /a clause without evidence is unfinished/iu);
			match(prompt, /not done/u);
		}
		const attended = main(false);
		strictEqual(attended.includes("reproduction test"), false);
		strictEqual(attended.includes("map each clause"), false);
		for (const prompt of [attended, main(true), worker]) {
			match(prompt, /Name the blocking guard and its stated way to proceed/u);
			match(prompt, /Preserve mathematical notation, units, scientific Unicode/u);
			match(prompt, /Before committing, verify the actual implementation against active decisions/u);
			match(prompt, /operator choices require operator revision/u);
			match(prompt, /For an approach or design question, stop once/u);
			match(prompt, /unless the operator says to switch/u);
			match(prompt, /declared dependencies were never installed/u);
			match(prompt, /missing module imported only there/u);
		}
	});
});

describe("headless flag threading into the compiled session inputs", () => {
	function compiled(systemPrompt: string): CompiledSessionPrompt {
		return { systemPrompt, systemPromptHash: systemPrompt, tokenEstimate: 1, sections: [], fragmentManifest: [] };
	}

	async function capturedInputs(headless: boolean | undefined): Promise<SessionPromptInputs | undefined> {
		let captured: SessionPromptInputs | undefined;
		const runtime = {
			targetId: "target",
			runtimeId: "runtime",
			wireModelId: "model",
			runtimeResolution: {
				capabilityDecisions: { tools: true },
				contextWindowDetails: { effectiveContextWindow: 32768, contextWindowSource: "loaded" },
			},
			agent: { state: { messages: [], tools: [], systemPrompt: "", model: {} } },
		} as unknown as AgentRuntime;
		const context = createTurnContext({
			...(headless !== undefined ? { headless } : {}),
			state: createTurnState("off"),
			getSettings: () => DEFAULT_SETTINGS,
			providers: { getRuntime: () => undefined } as unknown as ProvidersContract,
			middleware: {} as TurnMiddleware,
			prompts: {
				inputEpoch: () => "0",
				compileSessionPrompt: async (input) => {
					captured = input.sessionInputs;
					return compiled("prompt");
				},
				compileWorkerPrompt: async () => {
					throw new Error("not used");
				},
				reload() {},
			} as PromptsContract,
			emitNotice: () => {},
		});
		try {
			await context.ensureSessionPrompt(runtime);
		} finally {
			context.dispose();
		}
		return captured;
	}

	it("marks the session inputs headless only when the entry says so", async () => {
		strictEqual((await capturedInputs(true))?.headless, true);
		for (const headless of [false, undefined]) {
			const inputs = await capturedInputs(headless);
			ok(inputs !== undefined);
			deepStrictEqual(Object.hasOwn(inputs, "headless"), false);
		}
	});
});
