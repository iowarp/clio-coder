import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { extractGlobalFlags } from "../../src/cli/argv.js";
import { runClioCommand } from "../../src/cli/clio.js";
import { cwdHash } from "../../src/core/cwd-hash.js";
import { runOverrides } from "../../src/core/run-overrides.js";
import { clioStateDir } from "../../src/core/xdg.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

it("awaits the boot runner and returns its exit code with headless options intact", async () => {
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	let finished = false;
	const result = runClioCommand(
		{ headless: { prompt: "fixture" } },
		{
			bootOrchestrator: async (options) => {
				strictEqual(options?.headless?.prompt, "fixture");
				strictEqual(options?.terminalLease, undefined);
				await pending;
				finished = true;
				return { exitCode: 7, bootTimeMs: 0 };
			},
		},
	);
	strictEqual(finished, false);
	release();
	strictEqual(await result, 7);
});

it("preserves the boot runner failure", async () => {
	const failure = new Error("fixture hydration failure");
	await rejects(
		runClioCommand(
			{ headless: { prompt: "fixture" } },
			{
				bootOrchestrator: async () => {
					throw failure;
				},
			},
		),
		(error) => error === failure,
	);
});

it("--max-context-tokens caps the interactive session's window through the run overrides, as run does (c16-E)", async () => {
	const parsed = extractGlobalFlags(["--max-context-tokens", "8192"]);
	strictEqual(parsed.maxContextTokens, 8192);
	strictEqual(
		extractGlobalFlags(["--max-context-tokens", "0"]).error,
		"--max-context-tokens must be a positive integer",
	);
	strictEqual(extractGlobalFlags(["--max-context-tokens=8192"]).maxContextTokens, 8192);
	strictEqual(extractGlobalFlags(["--max-context-tokens=-5"]).error, "--max-context-tokens must be a positive integer");
	let seen: number | undefined;
	const code = await runClioCommand(
		{
			headless: { prompt: "fixture" },
			...(parsed.maxContextTokens ? { maxContextTokens: parsed.maxContextTokens } : {}),
		},
		{
			bootOrchestrator: async () => {
				seen = runOverrides().maxContextTokens;
				return { exitCode: 0, bootTimeMs: 0 };
			},
		},
	);
	strictEqual(code, 0);
	strictEqual(seen, 8192);
	strictEqual(runOverrides().maxContextTokens, undefined);
});

it("--resume <id|prefix> resolves as /resume does, and a miss or an ambiguous prefix exits 2 before boot (#191)", async () => {
	const isolated = await isolateClioEnv("clio-command-resume-");
	try {
		for (const id of ["aaa111", "aaa222"]) {
			const dir = join(clioStateDir(), "sessions", cwdHash(process.cwd()), id);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "meta.json"), JSON.stringify({ id, cwd: process.cwd(), createdAt: "2026-11-19T00:00:00Z" }));
		}
		let booted = false;
		const bootOrchestrator = async () => {
			booted = true;
			return { exitCode: 0, bootTimeMs: 0 };
		};
		strictEqual(await runClioCommand({ resume: { kind: "id", id: "zzz" } }, { bootOrchestrator }), 2);
		strictEqual(await runClioCommand({ resume: { kind: "id", id: "aaa" } }, { bootOrchestrator }), 2);
		strictEqual(booted, false);
		deepStrictEqual(extractGlobalFlags(["-r", "aaa1"]).resume, { kind: "id", id: "aaa1" });
		deepStrictEqual(extractGlobalFlags(["--resume=aaa1"]).resume, { kind: "id", id: "aaa1" });
	} finally {
		isolated.restore();
	}
});

it("a bare --resume asks for the picker, also before another flag or a subcommand", () => {
	deepStrictEqual(extractGlobalFlags(["--resume"]).resume, { kind: "picker" });
	const beforeFlag = extractGlobalFlags(["--resume", "--with-panes"]);
	deepStrictEqual([beforeFlag.resume, beforeFlag.panes], [{ kind: "picker" }, "with"]);
	const beforeCommand = extractGlobalFlags(["-r", "run", "task"], (token) => token === "run");
	deepStrictEqual([beforeCommand.resume, beforeCommand.rest], [{ kind: "picker" }, ["run", "task"]]);
});

it("--continue and -c ask for the latest session, as run --continue does", () => {
	deepStrictEqual(extractGlobalFlags(["--continue"]).resume, { kind: "latest" });
	deepStrictEqual(extractGlobalFlags(["-c"]).resume, { kind: "latest" });
});
