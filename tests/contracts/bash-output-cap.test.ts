import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import {
	BASH_HARD_CAP_BYTES,
	type BashCommandResult,
	type BashStreamByteCounts,
	createBashOutputProgressController,
} from "../../src/core/bash-exec.js";
import { BASH_DEFAULT_RESULT_DISPOSITION, bashOutputCapResult, bashTool } from "../../src/tools/bash.js";
import { shapeToolResult } from "../../src/tools/result-shaping.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

it("stops a child at the Bash cap and preserves partial output and recovery instructions", async () => {
	const env = await isolateClioEnv("clio-bash-cap-");
	try {
		const started = Date.now();
		const result = await bashTool.run({
			command: "printf 'partial-stderr\\n' >&2; head -c 17825792 /dev/zero | tr '\\0' x; sleep 30",
		});
		ok(Date.now() - started < 10_000, "cap cancellation must not wait for the trailing sleep");
		strictEqual(result.kind, "error");
		if (result.kind !== "error") return;
		strictEqual(result.details?.outputCapped, true);
		strictEqual(result.details?.outcome, "output-cap");
		ok(result.details?.signal === "SIGTERM" || result.details?.signal === "SIGKILL");
		strictEqual(result.details?.outputBytes, BASH_HARD_CAP_BYTES);
		match(result.message, /16777216-byte \(16 MiB\) hard cap/);
		match(result.message, /stdout: \d+ bytes, stderr: \d+ bytes/);
		match(result.message, /Partial output offloaded to/);
		match(result.message, /run_script.*unbounded.*\.clio-coder\/runs\/<runId>\//);
		const shaped = shapeToolResult(bashTool, result, { sessionId: "cap" }, BASH_DEFAULT_RESULT_DISPOSITION);
		strictEqual(shaped.kind, "error");
		if (shaped.kind !== "error") return;
		const path = (shaped.details?.resultSize as { offloadPath?: string } | undefined)?.offloadPath;
		ok(typeof path === "string");
		ok(shaped.message.includes(path));
		match(shaped.message, /hard cap.*stdout:.*stderr:/);
		const saved = readFileSync(path, "utf8");
		strictEqual(Buffer.byteLength(saved), BASH_HARD_CAP_BYTES);
		ok(saved.startsWith("x".repeat(1024)));
		match(shaped.message, /1 decoded output bytes discarded from the offload/);
		match(bashTool.description, /16 MiB hard cap that stops the child/);
	} finally {
		env.restore();
	}
});

it("counts every received byte separately from retained bytes across the cap", () => {
	const collector = createBashOutputProgressController();
	collector.append("stdout", Buffer.alloc(BASH_HARD_CAP_BYTES - 2, 0xff));
	strictEqual(collector.append("stderr", Buffer.from([0xe2, 0x82, 0xac, 0x41])), true);
	strictEqual(collector.append("stdout", Buffer.alloc(7)), false);
	strictEqual(collector.append("stderr", Buffer.alloc(11)), false);
	const result = collector.settle();
	deepStrictEqual(collector.byteCounts(), {
		observedStdoutBytes: BASH_HARD_CAP_BYTES + 5,
		observedStderrBytes: 15,
		retainedStdoutBytes: BASH_HARD_CAP_BYTES - 2,
		retainedStderrBytes: 2,
	});
	strictEqual(result.outputBytes, BASH_HARD_CAP_BYTES);
	strictEqual(result.stderr, "");
	ok(Buffer.byteLength(result.stdout) > result.outputBytes, "replacement characters must not change raw byte counts");
});

function capped(stdout: string): BashCommandResult & BashStreamByteCounts {
	return {
		error: null,
		stdout,
		stderr: "",
		exitCode: null,
		signal: "SIGTERM",
		aborted: false,
		timedOut: false,
		outputCapped: true,
		outputBytes: Buffer.byteLength(stdout),
		observedStdoutBytes: Buffer.byteLength(stdout) + 1,
		observedStderrBytes: 0,
		retainedStdoutBytes: Buffer.byteLength(stdout),
		retainedStderrBytes: 0,
	};
}

it("reports inline, complete offload, ceiling loss and failed retention under every output policy", async () => {
	const env = await isolateClioEnv("clio-cap-dispositions-");
	try {
		for (const policy of ["full", "bounded", "summary", "metadata-only"] as const) {
			const raw = "x".repeat(policy === "full" || policy === "bounded" ? 20_000 : 100);
			const result = bashOutputCapResult(capped(raw), policy, { sessionId: "retention" });
			ok(result.kind === "error");
			match(result.message, /Partial output offloaded to/);
			const retention = result.details?.retention as { offloadPath: string; discardedBytes: number };
			strictEqual(readFileSync(retention.offloadPath, "utf8"), raw);
			strictEqual(retention.discardedBytes, 0);
			const shaped = shapeToolResult(bashTool, result, { sessionId: "retention" }, BASH_DEFAULT_RESULT_DISPOSITION);
			strictEqual(shaped.modelContext, result.message);
			ok(shaped.modelContext?.includes(retention.offloadPath));
			if (policy === "summary" || policy === "metadata-only") strictEqual(shaped.modelContext?.includes(raw), false);
		}
		const inline = bashOutputCapResult(capped("small\n"), "bounded");
		ok(inline.kind === "error");
		match(inline.message, /^small\n/);
		strictEqual(
			shapeToolResult(bashTool, inline, undefined, BASH_DEFAULT_RESULT_DISPOSITION).modelContext,
			inline.message,
		);
		match(inline.message, /Partial output shown inline \(6 decoded output bytes\)/);
		const raw = "x".repeat(BASH_HARD_CAP_BYTES + 17);
		const truncated = bashOutputCapResult(capped(raw), "metadata-only");
		ok(truncated.kind === "error");
		strictEqual(
			shapeToolResult(bashTool, truncated, undefined, BASH_DEFAULT_RESULT_DISPOSITION).modelContext,
			truncated.message,
		);
		match(truncated.message, /17 decoded output bytes discarded from the offload/);
		const retention = truncated.details?.retention as { offloadPath: string };
		strictEqual(readFileSync(retention.offloadPath, "utf8"), raw.slice(0, BASH_HARD_CAP_BYTES));
		const state = process.env.CLIO_CODER_STATE_DIR;
		ok(state);
		mkdirSync(state, { recursive: true });
		writeFileSync(join(state, "scratch", "blocked"), "file blocks directory");
		for (const policy of ["bounded", "summary", "metadata-only"] as const) {
			const failed = bashOutputCapResult(capped("x".repeat(20_000)), policy, { sessionId: "blocked" });
			ok(failed.kind === "error");
			strictEqual(
				shapeToolResult(bashTool, failed, undefined, BASH_DEFAULT_RESULT_DISPOSITION).modelContext,
				failed.message,
			);
			match(failed.message, /retention failed; no offload was written/);
			const facts = failed.details?.retention as { status: string; discardedBytes: number };
			strictEqual(facts.status, "failed");
			const shown = policy === "bounded" ? 14_336 : 0;
			strictEqual(facts.discardedBytes, 20_000 - shown);
			ok(failed.modelContext?.includes(`${facts.discardedBytes} decoded output bytes discarded`));
		}
	} finally {
		env.restore();
	}
});
