import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	emptyHarnessProfile,
	type HarnessProfile,
	harnessProfilePath,
	readHarnessProfile,
	recordHarnessFeature,
	recordLessonShown,
} from "../../src/core/harness-profile.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import {
	createGuidanceRegistration,
	GUIDANCE_LESSONS,
	type GuidanceDeps,
	harnessQuestionTopics,
	LESSON_LIFETIME_SHOWS,
	SESSION_TIP_BUDGET,
} from "../../src/domains/middleware/guidance.js";
import { createMiddlewareToolChoiceControl } from "../../src/domains/middleware/tool-choice-control.js";
import type { MiddlewareEffect, MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { BUILTIN_SLASH_COMMANDS } from "../../src/interactive/slash-commands.js";
import { createTurnMiddleware } from "../../src/interactive/turn-middleware.js";
import { type AgentRuntime, createTurnState } from "../../src/interactive/turn-state.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

// Demo guidance shows the operator one capability tip after a turn, picked by
// the harness from what the turn did and what the operator already knows. The
// model never sees it. With interface.demo off nothing runs and nothing is
// written.

interface FakeProfile {
	profile: HarnessProfile;
	calls: string[];
	io: NonNullable<GuidanceDeps["profile"]>;
}

function fakeProfile(): FakeProfile {
	const profile = emptyHarnessProfile();
	const calls: string[] = [];
	return {
		profile,
		calls,
		io: {
			read: () => {
				calls.push("read");
				return profile;
			},
			lessonShown: (id) => {
				calls.push(`shown:${id}`);
				profile.lessons[id] = { shown: (profile.lessons[id]?.shown ?? 0) + 1, lastShownAt: "t" };
			},
			feature: (name) => {
				calls.push(`feature:${name}`);
				profile.features[name] = (profile.features[name] ?? 0) + 1;
			},
			topic: (name) => {
				calls.push(`topic:${name}`);
				profile.topics[name] = (profile.topics[name] ?? 0) + 1;
			},
		},
	};
}

function guidance(overrides: Partial<GuidanceDeps> = {}, store = fakeProfile()) {
	let enabled = true;
	const hook = createGuidanceRegistration({
		enabled: () => enabled,
		autonomy: () => "auto-edit",
		keyFor: (id) => (id === "clio-coder.output.cycle" ? "Alt+O" : null),
		hasProjectContext: () => true,
		profile: store.io,
		...overrides,
	});
	const turn = (
		prompt: string,
		options: {
			sessionId?: string;
			prior?: number;
			tools?: Array<Pick<MiddlewareHookInput, "toolName" | "toolArgs">>;
			end?: Record<string, number | string | boolean>;
			continuation?: boolean;
		} = {},
	): ReadonlyArray<MiddlewareEffect> => {
		const sessionId = options.sessionId ?? "s1";
		hook.evaluate({
			hook: "turn_start",
			sessionId,
			text: prompt,
			metadata: {
				conversationMessages: options.prior ?? 2,
				...(options.continuation ? { requestContinuation: true } : {}),
			},
		});
		for (const tool of options.tools ?? [])
			hook.evaluate({ hook: "after_tool", sessionId, ...tool, metadata: { resultKind: "ok" } });
		return hook.evaluate({ hook: "turn_end", sessionId, metadata: { stopReason: "stop", ...options.end } });
	};
	return {
		hook,
		store,
		turn,
		setEnabled: (value: boolean) => {
			enabled = value;
		},
	};
}

const tipOf = (effects: ReadonlyArray<MiddlewareEffect>): string | undefined =>
	effects.find((effect) => effect.kind === "notify_operator")?.message;

describe("demo guidance tips", () => {
	it("answers a question about Clio's own settings with an operator-only tip", () => {
		const { turn, store } = guidance();
		const effects = turn("How do I switch the model to something faster in clio?");
		deepStrictEqual(
			effects.map((effect) => effect.kind),
			["notify_operator"],
		);
		const tip = tipOf(effects) ?? "";
		match(tip, /^\[tip\] Next time just ask: I can preview a Clio settings change/);
		// The first tip ever says where tips come from and how to stop them.
		match(tip, /Demo guidance in \/settings/);
		ok(store.calls.includes("shown:settings-change"));
		ok(store.calls.includes("topic:model"));
	});

	it("words the settings tip for the autonomy that can act on it", () => {
		const { turn } = guidance({ autonomy: () => "suggest" });
		match(tipOf(turn("how can I change the thinking level in clio?")) ?? "", /\/model switches the chat model/);
	});

	it("does nothing and touches no profile while demo guidance is off", () => {
		const { turn, store, setEnabled } = guidance();
		setEnabled(false);
		deepStrictEqual(turn("How do I switch the model in clio?"), []);
		deepStrictEqual(turn("btw what is a monad", { tools: [{ toolName: "bash", toolArgs: { command: "ls" } }] }), []);
		deepStrictEqual(store.calls, []);
	});

	it("stays quiet on ordinary work, continuations, and turns with nothing to teach", () => {
		const { turn } = guidance();
		deepStrictEqual(
			turn("fix the off-by-one in the parser", { tools: [{ toolName: "read", toolArgs: { path: "a.ts" } }] }),
			[],
		);
		deepStrictEqual(turn("How do I switch the model in clio?", { continuation: true }), []);
		// A question about ordinary project work is not about the harness.
		deepStrictEqual(harnessQuestionTopics("how do I train the model on this dataset?"), []);
		ok(harnessQuestionTopics("where is the keybinding for the model picker?").includes("keys"));
	});

	it("spaces tips across turns, lets a direct answer through sooner, and caps a session", () => {
		const { turn } = guidance();
		ok(tipOf(turn("btw, what does this regex do?")));
		// The very next turn never tips, even for a direct match.
		strictEqual(tipOf(turn("How do I switch the model in clio?")), undefined);
		// A direct answer may come after one quiet turn; weaker lessons wait longer.
		ok(tipOf(turn("How do I switch the model in clio?")));
		strictEqual(tipOf(turn("no, that's wrong, go back")), undefined);
		strictEqual(tipOf(turn("no, try again")), undefined);
		let shown = 2;
		for (let index = 0; index < 20; index++) {
			if (tipOf(turn("no, that is not what i asked", { end: { assistantTextChars: 9_000, turnToolCalls: 12 } })))
				shown += 1;
		}
		strictEqual(shown, SESSION_TIP_BUDGET);
	});

	it("starts a new session's budget and spacing afresh", () => {
		const { turn } = guidance();
		ok(tipOf(turn("btw, quick thing", { sessionId: "a" })));
		strictEqual(tipOf(turn("btw, another", { sessionId: "a" })), undefined);
		ok(tipOf(turn("How do I switch the model in clio?", { sessionId: "b" })));
	});

	it("retires a lesson once the operator uses its feature or it was shown enough", () => {
		const learned = fakeProfile();
		learned.profile.features["/btw"] = 1;
		strictEqual(tipOf(guidance({}, learned).turn("btw, what is this?")), undefined);
		const worn = fakeProfile();
		worn.profile.lessons["side-question"] = { shown: LESSON_LIFETIME_SHOWS, lastShownAt: "t" };
		strictEqual(tipOf(guidance({}, worn).turn("btw, what is this?")), undefined);
		// Asking Clio through her docs counts as knowing the docs route.
		const asked = guidance();
		asked.turn("how do I add a skill in clio?", {
			tools: [{ toolName: "gateway", toolArgs: { op: "call", capability: "clio_docs" } }],
		});
		ok(asked.store.calls.includes("feature:ask-clio"));
	});

	it("names a key only when it is bound, and grounds a mention tip in the prompt", () => {
		const bound = guidance();
		match(tipOf(bound.turn("explain it", { end: { assistantTextChars: 9_000 } })) ?? "", /Alt\+O cycles output styles/);
		const unbound = guidance({ keyFor: () => null });
		strictEqual(tipOf(unbound.turn("explain it", { end: { assistantTextChars: 9_000 } })), undefined);
		const mention = guidance();
		match(
			tipOf(
				mention.turn("what does src/app/main.ts do", {
					tools: [{ toolName: "read", toolArgs: { path: "src/app/main.ts" } }],
				}),
			) ?? "",
			/@src\/app\/main\.ts/,
		);
	});

	it("teaches only slash commands that exist", () => {
		const names = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
		const context = {
			autonomy: "auto-edit",
			keyFor: () => "Alt+O",
			hasProjectContext: false,
			contextPressure: 0.9,
			profile: emptyHarnessProfile(),
			promptPath: "src/app.ts",
		};
		for (const lesson of GUIDANCE_LESSONS) {
			const text = lesson.text(context) ?? "";
			for (const [, name] of text.matchAll(/(?:^|[\s(])\/([a-z][\w-]*)/gu)) {
				ok(names.has(name ?? ""), `${lesson.id} names /${name}`);
			}
		}
	});
});

describe("notify_operator delivery", () => {
	it("reaches the operator after a turn and never the model", async () => {
		const tips: string[] = [];
		const notices: string[] = [];
		const { contract } = createMiddlewareBundle({
			registrations: [
				{
					id: "fixture.tip",
					description: "operator-only tip",
					hooks: ["turn_end"],
					evaluate: () => [{ kind: "notify_operator", message: "[tip] try /view", key: "guidance.view" }],
				},
			],
		});
		const runtime = {
			wireModelId: "fixture",
			runtimeId: "fixture",
			runtimeResolution: {},
			agent: { state: { tools: [], messages: [] } },
		} as unknown as AgentRuntime;
		const turn = createTurnMiddleware({
			state: createTurnState("off"),
			middleware: contract,
			middlewareToolChoice: createMiddlewareToolChoiceControl(),
			emitNotice: (text) => notices.push(text),
			emitFooterNotice: () => {},
			emitOperatorTip: (message, key) => tips.push(`${key} ${message}`),
		});
		turn.fireTurnStart(runtime, "inspect");
		await turn.fireTurnEnd(runtime, [
			{
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				stopReason: "stop",
				timestamp: 1,
			} as unknown as AgentMessage,
		]);
		deepStrictEqual(tips, ["guidance.view [tip] try /view"]);
		deepStrictEqual(notices, []);
		strictEqual(turn.flushPendingReminders(), "");
	});
});

describe("harness profile", () => {
	let env: IsolatedClioEnv;
	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-harness-profile-");
	});
	afterEach(() => env.restore());

	it("persists features and lessons in the state dir and survives a corrupt file", () => {
		recordHarnessFeature("/view");
		recordHarnessFeature("/view");
		recordLessonShown("view", new Date("2026-01-01T00:00:00Z"));
		const onDisk = JSON.parse(readFileSync(harnessProfilePath(), "utf8"));
		strictEqual(onDisk.features["/view"], 2);
		deepStrictEqual(onDisk.lessons.view, { shown: 1, lastShownAt: "2026-01-01T00:00:00.000Z" });
		writeFileSync(harnessProfilePath(), "{not json");
		recordHarnessFeature("!");
		deepStrictEqual(readHarnessProfile().features, { "!": 1 });
		ok(existsSync(harnessProfilePath()));
	});
});
