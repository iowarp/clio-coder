import { readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Phase 1 placeholder. Full fragment validation lands in Phase 3.
 * Today: assert that src/domains/prompts/fragments exists if the domain is present,
 * and exit 0 if the domain does not yet exist.
 */

const projectRoot = process.cwd();
const promptsDomain = path.join(projectRoot, "src", "domains", "prompts");
const fragmentsDir = path.join(promptsDomain, "fragments");

function exists(p: string): boolean {
	try {
		statSync(p);
		return true;
	} catch {
		return false;
	}
}

if (!exists(promptsDomain)) {
	console.log("prompts: domain not yet present (Phase 1) — skipping");
	process.exit(0);
}

if (!exists(fragmentsDir)) {
	console.error("prompts: src/domains/prompts/fragments/ missing");
	process.exit(1);
}

const entries = readdirSync(fragmentsDir, { withFileTypes: true });
let hasFragment = false;
for (const entry of entries) {
	if (entry.isDirectory() || entry.name.endsWith(".md")) {
		hasFragment = true;
		break;
	}
}

if (!hasFragment) {
	console.error("prompts: fragments directory is empty");
	process.exit(1);
}

console.log("prompts: OK (full validation lands in Phase 3)");
