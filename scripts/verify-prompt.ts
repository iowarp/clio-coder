import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePackageRoot } from "../src/core/package-root.js";
import { compile } from "../src/domains/prompts/compiler.js";
import { loadFragments } from "../src/domains/prompts/fragment-loader.js";

const ENV_KEYS = ["CLIO_HOME", "CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"] as const;

async function main(): Promise<void> {
	const home = mkdtempSync(join(tmpdir(), "clio-verify-prompt-"));
	const snapshot = new Map<string, string | undefined>();
	for (const key of ENV_KEYS) snapshot.set(key, process.env[key]);
	for (const key of ["CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"] as const) {
		delete process.env[key];
	}
	process.env.CLIO_HOME = home;

	try {
		const fragmentsDir = join(resolvePackageRoot(), "src", "domains", "prompts", "fragments");
		const table = loadFragments(fragmentsDir);
		const baseInputs = {
			identity: "identity.clio",
			mode: "modes.default",
			safety: "safety.auto-edit",
			providers: "providers.dynamic",
			session: "session.dynamic",
			dynamicInputs: {
				provider: "anthropic",
				model: "claude-sonnet-4-6",
				turnCount: 1,
				sessionNotes: "",
			},
		} as const;

		const first = compile(table, baseInputs);
		const second = compile(table, baseInputs);
		assert.equal(second.staticCompositionHash, first.staticCompositionHash);
		assert.equal(second.renderedPromptHash, first.renderedPromptHash);
		assert.equal(second.text, first.text);

		const changedTurnCount = compile(table, {
			...baseInputs,
			dynamicInputs: { ...baseInputs.dynamicInputs, turnCount: 2 },
		});
		assert.notEqual(changedTurnCount.renderedPromptHash, first.renderedPromptHash);
		assert.equal(changedTurnCount.staticCompositionHash, first.staticCompositionHash);

		const changedMode = compile(table, {
			...baseInputs,
			mode: "modes.advise",
		});
		assert.notEqual(changedMode.staticCompositionHash, first.staticCompositionHash);

		process.stdout.write("verify-prompt: OK\n");
	} finally {
		try {
			rmSync(home, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
		for (const [key, value] of snapshot) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

main().catch((err) => {
	process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
	process.exit(1);
});
