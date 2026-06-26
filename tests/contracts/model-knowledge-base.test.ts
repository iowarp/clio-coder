import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";
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
});
