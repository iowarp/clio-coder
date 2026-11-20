import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { runHeadlessMainAgent } from "../../src/cli/modes/print.js";
import { withRunResultV2 } from "../../src/cli/run-failure.js";
import type { CallFilter } from "../../src/core/telemetry/dto.js";
import type { TelemetryRecord } from "../../src/core/telemetry/envelope.js";
import { unreportedUsageNotice } from "../../src/core/telemetry/pricing.js";
import { runUsageFromCallRecords } from "../../src/domains/dispatch/run-call-usage.js";
import { READ_MODEL_FOLD } from "../../src/domains/telemetry/index.js";
import { isolateClioEnv } from "../harness/scratch-env.js";
import { telemetryCall, telemetryViewOf } from "../harness/telemetry-view.js";

const answer = {
	role: "assistant",
	stopReason: "stop",
	content: [{ type: "text", text: "done" }],
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
};

async function captured(run: () => Promise<unknown>): Promise<{ stdout: string; stderr: string }> {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const write = process.stdout.write;
	const writeError = process.stderr.write;
	process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
		stdout.push(String(chunk));
		for (const argument of rest) if (typeof argument === "function") argument();
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		stderr.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		await run();
	} finally {
		process.stdout.write = write;
		process.stderr.write = writeError;
	}
	return { stdout: stdout.join(""), stderr: stderr.join("") };
}

function runStub(notice: boolean, options: Record<string, unknown> = {}): Promise<number> {
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
	return runHeadlessMainAgent(
		chat as never,
		{
			prompt: "x",
			mode: "text",
			shutdown: { onDrain() {}, getExitCode: () => 0, isShuttingDown: () => false },
			...options,
		} as never,
	);
}

async function stderrOfRun(notice: boolean): Promise<string> {
	return (await captured(() => runStub(notice))).stderr;
}

test("the no-usage notice is repeated once in the exit summary only when it fired", async (t) => {
	const env = await isolateClioEnv("headless-no-usage-");
	t.after(() => env.restore());
	const line = `clio-coder run: ${unreportedUsageNotice("local")}\n`;
	strictEqual((await stderrOfRun(true)).split(line).length - 1, 2);
	strictEqual((await stderrOfRun(false)).includes(unreportedUsageNotice("local")), false);
});

// Last in the file: the v2 writer keeps its started mark for the rest of the process.
test("a v2 run_end counts a safety-judge side call in usage.side and usage.total, never in usage.main", async (t) => {
	const env = await isolateClioEnv("headless-side-usage-");
	t.after(() => env.restore());
	const session = "side-usage";
	// Stamped after the run starts, so the run's window reads them like the calls it made.
	const at = new Date(Date.now() + 60_000).toISOString();
	const main = telemetryCall(session, { role: "main", at, usage: { input: 10, output: 2 }, usd: 0.01 });
	const judge = telemetryCall(session, { role: "safety-judge", at, usage: { input: 5, output: 1 }, usd: 0.002 });
	const view = telemetryViewOf(session, [...main, ...judge]);
	// The orchestrator's runUsage: the session's calls by role from the run's start, folded as the read model folds.
	const runUsage = async (from: string, roles: CallFilter["roles"] = ["main", "compaction"]) =>
		runUsageFromCallRecords(view.callRecords({ ...(roles !== undefined ? { roles } : {}), from }), READ_MODEL_FOLD);
	const callIdOf = (records: TelemetryRecord[]) =>
		records.flatMap((record) => (record.k === "call.started" ? [record.data.callId] : []));
	const { stdout } = await captured(() =>
		withRunResultV2({ format: "json", mode: "main", verify: [] }, () =>
			runStub(false, { mode: "json", jsonEvents: "full", runUsage }),
		),
	);
	const lines = stdout.trim().split("\n");
	const envelope = JSON.parse(lines[lines.length - 1] ?? "{}") as {
		type?: string;
		usage?: Record<
			string,
			{ callIds: string[]; sums: { apiCalls: { measured: number }; usd: { measured: number } } } | undefined
		>;
	};
	strictEqual(envelope.type, "run_end");
	deepStrictEqual(envelope.usage?.main?.callIds, callIdOf(main));
	deepStrictEqual([...(envelope.usage?.total?.callIds ?? [])].sort(), [...callIdOf(main), ...callIdOf(judge)].sort());
	deepStrictEqual(envelope.usage?.side?.callIds, callIdOf(judge));
	strictEqual(envelope.usage?.children, undefined);
	strictEqual(envelope.usage?.total?.sums.apiCalls.measured, 2);
	strictEqual(Math.abs((envelope.usage?.total?.sums.usd.measured ?? 0) - 0.012) < 1e-9, true);
});
