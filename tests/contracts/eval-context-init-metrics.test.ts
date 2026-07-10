import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runContextInitRunner } from "../../src/domains/eval/runners/context-init.js";

describe("contracts/eval context-init metrics", () => {
	it("parses machine-readable generation metrics and honors runner args", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-eval-context-init-"));
		try {
			const entry = join(root, "fake-clio.mjs");
			const payload = {
				version: 1,
				action: "wrote",
				generation: {
					mode: "scout",
					parserOutcome: "parsed",
					scout: {
						tokens: { input: 101, output: 22, total: 123, cacheRead: 4, cacheWrite: 2 },
						toolCalls: 3,
						toolFailures: 1,
						toolBlocked: 1,
						durationMs: 875,
						promptBytes: 4096,
						outputBytes: 512,
					},
				},
			};
			writeFileSync(
				entry,
				[
					'import { writeFileSync } from "node:fs";',
					`writeFileSync("CLIO.md", ${JSON.stringify("# Eval\n\nMeasured context.\n")}, "utf8");`,
					`process.stdout.write(${JSON.stringify(JSON.stringify(payload))});`,
					"process.stderr.write(JSON.stringify(process.argv.slice(2)));",
				].join("\n"),
				"utf8",
			);

			const output = await runContextInitRunner(
				{ kind: "context-init", args: ["--heuristic"], timeoutMs: 5000 },
				root,
				entry,
				5000,
			);

			strictEqual(output.exitCode, 0);
			deepStrictEqual(
				{
					mode: output.metrics["context.initMode"],
					parser: output.metrics["context.initParserOutcome"],
					fallback: output.metrics["context.initFallback"],
					modelMs: output.metrics["latency.modelMs"],
					input: output.metrics["tokens.input"],
					output: output.metrics["tokens.output"],
					total: output.metrics["tokens.total"],
					calls: output.metrics["tools.totalCalls"],
					failed: output.metrics["tools.failed"],
					blocked: output.metrics["tools.blocked"],
					promptBytes: output.metrics["context.initPromptBytes"],
					outputBytes: output.metrics["context.initOutputBytes"],
				},
				{
					mode: "scout",
					parser: "parsed",
					fallback: false,
					modelMs: 875,
					input: 101,
					output: 22,
					total: 123,
					calls: 3,
					failed: 1,
					blocked: 1,
					promptBytes: 4096,
					outputBytes: 512,
				},
			);
			strictEqual(output.metrics["context.clioMdBytes"], Buffer.byteLength(readFileSync(join(root, "CLIO.md"))));
			const invokedArgs = JSON.parse(output.stderr) as string[];
			ok(invokedArgs.includes("--json"));
			ok(invokedArgs.includes("--heuristic"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not force the heuristic path when the suite omits it", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-eval-context-init-default-"));
		try {
			const entry = join(root, "fake-clio.mjs");
			writeFileSync(
				entry,
				'process.stdout.write(JSON.stringify({version:1,generation:{mode:"heuristic",parserOutcome:"not-run"}}));\nprocess.stderr.write(JSON.stringify(process.argv.slice(2)));\n',
				"utf8",
			);
			const output = await runContextInitRunner({ kind: "context-init" }, root, entry, 5000);
			const invokedArgs = JSON.parse(output.stderr) as string[];
			strictEqual(invokedArgs.includes("--heuristic"), false);
			strictEqual(output.metrics["context.initMode"], "heuristic");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed when generation telemetry is object-shaped but malformed", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-eval-context-init-invalid-"));
		try {
			const entry = join(root, "fake-clio.mjs");
			writeFileSync(entry, "process.stdout.write(JSON.stringify({version:1,generation:{}}));\n", "utf8");

			const output = await runContextInitRunner({ kind: "context-init" }, root, entry, 5000);
			strictEqual(output.exitCode, 1);
			match(output.stderr, /did not receive a valid JSON generation result/);
			strictEqual(output.metrics["context.initMode"], "unknown");
			strictEqual(output.metrics["verifier.exitCode"], 1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
