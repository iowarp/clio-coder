#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { DISPATCH_SCENARIOS, findDispatchScenario } from "../benchmarks/battletest/suites/dispatch-scenarios.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FLEET_JSON = join(REPO_ROOT, "benchmarks", "community-benchmarks", "fleet.json");
const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

const FLEET_ENV = {
	orchestrator: {
		target: "CLIO_MAIN_TARGET",
		model: "CLIO_MAIN_MODEL",
		url: "CLIO_MAIN_URL",
		thinking: "CLIO_MAIN_THINKING",
	},
	workers: {
		target: "CLIO_WORKER_TARGET",
		model: "CLIO_WORKER_MODEL",
		url: "CLIO_WORKER_URL",
		thinking: "CLIO_WORKER_THINKING",
	},
};

function usage() {
	const ids = DISPATCH_SCENARIOS.map((scenario) => scenario.id).join(", ");
	return [
		"usage: node --import tsx scripts/battletest-dispatch-harness.mjs <scenario|all> [options]",
		"",
		"Options:",
		"  --profile <name>       Fleet profile from benchmarks/community-benchmarks/fleet.json",
		"  --scratch <path>       Scratch root for isolated CLIO_* dirs and evidence",
		"  --evidence-dir <path>  Evidence output directory",
		"  --list                 List dispatch scenario ids",
		"",
		`Scenarios: ${ids}`,
	].join("\n");
}

function parseArgs(argv) {
	const options = {};
	let scenarioId = null;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			options.help = true;
		} else if (arg === "--list") {
			options.list = true;
		} else if (arg === "--profile") {
			index += 1;
			options.profile = requireValue(argv, index, arg);
		} else if (arg === "--scratch") {
			index += 1;
			options.scratch = requireValue(argv, index, arg);
		} else if (arg === "--evidence-dir") {
			index += 1;
			options.evidenceDir = requireValue(argv, index, arg);
		} else if (arg.startsWith("--")) {
			throw new Error(`unknown option: ${arg}`);
		} else if (scenarioId === null) {
			scenarioId = arg;
		} else {
			throw new Error(`unexpected argument: ${arg}`);
		}
	}
	return { scenarioId, options };
}

function requireValue(argv, index, flag) {
	const value = argv[index];
	if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
	return value;
}

function createScratch(options) {
	const root = options.scratch ? resolve(options.scratch) : mkdtempSync(join(tmpdir(), "clio-battletest-dispatch-"));
	const paths = {
		root,
		homeDir: root,
		configDir: join(root, "config"),
		dataDir: join(root, "data"),
		stateDir: join(root, "state"),
		cacheDir: join(root, "cache"),
		workspaceDir: join(root, "workspace"),
		evidenceDir: options.evidenceDir ? resolve(options.evidenceDir) : join(root, "evidence"),
	};
	for (const dir of Object.values(paths)) mkdirSync(dir, { recursive: true });
	return paths;
}

function installIsolatedEnv(scratch) {
	process.env.CLIO_HOME = scratch.homeDir;
	process.env.CLIO_CONFIG_DIR = scratch.configDir;
	process.env.CLIO_DATA_DIR = scratch.dataDir;
	process.env.CLIO_STATE_DIR = scratch.stateDir;
	process.env.CLIO_CACHE_DIR = scratch.cacheDir;
	process.env.CLIO_REQUIRE_HOME_PREFIX = "1";
	process.env.CLIO_NO_UPDATE_NOTIFIER = "1";
	process.env.CLIO_RIGOR = process.env.CLIO_RIGOR || "high";
}

function loadFleet(profileOverride) {
	const data = JSON.parse(readFileSync(FLEET_JSON, "utf8"));
	const profile = profileOverride || process.env.CLIO_FLEET_PROFILE || data.default;
	const rawProfile = data.profiles?.[profile];
	if (!rawProfile) {
		const available = Object.keys(data.profiles ?? {})
			.sort()
			.join(", ");
		throw new Error(`unknown fleet profile ${profile}; available: ${available}`);
	}
	return {
		profile,
		orchestrator: applyFleetEnv(rawProfile.orchestrator, FLEET_ENV.orchestrator),
		workers: applyFleetEnv(rawProfile.workers, FLEET_ENV.workers),
		autonomy: process.env.CLIO_AUTONOMY || data.autonomy || "full-auto",
		predictionModelName: process.env.CLIO_PRED_MODEL || data.predictionModelName || "clio-coder",
	};
}

function applyFleetEnv(node, envMap) {
	const resolved = {};
	for (const [key, value] of Object.entries(node ?? {})) {
		if (key !== "description") resolved[key] = value;
	}
	for (const [field, envVar] of Object.entries(envMap)) {
		const override = process.env[envVar]?.trim();
		if (override) resolved[field] = override;
	}
	return resolved;
}

async function renderSettings(fleet, scratch) {
	const { DEFAULT_SETTINGS } = await import("../src/core/defaults.js");
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.autonomy = fleet.autonomy;
	settings.targets = targetDescriptors([fleet.orchestrator, fleet.workers]);
	settings.orchestrator = workerTargetSettings(fleet.orchestrator);
	settings.workers.default = workerTargetSettings(fleet.workers);
	settings.workers.profiles = {};
	settings.workers.agentBindings = {};
	const settingsPath = join(scratch.configDir, "settings.yaml");
	writeFileSync(settingsPath, stringify(settings), "utf8");
	return settingsPath;
}

function workerTargetSettings(node) {
	const thinkingLevel = normalizeThinking(node.thinking);
	return {
		target: requireNodeField(node, "target"),
		model: requireNodeField(node, "model"),
		thinkingLevel,
	};
}

function targetDescriptors(nodes) {
	const byId = new Map();
	for (const node of nodes) {
		const id = requireNodeField(node, "target");
		const runtime = requireNodeField(node, "runtime");
		const model = requireNodeField(node, "model");
		const existing = byId.get(id);
		if (existing) {
			if (!existing.wireModels.includes(model)) existing.wireModels.push(model);
			if (!existing.defaultModel) existing.defaultModel = model;
			if (!existing.url && node.url) existing.url = node.url;
			continue;
		}
		const descriptor = {
			id,
			runtime,
			defaultModel: model,
			wireModels: [model],
		};
		if (node.url) descriptor.url = node.url;
		byId.set(id, descriptor);
	}
	return [...byId.values()];
}

function requireNodeField(node, field) {
	const value = node?.[field];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`fleet node is missing ${field}`);
	}
	return value.trim();
}

function normalizeThinking(value) {
	if (typeof value !== "string" || value.trim().length === 0) return "off";
	const trimmed = value.trim();
	if (!VALID_THINKING_LEVELS.has(trimmed)) throw new Error(`invalid thinking level in fleet: ${trimmed}`);
	return trimmed;
}

function resolveScenarioArgs(args, context) {
	return resolveValue(args, context);
}

function resolveValue(value, context) {
	if (Array.isArray(value)) return value.map((item) => resolveValue(item, context));
	if (!isPlainObject(value)) return value;
	if (typeof value.kind === "string") return resolvePlaceholder(value, context);
	const out = {};
	for (const [key, child] of Object.entries(value)) out[key] = resolveValue(child, context);
	return out;
}

function resolvePlaceholder(placeholder, context) {
	if (placeholder.kind === "fleet") {
		return resolveFleetField(context.fleet, placeholder.role, placeholder.field);
	}
	if (placeholder.kind === "envOrFleet") {
		const override = process.env[placeholder.env]?.trim();
		return override || resolveFleetField(context.fleet, placeholder.role, placeholder.field);
	}
	if (placeholder.kind === "scratch") {
		if (placeholder.name === "workspace") return context.scratch.workspaceDir;
		throw new Error(`unknown scratch placeholder: ${placeholder.name}`);
	}
	if (placeholder.kind === "repeat") {
		return String(placeholder.value ?? "").repeat(Number(placeholder.count ?? 0));
	}
	throw new Error(`unknown placeholder kind: ${placeholder.kind}`);
}

function resolveFleetField(fleet, role, field) {
	const node = fleet?.[role];
	if (!node) throw new Error(`unknown fleet role: ${role}`);
	if (field === "thinking") return normalizeThinking(node.thinking);
	return requireNodeField(node, field);
}

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function receiptsDir(scratch) {
	return join(scratch.stateDir, "receipts");
}

function listReceiptPaths(scratch) {
	const dir = receiptsDir(scratch);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => join(dir, name))
		.sort();
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function receiptSummary(path) {
	const json = readJson(path);
	return {
		path,
		json,
		key: {
			runId: json.runId,
			agentId: json.agentId,
			targetId: json.targetId,
			wireModelId: json.wireModelId,
			exitCode: json.exitCode,
			outcome: json.outcome,
			outcomeDetail: json.outcomeDetail,
			pipeline: json.pipeline ?? null,
			personaOverride: json.personaOverride ?? null,
			toolStats: json.toolStats ?? [],
			safety: json.safety ?? null,
		},
	};
}

function orderReceiptPaths(paths, result) {
	const byRunId = new Map(paths.map((path) => [readJson(path).runId, path]));
	const ordered = [];
	const resultRunIds = Array.isArray(result?.details?.runIds) ? result.details.runIds : [];
	for (const runId of resultRunIds) {
		const path = byRunId.get(runId);
		if (!path) continue;
		ordered.push(path);
		byRunId.delete(runId);
	}
	const remaining = [...byRunId.values()].sort((left, right) => receiptSortKey(left) - receiptSortKey(right));
	return [...ordered, ...remaining];
}

function receiptSortKey(path) {
	const json = readJson(path);
	const startedAt = Date.parse(json.startedAt ?? "");
	if (Number.isFinite(startedAt)) return startedAt;
	return statSync(path).mtimeMs;
}

async function loadSourceDispatchTool() {
	const { loadDomains } = await import("../src/core/domain-loader.js");
	const { ConfigDomainModule } = await import("../src/domains/config/index.js");
	const { ExtensionsDomainModule } = await import("../src/domains/extensions/index.js");
	const { createResourcesDomainModule } = await import("../src/domains/resources/index.js");
	const { ShareDomainModule } = await import("../src/domains/share/index.js");
	const { createContextDomainModule } = await import("../src/domains/context/index.js");
	const { ProvidersDomainModule } = await import("../src/domains/providers/index.js");
	const { SafetyDomainModule } = await import("../src/domains/safety/index.js");
	const { createPromptsDomainModule } = await import("../src/domains/prompts/index.js");
	const { AgentsDomainModule } = await import("../src/domains/agents/index.js");
	const { MiddlewareDomainModule } = await import("../src/domains/middleware/index.js");
	const { SessionDomainModule } = await import("../src/domains/session/index.js");
	const { ObservabilityDomainModule } = await import("../src/domains/observability/index.js");
	const { SchedulingDomainModule } = await import("../src/domains/scheduling/index.js");
	const { createDispatchDomainModule } = await import("../src/domains/dispatch/index.js");
	const { ensureClioState, LifecycleDomainModule } = await import("../src/domains/lifecycle/index.js");
	const { createRegistry } = await import("../src/tools/registry.js");
	const { registerAllTools } = await import("../src/tools/bootstrap.js");

	ensureClioState();
	const loaded = await loadDomains([
		ConfigDomainModule,
		ExtensionsDomainModule,
		createResourcesDomainModule({
			noContextFiles: true,
			skills: () => ({ disableDiscovery: true }),
		}),
		ShareDomainModule,
		createContextDomainModule({ noContextFiles: true }),
		ProvidersDomainModule,
		SafetyDomainModule,
		createPromptsDomainModule({ noContextFiles: true }),
		AgentsDomainModule,
		MiddlewareDomainModule,
		SessionDomainModule,
		ObservabilityDomainModule,
		SchedulingDomainModule,
		createDispatchDomainModule(),
		LifecycleDomainModule,
	]);
	const dispatch = loaded.getContract("dispatch");
	const safety = loaded.getContract("safety");
	const middleware = loaded.getContract("middleware");
	if (!dispatch || !safety) throw new Error("dispatch and safety domains must load");
	const registry = createRegistry({
		safety,
		...(middleware ? { middleware } : {}),
		autonomy: () => "full-auto",
	});
	registerAllTools(registry, { dispatch });
	const tool = registry.get("dispatch");
	if (!tool) throw new Error("dispatch tool was not registered");
	return { loaded, dispatch, tool };
}

async function runScenario(scenario, context) {
	const before = new Set(listReceiptPaths(context.scratch));
	const args = resolveScenarioArgs(scenario.args, context);
	let source = null;
	let result = null;
	let thrown = null;
	try {
		source = await loadSourceDispatchTool();
		result = await source.tool.run(args, {});
		await source.dispatch.drain?.();
	} catch (err) {
		thrown = errorJson(err);
	} finally {
		await source?.loaded.stop();
	}
	const newReceiptPaths = orderReceiptPaths(
		listReceiptPaths(context.scratch).filter((path) => !before.has(path)),
		result,
	);
	const receipts = newReceiptPaths.map(receiptSummary);
	const evidence = {
		scenario: scenario.id,
		title: scenario.title,
		tier: scenario.tier,
		retryClass: scenario.retryClass,
		scratch: {
			root: context.scratch.root,
			workspaceDir: context.scratch.workspaceDir,
			stateDir: context.scratch.stateDir,
			evidenceDir: context.scratch.evidenceDir,
		},
		fleet: {
			profile: context.fleet.profile,
			orchestrator: context.fleet.orchestrator,
			workers: context.fleet.workers,
		},
		settingsPath: context.settingsPath,
		args,
		result,
		thrown,
		newReceiptPaths,
		receipts,
		expectations: scenario.expectations,
	};
	const failures = validateEvidence(scenario.expectations, evidence);
	evidence.validation = {
		passed: failures.length === 0,
		failures,
	};
	const outputPath = join(context.scratch.evidenceDir, `${scenario.id}.json`);
	writeFileSync(outputPath, JSON.stringify(evidence, null, 2), "utf8");
	return { evidence, outputPath };
}

function errorJson(err) {
	if (err instanceof Error) {
		return { name: err.name, message: err.message, stack: err.stack };
	}
	return { message: String(err) };
}

function validateEvidence(expectations, evidence) {
	const failures = [];
	for (const expectation of expectations) {
		const failure = validateExpectation(expectation, evidence);
		if (failure) failures.push(failure);
	}
	return failures;
}

function validateExpectation(expectation, evidence) {
	if (expectation.kind === "result-kind") {
		return assertEqual(expectation, evidence.result?.kind, expectation.equals, "result.kind");
	}
	if (expectation.kind === "result-message-includes") {
		return assertIncludes(expectation, evidence.result?.message ?? "", expectation.text, "result.message");
	}
	if (expectation.kind === "result-output-includes") {
		const text = [evidence.result?.output, evidence.result?.message].filter(Boolean).join("\n");
		return assertIncludes(expectation, text, expectation.text, "result text");
	}
	if (expectation.kind === "receipt-count") {
		return assertEqual(expectation, evidence.receipts.length, expectation.equals, "receipt count");
	}
	if (expectation.kind === "receipt-field") {
		const receipt = receiptAt(evidence, expectation.receipt);
		if (!receipt) return `missing receipt ${expectation.receipt} for ${JSON.stringify(expectation)}`;
		const actual = getPath(receipt.json, expectation.path);
		if (expectation.absent === true) {
			return actual === undefined || actual === null
				? null
				: `expected receipt ${expectation.receipt} ${expectation.path.join(".")} to be absent, got ${formatValue(actual)}`;
		}
		if (expectation.present === true) {
			return actual !== undefined && actual !== null
				? null
				: `expected receipt ${expectation.receipt} ${expectation.path.join(".")} to be present`;
		}
		if (Number.isInteger(expectation.equalsReceiptRunId)) {
			const expectedReceipt = receiptAt(evidence, expectation.equalsReceiptRunId);
			const expected = expectedReceipt?.json.runId;
			return assertEqual(expectation, actual, expected, `receipt ${expectation.receipt} ${expectation.path.join(".")}`);
		}
		return assertEqual(
			expectation,
			actual,
			expectation.equals,
			`receipt ${expectation.receipt} ${expectation.path.join(".")}`,
		);
	}
	if (expectation.kind === "receipt-field-min") {
		const receipt = receiptAt(evidence, expectation.receipt);
		if (!receipt) return `missing receipt ${expectation.receipt} for ${JSON.stringify(expectation)}`;
		const actual = getPath(receipt.json, expectation.path);
		return typeof actual === "number" && actual >= expectation.min
			? null
			: `expected receipt ${expectation.receipt} ${expectation.path.join(".")} >= ${expectation.min}, got ${formatValue(actual)}`;
	}
	if (expectation.kind === "no-receipt-task-includes") {
		const matching = evidence.receipts.find((receipt) => String(receipt.json.task ?? "").includes(expectation.text));
		return matching ? `receipt ${matching.json.runId} unexpectedly included task text ${expectation.text}` : null;
	}
	if (expectation.kind === "tool-success-count") {
		const receipt = receiptAt(evidence, expectation.receipt);
		if (!receipt) return `missing receipt ${expectation.receipt} for ${JSON.stringify(expectation)}`;
		const actual = toolSuccessCount(receipt.json, expectation.tool);
		return assertEqual(
			expectation,
			actual,
			expectation.equals,
			`receipt ${expectation.receipt} tool ${expectation.tool} ok`,
		);
	}
	return `unknown expectation kind: ${expectation.kind}`;
}

function receiptAt(evidence, index) {
	return evidence.receipts[index] ?? null;
}

function getPath(value, path) {
	let current = value;
	for (const key of path) {
		if (!isPlainObject(current) && !Array.isArray(current)) return undefined;
		current = current[key];
	}
	return current;
}

function toolSuccessCount(receipt, toolName) {
	const stats = Array.isArray(receipt.toolStats) ? receipt.toolStats : [];
	return stats
		.filter((stat) => stat?.tool === toolName)
		.reduce((total, stat) => total + (Number.isFinite(stat.ok) ? Number(stat.ok) : 0), 0);
}

function assertEqual(_expectation, actual, expected, label) {
	return Object.is(actual, expected)
		? null
		: `expected ${label} to equal ${formatValue(expected)}, got ${formatValue(actual)}`;
}

function assertIncludes(_expectation, actual, expected, label) {
	return actual.includes(expected) ? null : `expected ${label} to include ${formatValue(expected)}`;
}

function formatValue(value) {
	return JSON.stringify(value);
}

async function main() {
	const { scenarioId, options } = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log(usage());
		return 0;
	}
	if (options.list) {
		for (const scenario of DISPATCH_SCENARIOS) console.log(`${scenario.id}\t${scenario.tier}\t${scenario.title}`);
		return 0;
	}
	if (!scenarioId) throw new Error(`missing scenario id\n\n${usage()}`);
	const selected =
		scenarioId === "all"
			? DISPATCH_SCENARIOS
			: [findDispatchScenario(scenarioId)].filter((scenario) => scenario !== null);
	if (selected.length === 0) throw new Error(`unknown scenario: ${scenarioId}\n\n${usage()}`);

	const scratch = createScratch(options);
	installIsolatedEnv(scratch);
	const fleet = loadFleet(options.profile);
	const settingsPath = await renderSettings(fleet, scratch);
	const context = { scratch, fleet, settingsPath };
	let failed = false;
	for (const scenario of selected) {
		const { evidence, outputPath } = await runScenario(scenario, context);
		const status = evidence.validation.passed ? "PASS" : "FAIL";
		console.log(`${status} ${scenario.id} evidence=${outputPath}`);
		if (!evidence.validation.passed) {
			failed = true;
			for (const failure of evidence.validation.failures) console.log(`  - ${failure}`);
		}
	}
	return failed ? 1 : 0;
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((err) => {
		console.error(err instanceof Error ? err.stack : String(err));
		process.exitCode = 1;
	});
