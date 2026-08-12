/**
 * Commands the help text advertises, held against what happens when a user
 * types them exactly as written.
 *
 * Both cases here are honest at the point of failure and silent at the point
 * of discovery, which is the worse half to be silent in. `clio run
 * --no-context-files` said only that the option was unknown while `clio
 * --no-context-files run` worked, leaving the ordering rule to be guessed at.
 * `clio trace ui` was listed beside subcommands that work everywhere but can
 * only fail from an installed package, which does not ship the viewer.
 */
import { match, ok, strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeScratchHome, runCli } from "../harness/spawn.js";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;

function runNode(
	args: ReadonlyArray<string>,
	env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [...args], { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

describe("clio discoverability messages", { concurrency: false }, () => {
	it("names the position a global option has to be in", async () => {
		const scratch = makeScratchHome("clio-discover-");
		try {
			const misplaced = await runCli(["run", "--no-context-files", "hello"], { env: scratch.env });
			match(misplaced.stderr, /--no-context-files is a global option/);
			match(misplaced.stderr, /must come before the subcommand/);
			match(misplaced.stderr, /clio --no-context-files run/);
			ok(!/unknown clio run option/.test(misplaced.stderr), "a flag the CLI does accept must not be reported as unknown");

			// The same rule, stated for the flag that carries a value.
			const key = await runCli(["run", "--api-key", "not-a-real-key", "hello"], { env: scratch.env });
			match(key.stderr, /clio --api-key <key> run/);
			ok(!key.stderr.includes("not-a-real-key"), "the hint must not echo the value back");

			// `--no-skills` is a run option as well as a global one, so both
			// positions work and neither owes the user a hint.
			const both = await runCli(["run", "--no-skills"], { env: scratch.env });
			ok(!/is a global option/.test(both.stderr), `stderr=${both.stderr}`);
			match(both.stderr, /empty task/);
		} finally {
			scratch.cleanup();
		}
	});

	it("answers --help on stdout with status 0 for every subcommand", async () => {
		const scratch = makeScratchHome("clio-discover-help-");
		try {
			// `clio trace --help` reported `unknown trace flag: --help` on stderr
			// and exited 2, so the one thing a lost user reliably types was the one
			// thing that looked broken.
			for (const topic of ["configure", "targets", "doctor", "reset", "uninstall", "trace", "models"]) {
				const result = await runCli([topic, "--help"], { env: scratch.env });
				strictEqual(result.code, 0, `clio ${topic} --help exited ${result.code}: ${result.stderr}`);
				ok(result.stdout.includes(`clio ${topic}`), `clio ${topic} --help names itself on stdout`);
				strictEqual(result.stderr.trim(), "", `clio ${topic} --help writes nothing to stderr`);
			}
		} finally {
			scratch.cleanup();
		}
	});

	it("says at discovery that the trace viewer needs a source checkout", async () => {
		const scratch = makeScratchHome("clio-discover-trace-");
		try {
			const usage = await runCli(["trace"], { env: scratch.env });
			match(usage.stdout, /clio trace ui .*source checkout only/);
			match(usage.stdout, /ships with the repository, not the npm package/);
		} finally {
			scratch.cleanup();
		}
	});

	it("points a failed trace ui at the subcommands that read the same database", async () => {
		const scratch = makeScratchHome("clio-discover-trace-fail-");
		try {
			// A dist with no sibling apps/trace-viewer, which is the shape an npm
			// install has. Running the checkout's own entry would find the viewer
			// and start a server, so it can never reach this path.
			const installed = join(scratch.dir, "installed");
			mkdirSync(installed, { recursive: true });
			cpSync(join(REPO_ROOT, "dist"), join(installed, "dist"), { recursive: true });
			cpSync(join(REPO_ROOT, "package.json"), join(installed, "package.json"));
			symlinkSync(join(REPO_ROOT, "node_modules"), join(installed, "node_modules"));

			const result = await runNode([join(installed, "dist", "cli", "index.js"), "trace", "ui"], {
				...process.env,
				...scratch.env,
			});

			strictEqual(result.code, 1, `stdout=${result.stdout} stderr=${result.stderr}`);
			match(result.stderr, /trace viewer is available only from a source checkout/);
			match(result.stderr, /npm package does not carry the viewer/);
			match(result.stderr, /clio trace runs --db /);
			match(result.stderr, /npm run trace:ui/);
		} finally {
			scratch.cleanup();
		}
	});
});
