import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { resetXdgCache } from "../../src/core/xdg.js";
import type { TargetStatus } from "../../src/domains/providers/contract.js";
import {
	MODEL_CATALOG_DIRS_ENV,
	MODEL_CATALOG_OVERLAY_DIR,
	resolveProviderModelCatalogDirs,
} from "../../src/domains/providers/knowledge-base-path.js";
import { resolveModelCapabilities } from "../../src/domains/providers/model-capabilities.js";
import { type CapabilityFlags, EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import { FileKnowledgeBase } from "../../src/domains/providers/types/knowledge-base.js";
import type { LocalModelQuirks } from "../../src/domains/providers/types/local-model-quirks.js";

function scratchDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function writeCatalog(dir: string, name: string, yaml: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, name), yaml, "utf8");
}

const LOCAL_BASE_CAPABILITIES: CapabilityFlags = {
	...EMPTY_CAPABILITIES,
	chat: true,
	tools: true,
	toolCallFormat: "openai",
	contextWindow: 8192,
	maxTokens: 4096,
};

function localStatus(modelId: string, probeCapabilities?: Partial<CapabilityFlags>): TargetStatus {
	return {
		target: { id: "mini", runtime: "llamacpp", defaultModel: modelId },
		runtime: {
			id: "llamacpp",
			displayName: "llama.cpp",
			kind: "http",
			tier: "local-native",
			apiFamily: "openai-completions",
			auth: "api-key",
			defaultCapabilities: LOCAL_BASE_CAPABILITIES,
			synthesizeModel: () => {
				throw new Error("not used");
			},
		},
		available: true,
		reason: "test",
		health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
		capabilities: LOCAL_BASE_CAPABILITIES,
		probeCapabilities: probeCapabilities ?? null,
		probeModelCapabilities: probeCapabilities ? { [modelId]: probeCapabilities } : undefined,
		probeModelId: modelId,
		discoveredModels: [modelId],
	} as TargetStatus;
}

describe("contracts/model knowledge base", () => {
	it("loads ordered catalog roots and lets overlays win equally specific matches", () => {
		const root = scratchDir("clio-kb-");
		try {
			const bundled = join(root, "bundled");
			const overlay = join(root, "overlay");
			writeCatalog(
				bundled,
				"models.yaml",
				`
- family: bundled-family
  matchPatterns:
    - lab-model
  capabilities:
    contextWindow: 8192
- family: bundled-specific-family
  matchPatterns:
    - lab-model-special
  capabilities:
    contextWindow: 131072
`,
			);
			writeCatalog(
				overlay,
				"models.yaml",
				`
- family: overlay-family
  matchPatterns:
    - lab-model
  capabilities:
    contextWindow: 262144
`,
			);

			const kb = new FileKnowledgeBase([
				{ dir: bundled, label: "bundled" },
				{ dir: overlay, label: "overlay" },
			]);

			const broad = kb.lookup("my-lab-model");
			strictEqual(broad?.entry.family, "overlay-family");
			strictEqual(broad?.entry.capabilities.contextWindow, 262144);

			const specific = kb.lookup("my-lab-model-special");
			strictEqual(specific?.entry.family, "bundled-specific-family");
			strictEqual(specific?.entry.capabilities.contextWindow, 131072);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("resolves bundled, user, project, and env catalog roots in precedence order", () => {
		const root = scratchDir("clio-kb-paths-");
		const previousConfig = process.env.CLIO_CONFIG_DIR;
		const previousCatalogDirs = process.env[MODEL_CATALOG_DIRS_ENV];
		try {
			const configDir = join(root, "config");
			const projectDir = join(root, "project");
			const envDirA = join(root, "env-a");
			const envDirB = join(root, "env-b");
			const userCatalog = join(configDir, MODEL_CATALOG_OVERLAY_DIR);
			const projectCatalog = join(projectDir, ".clio", MODEL_CATALOG_OVERLAY_DIR);
			for (const dir of [userCatalog, projectCatalog, envDirA, envDirB]) {
				mkdirSync(dir, { recursive: true });
			}

			process.env.CLIO_CONFIG_DIR = configDir;
			process.env[MODEL_CATALOG_DIRS_ENV] = [envDirA, envDirB].join(delimiter);
			resetXdgCache();

			const dirs = resolveProviderModelCatalogDirs(import.meta.url, { cwd: projectDir });

			ok(dirs.bundled?.endsWith(join("src", "domains", "providers", "models")));
			deepStrictEqual(dirs.overlays, [userCatalog, projectCatalog, envDirA, envDirB]);
			deepStrictEqual(dirs.all, [dirs.bundled, userCatalog, projectCatalog, envDirA, envDirB]);
		} finally {
			if (previousConfig === undefined) delete process.env.CLIO_CONFIG_DIR;
			else process.env.CLIO_CONFIG_DIR = previousConfig;
			if (previousCatalogDirs === undefined) delete process.env[MODEL_CATALOG_DIRS_ENV];
			else process.env[MODEL_CATALOG_DIRS_ENV] = previousCatalogDirs;
			resetXdgCache();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("resolves mini's local-model ids against the bundled catalog with longest-substring specificity", () => {
		// Load the real bundled catalog exactly as production does (the whole
		// models dir, both local- and cloud-model files), so these assertions
		// pin the shipped matchPattern specificity, not a scratch fixture.
		const bundled = join(dirname(fileURLToPath(import.meta.url)), "../../src/domains/providers/models");
		const kb = new FileKnowledgeBase([{ dir: bundled, label: "bundled" }]);

		// The qat/UD-Q4_K_XL/MTP build must resolve to its own 262K family, not
		// to the NVFP4 turbo family whose broader `gemma-4-31b-it` (14 chars)
		// pattern also matches this id but is shorter than the qat patterns.
		const qat = kb.lookup("Gemma-4-31B-it-qat-UD-Q4_K_XL-MTP-262K");
		strictEqual(qat?.entry.family, "gemma-4-31b-it-qat-mtp");
		strictEqual(qat?.entry.capabilities.contextWindow, 262144);

		// Regression guard: the NVFP4 turbo id keeps its 122880-context family;
		// the new qat family must not steal it.
		const nvfp4 = kb.lookup("gemma-4-31b-it-nvfp4-turbo");
		strictEqual(nvfp4?.entry.family, "gemma-4-31b-it-nvfp4-turbo");
		strictEqual(nvfp4?.entry.capabilities.contextWindow, 122880);

		// The locked mini orchestrator (hero) resolves to its own coder family.
		const hero = kb.lookup("Qwopus3.6-35B-A3B-Coder-MTP-Q4_K_M-262K");
		strictEqual(hero?.entry.family, "qwopus3.6-35b-a3b-coder");
		strictEqual(hero?.entry.capabilities.contextWindow, 262144);

		// The qat family's `gemma-4-31b-it-qat` patterns are not substrings of
		// the 12B or 26B ids, so those must not be captured by it.
		strictEqual(kb.lookup("Gemma-4-12B-it-UD-Q4_K_XL-262K")?.entry.family !== "gemma-4-31b-it-qat-mtp", true);
		strictEqual(kb.lookup("Gemma-4-26B-A4B-it-Q4_K_M-262K")?.entry.family, "gemma4-26b-a4b");
	});

	it("pins reasoning classes for the blessed local families as catalog data", () => {
		const bundled = join(dirname(fileURLToPath(import.meta.url)), "../../src/domains/providers/models");
		const kb = new FileKnowledgeBase([{ dir: bundled, label: "bundled" }]);

		// Coder-MTP variants are reasoning class "never": reasoning=false so no
		// per-request path (pi-ai qwen-chat-template kwargs included) can flip
		// enable_thinking back on over the server's launch default, and the
		// thinking mechanism is none so the dial clamps to off.
		for (const [wireId, family] of [
			["Qwopus3.6-35B-A3B-Coder-MTP-Q4_K_M-262K", "qwopus3.6-35b-a3b-coder"],
			["Qwopus3.6-27B-Coder-MTP-Q5_K_M-262K", "qwopus3.6-27b-coder"],
			["Qwopus3.5-9B-Coder-Q8_0-262K", "qwopus3.5-9b-coder"],
		] as const) {
			const hit = kb.lookup(wireId);
			strictEqual(hit?.entry.family, family, `${wireId} family`);
			strictEqual(hit?.entry.capabilities.reasoning, false, `${wireId} reasoning`);
			const quirks = hit?.entry.quirks as LocalModelQuirks | undefined;
			strictEqual(quirks?.thinking?.mechanism, "none", `${wireId} mechanism`);
		}

		// Qwopus Coder-MTP families ship the upstream non-thinking sampler
		// defaults including presence penalty 1.5: measured on live dispatch,
		// without it a coder worker repeated one identical code_nav call into
		// the loop-guard abort on 3 of 3 runs; with it the same task passed
		// 3 of 3 with edit-then-validate trajectories.
		for (const wireId of ["Qwopus3.6-35B-A3B-Coder-MTP-Q4_K_M-262K", "Qwopus3.6-27B-Coder-MTP-Q5_K_M-262K"] as const) {
			const quirks = kb.lookup(wireId)?.entry.quirks as LocalModelQuirks | undefined;
			strictEqual(quirks?.sampling?.instruct?.presencePenalty, 1.5, `${wireId} presencePenalty`);
			strictEqual(quirks?.sampling?.instruct?.repeatPenalty, 1.05, `${wireId} repeatPenalty`);
		}

		// The 27B Coder-MTP id must not fall through to the reasoning-capable
		// v1-preview family via its broader `qwopus3.6-27b` pattern.
		strictEqual(kb.lookup("qwopus3.6-27b-v1-preview")?.entry.family, "qwopus3.6-27b-v1-preview");
		strictEqual(kb.lookup("qwopus3.6-27b-v1-preview")?.entry.capabilities.reasoning, true);

		// Ornith is reasoning class "always": it cannot be silenced.
		const ornithQuirks = kb.lookup("Ornith-1.0-35B-Q4_K_M-262K")?.entry.quirks as LocalModelQuirks | undefined;
		strictEqual(ornithQuirks?.thinking?.mechanism, "always-on");
	});

	it("keeps catalog reasoning class authoritative over noisy live reasoning detection", () => {
		const bundled = join(dirname(fileURLToPath(import.meta.url)), "../../src/domains/providers/models");
		const kb = new FileKnowledgeBase([{ dir: bundled, label: "bundled" }]);
		const qwopus = "Qwopus3.6-35B-A3B-Coder-MTP-Q4_K_M-262K";
		const ornith = "Ornith-1.0-35B-Q4_K_M-262K";

		const noThinkingCaps = resolveModelCapabilities(localStatus(qwopus, { reasoning: true }), qwopus, kb, {
			detectedReasoning: true,
		});
		strictEqual(noThinkingCaps.reasoning, false);

		const alwaysThinkingCaps = resolveModelCapabilities(localStatus(ornith, { reasoning: false }), ornith, kb, {
			detectedReasoning: false,
		});
		strictEqual(alwaysThinkingCaps.reasoning, true);
	});
});
