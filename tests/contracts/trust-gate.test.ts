import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readLayeredSettings } from "../../src/core/settings-layers.js";
import {
	captureProjectSurface,
	projectSurfaceTrust,
	recordProjectSurfaceTrust,
	revokeProjectSurfaceTrust,
	workspaceTrustDirectory,
} from "../../src/core/workspace-trust.js";
import { INTEROP_AGENT_KINDS } from "../../src/domains/interop/registry.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import { loadUserHooks, userHookToRegistration } from "../../src/domains/middleware/hooks.js";
import { buildUserHookRegistrations, spawnSyncCommandRunner } from "../../src/domains/middleware/hooks-io.js";
import { createSafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";
import { createStdioTransport } from "../../src/engine/acp/transport.js";
import { createExtensionReloadCoordinator } from "../../src/entry/extension-reload.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function approve(workspace: string, surface: "safety" | "hooks" | "settings"): string {
	const snapshot = captureProjectSurface(workspace, surface);
	ok(snapshot.contentHash);
	recordProjectSurfaceTrust(workspace, surface, snapshot.contentHash);
	return snapshot.contentHash;
}

test("S3-01: a real boot names skipped safety and settings files and the review command", async () => {
	const home = await isolateClioEnv("clio-coder-trust-boot-");
	try {
		const workspace = join(home.dir, "workspace");
		mkdirSync(join(workspace, ".clio-coder"), { recursive: true });
		writeFileSync(join(workspace, ".clio-coder", "safety.yaml"), "version: 1\ndisableDefaultPathPolicy: true\n");
		writeFileSync(join(workspace, ".clio-coder", "settings.yaml"), "safety:\n  autonomy: full-auto\n");
		const cli = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
		const boot = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), cli], {
			cwd: workspace,
			env: { ...process.env, CLIO_CODER_INTERACTIVE: "0" },
			encoding: "utf8",
			timeout: 30_000,
		});
		strictEqual(boot.status, 0, boot.stderr);
		for (const surface of ["safety", "settings"]) {
			ok(boot.stderr.includes(join(workspace, ".clio-coder", `${surface}.yaml`)), boot.stderr);
			ok(boot.stderr.includes(`config trust ${surface}`), boot.stderr);
		}
	} finally {
		home.restore();
	}
});

test("S3-01: approved safety, settings, and hooks take effect, and changed bytes restore defaults", async () => {
	const home = await isolateClioEnv("clio-coder-trust-cycle-");
	try {
		const workspace = join(home.dir, "workspace");
		const config = join(workspace, ".clio-coder");
		mkdirSync(config, { recursive: true });
		writeFileSync(join(config, "safety.yaml"), "version: 1\ndisableDefaultPathPolicy: true\n");
		writeFileSync(join(config, "settings.yaml"), "safety:\n  autonomy: full-auto\n");
		writeFileSync(
			join(config, "hooks.yaml"),
			JSON.stringify([
				{ id: "trusted-command", kind: "command", on: "before_tool", argv: [process.execPath, "-e", "process.exit(0)"] },
			]),
		);
		const readEnv = () => createSafetyPolicyEngine({ cwd: workspace }).evaluate({ tool: "read", args: { path: ".env" } });
		strictEqual(readEnv().kind, "block");
		for (const surface of ["safety", "settings", "hooks"] as const) approve(workspace, surface);
		strictEqual(readEnv().kind, "allow");
		strictEqual(readLayeredSettings(workspace).settings.safety.autonomy, "full-auto");
		const hooks = buildUserHookRegistrations({ cwd: workspace, recordReceipt: () => undefined });
		strictEqual(hooks.registrations.length, 1);
		// Even a comment change needs fresh consent. No parser normalization can
		// silently give different source bytes a previous approval.
		for (const surface of ["safety", "settings", "hooks"] as const) {
			const file = join(config, `${surface}.yaml`);
			writeFileSync(file, `${readFileSync(file, "utf8")}\n# changed\n`);
			strictEqual(captureProjectSurface(workspace, surface).verdict, "changed");
		}
		strictEqual(readEnv().kind, "block");
		strictEqual(readLayeredSettings(workspace).settings.safety.autonomy, "auto-edit");
		deepStrictEqual(buildUserHookRegistrations({ cwd: workspace, recordReceipt: () => undefined }).registrations, []);
		deepStrictEqual(hooks.registrations[0]?.evaluate({ hook: "before_tool", toolName: "read" }), []);
	} finally {
		home.restore();
	}
});

test("S3-01: trust survives a fresh process and canonical aliases without extending to another workspace or surface", async () => {
	const home = await isolateClioEnv("clio-coder-trust-identity-");
	try {
		const workspace = join(home.dir, "workspace");
		mkdirSync(join(workspace, ".clio-coder"), { recursive: true });
		writeFileSync(join(workspace, ".clio-coder", "hooks.yaml"), "[]\n");
		const hash = approve(workspace, "hooks");
		const alias = join(home.dir, "alias");
		symlinkSync(workspace, alias, "dir");
		strictEqual(projectSurfaceTrust(alias, "hooks", hash), "trusted");
		strictEqual(projectSurfaceTrust(workspace, "settings", hash), "untrusted");
		const child = join(workspace, "nested");
		mkdirSync(child);
		strictEqual(projectSurfaceTrust(child, "hooks", hash), "untrusted");
		const moduleUrl = new URL("../../src/domains/safety/workspace-trust.ts", import.meta.url).href;
		const restarted = spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"-e",
				`import { projectSurfaceTrust } from ${JSON.stringify(moduleUrl)}; process.stdout.write(projectSurfaceTrust(${JSON.stringify(alias)}, "hooks", ${JSON.stringify(hash)}));`,
			],
			{ encoding: "utf8", env: process.env },
		);
		strictEqual(restarted.status, 0, restarted.stderr);
		strictEqual(restarted.stdout, "trusted");
		const [record] = readdirSync(workspaceTrustDirectory());
		ok(record);
		writeFileSync(join(workspaceTrustDirectory(), record), "{broken");
		strictEqual(projectSurfaceTrust(workspace, "hooks", hash), "untrusted");
		throws(() => recordProjectSurfaceTrust(workspace, "hooks", hash.slice(0, 16)), /SHA-256/);
	} finally {
		home.restore();
	}
});

test("S3-01: local-file addition invalidates the entire surface and revocation stops published hooks", async () => {
	const home = await isolateClioEnv("clio-coder-trust-local-");
	try {
		const workspace = join(home.dir, "workspace");
		const config = join(workspace, ".clio-coder");
		mkdirSync(config, { recursive: true });
		writeFileSync(join(config, "hooks.yaml"), "- id: project\n  kind: prompt\n  on: turn_start\n  message: approved\n");
		approve(workspace, "hooks");
		writeFileSync(join(config, "hooks.local.yaml"), "- id: local\n  kind: prompt\n  on: turn_start\n  message: local\n");
		strictEqual(captureProjectSurface(workspace, "hooks").verdict, "changed");
		deepStrictEqual(buildUserHookRegistrations({ cwd: workspace, recordReceipt: () => undefined }).registrations, []);
		approve(workspace, "hooks");
		const notices: string[] = [];
		const middleware = createMiddlewareBundle().contract;
		const coordinator = createExtensionReloadCoordinator({
			extensions: undefined,
			middleware,
			cwd: () => workspace,
			recordReceipt: () => undefined,
			report: (line) => notices.push(line),
		});
		coordinator.applyBoot();
		strictEqual(middleware.runHook({ hook: "turn_start" }).effects.length, 2);
		revokeProjectSurfaceTrust(workspace, "hooks");
		deepStrictEqual(middleware.runHook({ hook: "turn_start" }).effects, []);
		ok(notices.some((line) => line.includes("trust was revoked")));
		// State removal must never be undone by an authority writer.
		const hash = captureProjectSurface(workspace, "hooks").contentHash;
		ok(hash);
		rmSync(join(home.dir, "state"), { recursive: true, force: true });
		throws(() => recordProjectSurfaceTrust(workspace, "hooks", hash), /state was removed/);
		strictEqual(existsSync(join(home.dir, "state")), false);
	} finally {
		home.restore();
	}
});

test("S3-01: CLI review is read-only and approval refuses a stale digest", async () => {
	const home = await isolateClioEnv("clio-coder-trust-cli-");
	try {
		const workspace = join(home.dir, "workspace");
		mkdirSync(join(workspace, ".clio-coder"), { recursive: true });
		const file = join(workspace, ".clio-coder", "settings.yaml");
		writeFileSync(file, "safety:\n  autonomy: full-auto\n");
		const command = (args: string[]) =>
			spawnSync(
				process.execPath,
				[
					"--import",
					import.meta.resolve("tsx"),
					"--input-type=module",
					"-e",
					`import { runConfigTrustCommand } from ${JSON.stringify(new URL("../../src/cli/config-trust.ts", import.meta.url).href)};
			process.exitCode = runConfigTrustCommand(JSON.parse(process.argv[1]), process.cwd());`,
					JSON.stringify(args),
				],
				{ cwd: workspace, env: process.env, encoding: "utf8", timeout: 10_000 },
			);
		const review = command(["settings", "--json"]);
		strictEqual(review.status, 0, review.stderr);
		const reviewed = JSON.parse(review.stdout) as { contentHash: string };
		strictEqual(existsSync(workspaceTrustDirectory()), false);
		writeFileSync(file, "safety:\n  autonomy: suggest\n");
		strictEqual(command(["settings", "--hash", reviewed.contentHash]).status, 1);
		strictEqual(captureProjectSurface(workspace, "settings").verdict, "untrusted");
		const current = captureProjectSurface(workspace, "settings");
		ok(current.contentHash);
		strictEqual(command(["settings", "--hash", current.contentHash]).status, 0);
		strictEqual(readLayeredSettings(workspace).settings.safety.autonomy, "suggest");
		strictEqual(command(["settings", "--revoke"]).status, 0);
		strictEqual(readLayeredSettings(workspace).settings.safety.autonomy, "auto-edit");
	} finally {
		home.restore();
	}
});

test("S3-01: untrusted project hooks and settings cannot acquire operator authority", async () => {
	const home = await isolateClioEnv("clio-coder-trust-gate-");
	try {
		const workspace = join(home.dir, "workspace");
		mkdirSync(join(workspace, ".clio-coder"), { recursive: true });
		writeFileSync(
			join(workspace, ".clio-coder", "hooks.yaml"),
			JSON.stringify([
				{ id: "repo-command", kind: "command", on: "before_tool", argv: [process.execPath, "-e", "process.exit(0)"] },
			]),
		);
		writeFileSync(join(workspace, ".clio-coder", "settings.yaml"), "safety:\n  autonomy: full-auto\n");
		const hooks = buildUserHookRegistrations({ cwd: workspace, recordReceipt: () => undefined });
		deepStrictEqual(hooks.registrations, []);
		ok(hooks.fileIssues.some((issue) => issue.message.includes("hooks.yaml") && issue.message.includes("untrusted")));
		const settings = readLayeredSettings(workspace);
		strictEqual(settings.settings.safety.autonomy, "auto-edit");
		ok(settings.issues.some((issue) => issue.message.includes("settings.yaml") && issue.message.includes("untrusted")));
	} finally {
		home.restore();
	}
});

test("S3-02: a registered command hook receives a safe environment and preserves attribution opt-out", async () => {
	const home = await isolateClioEnv("clio-coder-hook-environment-");
	try {
		process.env.ANTHROPIC_API_KEY = "fixture-anthropic-secret";
		process.env.OPENAI_API_KEY = "fixture-openai-secret";
		process.env.FOO_TOKEN = "fixture-token";
		process.env.NODE_OPTIONS = "--no-warnings";
		process.env.CLIO_CODER_GIT_COMMITS_ENABLED = "0";
		const loaded = loadUserHooks(
			[
				{
					source: { origin: "user", sourcePath: "operator-hook" },
					declarations: [
						{
							id: "env-probe",
							on: "after_tool",
							kind: "command",
							argv: [
								process.execPath,
								"-e",
								`process.stdout.write(JSON.stringify(Object.fromEntries(
					["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "FOO_TOKEN", "NODE_OPTIONS", "PATH", "HOME", "CLIO_CODER_GIT_COMMITS_ENABLED"]
					.map(key => [key, process.env[key]]))))`,
							],
						},
					],
				},
			],
			{ workspaceRoot: home.dir },
		);
		const hook = loaded.hooks[0];
		ok(hook);
		const registration = userHookToRegistration(hook, {
			recordReceipt: () => undefined,
			runCommand: spawnSyncCommandRunner(),
		});
		const effects = registration.evaluate({ hook: "after_tool", toolName: "read" });
		const effect = effects[0];
		ok(effect?.kind === "annotate_tool_result");
		const env = JSON.parse(effect.message) as NodeJS.ProcessEnv;
		for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "FOO_TOKEN", "NODE_OPTIONS"])
			strictEqual(env[key], undefined, key);
		strictEqual(env.PATH, process.env.PATH);
		strictEqual(env.HOME, process.env.HOME);
		strictEqual(env.CLIO_CODER_GIT_COMMITS_ENABLED, "0");
	} finally {
		home.restore();
	}
});

test("S3-03: npm ACP recipes approve exact versions", () => {
	const recipes = INTEROP_AGENT_KINDS.flatMap((kind) => (kind.acp?.npmPackage ? [kind.acp] : []));
	strictEqual(recipes.length, 2);
	for (const recipe of recipes) {
		const spec = recipe.args.find((arg) => arg.startsWith(`${recipe.npmPackage}@`));
		ok(spec, `${recipe.npmPackage} must have an exact version in its launch arguments`);
		match(spec.slice((recipe.npmPackage?.length ?? 0) + 1), /^\d+\.\d+\.\d+$/);
	}
});

test("S3-03: a real ACP child excludes inherited credentials and accepts only explicit extra environment", async () => {
	const home = await isolateClioEnv("clio-coder-acp-environment-");
	try {
		process.env.ANTHROPIC_API_KEY = "fixture-parent-secret";
		process.env.OPENAI_API_KEY = "fixture-parent-openai";
		process.env.FOO_TOKEN = "fixture-parent-token";
		process.env.NODE_OPTIONS = "--no-warnings";
		const transport = createStdioTransport(
			process.execPath,
			[
				"-e",
				`
			require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
				const request = JSON.parse(line);
				process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: process.env }) + "\\n");
			});
		`,
			],
			{ cwd: home.dir, env: { ADAPTER_SETTING: "explicit", OPENAI_API_KEY: "fixture-adapter-key" } },
		);
		try {
			const env = await transport.request<NodeJS.ProcessEnv>("env", {}, 5000);
			for (const key of ["ANTHROPIC_API_KEY", "FOO_TOKEN", "NODE_OPTIONS"]) strictEqual(env[key], undefined, key);
			strictEqual(env.OPENAI_API_KEY, "fixture-adapter-key");
			strictEqual(env.ADAPTER_SETTING, "explicit");
			strictEqual(env.PATH, process.env.PATH);
			strictEqual(env.HOME, process.env.HOME);
		} finally {
			await transport.forceTerminate();
		}
	} finally {
		home.restore();
	}
});
