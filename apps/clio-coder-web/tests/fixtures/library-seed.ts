import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initializeClioHome } from "../../../../src/core/init.js";
import { installExtension } from "../../../../src/domains/extensions/manager.js";

const cwd = process.argv[2];
assert.ok(cwd);
initializeClioHome();
const config = process.env.CLIO_CODER_CONFIG_DIR;
assert.ok(config);
const prompt = join(config, "prompts");
mkdirSync(prompt, { recursive: true });
writeFileSync(
	join(prompt, "fixture-welcome.md"),
	"---\ndescription: Explain a project in plain language.\n---\nDescribe this project for someone learning to build.\n",
);
const skill = join(config, "skills", "fixture-skill");
mkdirSync(skill, { recursive: true });
writeFileSync(
	join(skill, "SKILL.md"),
	"---\nname: fixture-skill\ndescription: A small library fixture.\n---\nExplain the next step.\n",
);
const source = join(cwd, "extension-source");
mkdirSync(source, { recursive: true });
writeFileSync(
	join(source, "clio-coder-extension.yaml"),
	JSON.stringify({
		id: "fixture-extension",
		name: "Fixture extension",
		version: "1.0.0",
		description: "Read-only discovery fixture.",
		compatibility: { clio: ">=0.0.0" },
	}),
);
const result = installExtension(source, { cwd, scope: "project" });
assert.ok(result.extension, JSON.stringify(result.diagnostics));
writeFileSync(
	join(cwd, "package.json"),
	JSON.stringify({
		name: "library-fixture",
		private: true,
		scripts: { test: `node -e "require('fs').writeFileSync('check-ran','yes')"` },
	}),
);
process.stdout.write(JSON.stringify({ extension: result.extension.id }));
