#!/usr/bin/env node
/**
 * Build step: run the package's own YAML loaders once and write what they parsed to
 * dist/assets/preparsed-yaml.json (Astra r8-3), so a CLI start or a worker start skips the YAML parser for
 * package-owned bytes. The loaders themselves name the texts, so the asset cannot drift from what they read:
 * prompt fragment frontmatter, the damage-control rules, the bundled model catalog and the packaged model
 * profiles. Operator and project overlays are never loaded here and always parse at runtime.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PREPARSED_YAML_ASSET, preparsePackagedYaml } from "../src/core/packaged-yaml.js";
import { loadFragments } from "../src/domains/prompts/fragment-loader.js";
import { resolveProviderKnowledgeBaseRoots } from "../src/domains/providers/knowledge-base-path.js";
import { loadModelProfiles } from "../src/domains/providers/model-profiles.js";
import { FileKnowledgeBase } from "../src/domains/providers/types/knowledge-base.js";
import { getCachedBaseRuleset } from "../src/domains/safety/rule-pack-loader.js";
import { reportBuildStage } from "./build-output.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const target = join(root, PREPARSED_YAML_ASSET);
const startedAt = performance.now();

const body = preparsePackagedYaml(() => {
	loadFragments();
	getCachedBaseRuleset();
	const packaged = resolveProviderKnowledgeBaseRoots(import.meta.url).filter((entry) => entry.packaged === true);
	if (packaged.length === 0) throw new Error("build-preparsed-yaml: the bundled model catalog was not found");
	new FileKnowledgeBase(packaged);
	// The operator's profile file is theirs and never belongs in the package; point the overlay at nothing.
	loadModelProfiles({ userPath: join(root, "models", "operator-profiles-not-read.yaml") });
});
mkdirSync(dirname(target), { recursive: true });
// Written beside and renamed over, so a process starting during the build reads the old asset or the new one.
writeFileSync(`${target}.next`, body);
renameSync(`${target}.next`, target);
reportBuildStage("Preparsed YAML", startedAt, Buffer.byteLength(body));
