import { match, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { readCodewiki, writeCodewiki } from "../../src/domains/context/codewiki/artifact.js";
import { buildCodewiki } from "../../src/domains/context/codewiki/indexer.js";

import { makeScratchHome } from "../harness/scratch-env.js";

const require = createRequire(import.meta.url);
const loader = require.resolve("tsx");
const command = fileURLToPath(new URL("../../src/cli/context-map.ts", import.meta.url));

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function fixture(run: (cwd: string, env: NodeJS.ProcessEnv) => Promise<void>, withGit = true): Promise<void> {
	const cwd = mkdtempSync(join(tmpdir(), "clio-coder-map-freshness-"));
	const home = makeScratchHome();
	try {
		mkdirSync(join(cwd, "app"));
		mkdirSync(join(cwd, "store"));
		writeFileSync(join(cwd, ".gitignore"), ".clio-coder/\n");
		writeFileSync(
			join(cwd, "app/main.ts"),
			'import { value } from "../store/value.js";\nexport function main() { return value; }\n',
		);
		writeFileSync(join(cwd, "store/value.ts"), "export const value = 1;\n");
		if (withGit) {
			git(cwd, "init", "-q");
			git(cwd, "config", "user.email", "fixture@example.test");
			git(cwd, "config", "user.name", "Fixture");
			git(cwd, "remote", "add", "origin", "git@github.com:example/map-fixture.git");
			git(cwd, "add", ".");
			git(cwd, "commit", "-qm", "initial");
		}
		writeCodewiki(cwd, await buildCodewiki({ cwd, language: "typescript" }));
		await run(cwd, { ...process.env, ...home.env });
	} finally {
		home.cleanup();
		rmSync(cwd, { recursive: true, force: true });
	}
}

function mapRepository(cwd: string, env: NodeJS.ProcessEnv, args = ["--json"]) {
	// Import only this deterministic subcommand, without booting the CLI or providers.
	const stdout = execFileSync(
		process.execPath,
		[
			"--import",
			loader,
			"--input-type=module",
			"-e",
			`const { runContextMapCommand } = await import(${JSON.stringify(command)}); process.exitCode = await runContextMapCommand(${JSON.stringify(args)});`,
		],
		{ cwd, env, encoding: "utf8", timeout: 30_000 },
	);
	const result = JSON.parse(stdout) as {
		path: string;
		repository: { url: string; revision: string } | null;
		index: string;
		sourceState: string;
	};
	return { result, html: readFileSync(result.path, "utf8") };
}

function uncited(html: string): void {
	ok(!html.includes("/blob/"));
	match(html, /local files at generation time/);
}

describe("context map current source evidence", () => {
	it("reconciles a stale index at a new clean HEAD and pins current parser lines", async () => {
		await fixture(async (cwd, env) => {
			writeFileSync(
				join(cwd, "app/main.ts"),
				'\n\n\nimport { value } from "../store/value.js";\nexport function current() { return value; }\n',
			);
			git(cwd, "add", ".");
			git(cwd, "commit", "-qm", "move symbol");
			const { result, html } = mapRepository(cwd, env);
			match(html, /app\/main.ts:5/);
			match(html, /github.com\/example\/map-fixture\/blob\//);
			strictEqual(result.index, "reconciled");
			strictEqual(result.sourceState, "clean");
			strictEqual(result.repository?.revision, git(cwd, "rev-parse", "HEAD"));
			ok(readCodewiki(cwd)?.symbols.some((symbol) => symbol.name === "current" && symbol.line === 5));
			const second = mapRepository(cwd, env);
			strictEqual(second.html, html);
		});
	});

	it("refreshes changed, added, and deleted parser facts but never pins dirty lines", async () => {
		await fixture(async (cwd, env) => {
			rmSync(join(cwd, "store/value.ts"));
			mkdirSync(join(cwd, "service"));
			writeFileSync(join(cwd, "service/current.ts"), "export const current = 2;\n");
			writeFileSync(
				join(cwd, "app/main.ts"),
				'import { current } from "../service/current.js";\n\nexport function changed() { return current; }\n',
			);
			const { result, html } = mapRepository(cwd, env);
			uncited(html);
			strictEqual(result.sourceState, "dirty");
			strictEqual(result.repository, null);
			match(html, /service\/current.ts/);
			ok(!html.includes("store/value.ts"));
			match(html, /app\/main.ts.*→.*service\/current.ts/);
			ok(!readCodewiki(cwd)?.symbols.some((symbol) => symbol.name === "main" || symbol.name === "value"));
		});
	});

	it("does not mistake assume-unchanged status for immutable source identity", async () => {
		await fixture(async (cwd, env) => {
			git(cwd, "update-index", "--assume-unchanged", "app/main.ts");
			writeFileSync(join(cwd, "app/main.ts"), "\n\nexport function hiddenChange() {}\n");
			strictEqual(git(cwd, "status", "--porcelain"), "");
			const { result, html } = mapRepository(cwd, env);
			uncited(html);
			strictEqual(result.sourceState, "dirty");
			ok(readCodewiki(cwd)?.symbols.some((symbol) => symbol.name === "hiddenChange" && symbol.line === 3));
		});
	});

	it("keeps a refreshed map usable when Git evidence is unavailable", async () => {
		await fixture(async (cwd, env) => {
			writeFileSync(join(cwd, "app/main.ts"), "\nexport function withoutGit() {}\n");
			const { result, html } = mapRepository(cwd, env);
			strictEqual(result.sourceState, "unknown");
			strictEqual(result.index, "reconciled");
			uncited(html);
			match(html, /<svg/);
			ok(readCodewiki(cwd)?.symbols.some((symbol) => symbol.name === "withoutGit" && symbol.line === 2));
		}, false);
	});

	it("keeps unavailable Git executable evidence unknown", async () => {
		await fixture(async (cwd, env) => {
			const { result, html } = mapRepository(cwd, { ...env, PATH: join(cwd, "no-executables") });
			strictEqual(result.sourceState, "unknown");
			strictEqual(result.index, "reconciled");
			uncited(html);
			match(html, /<svg/);
		});
	});

	it("reports clean separately from a missing supported origin", async () => {
		await fixture(async (cwd, env) => {
			git(cwd, "remote", "remove", "origin");
			const { result, html } = mapRepository(cwd, env);
			strictEqual(result.sourceState, "clean");
			strictEqual(result.repository, null);
			uncited(html);
			match(readFileSync(result.path, "utf8"), /Codebase map/);
		});
	});
});

it("builds a missing index and honors the requested HTML destination", async () => {
	await fixture(async (cwd, env) => {
		rmSync(join(cwd, ".clio-coder"), { recursive: true, force: true });
		const { result, html } = mapRepository(cwd, env, ["--out", "deliverables/overview.html", "--json"]);
		strictEqual(result.path, join(cwd, "deliverables/overview.html"));
		match(html, /app\/main.ts:2/);
		ok(readCodewiki(cwd));
	}, false);
});

it("rejects a non-HTML output without overwriting it", async () => {
	await fixture(async (cwd, env) => {
		const target = join(cwd, "input.json");
		writeFileSync(target, "operator contents");
		let failed = false;
		try {
			mapRepository(cwd, env, ["--out", "input.json", "--json"]);
		} catch {
			failed = true;
		}
		ok(failed);
		strictEqual(readFileSync(target, "utf8"), "operator contents");
	}, false);
});
