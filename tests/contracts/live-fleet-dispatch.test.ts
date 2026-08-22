/**
 * Two things the first real `live:fleet-dispatch` run showed the harness got
 * wrong, pinned so they stay fixed:
 *
 * 1. A turn that hits its budget must keep the partial `run --json` stream.
 *    runCli used to reject at the kill and drop the capture on `close`, so a
 *    600 s timeout left nothing to say how far the lifecycle got.
 * 2. The workspace-unchanged assertion must not count the two files Clio
 *    writes for itself (`.clio-coder/codewiki.json`, `.clio-coder/state.json`)
 *    as the model changing the workspace, and must still count anything else
 *    under `.clio-coder/`.
 */
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { settleRun } from "../../benchmarks/internal/live-target.js";
import {
	CLIO_MANAGED_WORKSPACE_PATHS,
	workspaceChanges,
	workspaceSnapshot,
} from "../../benchmarks/internal/workspace-snapshot.js";
import { RunCliTimeoutError, runNodeScript } from "../harness/spawn.js";

const FIRST_LINE = '{"type":"tool_execution_start","toolName":"dispatch","toolCallId":"t1"}';
const STDERR_LINE = "partial-stderr-marker";

describe("contracts/live fleet-dispatch harness", { concurrency: false }, () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "clio-live-fleet-dispatch-test-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	/** A child that writes one JSONL line and one stderr line, then never exits. */
	function hangingScript(): string {
		const script = join(dir, "hang.mjs");
		writeFileSync(
			script,
			[
				`process.stdout.write(${JSON.stringify(`${FIRST_LINE}\n`)});`,
				`process.stderr.write(${JSON.stringify(`${STDERR_LINE}\n`)});`,
				"setInterval(() => {}, 1000);",
				"",
			].join("\n"),
			"utf8",
		);
		return script;
	}

	it("a timeout rejects with the partial stdout and stderr the child wrote before it was signalled", async () => {
		const script = hangingScript();
		const started = Date.now();
		let caught: unknown;
		try {
			await runNodeScript(script, ["--flag"], { cwd: dir, timeoutMs: 1_500 });
		} catch (error) {
			caught = error;
		}
		ok(caught instanceof RunCliTimeoutError, `expected RunCliTimeoutError, got ${String(caught)}`);
		strictEqual(caught.message, "runCli timeout after 1500ms: --flag");
		strictEqual(caught.timeoutMs, 1_500);
		strictEqual(caught.stdout, `${FIRST_LINE}\n`);
		strictEqual(caught.stderr, `${STDERR_LINE}\n`);
		// SIGTERM, not SIGKILL: the timeout asks the group to shut down first so
		// the CLI can signal its own detached tool groups, and a child with no
		// handler dies to that. The SIGKILL escalation is a separate contract
		// (tests/contracts/live-spawn.test.ts).
		strictEqual(caught.signal, "SIGTERM");
		strictEqual(caught.code, null);
		ok(Date.now() - started < 6_000, "rejection waited on the kill grace instead of the child's close");
	});

	it("a child that exits on its own resolves unchanged", async () => {
		const script = join(dir, "exit.mjs");
		writeFileSync(script, `process.stdout.write("done\\n"); process.exit(3);\n`, "utf8");
		const result = await runNodeScript(script, [], { cwd: dir, timeoutMs: 10_000 });
		deepStrictEqual(result, { code: 3, signal: null, stdout: "done\n", stderr: "" });
	});

	it("settleRun turns a timeout into a result with timedOut=true and keeps the stream", async () => {
		const script = hangingScript();
		const settled = await settleRun(runNodeScript(script, [], { cwd: dir, timeoutMs: 1_500 }));
		strictEqual(settled.timedOut, true);
		strictEqual(settled.stdout, `${FIRST_LINE}\n`);
		strictEqual(settled.stderr, `${STDERR_LINE}\n`);
		// Same reason as above: a child with no SIGTERM handler never reaches the
		// SIGKILL escalation, and the partial stream survives either way.
		strictEqual(settled.signal, "SIGTERM");
	});

	it("settleRun passes a finished run through with timedOut=false", async () => {
		const script = join(dir, "exit.mjs");
		writeFileSync(script, `process.stdout.write("ok\\n");\n`, "utf8");
		const settled = await settleRun(runNodeScript(script, [], { cwd: dir, timeoutMs: 10_000 }));
		deepStrictEqual(settled, { code: 0, signal: null, stdout: "ok\n", stderr: "", timedOut: false });
	});

	it("settleRun rethrows anything that is not a timeout", async () => {
		await rejects(settleRun(Promise.reject(new Error("spawn ENOENT"))), /spawn ENOENT/u);
	});

	it("the snapshot diff ignores exactly Clio's own artifacts and nothing else under .clio-coder", () => {
		const workspace = join(dir, "workspace");
		mkdirSync(join(workspace, "src"), { recursive: true });
		mkdirSync(join(workspace, ".git"), { recursive: true });
		writeFileSync(join(workspace, "src", "index.ts"), "export const a = 1;\n", "utf8");
		writeFileSync(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
		const before = workspaceSnapshot(workspace);
		deepStrictEqual([...before.keys()].sort(), ["src/", "src/index.ts"]);

		// What a `run` turn leaves behind on its own.
		mkdirSync(join(workspace, ".clio-coder"), { recursive: true });
		writeFileSync(join(workspace, ".clio-coder", "codewiki.json"), '{"version":1}\n', "utf8");
		writeFileSync(join(workspace, ".clio-coder", "state.json"), '{"version":1}\n', "utf8");
		const afterClio = workspaceSnapshot(workspace);
		ok(afterClio.has(".clio-coder/codewiki.json"), "the snapshot itself still records the artifact");
		ok(afterClio.has(".clio-coder/state.json"));
		ok(afterClio.has(".clio-coder/"));
		deepStrictEqual(workspaceChanges(before, afterClio), []);

		// An artifact rewritten between snapshots is still not a workspace change.
		writeFileSync(join(workspace, ".clio-coder", "state.json"), '{"version":1,"lastSessionAt":"x"}\n', "utf8");
		deepStrictEqual(workspaceChanges(afterClio, workspaceSnapshot(workspace)), []);

		// Anything else under .clio-coder, and anything outside it, counts.
		mkdirSync(join(workspace, ".clio-coder", "handoffs"), { recursive: true });
		writeFileSync(join(workspace, ".clio-coder", "handoffs", "one.md"), "# handoff\n", "utf8");
		writeFileSync(join(workspace, ".clio-coder", "settings.local.yaml"), "autonomy: full\n", "utf8");
		writeFileSync(join(workspace, "src", "index.ts"), "export const a = 2;\n", "utf8");
		writeFileSync(join(workspace, "REPORT.md"), "# report\n", "utf8");
		deepStrictEqual(workspaceChanges(before, workspaceSnapshot(workspace)), [
			".clio-coder/handoffs/",
			".clio-coder/handoffs/one.md",
			".clio-coder/settings.local.yaml",
			"REPORT.md",
			"src/index.ts",
		]);

		// A deleted user file counts too.
		rmSync(join(workspace, "src", "index.ts"));
		ok(workspaceChanges(before, workspaceSnapshot(workspace)).includes("src/index.ts"));
	});

	it("the exclusion list is the two generated files plus their directory entry", () => {
		deepStrictEqual([...CLIO_MANAGED_WORKSPACE_PATHS].sort(), [
			".clio-coder/",
			".clio-coder/codewiki.json",
			".clio-coder/state.json",
		]);
	});
});
