import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { prefixHeadlessFailure, runHeadlessMainAgent } from "../../src/cli/modes/print.js";
import { CITATION_CHECK_PREFIX } from "../../src/domains/safety/citation-grounding.js";
import type { ChatLoopRunSnapshot } from "../../src/session-control/chat-loop.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("headless budget and admission stops do not report an endpoint outage", () => {
	const chat = {
		lastRunSnapshot: () => ({ targetId: "openai-codex", runtimeId: "openai-codex" }) as ChatLoopRunSnapshot,
	};
	const budget = "budget_ceiling: this run's priced spend $0.0007 reached its --max-cost-usd $0.0006 cap.";
	strictEqual(prefixHeadlessFailure(chat, budget), budget);
	const admission = "IMAGE_INPUT_UNSUPPORTED: this route does not accept images";
	strictEqual(prefixHeadlessFailure(chat, admission, true), admission);
	const provider = prefixHeadlessFailure(chat, "HTTP 503");
	match(provider, /target 'openai-codex' \(openai-codex\): HTTP 503/u);
	doesNotMatch(provider, /endpoint unavailable/u);
});

const answerMessage = (text: string): object => ({
	role: "assistant",
	stopReason: "stop",
	content: [{ type: "text", text }],
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
});

/** Stdout of a headless run whose answer drew a citation check before the final reply. */
async function stdoutAfterCitationCheck(answer: string, reply: string, mode: "text" | "json"): Promise<string> {
	let handler: (event: unknown) => void = () => {};
	const stub: Record<string, unknown> = {
		onEvent: (next: (event: unknown) => void) => {
			handler = next;
			return () => {};
		},
		getSessionId: () => null,
		submit: async () => {
			handler({ type: "agent_start" });
			handler({ type: "message_end", message: answerMessage(answer) });
			handler({
				type: "notice",
				level: "warning",
				surface: "transcript",
				source: "reminder",
				text: `${CITATION_CHECK_PREFIX} README.md:2 cite line numbers no tool printed`,
			});
			handler({ type: "message_end", message: answerMessage(reply) });
			handler({ type: "agent_end", messages: [answerMessage(answer), answerMessage(reply)] });
		},
		whenSettled: async () => {},
		lastRunSnapshot: () => null,
		isStreaming: () => false,
	};
	const chat = new Proxy(stub, { get: (target, key) => (key in target ? target[key as string] : undefined) });
	const written: string[] = [];
	const write = process.stdout.write;
	const writeError = process.stderr.write;
	process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
		written.push(String(chunk));
		for (const argument of rest) if (typeof argument === "function") argument();
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = (() => true) as typeof process.stderr.write;
	try {
		await runHeadlessMainAgent(chat as never, {
			prompt: "x",
			mode,
			...(mode === "json" ? { jsonEvents: "terminal" as const } : {}),
			shutdown: { onDrain() {}, getExitCode: () => 0, isShuttingDown: () => false },
		} as never);
	} finally {
		process.stdout.write = write;
		process.stderr.write = writeError;
	}
	return written.join("");
}

test("a reply to a citation check that holds only corrections keeps the answer it corrects", async () => {
	const answer = "The entry point is c_to_k in src/convert.py.\nRun the tests with python3 -m pytest -q (README.md:2).";
	const reply = "Citations re-verified; README.md:2 holds.";
	const env = await isolateClioEnv("headless-citation-check-");
	try {
		const text = await stdoutAfterCitationCheck(answer, reply, "text");
		ok(text.includes(answer), text);
		ok(text.includes(reply), text);
		const terminal = await stdoutAfterCitationCheck(answer, reply, "json");
		const end = terminal
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line))
			.find((frame) => frame.type === "turn_end");
		strictEqual(end.text, `${answer}\n\n${reply}`);
	} finally {
		env.restore();
	}
});

test("a reply to a citation check that restates the answer is printed alone", async () => {
	const answer = "The entry point is c_to_k in src/convert.py.\nRun the tests with python3 -m pytest -q (README.md:2).";
	const reply = `Confirmed with line numbers; the citations stand.\n\n${answer}`;
	const env = await isolateClioEnv("headless-citation-check-");
	try {
		const text = await stdoutAfterCitationCheck(answer, reply, "text");
		strictEqual(text, `${reply}\n`);
	} finally {
		env.restore();
	}
});
