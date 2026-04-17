import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/domains/prompts/compiler.js";
import type { FragmentTable, LoadedFragment } from "../src/domains/prompts/fragment-loader.js";
import { loadFragments } from "../src/domains/prompts/fragment-loader.js";
import { canonicalJson, sha256 } from "../src/domains/prompts/hash.js";

/**
 * Phase 3 Slice 3 diag harness. Exercises the prompts compiler and its two
 * reproducibility hashes against the real fragment tree, then validates that
 * unknown placeholders in a synthetic fragment still throw.
 *
 * Uses the xdg hermeticity pattern so CLIO_HOME is ephemeral even though the
 * compiler itself does not read settings.
 */

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-prompt] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-prompt] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

function fragmentTableWithOverride(base: FragmentTable, override: LoadedFragment): FragmentTable {
	const byId = new Map(base.byId);
	byId.set(override.id, override);
	return { byId, rootDir: base.rootDir };
}

async function runHarness(): Promise<void> {
	const home = mkdtempSync(join(tmpdir(), "clio-diag-prompt-"));
	const ENV_KEYS = ["CLIO_HOME", "CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"] as const;
	const snapshot = new Map<string, string | undefined>();
	for (const k of ENV_KEYS) snapshot.set(k, process.env[k]);
	for (const k of ["CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"] as const) {
		delete process.env[k];
	}
	process.env.CLIO_HOME = home;

	try {
		const table = loadFragments();
		check("fragments:loaded", table.byId.size >= 5, `size=${table.byId.size}`);

		// Contract: canonicalJson must match JSON.stringify for sparse arrays
		// and explicit undefined entries — both serialize as `null`.
		const sparse: unknown[] = [];
		sparse[1] = 1;
		sparse[3] = 2;
		// sparse === [,1,,2] conceptually; indices 0 and 2 are holes.
		const sparseCanonical = canonicalJson(sparse);
		check(
			"canonicalJson:sparse-array-matches-JSON.stringify",
			sparseCanonical === "[null,1,null,2]",
			`got=${sparseCanonical}`,
		);

		// Contract: every loaded fragment's relPath must use POSIX forward
		// slashes so the staticCompositionHash is host-independent.
		let backslashPath: string | null = null;
		for (const f of table.byId.values()) {
			if (f.relPath.includes("\\")) {
				backslashPath = f.relPath;
				break;
			}
		}
		check(
			"fragments:relPath-no-backslash",
			backslashPath === null,
			backslashPath === null ? undefined : `backslash in ${backslashPath}`,
		);

		const baseInputs = {
			identity: "identity.clio",
			mode: "modes.default",
			safety: "safety.auto-edit",
			providers: "providers.dynamic",
			session: "session.dynamic",
			dynamicInputs: {
				provider: "anthropic",
				model: "claude-sonnet-4-6",
				sessionNotes: "",
				turnCount: 1,
			},
		};

		const first = compile(table, baseInputs);
		check("text:non-empty", first.text.length > 0, `len=${first.text.length}`);
		check("text:contains-clio", first.text.includes("Clio"));
		check("text:contains-provider", first.text.includes("anthropic"));
		check("manifest:five-entries", first.fragmentManifest.length === 5, `len=${first.fragmentManifest.length}`);
		check("hash:rendered-matches-sha256-of-text", first.renderedPromptHash === sha256(first.text));

		// Determinism: re-run with identical inputs.
		const second = compile(table, baseInputs);
		check(
			"hash:static-composition-stable",
			first.staticCompositionHash === second.staticCompositionHash,
			`${first.staticCompositionHash} vs ${second.staticCompositionHash}`,
		);
		check("hash:rendered-stable-same-inputs", first.renderedPromptHash === second.renderedPromptHash);
		check("text:stable-same-inputs", first.text === second.text);

		// turnCount change flips the rendered hash but not the static hash.
		const third = compile(table, { ...baseInputs, dynamicInputs: { ...baseInputs.dynamicInputs, turnCount: 2 } });
		check("hash:rendered-changes-with-turnCount", third.renderedPromptHash !== first.renderedPromptHash);
		check("hash:static-composition-invariant-to-dynamic", third.staticCompositionHash === first.staticCompositionHash);

		// mode fragment swap flips the static hash.
		const fourth = compile(table, { ...baseInputs, mode: "modes.advise" });
		check("hash:static-composition-changes-with-mode", fourth.staticCompositionHash !== first.staticCompositionHash);

		// Unknown placeholder in a synthetic dynamic fragment must throw.
		const badProviders: LoadedFragment = {
			path: "<diag-synthetic>",
			relPath: "providers/diag-bad.md",
			id: "providers.diag-bad",
			version: 1,
			budgetTokens: 100,
			description: "diag synthetic bad placeholder",
			dynamic: true,
			body: "Provider: {{provider}}\nBogus: {{notAllowed}}\n",
			contentHash: sha256("diag-synthetic-bad"),
		};
		const badTable = fragmentTableWithOverride(table, badProviders);
		let threw = false;
		let message = "";
		try {
			compile(badTable, { ...baseInputs, providers: "providers.diag-bad" });
		} catch (err) {
			threw = true;
			message = err instanceof Error ? err.message : String(err);
		}
		check(
			"compile:unknown-placeholder-throws",
			threw && message.includes("notAllowed"),
			`threw=${threw} message=${message}`,
		);

		// Missing dynamic input renders as empty string (does not throw).
		const noProvider = compile(table, {
			...baseInputs,
			dynamicInputs: { ...baseInputs.dynamicInputs, provider: null },
		});
		check(
			"compile:null-placeholder-renders-empty",
			!noProvider.text.includes("anthropic") && noProvider.text.includes("Provider: "),
		);

		// Writing a scratch file inside the ephemeral home to exercise cleanup.
		writeFileSync(join(home, "scratch.txt"), "diag");
	} finally {
		try {
			rmSync(home, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
		for (const [k, v] of snapshot) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

async function main(): Promise<void> {
	await runHarness();

	if (failures.length > 0) {
		process.stderr.write(`[diag-prompt] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-prompt] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-prompt] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
