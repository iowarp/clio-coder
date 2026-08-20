import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { closeServer, seedOpenAICompatToolOrchestrator, startOpenAICompatFixture } from "./openai-compat-fixture.js";
import { emittedJavaScriptContaining, runCliWithCoverage } from "./runtime-module-graph.js";

const IMPLEMENTATION_MARKERS = {
	web_fetch: "web_fetch: binary or unsupported content type",
	verify: "frontend validation:",
	code_nav: "code_nav: no wiki page matches",
	context: "context: scope must be workspace, docs, or skills",
} as const;

type LazyToolName = keyof typeof IMPLEMENTATION_MARKERS;

interface PiGraphFiles {
	compat: string;
	legacyAliases: string;
	openAICompletions: string;
	unconfiguredCatalog: string[];
	unrelatedImplementations: string[];
}

function findPiPackage(packageRoot: string): string {
	let cursor = packageRoot;
	const root = parse(cursor).root;
	while (true) {
		const candidate = join(cursor, "node_modules", "@earendil-works", "pi-ai");
		if (existsSync(candidate)) return realpathSync(candidate);
		if (cursor === root) break;
		cursor = dirname(cursor);
	}
	throw new Error(`could not resolve installed @earendil-works/pi-ai from ${packageRoot}`);
}

function piGraphFiles(packageRoot: string): PiGraphFiles {
	const root = findPiPackage(packageRoot);
	return {
		compat: realpathSync(join(root, "dist", "compat.js")),
		legacyAliases: realpathSync(join(root, "dist", "legacy-api-aliases.js")),
		openAICompletions: realpathSync(join(root, "dist", "api", "openai-completions.js")),
		unconfiguredCatalog: [
			"providers/all.js",
			"providers/azure-openai-responses.js",
			"providers/cerebras.js",
			"providers/xai.js",
		].map((path) => realpathSync(join(root, "dist", path))),
		unrelatedImplementations: [
			"api/anthropic-messages.js",
			"api/bedrock-converse-stream.js",
			"api/google-generative-ai.js",
			"api/mistral-conversations.js",
			"api/openrouter-images.js",
			"auth/oauth/anthropic.js",
			"auth/oauth/openai-codex.js",
			"auth/oauth/github-copilot.js",
		].map((path) => realpathSync(join(root, "dist", path))),
	};
}

function assertNarrowPiRuntimeGraph(files: Set<string>, pi: PiGraphFiles): void {
	strictEqual(files.has(pi.compat), false, "no-plugin turns must not evaluate pi-ai/compat");
	strictEqual(files.has(pi.legacyAliases), false, "the deprecated Pi API alias aggregate must remain absent");
	ok(files.has(pi.openAICompletions), "the invoked OpenAI-compatible provider implementation must be present");
	for (const unconfigured of pi.unconfiguredCatalog) {
		strictEqual(files.has(unconfigured), false, `unconfigured Pi provider catalog must remain absent: ${unconfigured}`);
	}
	for (const unrelated of pi.unrelatedImplementations) {
		strictEqual(files.has(unrelated), false, `unrelated Pi implementation must remain absent: ${unrelated}`);
	}
}

function configuredEnv(input: { env: NodeJS.ProcessEnv }): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...input.env,
		CLIO_CODER_TEST_OPENAI_KEY: "lazy-tool-graph-key",
		CLIO_CODER_RESIDENCY: "observe",
	};
	delete env.CLIO_CODER_NO_NETWORK_TOOLS;
	return env;
}

function assertProviderAdvertisedAllTools(requests: Array<Record<string, unknown>>): void {
	const request = requests.find((candidate) => Array.isArray(candidate.tools));
	ok(request, "a real provider request must serialize the registered tool surface");
	const tools = request.tools as Array<Record<string, unknown>>;
	const wire = JSON.stringify(tools);
	for (const name of Object.keys(IMPLEMENTATION_MARKERS)) {
		ok(wire.includes(`"name":"${name}"`), `${name} must be advertised before its implementation loads`);
	}
}

function includesAny(files: Set<string>, expected: Set<string>): boolean {
	return [...expected].some((path) => files.has(path));
}

async function invokeTool(input: {
	name: LazyToolName;
	args: Record<string, unknown>;
	packageRoot: string;
	bin: string;
	workRoot: string;
	env: NodeJS.ProcessEnv;
	implementationFiles: Readonly<Record<LazyToolName, Set<string>>>;
	baseSettings: string;
	pi: PiGraphFiles;
	expectedResult?: string;
	seedFiles?: Readonly<Record<string, string>>;
}): Promise<void> {
	const fixture = await startOpenAICompatFixture(`${input.name} lazy invocation complete`, {
		toolCall: { name: input.name, arguments: input.args },
	});
	const configDir = input.env.CLIO_CODER_CONFIG_DIR;
	ok(configDir, "lazy graph harness requires CLIO_CODER_CONFIG_DIR");
	writeFileSync(join(configDir, "settings.yaml"), input.baseSettings, "utf8");
	seedOpenAICompatToolOrchestrator(configDir, fixture.url, "full-auto");
	const cwd = join(input.workRoot, `invoke-${input.name}`);
	mkdirSync(cwd, { recursive: true });
	for (const [path, content] of Object.entries(input.seedFiles ?? {})) {
		writeFileSync(join(cwd, path), content, "utf8");
	}
	const coverageDir = mkdtempSync(join(tmpdir(), `clio-lazy-${input.name}-coverage-`));
	try {
		const result = await runCliWithCoverage({
			bin: input.bin,
			args: ["--no-context-files", "--no-skills", "run", "--autonomy", "full-auto", `invoke ${input.name}`],
			cwd,
			env: input.env,
			coverageDir,
			timeoutMs: 45_000,
		});
		strictEqual(result.code, 0, `tool=${input.name} stdout=${result.stdout} stderr=${result.stderr}`);
		assertNarrowPiRuntimeGraph(result.files, input.pi);
		ok(
			includesAny(result.files, input.implementationFiles[input.name]),
			`${input.name} must evaluate its implementation chunk on first invocation`,
		);
		for (const other of Object.keys(IMPLEMENTATION_MARKERS) as LazyToolName[]) {
			if (other === input.name) continue;
			strictEqual(
				includesAny(result.files, input.implementationFiles[other]),
				false,
				`${input.name} must not pull the unrelated ${other} implementation into its runtime graph`,
			);
		}
		ok(fixture.requests.length >= 2, `${input.name} must return its real result to the model`);
		if (input.expectedResult) {
			ok(
				fixture.requests.some((request) => JSON.stringify(request).includes(input.expectedResult as string)),
				`${input.name} provider history must contain the implementation result`,
			);
		}
	} finally {
		rmSync(coverageDir, { recursive: true, force: true });
		fixture.server.closeAllConnections();
		await closeServer(fixture.server);
	}
}

/** Built-runtime absence/presence proof shared by checkout and installed-tarball smokes. */
export async function assertLazyToolLoading(input: {
	packageRoot: string;
	bin: string;
	workRoot: string;
	env: NodeJS.ProcessEnv;
}): Promise<void> {
	mkdirSync(input.workRoot, { recursive: true });
	const env = configuredEnv(input);
	const pi = piGraphFiles(input.packageRoot);
	const implementationFiles = Object.fromEntries(
		Object.entries(IMPLEMENTATION_MARKERS).map(([name, marker]) => {
			const files = emittedJavaScriptContaining(input.packageRoot, marker);
			ok(files.size > 0, `${name} implementation must be discoverable in emitted JavaScript`);
			return [name, files];
		}),
	) as Record<LazyToolName, Set<string>>;

	const initCoverage = mkdtempSync(join(tmpdir(), "clio-lazy-tool-init-coverage-"));
	try {
		const initialized = await runCliWithCoverage({
			bin: input.bin,
			args: ["doctor", "--fix"],
			cwd: input.workRoot,
			env,
			coverageDir: initCoverage,
		});
		strictEqual(initialized.code, 0, `stdout=${initialized.stdout} stderr=${initialized.stderr}`);
	} finally {
		rmSync(initCoverage, { recursive: true, force: true });
	}

	const discovery = await startOpenAICompatFixture("lazy tool discovery complete");
	const configDir = env.CLIO_CODER_CONFIG_DIR;
	ok(configDir, "lazy graph harness requires CLIO_CODER_CONFIG_DIR");
	const baseSettings = readFileSync(join(configDir, "settings.yaml"), "utf8");
	seedOpenAICompatToolOrchestrator(configDir, discovery.url, "full-auto");
	const discoveryCwd = join(input.workRoot, "discovery");
	mkdirSync(discoveryCwd, { recursive: true });
	const discoveryCoverage = mkdtempSync(join(tmpdir(), "clio-lazy-tool-discovery-coverage-"));
	try {
		const result = await runCliWithCoverage({
			bin: input.bin,
			args: ["--no-context-files", "--no-skills", "run", "answer without calling a tool"],
			cwd: discoveryCwd,
			env,
			coverageDir: discoveryCoverage,
		});
		strictEqual(result.code, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
		assertNarrowPiRuntimeGraph(result.files, pi);
		assertProviderAdvertisedAllTools(discovery.requests);
		for (const name of Object.keys(IMPLEMENTATION_MARKERS) as LazyToolName[]) {
			strictEqual(
				includesAny(result.files, implementationFiles[name]),
				false,
				`${name} implementation must remain absent through registration and provider serialization`,
			);
		}
	} finally {
		rmSync(discoveryCoverage, { recursive: true, force: true });
		discovery.server.closeAllConnections();
		await closeServer(discovery.server);
	}

	await invokeTool({
		...input,
		env,
		implementationFiles,
		baseSettings,
		pi,
		name: "context",
		args: { scope: "docs" },
		expectedResult: "Pass query=<terms> to search these bundled docs",
	});
	await invokeTool({
		...input,
		env,
		implementationFiles,
		baseSettings,
		pi,
		name: "verify",
		args: {},
		seedFiles: { "package.json": '{"scripts":{"test":"node --test"}}\n' },
		expectedResult: "Declared verification checks:",
	});
	await invokeTool({
		...input,
		env,
		implementationFiles,
		baseSettings,
		pi,
		name: "code_nav",
		args: { mode: "entries" },
		seedFiles: { "main.ts": "export function lazyCodeNavEntry() { return 1; }\n" },
		expectedResult: "main.ts",
	});

	let webHits = 0;
	const webServer = createServer((_request, response) => {
		webHits += 1;
		response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
		response.end("lazy web_fetch implementation reached localhost fixture");
	});
	await new Promise<void>((resolve) => webServer.listen(0, "127.0.0.1", resolve));
	const address = webServer.address() as AddressInfo;
	try {
		await invokeTool({
			...input,
			env,
			implementationFiles,
			baseSettings,
			pi,
			name: "web_fetch",
			args: { url: `http://127.0.0.1:${address.port}/lazy`, format: "raw" },
			expectedResult: "lazy web_fetch implementation reached localhost fixture",
		});
		strictEqual(webHits, 1, "web_fetch must reach the localhost fixture exactly once");
	} finally {
		webServer.closeAllConnections();
		await closeServer(webServer);
	}
}
