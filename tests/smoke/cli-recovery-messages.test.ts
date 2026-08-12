/**
 * The messages Clio prints when its own state is broken, held against whether
 * the command each one names can actually change the outcome.
 *
 * Every case here was reachable only from a machine already in trouble, which
 * is how each one shipped with an instruction that reads well and does
 * nothing: an invalid settings.yaml told the operator to run a repair that
 * deliberately never touches settings, a YAML parse error folded its source
 * excerpt into the middle of an aligned report and pushed the rows after it
 * out of view, and an installation missing one of its own chunks named a
 * build artifact instead of a reinstall.
 */
import { match, ok, strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { makeScratchHome, runCli } from "../harness/spawn.js";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;

/** Run an arbitrary node entry, which the shared runCli helper pins to this checkout's. */
function runNode(args: ReadonlyArray<string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [...args], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
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

describe("clio broken-state recovery messages", { concurrency: false }, () => {
	let scratch: ReturnType<typeof makeScratchHome>;

	beforeEach(() => {
		scratch = makeScratchHome("clio-recovery-");
	});

	afterEach(() => {
		scratch.cleanup();
	});

	it("names the file and the two commands that repair an invalid settings.yaml", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const settings = join(scratch.dir, "config", "settings.yaml");
		writeFileSync(settings, "version: 1\nidentity: clio\ntypoKey: 3\n", "utf8");

		const report = await runCli(["doctor"], { env: scratch.env });
		strictEqual(report.code, 1);
		match(report.stdout, /typoKey: unknown key/);
		match(report.stdout, /clio reset --config --force/);
		ok(
			!/remove unrecognized keys or update them to current settings key names/.test(report.stdout),
			"the one-size remedy that did not fit range errors is gone",
		);

		// `doctor --fix` deliberately never rewrites settings, so nothing may
		// tell the operator that it will.
		const loader = await runCli(["targets"], { env: scratch.env });
		strictEqual(loader.code, 1);
		match(loader.stderr, /Fix the keys above in .*settings\.yaml/);
		match(loader.stderr, /never rewrites settings/);
		match(loader.stderr, /clio reset --config --force/);

		const fixed = await runCli(["doctor", "--fix"], { env: scratch.env });
		strictEqual(fixed.code, 1, "--fix cannot repair settings content and must keep saying so");

		const discarded = await runCli(["reset", "--config", "--force"], { env: scratch.env });
		strictEqual(discarded.code, 0, `stderr=${discarded.stderr}`);
		const recovered = await runCli(["doctor"], { env: scratch.env });
		strictEqual(recovered.code, 0, `the documented remedy actually recovers; stdout=${recovered.stdout}`);
	});

	it("folds a multi-line YAML parse error into one doctor row", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		writeFileSync(join(scratch.dir, "config", "settings.yaml"), "version: 1\n  bad: [unclosed\n", "utf8");

		const result = await runCli(["doctor"], { env: scratch.env });

		strictEqual(result.code, 1);
		const rows = result.stdout.trimEnd().split("\n");
		ok(
			rows.every((row) => /^(OK|WARN|!!)/.test(row)),
			`every report line must start a finding; got:\n${result.stdout}`,
		);
		const settingsRow = rows.find((row) => row.includes("settings.yaml"));
		ok(settingsRow?.includes("unreadable:"), `expected an unreadable row, got ${settingsRow}`);
		ok(settingsRow?.includes("clio reset --config --force"), "the parse-error row carries a remedy too");
	});

	it("turns a missing command chunk into a reinstall instruction", async () => {
		// An install interrupted between unpacking the entry and unpacking the
		// rest: the launcher starts, parses flags, and then cannot import the
		// command it was asked for. Reproduced against a real copied dist so the
		// dispatcher's own error path runs, not a hand-written stand-in.
		const brokenRoot = join(scratch.dir, "broken-install");
		mkdirSync(brokenRoot, { recursive: true });
		cpSync(join(REPO_ROOT, "dist"), join(brokenRoot, "dist"), { recursive: true });
		cpSync(join(REPO_ROOT, "package.json"), join(brokenRoot, "package.json"));
		symlinkSync(join(REPO_ROOT, "node_modules"), join(brokenRoot, "node_modules"));
		const chunk = readdirSync(join(brokenRoot, "dist")).find((name) => /^reset-.*\.js$/.test(name));
		ok(chunk, "the reset command is code-split into its own chunk");
		rmSync(join(brokenRoot, "dist", chunk), { force: true });

		const result = await runNode([join(brokenRoot, "dist", "cli", "index.js"), "reset", "--dry-run"]);

		strictEqual(result.code, 1, `stdout=${result.stdout} stderr=${result.stderr}`);
		match(result.stderr, /installation is incomplete/);
		match(result.stderr, /npm install -g @iowarp\/clio-coder/);
		match(result.stderr, /npm run install:local/);
		match(result.stderr, new RegExp(chunk.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	});

	it("says what the bannered boot is actually configured for", async () => {
		// The whole of what a piped or CI invocation of bare `clio` shows. It
		// used to end in a hardcoded `ready` that a machine with no target at
		// all printed just as happily.
		const fresh = await runCli([], { env: scratch.env });
		strictEqual(fresh.code, 0, `stderr=${fresh.stderr}`);
		match(fresh.stdout, /EXPERIMENTAL/);
		match(fresh.stdout, /no model target configured/);
		match(fresh.stdout, /clio configure/);
		ok(!/· ready/.test(fresh.stdout), "an unconfigured install may not describe itself as ready");

		// Written directly rather than through `clio configure`, which probes the
		// endpoint; the banner is what is under test, not target registration.
		const settings = readFileSync(join(scratch.dir, "config", "settings.yaml"), "utf8");
		writeFileSync(
			join(scratch.dir, "config", "settings.yaml"),
			settings
				.replace(
					"targets: []",
					"targets:\n  - id: probe\n    runtime: ollama-native\n    url: http://127.0.0.1:11434\n    defaultModel: probe-model",
				)
				.replace("orchestrator:\n  target: null\n  model: null", "orchestrator:\n  target: probe\n  model: probe-model"),
			"utf8",
		);

		const configured = await runCli([], { env: scratch.env });
		strictEqual(configured.code, 0, `stderr=${configured.stderr}`);
		match(configured.stdout, /target probe · model probe-model/);
	});

	it("lets a module error from outside the installation report itself", async () => {
		// The advice is filtered to this installation's own output directory, so
		// a user's extension or hook failing to resolve still surfaces normally.
		const script = join(scratch.dir, "outside.mjs");
		writeFileSync(script, "await import('/nonexistent-user-module.mjs');\n", "utf8");

		const result = await runNode([script]);

		strictEqual(result.code, 1);
		match(result.stderr, /Cannot find module/);
		ok(!result.stderr.includes("installation is incomplete"), "no clio repair advice for a foreign module error");
	});
});

/**
 * What `clio configure` says about a target it could not reach, and about one
 * it reached without learning anything.
 *
 * Both were found by configuring a target by hand and then trying to take a
 * turn against it. A closed port produced `probe failed: fetch failed`, which
 * is undici's wrapper for every transport error and names neither the address
 * nor the reason. A server answering only its health check produced an
 * unqualified `probe ok`, indistinguishable from a full read, so a target that
 * could not serve a completion was blessed at configure time and the user
 * found out from a raw 404 on their first turn.
 */
describe("clio configure probe reporting", { concurrency: false }, () => {
	let scratch: ReturnType<typeof makeScratchHome>;

	beforeEach(() => {
		scratch = makeScratchHome("clio-probe-");
	});

	afterEach(() => {
		scratch.cleanup();
	});

	/** A port nothing listens on, obtained by binding one and giving it back. */
	async function closedPort(): Promise<number> {
		const { createServer } = await import("node:net");
		const server = createServer();
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		const port = typeof address === "object" && address !== null ? address.port : 0;
		await new Promise<void>((resolve) => server.close(() => resolve()));
		return port;
	}

	it("names the address and the reason a target could not be reached", async () => {
		const port = await closedPort();
		const result = await runCli(
			["configure", "--id", "down", "--runtime", "llamacpp", "--url", `http://127.0.0.1:${port}`, "--model", "m"],
			{ env: scratch.env },
		);
		match(result.stdout, /probe failed/);
		match(result.stdout, new RegExp(`http://127\\.0\\.0\\.1:${port}`), "the address it tried is named");
		match(result.stdout, /ECONNREFUSED/, "the reason is the errno, not undici's wrapper");
		ok(!/probe failed[^\n]*fetch failed/.test(result.stdout), "the bare wrapper is not the whole message");
		match(result.stdout, /clio configure --id down --url/, "and it names the command that changes the outcome");
	});

	it("does not report a probe that read nothing as an unqualified probe ok", async () => {
		const { createServer } = await import("node:http");
		// llama.cpp aliases /v1/health and serves /props and /v1/models. A server
		// that answers only the health check is the shape that used to pass.
		const server = createServer((req, res) => {
			if (req.url === "/health") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end('{"status":"ok"}');
				return;
			}
			res.writeHead(404);
			res.end("not found");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		const port = typeof address === "object" && address !== null ? address.port : 0;
		try {
			const result = await runCli(
				["configure", "--id", "stub", "--runtime", "llamacpp", "--url", `http://127.0.0.1:${port}`, "--model", "m"],
				{ env: scratch.env },
			);
			match(result.stdout, /probe reachable/, "reachable is not the same claim as ok");
			ok(!/probe ok/.test(result.stdout), "a probe that read nothing must not read as a full one");
			match(result.stdout, /no model list and no version/, "it says which reads came back empty");
			match(result.stdout, /clio targets --probe/, "and names the command that retries them");
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("reports a full read as probe ok and says what it read", async () => {
		const { createServer } = await import("node:http");
		const server = createServer((req, res) => {
			const send = (body: string): void => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(body);
			};
			if (req.url === "/health") return send('{"status":"ok"}');
			if (req.url === "/props") return send('{"build_info":"b1-testing","default_generation_settings":{"n_ctx":4096}}');
			if (req.url === "/v1/models") return send('{"data":[{"id":"m"}]}');
			res.writeHead(404);
			res.end("not found");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		const port = typeof address === "object" && address !== null ? address.port : 0;
		try {
			const result = await runCli(
				["configure", "--id", "full", "--runtime", "llamacpp", "--url", `http://127.0.0.1:${port}`, "--model", "m"],
				{ env: scratch.env },
			);
			match(result.stdout, /probe ok/, "a probe that read the catalog still says ok");
			match(result.stdout, /1 models/, "and says what it read");
			ok(!/probe reachable/.test(result.stdout), "the degraded wording is not used for a full read");
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});

/**
 * Every failing row in `clio doctor` names the command that repairs it, which
 * is the whole reason the report is worth reading from a broken machine.
 * `state metadata` was the one row that said only what was wrong.
 */
describe("clio doctor remedies", { concurrency: false }, () => {
	let scratch: ReturnType<typeof makeScratchHome>;

	beforeEach(() => {
		scratch = makeScratchHome("clio-doctor-");
	});

	afterEach(() => {
		scratch.cleanup();
	});

	it("names doctor --fix on the state-metadata row it repairs", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const stateFile = join(scratch.dir, "state", "install.json");
		ok(existsSync(stateFile), "doctor --fix wrote the state metadata");
		rmSync(stateFile);

		const broken = await runCli(["doctor"], { env: scratch.env });
		const row = broken.stdout.split("\n").find((line) => line.includes("state metadata")) ?? "";
		match(row, /missing/, "the row still says what is wrong");
		match(row, /clio doctor --fix/, "and now says what repairs it");

		// The named command has to actually repair it.
		const fixed = await runCli(["doctor", "--fix"], { env: scratch.env });
		strictEqual(fixed.code, 0);
		const fixedRow = fixed.stdout.split("\n").find((line) => line.includes("state metadata")) ?? "";
		ok(!/missing/.test(fixedRow), `state metadata is repaired: ${JSON.stringify(fixedRow)}`);
	});
});
