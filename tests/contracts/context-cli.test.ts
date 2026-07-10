import { match, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

type HandlerName = "context" | "init";
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TSX_LOADER = join(REPO_ROOT, "node_modules/tsx/dist/loader.mjs");

function runHandler(
	cwd: string,
	handler: HandlerName,
	args: ReadonlyArray<string>,
): { status: number; stdout: string; stderr: string } {
	const moduleUrl = pathToFileURL(
		join(REPO_ROOT, handler === "context" ? "src/cli/context.ts" : "src/cli/init.ts"),
	).href;
	const exportName = handler === "context" ? "runContextCommand" : "runInitCommand";
	const script = [
		`const mod = await import(${JSON.stringify(moduleUrl)});`,
		`const code = await mod.${exportName}(JSON.parse(process.env.CLIO_TEST_ARGS ?? "[]"));`,
		"process.exitCode = code;",
	].join("\n");
	const child = spawnSync(process.execPath, ["--import", TSX_LOADER, "--eval", script], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, CLIO_TEST_ARGS: JSON.stringify(args) },
	});
	if (child.error) throw child.error;
	return { status: child.status ?? 0, stdout: child.stdout, stderr: child.stderr };
}

describe("contracts/context cli router", () => {
	let scratch: string;
	let previousCwd: string;

	beforeEach(() => {
		previousCwd = process.cwd();
		scratch = mkdtempSync(join(tmpdir(), "clio-context-cli-"));
		writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "context-cli-fixture", type: "module" }), "utf8");
		process.chdir(scratch);
	});

	afterEach(() => {
		process.chdir(previousCwd);
		rmSync(scratch, { recursive: true, force: true });
	});

	it("prints project context status and exits 0 for bare clio context", () => {
		const result = runHandler(scratch, "context", []);

		strictEqual(result.status, 0);
		strictEqual(result.stderr, "");
		match(result.stdout, /^CLIO\.md: none$/m);
		match(result.stdout, /^preload: /m);
		match(result.stdout, /^codewiki: absent \(0 entries\)$/m);
		match(result.stdout, /^adoption: 0 sources, up to date$/m);
	});

	it("routes clio context init through the shared init handler", () => {
		const args = ["--preview", "--heuristic", "--yes"];
		const direct = runHandler(scratch, "init", args);
		const routed = runHandler(scratch, "context", ["init", ...args]);

		strictEqual(direct.status, 0);
		strictEqual(routed.status, 0);
		strictEqual(routed.stdout, direct.stdout);
		strictEqual(routed.stderr, direct.stderr);
	});

	it("shows the last context generation mode and measurements", () => {
		const initialized = runHandler(scratch, "init", ["--heuristic", "--yes"]);
		strictEqual(initialized.status, 0, initialized.stderr);

		const status = runHandler(scratch, "context", []);
		strictEqual(status.status, 0);
		match(status.stdout, /^generation: heuristic \(parser not-run\)$/m);
	});

	it("emits a clean machine-readable init result", () => {
		const result = runHandler(scratch, "context", ["init", "--preview", "--heuristic", "--yes", "--json"]);

		strictEqual(result.status, 0);
		strictEqual(result.stderr, "");
		const payload = JSON.parse(result.stdout) as {
			version: number;
			action: string;
			generation: { mode: string; parserOutcome: string };
			timings: { wallMs: number; codewikiMs: number; generationMs: number };
		};
		strictEqual(payload.version, 1);
		strictEqual(payload.action, "previewed");
		strictEqual(payload.generation.mode, "heuristic");
		strictEqual(payload.generation.parserOutcome, "not-run");
		ok(payload.timings.wallMs >= payload.timings.codewikiMs);
		ok(payload.timings.wallMs >= payload.timings.generationMs);
	});

	it("rejects unknown context verbs and refresh flags with usage", () => {
		const bogus = runHandler(scratch, "context", ["bogus"]);
		strictEqual(bogus.status, 2);
		match(bogus.stderr, /clio context: unknown subcommand bogus/);
		match(bogus.stdout, /Usage:/);

		const refresh = runHandler(scratch, "context", ["refresh", "--bogus"]);
		strictEqual(refresh.status, 2);
		match(refresh.stderr, /clio context refresh: unknown flag --bogus/);
		match(refresh.stdout, /Usage:/);
	});

	it("accepts clio context refresh --wiki without a model call when no wiki exists", () => {
		const result = runHandler(scratch, "context", ["refresh", "--wiki"]);

		strictEqual(result.status, 0);
		strictEqual(result.stderr, "");
		match(result.stdout, /clio context refresh: codewiki rebuilt/);
	});
});
