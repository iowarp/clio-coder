import { strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { runHeadlessMainAgent } from "../../src/cli/modes/print.js";
import { unreportedUsageNotice } from "../../src/core/telemetry/pricing.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const answer = {
	role: "assistant",
	stopReason: "stop",
	content: [{ type: "text", text: "done" }],
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
};

async function stderrOfRun(notice: boolean): Promise<string> {
	let handler: (event: unknown) => void = () => {};
	const stub: Record<string, unknown> = {
		onEvent: (next: (event: unknown) => void) => {
			handler = next;
			return () => {};
		},
		getSessionId: () => null,
		submit: async () => {
			handler({ type: "agent_start" });
			if (notice)
				handler({ type: "notice", level: "warning", surface: "transcript", text: unreportedUsageNotice("local") });
			handler({ type: "message_end", message: answer });
			handler({ type: "agent_end", messages: [answer] });
		},
		whenSettled: async () => {},
		lastRunSnapshot: () => null,
		isStreaming: () => false,
	};
	const chat = new Proxy(stub, { get: (target, key) => (key in target ? target[key as string] : undefined) });
	const stderr: string[] = [];
	const write = process.stdout.write;
	const writeError = process.stderr.write;
	process.stdout.write = ((_chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
		for (const argument of rest) if (typeof argument === "function") argument();
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		stderr.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		await runHeadlessMainAgent(
			chat as never,
			{
				prompt: "x",
				mode: "text",
				shutdown: { onDrain() {}, getExitCode: () => 0, isShuttingDown: () => false },
			} as never,
		);
	} finally {
		process.stdout.write = write;
		process.stderr.write = writeError;
	}
	return stderr.join("");
}

test("the no-usage notice is repeated once in the exit summary only when it fired", async (t) => {
	const env = await isolateClioEnv("headless-no-usage-");
	t.after(() => env.restore());
	const line = `clio-coder run: ${unreportedUsageNotice("local")}\n`;
	strictEqual((await stderrOfRun(true)).split(line).length - 1, 2);
	strictEqual((await stderrOfRun(false)).includes(unreportedUsageNotice("local")), false);
});
