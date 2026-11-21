import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { stringify as stringifyYaml } from "yaml";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { explicitToolCapability, targetToolCapability } from "../../src/domains/dispatch/extension.js";
import {
	MODEL_CATALOG_DIRS_ENV,
	resolveModelCatalogOverlayRoots,
} from "../../src/domains/providers/catalog-overlays.js";
import type { ProvidersContract, TargetStatus } from "../../src/domains/providers/contract.js";
import {
	compareConfiguredModelProfiles,
	loadModelProfiles,
	type ModelProfile,
} from "../../src/domains/providers/model-profiles.js";
import { createProfileKnowledgeBase } from "../../src/domains/providers/profile-knowledge.js";
import { resolveRuntimeTarget } from "../../src/domains/providers/runtime-resolution.js";
import {
	lmStudioNativeReasoningLevels,
	lmStudioReasoningEffort,
} from "../../src/domains/providers/runtimes/common/lmstudio-http.js";
import litellmRuntime from "../../src/domains/providers/runtimes/protocol/litellm.js";
import { extractLocalModelQuirks } from "../../src/domains/providers/types/local-model-quirks.js";
import {
	remainingContextMaxTokens,
	resolveReservedOutputTokens,
	setGlobalDefaultMaxOutputTokens,
} from "../../src/engine/apis/output-budget.js";
import { packagedModelCatalog } from "../harness/packaged-model-catalog.js";

it("the packaged profiles and their substring fallback tier agree on upstream local models", () => {
	const root = mkdtempSync(join(tmpdir(), "clio-model-profiles-"));
	try {
		const profiles = loadModelProfiles({ userPath: join(root, "absent.yaml") });
		const catalog = packagedModelCatalog();
		const legacy = { lookup: (modelId: string) => catalog.fallbackLookup(modelId) };
		const patterns = (entry: ModelProfile) => [...(entry.match.exactIds ?? []), ...(entry.match.familyPrefixes ?? [])];
		for (const entry of profiles.entries()) {
			for (const alias of patterns(entry)) {
				strictEqual(profiles.lookup(alias, "llamacpp")?.profile.id, legacy.lookup(alias)?.entry.family, alias);
			}
		}
		const allCurated = structuredClone(DEFAULT_SETTINGS);
		allCurated.targets = profiles.entries().map((entry, index) => ({
			id: `curated-${index}`,
			runtime: "llamacpp",
			defaultModel: patterns(entry)[0] ?? entry.id,
		}));
		for (const row of compareConfiguredModelProfiles(allCurated, profiles, legacy)) {
			strictEqual(row.profileId, row.fallbackFamily, row.modelId ?? "(unset)");
			deepStrictEqual(row.differentFields, [], row.modelId ?? "(unset)");
		}
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.targets = [
			{ id: "blade", runtime: "litellm", defaultModel: "local/qwen3.8-27b-q6_k" },
			{ id: "cloud", runtime: "openai-codex", defaultModel: "gpt-6-sol" },
			{ id: "unset", runtime: "llamacpp" },
		];
		settings.chat.target = "blade";
		settings.chat.model = "dynamo/nvidia-nemotron-3.5-lightning-30b-a3b";
		settings.fleet.default.target = "blade";
		settings.fleet.default.model = "local/gemma-4-26b-a4b-it-q4_k_m";
		settings.fleet.profiles.worker = { target: "cloud", model: "gpt-6-luna", thinkingLevel: "low" };
		const comparison = compareConfiguredModelProfiles(settings, profiles, legacy);
		deepStrictEqual(
			comparison.map((row) => [row.targetId, row.profileId, row.differentFields]),
			[
				["blade", "qwen3.8-27b", []],
				["blade", "nemotron-3.5-lightning-30b-a3b", []],
				["blade", "gemma4-26b-a4b", []],
				["cloud", null, []],
				["cloud", null, []],
				["unset", null, []],
			],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("matches exact ids, anchored family prefixes, and runtime-qualified ties with field-level overrides", () => {
	const root = mkdtempSync(join(tmpdir(), "clio-model-profiles-"));
	const packagedPath = join(root, "packaged.yaml");
	const userPath = join(root, "user.yaml");
	const general = {
		id: "general",
		match: { familyPrefixes: ["foo"] },
		claims: { capabilities: { tools: true, vision: false } },
	};
	const specific = { id: "specific", match: { familyPrefixes: ["foo-v2"] }, claims: {} };
	const exact = { id: "exact", match: { exactIds: ["vendor/foo-v2"] }, claims: {} };
	const runtime = {
		id: "runtime",
		match: { exactIds: ["vendor/foo-v2"], runtimeIds: ["llamacpp"] },
		claims: {},
	};
	try {
		writeFileSync(packagedPath, stringifyYaml({ version: 1, models: [general, specific, exact, runtime] }));
		writeFileSync(
			userPath,
			stringifyYaml({ version: 1, models: [{ id: "general", claims: { capabilities: { vision: true } } }] }),
		);
		const profiles = loadModelProfiles({ packagedPath, userPath });
		strictEqual(profiles.lookup("vendor/foo-v2", "llamacpp")?.profile.id, "runtime");
		strictEqual(profiles.lookup("vendor/foo-v2", "lmstudio")?.profile.id, "exact");
		strictEqual(profiles.lookup("vendor/foo-v2-q4", "lmstudio")?.profile.id, "specific");
		strictEqual(profiles.lookup("vendor/foo-q4", "lmstudio")?.profile.id, "general");
		strictEqual(profiles.lookup("vendor/myfoo-q4", "lmstudio"), null);
		deepStrictEqual(profiles.lookup("foo", "lmstudio")?.profile.claims.capabilities, { tools: true, vision: true });
		writeFileSync(packagedPath, stringifyYaml({ version: 1, models: [general, { ...specific, match: general.match }] }));
		throws(() => loadModelProfiles({ packagedPath, userPath }), /ambiguous model profile/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

const NEMOTRON = "dynamo/nvidia-nemotron-3.5-lightning-30b-a3b";

function nemotronProviders(live?: Partial<TargetStatus>): ProvidersContract {
	const target = { id: "blade", runtime: "litellm", url: "http://blade.invalid:4000", defaultModel: NEMOTRON };
	const status: TargetStatus = {
		target,
		runtime: litellmRuntime,
		available: true,
		reason: "ready",
		health: { status: "healthy", lastCheckAt: "2026-01-01T00:00:00.000Z", lastError: null, latencyMs: 1 },
		capabilities: litellmRuntime.defaultCapabilities,
		probeCapabilities: null,
		probeModelCapabilities: null,
		probeModelId: null,
		discoveredModels: [NEMOTRON],
		...live,
	};
	return {
		getTarget: () => target,
		getRuntime: () => litellmRuntime,
		getDetectedReasoning: () => null,
		list: () => (live ? [status] : []),
		knowledgeBase: packagedModelCatalog(),
	} as unknown as ProvidersContract;
}

it("a profile's recommended output tokens fill an unset budget and yield to explicit values and live caps", () => {
	const profiles = loadModelProfiles({ userPath: join(tmpdir(), "clio-absent-profiles.yaml") });
	const profile = profiles.entries().find((entry) => typeof entry.recommendations?.outputTokens === "number");
	if (!profile) throw new Error("no packaged profile recommends output tokens");
	const recommended = profile.recommendations?.outputTokens as number;
	const kb = packagedModelCatalog();
	const alias = profile.match.exactIds?.[0];
	if (!alias) throw new Error("profile has no exact id");
	const quirks = extractLocalModelQuirks(kb.lookup(alias, "llamacpp")?.entry.quirks);
	strictEqual(quirks?.outputTokens, recommended);
	const model = { contextWindow: 10_000_000, maxTokens: 0, clioCoder: { quirks } };
	const context = { messages: [] };
	setGlobalDefaultMaxOutputTokens(0);
	try {
		strictEqual(remainingContextMaxTokens(model, context, undefined), recommended, "fills an unset budget");
		strictEqual(remainingContextMaxTokens(model, context, { maxTokens: 111 }), 111, "a request value wins");
		setGlobalDefaultMaxOutputTokens(333);
		strictEqual(remainingContextMaxTokens(model, context, undefined), 333, "chat.maxOutputTokens wins");
		setGlobalDefaultMaxOutputTokens(0);
		strictEqual(
			remainingContextMaxTokens({ ...model, maxTokens: 1_000 }, context, undefined),
			1_000,
			"a live cap clamps it",
		);
		strictEqual(
			remainingContextMaxTokens({ ...model, contextWindow: 5_000 }, context, undefined) < 5_000,
			true,
			"the remaining window clamps it",
		);
		strictEqual(resolveReservedOutputTokens(0, undefined, recommended), recommended);
	} finally {
		setGlobalDefaultMaxOutputTokens(0);
	}
});

it("resolves a model from its profile only where the server is silent, and never promotes a model maximum", () => {
	const silent = resolveRuntimeTarget(nemotronProviders(), {
		targetId: "blade",
		wireModelId: NEMOTRON,
		requestedThinkingLevel: "low",
	});
	strictEqual(silent.ok, true);
	if (!silent.ok) return;
	const window = silent.target.contextWindowDetails;
	strictEqual(window.modelMaximum.value, 1_048_576);
	strictEqual(window.modelMaximum.kind, "model-maximum");
	strictEqual(window.servingLimit.value, null);
	// The model card publishes a context maximum, not an independent output cap.
	strictEqual(silent.target.maxOutputTokensField.value, null);
	strictEqual(silent.target.capabilities.tools, true);
	strictEqual(silent.target.modelRuntime.thinking.mechanism, "on-off");
	strictEqual(silent.target.modelRuntime.thinking.display, "on");

	const reported = resolveRuntimeTarget(
		nemotronProviders({
			probeModelCapabilities: {
				[NEMOTRON]: { contextWindow: 131_072, tools: false, reasoning: true, reasoningLevels: ["off", "low"] },
			},
			probeModelId: NEMOTRON,
		}),
		{ targetId: "blade", wireModelId: NEMOTRON, requestedThinkingLevel: "medium" },
	);
	strictEqual(reported.ok, true);
	if (!reported.ok) return;
	strictEqual(reported.target.contextWindowDetails.servingLimit.value, 131_072);
	strictEqual(reported.target.contextWindowDetails.modelMaximum.value, 1_048_576);
	strictEqual(reported.target.capabilities.tools, false);
	deepStrictEqual([...reported.target.modelRuntime.thinking.supportedLevels], ["off", "low"]);

	const noReasoning = resolveRuntimeTarget(
		nemotronProviders({ probeModelCapabilities: { [NEMOTRON]: { reasoning: false } }, probeModelId: NEMOTRON }),
		{ targetId: "blade", wireModelId: NEMOTRON, requestedThinkingLevel: "low" },
	);
	strictEqual(noReasoning.ok, true);
	if (!noReasoning.ok) return;
	strictEqual(noReasoning.target.capabilities.reasoning, false);
	strictEqual(noReasoning.target.modelRuntime.thinking.mechanism, "none");
	deepStrictEqual([...noReasoning.target.modelRuntime.thinking.supportedLevels], ["off"]);

	deepStrictEqual(lmStudioNativeReasoningLevels(["off", "on"]), ["off", "low"]);
	deepStrictEqual(lmStudioNativeReasoningLevels(["off", "low", "medium", "high"]), ["off", "low", "medium", "high"]);
});

it("sends the resolved effort a template accepts, never a rounded-down one", () => {
	const strict = ["off", "low", "medium", "xhigh"];
	deepStrictEqual(
		(["low", "medium", "high", "xhigh", "max"] as const).map((level) => lmStudioReasoningEffort(level, strict)),
		["low", "medium", "xhigh", "xhigh", "xhigh"],
	);
	strictEqual(lmStudioReasoningEffort("xhigh", ["low", "medium", "high"]), "high");
	strictEqual(lmStudioReasoningEffort("high", undefined), "high");
	strictEqual(lmStudioReasoningEffort("off", strict), "none");
	strictEqual(lmStudioReasoningEffort("low", ["off", "on"]), undefined);
});

it("drives the upstream Qwen3.8 template with the three efforts it accepts", () => {
	const kb = packagedModelCatalog();
	for (const [model, profile] of [
		["local/qwen3.8-27b-q4_k_m", "qwen3.8-27b"],
		["local/qwen3.8-27b-q6_k", "qwen3.8-27b"],
	] as const) {
		strictEqual(kb.lookup(model, "litellm")?.entry.family, profile, model);
		const thinking = extractLocalModelQuirks(kb.lookup(model, "litellm")?.entry.quirks)?.thinking;
		strictEqual(thinking?.mechanism, "effort-levels", model);
		deepStrictEqual(thinking?.effortByLevel, { low: "low", medium: "medium", xhigh: "xhigh" }, model);
	}
});

it("loads model-catalog.d overlays from the config, project and env dirs in that order, after the packaged tier", () => {
	const root = mkdtempSync(join(tmpdir(), "clio-model-catalog-d-"));
	const config = join(root, "config");
	const project = join(root, "project");
	const envDir = join(root, "env");
	const userDir = join(config, "model-catalog.d");
	const projectDir = join(project, ".clio-coder", "model-catalog.d");
	const saved = { config: process.env.CLIO_CODER_CONFIG_DIR, dirs: process.env[MODEL_CATALOG_DIRS_ENV] };
	const entry = (family: string, pattern: string, temperature: number) =>
		`- family: ${family}\n  matchPatterns: [${pattern}]\n  capabilities: { tools: false }\n  quirks: { thinking: { mechanism: none }, sampling: { instruct: { temperature: ${temperature} } } }\n`;
	try {
		for (const dir of [join(userDir, "nested"), projectDir, envDir]) mkdirSync(dir, { recursive: true });
		writeFileSync(join(userDir, "a.yaml"), entry("acme-coder", "acme-coder", 0.2));
		writeFileSync(join(userDir, "nested", "b.yml"), entry("zeta-lm", "zeta-lm", 0.9));
		// Ties on pattern length go to the later root: project beats packaged, env beats user.
		writeFileSync(join(projectDir, "p.yaml"), entry("gpt-oss-house", "gpt-oss-20b", 0.42));
		writeFileSync(join(envDir, "e.yaml"), entry("acme-coder", "acme-coder", 0.77));
		writeFileSync(
			join(config, "model-profiles.yaml"),
			stringifyYaml({ version: 1, models: [{ id: "acme-coder", match: { familyPrefixes: ["acme-coder"] }, claims: {} }] }),
		);
		process.env.CLIO_CODER_CONFIG_DIR = config;
		process.env[MODEL_CATALOG_DIRS_ENV] = envDir;
		const overlayRoots = resolveModelCatalogOverlayRoots({ cwd: project });
		deepStrictEqual(
			overlayRoots.map((overlay) => overlay.dir),
			[userDir, projectDir, envDir],
		);
		const kb = createProfileKnowledgeBase({ overlayRoots, userPath: join(config, "model-profiles.yaml") });
		const at = (id: string) => {
			const hit = kb.lookup(id, "llamacpp");
			return hit && [hit.matchKind, hit.entry.family, hit.entry.capabilities, hit.entry.quirks];
		};
		const sampler = (temperature: number) => ({ sampling: { instruct: { temperature } } });
		deepStrictEqual(at("acme-coder-7b"), ["family", "acme-coder", {}, sampler(0.77)], "user profile, env sampler");
		deepStrictEqual(at("vendor/zeta-lm-1b"), ["family", "zeta-lm", {}, sampler(0.9)], "nested user overlay file");
		deepStrictEqual(at("unsloth/my-gpt-oss-20b-q4"), ["alias", "gpt-oss-house", {}, sampler(0.42)], "project overlay");
		deepStrictEqual(at("vendor/my-llama-4-scout"), ["alias", "meta-llama-4-scout", {}, undefined], "packaged tier");
	} finally {
		if (saved.config === undefined) delete process.env.CLIO_CODER_CONFIG_DIR;
		else process.env.CLIO_CODER_CONFIG_DIR = saved.config;
		if (saved.dirs === undefined) delete process.env[MODEL_CATALOG_DIRS_ENV];
		else process.env[MODEL_CATALOG_DIRS_ENV] = saved.dirs;
		rmSync(root, { recursive: true, force: true });
	}
});

it("a malformed model-catalog.d file is skipped and named, and the overlays beside it still merge", () => {
	const root = mkdtempSync(join(tmpdir(), "clio-model-catalog-bad-"));
	try {
		const dir = join(root, "model-catalog.d");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "10-good.yaml"),
			"- family: acme-coder\n  matchPatterns: [acme-coder]\n  capabilities: {}\n  quirks: { sampling: { instruct: { temperature: 0.42 } } }\n",
		);
		writeFileSync(join(dir, "20-bad.yaml"), "- family: broken\n  matchPatterns: acme\n");
		const errors: string[] = [];
		const kb = createProfileKnowledgeBase({
			overlayRoots: [{ dir, label: "overlay" }],
			userPath: join(root, "absent.yaml"),
			onError: (message) => errors.push(message),
		});
		deepStrictEqual(kb.lookup("acme-coder-7b")?.entry.quirks, { sampling: { instruct: { temperature: 0.42 } } });
		strictEqual(errors.length, 1, errors.join("\n"));
		ok(errors[0]?.includes("20-bad.yaml") && errors[0].includes("matchPatterns"), errors[0]);
		ok(!errors[0]?.includes("10-good.yaml"), errors[0]);
		// A reload rereads the files; the bad one is skipped again instead of throwing.
		kb.reload();
		deepStrictEqual(kb.lookup("acme-coder-7b")?.entry.quirks, { sampling: { instruct: { temperature: 0.42 } } });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("an unprofiled route keeps tools on until a report or a profile says otherwise", () => {
	const model = "acme/unprofiled-9b";
	const tools = (live?: Partial<TargetStatus>) => {
		const resolved = resolveRuntimeTarget(nemotronProviders({ discoveredModels: [model], ...live }), {
			targetId: "blade",
			wireModelId: model,
			requestedThinkingLevel: "off",
		});
		strictEqual(resolved.ok, true);
		return resolved.ok ? resolved.target.capabilities.tools : null;
	};
	strictEqual(tools(), true, "no report at all, as after a failed first probe");
	strictEqual(tools({ probeModelCapabilities: { [model]: { tools: false } }, probeModelId: model }), false);
});

it("dispatch applies the live tool report before the runtime default, and a lowering override on top", () => {
	const kb = { lookup: () => null } as unknown as ProvidersContract;
	const status = (tools?: boolean) =>
		({
			target: { id: "t", runtime: "llamacpp", defaultModel: "m" },
			probeModelCapabilities: tools === undefined ? {} : { m: { tools } },
			probeModelId: "m",
		}) as unknown as TargetStatus;
	const runtime = { defaultCapabilities: { tools: true }, apiFamily: "openai-completions" } as never;
	const capability = (live: boolean | undefined, operator?: boolean) => {
		const target = {
			id: "t",
			runtime: "llamacpp",
			capabilities: operator === undefined ? undefined : { tools: operator },
		};
		const explicit = explicitToolCapability(kb, target as never, "m", status(live));
		return targetToolCapability({ toolsCapabilityExplicit: explicit, modelCapabilities: null, runtime });
	};
	strictEqual(capability(false), false, "a reported false beats the runtime default of true");
	strictEqual(capability(false, true), false, "an operator true never raises a reported false");
	strictEqual(capability(true, false), false, "an operator false lowers a reported true");
	strictEqual(capability(undefined), true, "the runtime default applies only when the server is silent");
	strictEqual(capability(undefined, false), false, "an operator false stands where the server is silent");
});

it("a bad field in the user profile file costs that field, with a warning naming the file and entry", () => {
	const root = mkdtempSync(join(tmpdir(), "clio-model-profiles-"));
	const packagedPath = join(root, "packaged.yaml");
	const userPath = join(root, "user.yaml");
	const base = {
		id: "base",
		match: { familyPrefixes: ["foo"] },
		claims: { capabilities: { tools: true, reasoning: true } },
	};
	try {
		writeFileSync(packagedPath, stringifyYaml({ version: 1, models: [base] }));
		writeFileSync(
			userPath,
			stringifyYaml({
				version: 1,
				models: [
					{
						id: "base",
						claims: {
							modelMaxContext: "big",
							capabilities: { reasoningLevels: 7, contextWindow: 4096, tools: "yes", vision: false },
						},
					},
					{ id: "second", match: { familyPrefixes: 3 } },
				],
			}),
		);
		const warnings: string[] = [];
		const profiles = loadModelProfiles({ packagedPath, userPath, onWarning: (message) => warnings.push(message) });
		deepStrictEqual(profiles.lookup("foo-1", "llamacpp")?.profile.claims, {
			capabilities: { tools: true, reasoning: true, vision: false },
		});
		for (const field of ["reasoningLevels", "contextWindow", "capabilities.tools", "modelMaxContext"]) {
			strictEqual(
				warnings.some((message) => message.includes(userPath) && message.includes("'base'") && message.includes(field)),
				true,
				field,
			);
		}
		strictEqual(
			warnings.some(
				(message) => message.includes(userPath) && message.includes("'second'") && message.includes("skipped"),
			),
			true,
		);
		writeFileSync(
			packagedPath,
			stringifyYaml({ version: 1, models: [{ ...base, claims: { capabilities: { reasoningLevels: ["off"] } } }] }),
		);
		throws(() => loadModelProfiles({ packagedPath, userPath: join(root, "absent.yaml") }), /live server report/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("a __proto__ key in the user profile file merges nothing and leaves the profile's prototype alone", () => {
	const root = mkdtempSync(join(tmpdir(), "clio-model-profiles-"));
	const packagedPath = join(root, "packaged.yaml");
	const userPath = join(root, "user.yaml");
	try {
		writeFileSync(
			packagedPath,
			stringifyYaml({
				version: 1,
				models: [
					{ id: "base", match: { familyPrefixes: ["foo"] }, claims: { capabilities: { tools: true } }, behavior: { a: 1 } },
				],
			}),
		);
		// stringifyYaml would drop an inherited key, so the file is written by hand.
		writeFileSync(
			userPath,
			["version: 1", "models:", "  - id: base", "    behavior:", "      __proto__: { planted: true }", ""].join("\n"),
		);
		const behavior = loadModelProfiles({ packagedPath, userPath }).lookup("foo-1", "llamacpp")?.profile.behavior;
		deepStrictEqual(behavior, { a: 1 });
		strictEqual(Object.getPrototypeOf(behavior), Object.prototype);
		strictEqual("planted" in (behavior ?? {}), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
