/**
 * The scratch home a live driver prepares keeps every process of the run
 * inside one tree.
 *
 * The binary enforces CLIO_CODER_REQUIRE_HOME_PREFIX: any resolved Clio
 * directory outside CLIO_CODER_HOME is fatal. The eval runner gives each item
 * its own state dir under os.tmpdir(), so a home that isolated only the five
 * CLIO_CODER_* variables sent every evaluator child to /tmp and tripped the
 * guardrail before a model was ever called (found by the first real
 * `live:recon` run). The home therefore also owns TMPDIR.
 */
import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { stringify } from "yaml";
import { parseLiveArgs, prepareLiveHome } from "../../benchmarks/internal/live-target.js";
import { loadEvalSuiteFile } from "../../src/domains/eval/suites/load.js";
import { runEvalSuiteV2 } from "../../src/domains/eval/suites/run.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

const FAKE_TARGET = {
	id: "fake-live",
	runtime: "openai-compat",
	url: "http://127.0.0.1:9",
	defaultModel: "fake-model",
};

describe("contracts/live home", { concurrency: false }, () => {
	let operator: IsolatedClioEnv;

	beforeEach(async () => {
		// The "operator" config the driver reads --target from.
		operator = await isolateClioEnv("clio-live-home-operator-");
		const configDir = process.env.CLIO_CODER_CONFIG_DIR as string;
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "settings.yaml"), stringify({ version: 1, targets: [FAKE_TARGET] }), "utf8");
		writeFileSync(join(configDir, "credentials.yaml"), "version: 1\nprofiles: {}\n", "utf8");
	});

	afterEach(() => {
		operator.restore();
	});

	it("keeps the five Clio directories and TMPDIR under one scratch root", () => {
		const home = prepareLiveHome(parseLiveArgs(["--target", "fake-live"]), { prefix: "clio-live-home-test-" });
		try {
			const root = home.dir;
			for (const key of [
				"CLIO_CODER_HOME",
				"CLIO_CODER_CONFIG_DIR",
				"CLIO_CODER_DATA_DIR",
				"CLIO_CODER_STATE_DIR",
				"CLIO_CODER_CACHE_DIR",
				"TMPDIR",
			]) {
				const value = home.env[key];
				ok(typeof value === "string" && resolve(value).startsWith(root), `${key}=${String(value)} must sit under ${root}`);
			}
			strictEqual(home.env.CLIO_CODER_REQUIRE_HOME_PREFIX, "1");
			ok(
				resolve(home.workspace).startsWith(root) && existsSync(home.workspace),
				"the default cwd is an empty dir under the home",
			);
			strictEqual(readdirSync(home.workspace).length, 0, "the workspace starts empty");
			ok(existsSync(home.env.TMPDIR as string), "TMPDIR is created, not merely named");
			strictEqual(home.target.id, "fake-live");
			strictEqual(home.model, "fake-model");
			ok(existsSync(join(home.configDir, "credentials.yaml")), "credentials travel with the run");
		} finally {
			home.cleanup(false);
			ok(!existsSync(join(home.configDir, "credentials.yaml")), "credentials never outlive the run");
			rmSync(home.dir, { recursive: true, force: true });
		}
	});

	it("sends an eval item's state dir inside the home rather than to the machine tmpdir", async () => {
		const home = prepareLiveHome(parseLiveArgs(["--target", "fake-live"]), { prefix: "clio-live-home-test-" });
		// The driver hands home.env to `clio-coder eval run`; applying it here is
		// what that child process would see. isolateClioEnv holds the env lock.
		const applied = Object.entries(home.env).filter(([key]) => key.startsWith("CLIO_CODER_") || key === "TMPDIR");
		const saved = new Map(applied.map(([key]) => [key, process.env[key]]));
		const outsideBefore = readdirSync(tmpdir()).filter((name) => name.startsWith("clio-eval-state-"));
		try {
			// A stand-in for the binary: succeed only when the runner-provided state
			// dir is inside the home, which is what the real guardrail requires.
			const entry = join(home.dir, "fake-clio.mjs");
			writeFileSync(
				entry,
				[
					"const home = process.env.CLIO_CODER_HOME ?? '';",
					"const state = process.env.CLIO_CODER_STATE_DIR ?? '';",
					"if (!state.startsWith(home)) { process.stderr.write(`state dir ${state} escapes ${home}\\n`); process.exit(90); }",
					"process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', usage: { input: 1, output: 1, totalTokens: 2 } } }) + '\\n');",
				].join("\n"),
				"utf8",
			);
			const workspace = join(home.dir, "fixture");
			mkdirSync(workspace, { recursive: true });
			const suitePath = join(home.dir, "suite.yaml");
			writeFileSync(
				suitePath,
				stringify({
					version: 2,
					suite: { id: "live-home", title: "live home", visibility: "local", description: "state dir placement" },
					matrix: { targets: [{ id: "fake-live", model: "fake-model" }], repeats: 1 },
					tasks: [
						{
							id: "placement",
							tags: ["machinery"],
							workspace: { kind: "temp-copy", path: workspace },
							runner: { kind: "clio-run", prompt: "noop" },
							verify: { assertions: [{ metric: "result.pass", op: "eq", value: true }] },
							metrics: { collect: ["result.pass"] },
							timeoutMs: 30_000,
						},
					],
				}),
				"utf8",
			);
			for (const [key, value] of applied) process.env[key] = value;
			const loaded = await loadEvalSuiteFile(suitePath);
			const artifact = await runEvalSuiteV2(loaded, { clioEntry: entry });
			const result = artifact.results[0];
			strictEqual(result?.pass, true, `item failed: ${JSON.stringify(result?.artifacts)}`);
			const outsideAfter = readdirSync(tmpdir()).filter((name) => name.startsWith("clio-eval-state-"));
			strictEqual(outsideAfter.length, outsideBefore.length, "no item state dir landed in the machine tmpdir");
		} finally {
			for (const [key, value] of saved) {
				if (value === undefined) Reflect.deleteProperty(process.env, key);
				else process.env[key] = value;
			}
			home.cleanup(false);
			rmSync(home.dir, { recursive: true, force: true });
		}
	});
});
