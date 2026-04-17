import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { parse as parseYaml } from "yaml";
import { DEFAULT_SETTINGS } from "../src/core/defaults.js";
import { SettingsSchema } from "../src/domains/config/schema.js";

/**
 * Verification script. Builds once, then runs:
 *   clio --version
 *   clio install  (into an ephemeral CLIO_HOME)
 *   clio doctor   (against the install)
 *   clio          (orchestrator boot stub against the install)
 *   diag-setup.ts (guided setup + mini/dynamo switch flow)
 *   verify-prompt.ts
 *   verify-session.ts
 *
 * Exits 0 on success. Any step that deviates from expected output exits 1.
 */

const projectRoot = process.cwd();
const cliPath = join(projectRoot, "dist", "cli", "index.js");

function log(msg: string): void {
	process.stdout.write(`[verify] ${msg}\n`);
}

function fail(msg: string, detail?: string): never {
	process.stderr.write(`[verify] FAIL: ${msg}\n`);
	if (detail) process.stderr.write(`${detail}\n`);
	process.exit(1);
}

function ensureBuilt(): void {
	if (!existsSync(cliPath)) {
		log("dist/cli/index.js missing; running tsup build");
		execFileSync("npm", ["run", "build"], { stdio: "inherit" });
	}
}

function runCli(args: string[], env: NodeJS.ProcessEnv): { stdout: string; exitCode: number } {
	try {
		const stdout = execFileSync("node", [cliPath, ...args], {
			env,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { stdout, exitCode: 0 };
	} catch (err) {
		const e = err as NodeJS.ErrnoException & { stdout?: Buffer | string; status?: number };
		return {
			stdout: typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString() ?? ""),
			exitCode: e.status ?? 1,
		};
	}
}

function checkVersion(env: NodeJS.ProcessEnv): void {
	const { stdout, exitCode } = runCli(["--version"], env);
	if (exitCode !== 0) fail(`clio --version exited ${exitCode}`, stdout);
	if (!stdout.includes("clio ")) fail("clio --version missing 'clio' line", stdout);
	if (!stdout.includes("pi-agent-core")) fail("clio --version missing pi-agent-core line", stdout);
	log("clio --version OK");
}

function checkInstall(home: string, env: NodeJS.ProcessEnv): void {
	const first = runCli(["install"], env);
	if (first.exitCode !== 0) fail(`clio install (first) exited ${first.exitCode}`, first.stdout);
	if (!first.stdout.includes("created")) fail("clio install (first) did not report created paths", first.stdout);
	if (!first.stdout.includes(`settings    ${join(home, "settings.yaml")}`)) {
		fail("clio install (first) did not print the resolved settings path", first.stdout);
	}
	if (first.stdout.includes("~/.clio/settings.yaml")) {
		fail("clio install (first) still printed the stale ~/.clio/settings.yaml hint", first.stdout);
	}

	const second = runCli(["install"], env);
	if (second.exitCode !== 0) fail(`clio install (second) exited ${second.exitCode}`, second.stdout);
	if (!second.stdout.includes("already installed")) fail("clio install (second) not idempotent", second.stdout);
	if (!second.stdout.includes(`settings    ${join(home, "settings.yaml")}`)) {
		fail("clio install (second) did not print the resolved settings path", second.stdout);
	}
	if (second.stdout.includes("~/.clio/settings.yaml")) {
		fail("clio install (second) still printed the stale ~/.clio/settings.yaml hint", second.stdout);
	}

	const settings = join(home, "settings.yaml");
	if (!existsSync(settings)) fail(`expected ${settings} to exist after install`);

	const installJsonDataDir = join(home, "data", "install.json");
	const installJsonDirect = join(home, "install.json");
	if (!existsSync(installJsonDataDir) && !existsSync(installJsonDirect)) {
		fail(`expected install.json under ${installJsonDataDir} or ${installJsonDirect}`);
	}
	log("clio install OK (idempotent)");
}

type ExampleSpec = {
	provider: "llamacpp" | "lmstudio";
	endpoint: "mini" | "dynamo";
	expected: {
		url: string;
		default_model: string;
		context_window: number;
		max_tokens: number;
	};
};

const EXAMPLE_SPECS: readonly ExampleSpec[] = [
	{
		provider: "llamacpp",
		endpoint: "mini",
		expected: {
			url: "http://127.0.0.1:8080",
			default_model: "Qwen3.6-35B-A3B-UD-Q4_K_XL",
			context_window: 262144,
			max_tokens: 16384,
		},
	},
	{
		provider: "lmstudio",
		endpoint: "dynamo",
		expected: {
			url: "http://127.0.0.1:1234",
			default_model: "qwen3.6-35b-a3b",
			context_window: 262144,
			max_tokens: 16384,
		},
	},
];

type TargetOverrideSpec = {
	block: "orchestrator" | "workers";
	path: "orchestrator" | "workers.default";
	expected: {
		provider: string;
		endpoint: string;
		model: string;
	};
	select(parsed: unknown): unknown;
};

const TARGET_OVERRIDE_SPECS: readonly TargetOverrideSpec[] = [
	{
		block: "orchestrator",
		path: "orchestrator",
		expected: {
			provider: "llamacpp",
			endpoint: "mini",
			model: "Qwen3.6-35B-A3B-UD-Q4_K_XL",
		},
		select(parsed) {
			return (parsed as { orchestrator?: unknown }).orchestrator;
		},
	},
	{
		block: "workers",
		path: "workers.default",
		expected: {
			provider: "llamacpp",
			endpoint: "mini",
			model: "Qwen3.6-35B-A3B-UD-Q4_K_XL",
		},
		select(parsed) {
			return (parsed as { workers?: { default?: unknown } }).workers?.default;
		},
	},
];

function objectKeys(value: unknown): string[] | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	return Object.keys(value).sort();
}

function assertExactKeyShape(actual: unknown, expected: unknown, path = "(root)"): void {
	const actualKeys = objectKeys(actual);
	const expectedKeys = objectKeys(expected);
	if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
		fail(
			`settings.yaml key shape mismatch at ${path}`,
			`expected=${JSON.stringify(expectedKeys)} actual=${JSON.stringify(actualKeys)}`,
		);
	}
	if (!actualKeys || !expectedKeys) return;
	const actualRecord = actual as Record<string, unknown>;
	const expectedRecord = expected as Record<string, unknown>;
	for (const key of expectedKeys) {
		assertExactKeyShape(actualRecord[key], expectedRecord[key], path === "(root)" ? key : `${path}.${key}`);
	}
}

function uncommentTemplateLine(line: string): string {
	return line.replace(/^(\s*)# /, "$1");
}

function materializeExampleBlock(
	body: string,
	provider: ExampleSpec["provider"],
	endpoint: ExampleSpec["endpoint"],
): string {
	const lines = body.split("\n");
	const providerLine = `  ${provider}:`;
	const providerIndex = lines.findIndex((line) => line === providerLine);
	if (providerIndex < 0) fail(`settings.yaml missing provider block ${provider}`);

	const endpointsIndex = lines.findIndex((line, index) => index > providerIndex && line === "    endpoints: {}");
	if (endpointsIndex < 0) fail(`settings.yaml missing endpoints placeholder for ${provider}`);

	const startMarker = `# clio-example:start provider=${provider} endpoint=${endpoint}`;
	const endMarker = `# clio-example:end provider=${provider} endpoint=${endpoint}`;
	const startIndex = lines.findIndex((line) => line.trim() === startMarker);
	const endIndex = lines.findIndex((line) => line.trim() === endMarker);
	if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
		fail(`settings.yaml missing canonical example markers for ${provider}/${endpoint}`);
	}

	const exampleLines = lines.slice(startIndex + 1, endIndex).map(uncommentTemplateLine);
	return [...lines.slice(0, endpointsIndex), ...exampleLines, ...lines.slice(endpointsIndex + 1)].join("\n");
}

function uncommentBlockExample(body: string, block: TargetOverrideSpec["block"]): string {
	const lines = body.split("\n");
	const startMarker = `# clio-example:start block=${block}`;
	const endMarker = `# clio-example:end block=${block}`;
	const startIndex = lines.findIndex((line) => line.trim() === startMarker);
	const endIndex = lines.findIndex((line) => line.trim() === endMarker);
	if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
		fail(`settings.yaml missing canonical block markers for ${block}`);
	}

	return lines
		.map((line, index) => (index > startIndex && index < endIndex ? uncommentTemplateLine(line) : line))
		.join("\n");
}

function assertExactObject(actual: unknown, expected: Record<string, string>, path: string): void {
	if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
		fail(`settings.yaml example for ${path} did not materialize an object`);
	}

	const actualRecord = actual as Record<string, unknown>;
	const expectedKeys = Object.keys(expected).sort();
	const actualKeys = Object.keys(actualRecord).sort();
	if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
		fail(
			`settings.yaml example for ${path} had the wrong key set`,
			`expected=${JSON.stringify(expectedKeys)} actual=${JSON.stringify(actualKeys)}`,
		);
	}

	for (const [key, value] of Object.entries(expected)) {
		if (actualRecord[key] !== value) {
			fail(
				`settings.yaml example for ${path} had the wrong value for ${key}`,
				`expected=${JSON.stringify(value)} actual=${JSON.stringify(actualRecord[key])}`,
			);
		}
	}
}

function assertSchemaValid(candidate: unknown, label: string): void {
	if (Value.Check(SettingsSchema, candidate)) return;
	const first = [...Value.Errors(SettingsSchema, candidate)][0];
	fail(`${label} failed schema validation`, `${first?.path ?? "(root)"} ${first?.message ?? "unknown schema error"}`);
}

function checkExampleFixture(body: string, spec: ExampleSpec): void {
	let parsed: unknown;
	try {
		parsed = parseYaml(materializeExampleBlock(body, spec.provider, spec.endpoint));
	} catch (err) {
		fail(
			`settings.yaml example for ${spec.provider}/${spec.endpoint} did not parse after replacement`,
			(err as Error).message,
		);
	}

	const endpoint = (
		parsed as {
			providers?: Record<string, { endpoints?: Record<string, unknown> }>;
		}
	).providers?.[spec.provider]?.endpoints?.[spec.endpoint];
	if (endpoint === undefined || endpoint === null || typeof endpoint !== "object" || Array.isArray(endpoint)) {
		fail(`settings.yaml example for ${spec.provider}/${spec.endpoint} did not materialize an endpoint object`);
	}

	const actual = endpoint as Record<string, unknown>;
	const expectedKeys = Object.keys(spec.expected).sort();
	const actualKeys = Object.keys(actual).sort();
	if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
		fail(
			`settings.yaml example for ${spec.provider}/${spec.endpoint} had the wrong key set`,
			`expected=${JSON.stringify(expectedKeys)} actual=${JSON.stringify(actualKeys)}`,
		);
	}

	for (const [key, value] of Object.entries(spec.expected)) {
		if (actual[key] !== value) {
			fail(
				`settings.yaml example for ${spec.provider}/${spec.endpoint} had the wrong value for ${key}`,
				`expected=${JSON.stringify(value)} actual=${JSON.stringify(actual[key])}`,
			);
		}
	}
}

const TEMPLATE_EXAMPLE_BLOCK_MARKERS: readonly string[] = [
	"# clio-example:start block=orchestrator",
	"# clio-example:end block=orchestrator",
	"# clio-example:start block=workers",
	"# clio-example:end block=workers",
];

function assertBlockMarkers(body: string): void {
	for (const marker of TEMPLATE_EXAMPLE_BLOCK_MARKERS) {
		if (!body.includes(marker)) {
			fail(`settings.yaml missing example marker: ${marker}`);
		}
	}
}

function checkTargetOverrideExamples(body: string): void {
	let parsed: unknown;
	let materialized = materializeExampleBlock(body, "llamacpp", "mini");
	for (const spec of TARGET_OVERRIDE_SPECS) {
		materialized = uncommentBlockExample(materialized, spec.block);
	}
	try {
		parsed = parseYaml(materialized);
	} catch (err) {
		fail("settings.yaml override examples did not parse after uncomment", (err as Error).message);
	}

	assertSchemaValid(parsed, "settings.yaml override examples");
	for (const spec of TARGET_OVERRIDE_SPECS) {
		assertExactObject(spec.select(parsed), spec.expected, spec.path);
	}
}

function checkSettingsTemplate(home: string): void {
	const settingsPath = join(home, "settings.yaml");
	const body = readFileSync(settingsPath, "utf8");
	if (body.includes("clio providers use"))
		fail("settings.yaml still advertises the nonexistent 'clio providers use' flow", body);

	let parsed: unknown;
	try {
		parsed = parseYaml(body);
	} catch (err) {
		fail("settings.yaml did not parse after install", (err as Error).message);
	}

	assertExactKeyShape(parsed, DEFAULT_SETTINGS);
	for (const spec of EXAMPLE_SPECS) {
		checkExampleFixture(body, spec);
	}
	assertBlockMarkers(body);
	checkTargetOverrideExamples(body);
	log("settings.yaml example block OK");
}

function checkDoctor(env: NodeJS.ProcessEnv): void {
	const { stdout, exitCode } = runCli(["doctor"], env);
	if (exitCode !== 0) fail(`clio doctor exited ${exitCode}`, stdout);
	if (!stdout.includes("clio version")) fail("clio doctor missing 'clio version' row", stdout);
	if (!stdout.includes("settings.yaml")) fail("clio doctor missing settings.yaml row", stdout);
	log("clio doctor OK");
}

function checkBoot(env: NodeJS.ProcessEnv): void {
	const { stdout, exitCode } = runCli([], env);
	if (exitCode !== 0) fail(`clio (default) exited ${exitCode}`, stdout);
	if (!stdout.includes("◆ clio")) fail("banner missing from clio default output", stdout);
	log("clio (orchestrator boot) OK");
}

function checkRegistryPaths(env: NodeJS.ProcessEnv): void {
	// Spawn scripts/diag-registry.ts through tsx so the registry exercises the
	// real domain loader across a subprocess boundary, mirroring the CLI.
	const script = join(projectRoot, "scripts", "diag-registry.ts");
	try {
		execFileSync("npx", ["tsx", script], { env, stdio: "inherit" });
		log("registry allow + block paths OK");
	} catch (err) {
		fail("registry diag failed", (err as Error).message);
	}
}

function checkSetupFlow(env: NodeJS.ProcessEnv): void {
	const script = join(projectRoot, "scripts", "diag-setup.ts");
	try {
		execFileSync("npx", ["tsx", script], { env, stdio: "inherit" });
		log("guided setup flow OK");
	} catch (err) {
		fail("guided setup flow failed", (err as Error).message);
	}
}

function checkPromptCompile(env: NodeJS.ProcessEnv): void {
	const script = join(projectRoot, "scripts", "verify-prompt.ts");
	try {
		execFileSync("npx", ["tsx", script], { env, stdio: "inherit" });
		log("prompt compile OK");
	} catch (err) {
		fail("prompt compile check failed", (err as Error).message);
	}
}

function checkSessionRoundTrip(env: NodeJS.ProcessEnv): void {
	const script = join(projectRoot, "scripts", "verify-session.ts");
	try {
		execFileSync("npx", ["tsx", script], { env, stdio: "inherit" });
		log("session round-trip OK");
	} catch (err) {
		fail("session round-trip check failed", (err as Error).message);
	}
}

function checkProvidersCommand(env: NodeJS.ProcessEnv): void {
	const { stdout, exitCode } = runCli(["providers"], env);
	if (exitCode !== 0) fail(`clio providers exited ${exitCode}`, stdout);
	if (!stdout.includes("anthropic")) fail("clio providers missing anthropic row", stdout);
	if (!stdout.includes("llamacpp")) fail("clio providers missing llamacpp row", stdout);
	log("clio providers OK");
}

function checkAgentsCommand(env: NodeJS.ProcessEnv): void {
	const { stdout, exitCode } = runCli(["agents"], env);
	if (exitCode !== 0) fail(`clio agents exited ${exitCode}`, stdout);
	if (!stdout.includes("scout")) fail("clio agents missing scout row", stdout);
	if (!stdout.includes("worker")) fail("clio agents missing worker row", stdout);
	log("clio agents OK");
}

function checkToolAdmission(env: NodeJS.ProcessEnv): void {
	const script = join(projectRoot, "scripts", "diag-tools.ts");
	try {
		execFileSync("npx", ["tsx", script], { env, stdio: "inherit" });
		log("tool admission OK");
	} catch (err) {
		fail("tool admission diag failed", (err as Error).message);
	}
}

function checkRunCommand(env: NodeJS.ProcessEnv): void {
	const { stdout, exitCode } = runCli(["run", "scout", "--faux", "hello"], {
		...env,
		CLIO_WORKER_FAUX: "1",
	});
	if (exitCode !== 0) fail(`clio run exited ${exitCode}`, stdout);
	if (!stdout.includes("receipt:")) fail("clio run missing receipt output", stdout);
	if (!stdout.includes("agent_end") && !stdout.includes("agent=")) fail("clio run missing event output", stdout);
	log("clio run (faux) OK");
}

function main(): void {
	ensureBuilt();
	const home = mkdtempSync(join(tmpdir(), "clio-verify-"));
	const env: NodeJS.ProcessEnv = { ...process.env, CLIO_HOME: home };
	log(`ephemeral CLIO_HOME=${home}`);
	checkVersion(env);
	checkInstall(home, env);
	checkSettingsTemplate(home);
	checkDoctor(env);
	checkBoot(env);
	checkSetupFlow(env);
	checkRegistryPaths(env);
	checkPromptCompile(env);
	checkSessionRoundTrip(env);
	checkProvidersCommand(env);
	checkAgentsCommand(env);
	checkToolAdmission(env);
	checkRunCommand(env);
	log("all checks passed");
}

main();
