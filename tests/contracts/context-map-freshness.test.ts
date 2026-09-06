import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { readCodewiki, writeCodewiki } from "../../src/domains/context/codewiki/artifact.js";
import { buildCodewiki } from "../../src/domains/context/codewiki/indexer.js";
import type { ArchitectureSeed } from "../../src/domains/context/wiki/map-seed.js";
import { makeScratchHome } from "../harness/scratch-env.js";

const require = createRequire(import.meta.url);
const loader = require.resolve("tsx");
const command = fileURLToPath(new URL("../../src/cli/context-map.ts", import.meta.url));

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function fixture(run: (cwd: string, env: NodeJS.ProcessEnv) => Promise<void>, withGit = true): Promise<void> {
	const cwd = mkdtempSync(join(tmpdir(), "clio-map-freshness-"));
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

function mapRepository(cwd: string, env: NodeJS.ProcessEnv) {
	// Import only this deterministic subcommand, without booting the CLI or providers.
	const stdout = execFileSync(
		process.execPath,
		[
			"--import",
			loader,
			"--input-type=module",
			"-e",
			`const { runContextMapCommand } = await import(${JSON.stringify(command)}); process.exitCode = await runContextMapCommand(["--json"]);`,
		],
		{ cwd, env, encoding: "utf8", timeout: 30_000 },
	);
	const result = JSON.parse(stdout) as {
		path: string;
		repository: { url: string; revision: string } | null;
		index: string;
		sourceState: string;
	};
	return { result, seed: JSON.parse(readFileSync(result.path, "utf8")) as ArchitectureSeed };
}

function uncited(seed: ArchitectureSeed): void {
	strictEqual(seed.meta.repository, undefined);
	ok(seed.components.every((component) => component.sources === undefined));
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
			const { result, seed } = mapRepository(cwd, env);
			deepStrictEqual(seed.components.find((component) => component.label === "app")?.sources, [
				{ path: "app/main.ts", line: 5 },
			]);
			strictEqual(result.index, "reconciled");
			strictEqual(result.sourceState, "clean");
			strictEqual(result.repository?.revision, git(cwd, "rev-parse", "HEAD"));
			ok(readCodewiki(cwd)?.symbols.some((symbol) => symbol.name === "current" && symbol.line === 5));
			const second = mapRepository(cwd, env);
			deepStrictEqual(second.seed, seed);
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
			const { result, seed } = mapRepository(cwd, env);
			uncited(seed);
			strictEqual(result.sourceState, "dirty");
			strictEqual(result.repository, null);
			deepStrictEqual(seed.components.map((component) => component.label).sort(), ["app", "service"]);
			ok(seed.connections.some((edge) => edge.from === "app" && edge.to === "service"));
			ok(!readCodewiki(cwd)?.symbols.some((symbol) => symbol.name === "main" || symbol.name === "value"));
		});
	});

	it("does not mistake assume-unchanged status for immutable source identity", async () => {
		await fixture(async (cwd, env) => {
			git(cwd, "update-index", "--assume-unchanged", "app/main.ts");
			writeFileSync(join(cwd, "app/main.ts"), "\n\nexport function hiddenChange() {}\n");
			strictEqual(git(cwd, "status", "--porcelain"), "");
			const { result, seed } = mapRepository(cwd, env);
			uncited(seed);
			strictEqual(result.sourceState, "dirty");
			ok(readCodewiki(cwd)?.symbols.some((symbol) => symbol.name === "hiddenChange" && symbol.line === 3));
		});
	});

	it("keeps a refreshed seed usable when Git evidence is unavailable", async () => {
		await fixture(async (cwd, env) => {
			writeFileSync(join(cwd, "app/main.ts"), "\nexport function withoutGit() {}\n");
			const { result, seed } = mapRepository(cwd, env);
			strictEqual(result.sourceState, "unknown");
			strictEqual(result.index, "reconciled");
			uncited(seed);
			ok(seed.components.length > 0);
			ok(readCodewiki(cwd)?.symbols.some((symbol) => symbol.name === "withoutGit" && symbol.line === 2));
		}, false);
	});

	it("keeps unavailable Git executable evidence unknown", async () => {
		await fixture(async (cwd, env) => {
			const { result, seed } = mapRepository(cwd, { ...env, PATH: join(cwd, "no-executables") });
			strictEqual(result.sourceState, "unknown");
			strictEqual(result.index, "reconciled");
			uncited(seed);
			ok(seed.components.length > 0);
		});
	});

	it("reports clean separately from a missing supported origin", async () => {
		await fixture(async (cwd, env) => {
			git(cwd, "remote", "remove", "origin");
			const { result, seed } = mapRepository(cwd, env);
			strictEqual(result.sourceState, "clean");
			strictEqual(result.repository, null);
			uncited(seed);
			match(readFileSync(result.path, "utf8"), /architecture/);
		});
	});
});
