import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { closeServer, seedOpenAICompatToolOrchestrator, startOpenAICompatFixture } from "./openai-compat-fixture.js";
import { emittedJavaScriptContaining, runCliWithCoverage } from "./runtime-module-graph.js";

const IMPLEMENTATION_MARKERS = {
	dispatch: "dispatch: pending gate evidence recovery failed closed",
	monitor: "collect never blocks; timeout_ms is ignored",
	steer: "steer queued for run",
	web_fetch: "web_fetch: binary or unsupported content type",
	verify: "frontend validation:",
	code_nav: "code_nav: no wiki page matches",
	context: "context: scope must be workspace, docs, skills, or recall",
} as const;

const ORCHESTRATOR_RUNNER_SURFACE_MARKERS = {
	dispatch: "// src/tools/dispatch.ts",
	monitor: "// src/tools/monitor-surface.ts",
	steer: "// src/tools/steer-surface.ts",
} as const;

type LazyToolName = keyof typeof IMPLEMENTATION_MARKERS;
type OrchestratorRunnerName = keyof typeof ORCHESTRATOR_RUNNER_SURFACE_MARKERS;

interface LazyImplementationGraph {
	/** Emitted dynamic-import target(s) carrying the implementation provenance. */
	roots: Set<string>;
	/** Every emitted module reached through a static import from roots. */
	closure: Set<string>;
	/** Stable surface/startup modules intentionally shared with discovery. */
	sharedSurface: Set<string>;
	/** The full runner closure after removing the explicitly shared surface closure. */
	exclusive: Set<string>;
}

function staticEmittedImports(path: string): string[] {
	const source = readFileSync(path, "utf8");
	const specifiers = new Set<string>();
	const pattern = /(?:\bfrom\s*|\bimport\s*)["'](\.[^"']+\.js)["']/gu;
	for (const match of source.matchAll(pattern)) {
		const specifier = match[1];
		if (specifier !== undefined) specifiers.add(specifier);
	}
	return [...specifiers]
		.map((specifier) => resolve(dirname(path), specifier))
		.filter((candidate) => existsSync(candidate))
		.map((candidate) => realpathSync(candidate));
}

/** Follow emitted ESM static imports only; dynamic imports are lazy roots of their own. */
function staticEmittedClosure(roots: ReadonlySet<string>): Set<string> {
	const closure = new Set<string>();
	const pending = [...roots];
	while (pending.length > 0) {
		const path = pending.pop();
		if (path === undefined || closure.has(path)) continue;
		closure.add(path);
		for (const imported of staticEmittedImports(path)) {
			if (!closure.has(imported)) pending.push(imported);
		}
	}
	return closure;
}

function difference(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
	return new Set([...left].filter((path) => !right.has(path)));
}

function intersection(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
	return new Set([...left].filter((path) => right.has(path)));
}

function union(...sets: ReadonlyArray<ReadonlySet<string>>): Set<string> {
	return new Set(sets.flatMap((set) => [...set]));
}

function assertFilesAbsent(actual: ReadonlySet<string>, expected: ReadonlySet<string>, message: string): void {
	const eager = [...expected].filter((path) => actual.has(path));
	strictEqual(eager.length, 0, `${message}: ${eager.join(", ")}`);
}

function assertFilesPresent(actual: ReadonlySet<string>, expected: ReadonlySet<string>, message: string): void {
	const missing = [...expected].filter((path) => !actual.has(path));
	strictEqual(missing.length, 0, `${message}: ${missing.join(", ")}`);
}

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
	implementationGraphs: Readonly<Record<LazyToolName, LazyImplementationGraph>>;
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
		const invokedGraph = input.implementationGraphs[input.name];
		ok(
			includesAny(result.files, invokedGraph.roots),
			`${input.name} must evaluate its implementation chunk on first invocation`,
		);
		if (input.name in ORCHESTRATOR_RUNNER_SURFACE_MARKERS) {
			assertFilesPresent(
				result.files,
				invokedGraph.exclusive,
				`${input.name} must evaluate its entire runner-exclusive emitted closure on first invocation`,
			);
		}
		for (const other of Object.keys(IMPLEMENTATION_MARKERS) as LazyToolName[]) {
			if (other === input.name) continue;
			strictEqual(
				includesAny(result.files, input.implementationGraphs[other].roots),
				false,
				`${input.name} must not pull the unrelated ${other} implementation into its runtime graph`,
			);
		}
		ok(fixture.requests.length >= 2, `${input.name} must return its real result to the model`);
		if (input.expectedResult) {
			const providerHistory = JSON.stringify(fixture.requests);
			const toolHistory = fixture.requests.flatMap((request) => {
				const messages = Array.isArray(request.messages) ? request.messages : [];
				return messages.filter(
					(message): message is Record<string, unknown> =>
						typeof message === "object" && message !== null && (message as Record<string, unknown>).role === "tool",
				);
			});
			ok(
				providerHistory.includes(input.expectedResult),
				`${input.name} provider history must contain the implementation result; tool-history=${JSON.stringify(toolHistory)}`,
			);
		}
	} finally {
		rmSync(coverageDir, { recursive: true, force: true });
		fixture.server.closeAllConnections();
		await closeServer(fixture.server);
	}
}

async function assertWorkerGraphExcludesOrchestratorTools(input: {
	packageRoot: string;
	workRoot: string;
	env: NodeJS.ProcessEnv;
	implementationGraphs: Readonly<Record<LazyToolName, LazyImplementationGraph>>;
}): Promise<void> {
	const coverageDir = mkdtempSync(join(tmpdir(), "clio-worker-tool-graph-"));
	try {
		const result = await runCliWithCoverage({
			bin: join(input.packageRoot, "dist", "worker", "entry.js"),
			args: [],
			cwd: input.workRoot,
			env: input.env,
			coverageDir,
			timeoutMs: 10_000,
		});
		strictEqual(result.code, 2, `worker EOF contract changed: stdout=${result.stdout} stderr=${result.stderr}`);
		for (const name of ["dispatch", "monitor", "steer"] as const) {
			assertFilesAbsent(
				result.files,
				input.implementationGraphs[name].roots,
				`worker bootstrap must never evaluate the orchestrator-only ${name} runner root`,
			);
			assertFilesAbsent(
				result.files,
				input.implementationGraphs[name].exclusive,
				`worker bootstrap must never evaluate the orchestrator-only ${name} runner-exclusive closure`,
			);
		}
	} finally {
		rmSync(coverageDir, { recursive: true, force: true });
	}
}

function emittedImplementationGraphs(packageRoot: string): Record<LazyToolName, LazyImplementationGraph> {
	const rootClosures = Object.fromEntries(
		Object.entries(IMPLEMENTATION_MARKERS).map(([name, marker]) => {
			const roots = emittedJavaScriptContaining(packageRoot, marker);
			ok(roots.size > 0, `${name} implementation must be discoverable in emitted JavaScript`);
			return [name, { roots, closure: staticEmittedClosure(roots) }];
		}),
	) as Record<LazyToolName, Pick<LazyImplementationGraph, "roots" | "closure">>;
	const orchestratorSurfaceClosures = Object.fromEntries(
		Object.entries(ORCHESTRATOR_RUNNER_SURFACE_MARKERS).map(([name, marker]) => {
			const surfaceRoots = emittedJavaScriptContaining(packageRoot, marker);
			ok(surfaceRoots.size > 0, `${name} stable surface must be discoverable separately from its runner`);
			const closure = staticEmittedClosure(surfaceRoots);
			assertFilesAbsent(
				closure,
				rootClosures[name as OrchestratorRunnerName].roots,
				`${name} runner root must not become a static dependency of its stable startup surface`,
			);
			return [name, closure];
		}),
	) as Record<OrchestratorRunnerName, Set<string>>;
	// Dispatch-domain startup is intentionally shared by all three surfaces. A
	// worker also shares generic engine/core chunks with these runners. Neither
	// set is runner-exclusive, so classify it explicitly instead of pretending
	// every file reachable from monitor/steer belongs to that lazy tool.
	const orchestratorShared = union(...Object.values(orchestratorSurfaceClosures));
	const workerShared = staticEmittedClosure(new Set([realpathSync(join(packageRoot, "dist", "worker", "entry.js"))]));
	const sharedRuntime = union(orchestratorShared, workerShared);
	const graphs = Object.fromEntries(
		(Object.keys(IMPLEMENTATION_MARKERS) as LazyToolName[]).map((name) => {
			const { roots, closure } = rootClosures[name];
			const sharedSurface =
				name in ORCHESTRATOR_RUNNER_SURFACE_MARKERS ? intersection(closure, orchestratorShared) : new Set<string>();
			const exclusive =
				name in ORCHESTRATOR_RUNNER_SURFACE_MARKERS ? difference(closure, sharedRuntime) : new Set(closure);
			ok(exclusive.size > 0, `${name} must retain a non-empty runner-exclusive emitted closure`);
			assertFilesPresent(exclusive, roots, `${name} runner roots must remain runner-exclusive`);
			return [name, { roots, closure, sharedSurface, exclusive }];
		}),
	) as Record<LazyToolName, LazyImplementationGraph>;
	return graphs;
}

async function assertAdmissionRejectionDoesNotLoadDispatch(input: {
	bin: string;
	workRoot: string;
	env: NodeJS.ProcessEnv;
	baseSettings: string;
	implementationGraphs: Readonly<Record<LazyToolName, LazyImplementationGraph>>;
}): Promise<void> {
	const fixture = await startOpenAICompatFixture("dispatch rejection observed without runner loading", {
		toolCall: { name: "dispatch", arguments: { list: true } },
	});
	const configDir = input.env.CLIO_CODER_CONFIG_DIR;
	ok(configDir, "lazy graph harness requires CLIO_CODER_CONFIG_DIR");
	writeFileSync(join(configDir, "settings.yaml"), input.baseSettings, "utf8");
	seedOpenAICompatToolOrchestrator(configDir, fixture.url, "read-only");
	const cwd = join(input.workRoot, "rejected-dispatch");
	mkdirSync(cwd, { recursive: true });
	const coverageDir = mkdtempSync(join(tmpdir(), "clio-lazy-dispatch-rejected-coverage-"));
	try {
		const result = await runCliWithCoverage({
			bin: input.bin,
			args: ["--no-context-files", "--no-skills", "run", "attempt a dispatch that policy will reject"],
			cwd,
			env: input.env,
			coverageDir,
			timeoutMs: 45_000,
		});
		strictEqual(result.code, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
		assertFilesAbsent(
			result.files,
			input.implementationGraphs.dispatch.exclusive,
			"an admission-known read-only rejection must not evaluate any dispatch runner-exclusive module",
		);
		assertFilesAbsent(
			result.files,
			input.implementationGraphs.dispatch.roots,
			"an admission-known read-only rejection must not evaluate the dispatch runner root",
		);
		const history = JSON.stringify(fixture.requests);
		ok(history.includes("autonomy level is read-only"), "the provider must observe the real admission rejection");
		ok(fixture.requests.length >= 2, "the rejected tool result must return to the model");
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
	const implementationGraphs = emittedImplementationGraphs(input.packageRoot);
	await assertWorkerGraphExcludesOrchestratorTools({
		packageRoot: input.packageRoot,
		workRoot: input.workRoot,
		env,
		implementationGraphs,
	});

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
				includesAny(result.files, implementationGraphs[name].roots),
				false,
				`${name} implementation must remain absent through registration and provider serialization`,
			);
			if (name in ORCHESTRATOR_RUNNER_SURFACE_MARKERS) {
				assertFilesPresent(
					result.files,
					implementationGraphs[name].sharedSurface,
					`${name} shared dispatch/surface startup closure must remain distinguishable and evaluated`,
				);
				assertFilesAbsent(
					result.files,
					implementationGraphs[name].exclusive,
					`${name} entire runner-exclusive emitted closure must remain absent through discovery`,
				);
			}
		}
	} finally {
		rmSync(discoveryCoverage, { recursive: true, force: true });
		discovery.server.closeAllConnections();
		await closeServer(discovery.server);
	}

	await assertAdmissionRejectionDoesNotLoadDispatch({
		bin: input.bin,
		workRoot: input.workRoot,
		env,
		baseSettings,
		implementationGraphs,
	});

	await invokeTool({
		...input,
		env,
		implementationGraphs,
		baseSettings,
		pi,
		name: "dispatch",
		args: { list: true },
		expectedResult: "Clio manages a small fleet of coding agents.",
	});
	await invokeTool({
		...input,
		env,
		implementationGraphs,
		baseSettings,
		pi,
		name: "monitor",
		args: { mode: "list" },
		expectedResult: "dispatched runs (",
	});
	await invokeTool({
		...input,
		env,
		implementationGraphs,
		baseSettings,
		pi,
		name: "steer",
		args: { run_id: "missing-lazy-run", action: "cancel" },
		expectedResult: "unknown run or assignment",
	});
	await invokeTool({
		...input,
		env,
		implementationGraphs,
		baseSettings,
		pi,
		name: "context",
		args: { scope: "docs" },
		expectedResult: "Pass query=<terms> to search these bundled docs",
	});
	await invokeTool({
		...input,
		env,
		implementationGraphs,
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
		implementationGraphs,
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
			implementationGraphs,
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
