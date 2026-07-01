import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { resetXdgCache } from "../../src/core/xdg.js";
import {
	MODEL_CATALOG_DIRS_ENV,
	MODEL_CATALOG_OVERLAY_DIR,
	resolveProviderModelCatalogDirs,
} from "../../src/domains/providers/knowledge-base-path.js";
import { FileKnowledgeBase } from "../../src/domains/providers/types/knowledge-base.js";

function scratchDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function writeCatalog(dir: string, name: string, yaml: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, name), yaml, "utf8");
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
});
