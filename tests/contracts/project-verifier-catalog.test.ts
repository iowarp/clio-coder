import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { typedValidationSummary } from "../../src/domains/safety/finish-contract.js";
import {
	type DeclaredCheckSource,
	loadProjectVerifierCatalog,
	PROJECT_VERIFIER_CATALOG_CAPS,
	PROJECT_VERIFIER_CATALOG_RELATIVE_PATH,
} from "../../src/tools/verify/catalog.js";
import { verifyTool } from "../../src/tools/verify/index.js";
import { runProjectCheck } from "../../src/tools/verify/scripts.js";

interface CatalogCheckInput {
	id: unknown;
	description: unknown;
	command: unknown;
	cwd: unknown;
	timeoutMs: unknown;
	tags: unknown;
	[key: string]: unknown;
}

function baseCheck(overrides: Partial<CatalogCheckInput> = {}): CatalogCheckInput {
	return {
		id: "test",
		description: "Run the project test suite",
		command: [process.execPath, "--version"],
		cwd: ".",
		timeoutMs: 10_000,
		tags: ["test"],
		...overrides,
	};
}

describe("contracts/project verifier catalog", { concurrency: false }, () => {
	let workspace: string;
	let previousCwd: string;
	const extraRoots: string[] = [];

	beforeEach(() => {
		previousCwd = process.cwd();
		workspace = mkdtempSync(join(tmpdir(), "clio-verifier-catalog-"));
		mkdirSync(join(workspace, ".clio-coder"), { recursive: true });
		process.chdir(workspace);
	});

	afterEach(() => {
		process.chdir(previousCwd);
		delete process.env.CLIO_CODER_CATALOG_SECRET;
		rmSync(workspace, { recursive: true, force: true });
		for (const root of extraRoots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function writeCatalog(value: unknown): void {
		writeFileSync(join(workspace, PROJECT_VERIFIER_CATALOG_RELATIVE_PATH), `${JSON.stringify(value, null, 2)}\n`, "utf8");
	}

	function writeRawCatalog(value: string): void {
		writeFileSync(join(workspace, PROJECT_VERIFIER_CATALOG_RELATIVE_PATH), value, "utf8");
	}

	function catalogError(): string {
		const result = loadProjectVerifierCatalog(workspace);
		strictEqual(result.ok, false, JSON.stringify(result));
		return result.ok ? "" : result.reason;
	}

	it("projects package scripts and Rust, CMake, Python, and Go checks through canonical listing metadata", async () => {
		writeFileSync(
			join(workspace, "package.json"),
			`${JSON.stringify({ scripts: { dev: "node server.js", typecheck: "tsc --noEmit" } }, null, 2)}\n`,
			"utf8",
		);
		writeCatalog({
			version: 1,
			checks: [
				baseCheck({
					id: "rust-workspace",
					description: "Run the Rust workspace tests",
					command: ["cargo", "test", "--workspace"],
					timeoutMs: 600_000,
					tags: ["rust", "test"],
				}),
				baseCheck({
					id: "cmake-test",
					description: "Run the CMake test target",
					command: ["cmake", "--build", "build", "--target", "test"],
					tags: ["cmake", "test"],
				}),
				baseCheck({
					id: "python-test",
					description: "Run the Python tests",
					command: ["python3", "-m", "pytest", "-q"],
					tags: ["python", "test"],
				}),
				baseCheck({
					id: "go-test",
					description: "Run the Go tests",
					command: ["go", "test", "./..."],
					tags: ["go", "test"],
				}),
			],
		});

		const result = await verifyTool.run({});
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		match(result.output, /package\.json:/u);
		match(result.output, /- typecheck/u);
		match(result.output, /\.clio-coder\/verifiers\.yaml:/u);
		for (const id of ["rust-workspace", "cmake-test", "python-test", "go-test"]) {
			ok(result.output.includes(`- ${id}`), result.output);
		}

		const sources = (result.details?.sources ?? []) as DeclaredCheckSource[];
		deepStrictEqual(
			sources.map((source) => source.kind),
			["package.json", "project-catalog"],
		);
		const packageCheck = sources[0]?.checks.find((check) => check.id === "typecheck");
		deepStrictEqual(packageCheck?.command, ["npm", "run", "typecheck"]);
		strictEqual(packageCheck?.cwd, ".");
		strictEqual(packageCheck?.timeoutMs, 120_000);
		deepStrictEqual(packageCheck?.tags, ["typecheck"]);
		const rust = sources[1]?.checks.find((check) => check.id === "rust-workspace");
		deepStrictEqual(rust, {
			id: "rust-workspace",
			description: "Run the Rust workspace tests",
			command: ["cargo", "test", "--workspace"],
			cwd: ".",
			timeoutMs: 600_000,
			tags: ["rust", "test"],
			source: {
				kind: "project-catalog",
				path: join(workspace, PROJECT_VERIFIER_CATALOG_RELATIVE_PATH),
			},
		});
	});

	it("executes only the declared argv, cwd, timeout, and safe environment with typed evidence", async () => {
		mkdirSync(join(workspace, "declared-cwd"));
		mkdirSync(join(workspace, "model-cwd"));
		process.env.CLIO_CODER_CATALOG_SECRET = "must-not-leak";
		const declaredArgument = "$(touch catalog-shell-interpolation-must-not-run)";
		const script = [
			"setTimeout(() => process.stdout.write(JSON.stringify({",
			"  argv: process.argv.slice(1),",
			"  cwd: process.cwd(),",
			"  secret: process.env.CLIO_CODER_CATALOG_SECRET ?? null",
			"})), 75);",
		].join("\n");
		const declaredCommand = [process.execPath, "-e", script, declaredArgument];
		writeCatalog({
			version: 1,
			checks: [
				baseCheck({
					id: "exact-vector",
					description: "Prove exact vector execution",
					command: declaredCommand,
					cwd: "declared-cwd",
					timeoutMs: 5_000,
					tags: ["hardening"],
				}),
			],
		});

		const result = await verifyTool.run({
			check: "exact-vector",
			args: ["model-only-argument"],
			cwd: "model-cwd",
			timeout_ms: 1,
			max_output_bytes: 8,
			env: { CLIO_CODER_CATALOG_SECRET: "model-injected-secret" },
		});
		strictEqual(result.kind, "ok", result.kind === "error" ? result.message : result.output);
		if (result.kind !== "ok") return;
		deepStrictEqual(JSON.parse(result.output) as unknown, {
			argv: [declaredArgument],
			cwd: join(workspace, "declared-cwd"),
			secret: null,
		});
		strictEqual(existsSync(join(workspace, "catalog-shell-interpolation-must-not-run")), false);
		deepStrictEqual(result.details?.argv, declaredCommand);
		strictEqual(result.details?.cwd, join(workspace, "declared-cwd"));
		strictEqual(result.details?.exitCode, 0);
		strictEqual(typeof result.details?.durationMs, "number");
		strictEqual(result.details?.aborted, false);
		strictEqual(result.details?.timedOut, false);
		strictEqual(result.details?.outputCapped, false);
		strictEqual(result.details?.check, "exact-vector");
		deepStrictEqual(result.details?.declaredCommand, declaredCommand);
		strictEqual(result.details?.declaredCwd, "declared-cwd");
		strictEqual(result.details?.declaredTimeoutMs, 5_000);
		deepStrictEqual(result.details?.tags, ["hardening"]);
	});

	it("honors declared timeout and cancellation while retaining execution evidence", async () => {
		writeCatalog({
			version: 1,
			checks: [
				baseCheck({
					id: "wait",
					description: "Wait until stopped",
					command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
					timeoutMs: 100,
				}),
			],
		});
		const timedOut = await verifyTool.run({ check: "wait", timeout_ms: 30_000 });
		strictEqual(timedOut.kind, "error");
		if (timedOut.kind === "error") match(timedOut.message, /timed out after 100ms/u);
		strictEqual(timedOut.details?.timedOut, true);
		strictEqual(timedOut.details?.aborted, false);
		strictEqual(timedOut.details?.declaredTimeoutMs, 100);

		writeCatalog({
			version: 1,
			checks: [
				baseCheck({
					id: "wait",
					description: "Wait until stopped",
					command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
					timeoutMs: 5_000,
				}),
			],
		});
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);
		const aborted = await verifyTool.run({ check: "wait" }, { signal: controller.signal });
		strictEqual(aborted.kind, "error");
		if (aborted.kind === "error") match(aborted.message, /verify: aborted/u);
		strictEqual(aborted.details?.aborted, true);
		strictEqual(aborted.details?.timedOut, false);
		strictEqual(aborted.details?.declaredTimeoutMs, 5_000);
	});

	it("applies the safe-exec output cap and reports shaped typed evidence", async () => {
		const command = [process.execPath, "-e", "process.stdout.write('x'.repeat(700000))"];
		writeCatalog({
			version: 1,
			checks: [baseCheck({ id: "output-cap", description: "Exercise output shaping", command })],
		});
		const result = await verifyTool.run({ check: "output-cap", max_output_bytes: 1_000_000 });
		strictEqual(result.kind, "error");
		if (result.kind === "error") match(result.message, /output exceeded 600000 bytes/u);
		strictEqual(result.details?.outputCapped, true);
		deepStrictEqual(result.details?.argv, command);
		strictEqual(result.details?.check, "output-cap");
	});

	it("rejects malformed YAML, strict shape violations, invalid values, shell sourcing, and cwd escapes", () => {
		const cases: Array<{ name: string; raw?: string; value?: unknown; expected: RegExp }> = [
			{ name: "malformed YAML", raw: "version: 1\nchecks: [\n", expected: /invalid YAML/u },
			{ name: "root shape", value: [], expected: /root must be an object/u },
			{ name: "root unknown", value: { version: 1, checks: [], extra: true }, expected: /root has unknown field/u },
			{ name: "version", value: { version: 2, checks: [] }, expected: /unsupported version 2/u },
			{
				name: "check unknown",
				value: { version: 1, checks: [{ ...baseCheck(), extra: true }] },
				expected: /checks\[0\] has unknown field/u,
			},
			{
				name: "missing field",
				value: { version: 1, checks: [{ ...baseCheck(), description: undefined }] },
				expected: /description is required/u,
			},
			{
				name: "duplicate id",
				value: { version: 1, checks: [baseCheck(), baseCheck()] },
				expected: /duplicates 'test' from checks\[0\]\.id/u,
			},
			{
				name: "empty argv",
				value: { version: 1, checks: [baseCheck({ command: [] })] },
				expected: /non-empty argv string array/u,
			},
			{
				name: "non-string argv",
				value: { version: 1, checks: [baseCheck({ command: [process.execPath, 42] })] },
				expected: /command\[1\] must be a non-empty string/u,
			},
			{
				name: "shell command string",
				value: { version: 1, checks: [baseCheck({ command: "cargo test --workspace" })] },
				expected: /shell command strings are not allowed/u,
			},
			{
				name: "shell executable",
				value: { version: 1, checks: [baseCheck({ command: ["bash", "-c", "cargo test"] })] },
				expected: /may not invoke shell executable 'bash'/u,
			},
			{
				name: "invalid id",
				value: { version: 1, checks: [baseCheck({ id: "Rust/Test" })] },
				expected: /id must match/u,
			},
			{
				name: "reserved id",
				value: { version: 1, checks: [baseCheck({ id: "frontend" })] },
				expected: /reserved built-in check id/u,
			},
			{
				name: "invalid tag",
				value: { version: 1, checks: [baseCheck({ tags: ["Test"] })] },
				expected: /tags\[0\] must match/u,
			},
			{
				name: "duplicate tag",
				value: { version: 1, checks: [baseCheck({ tags: ["test", "test"] })] },
				expected: /duplicate tag 'test'/u,
			},
			{
				name: "invalid description",
				value: { version: 1, checks: [baseCheck({ description: "two\nlines" })] },
				expected: /trimmed, single-line text/u,
			},
			{
				name: "absolute cwd",
				value: { version: 1, checks: [baseCheck({ cwd: tmpdir() })] },
				expected: /absolute cwd/u,
			},
			{
				name: "escaping cwd",
				value: { version: 1, checks: [baseCheck({ cwd: ".." })] },
				expected: /escapes the workspace root/u,
			},
			{
				name: "invalid timeout",
				value: { version: 1, checks: [baseCheck({ timeoutMs: 1.5 })] },
				expected: /positive integer/u,
			},
		];

		for (const testCase of cases) {
			if (testCase.raw !== undefined) writeRawCatalog(testCase.raw);
			else writeCatalog(testCase.value);
			match(catalogError(), testCase.expected, testCase.name);
		}
	});

	it("rejects every configured catalog cap with the configured value in the diagnostic", () => {
		writeRawCatalog("#".repeat(PROJECT_VERIFIER_CATALOG_CAPS.fileBytes + 1));
		match(catalogError(), new RegExp(String(PROJECT_VERIFIER_CATALOG_CAPS.fileBytes)));

		const capCases: Array<{ value: unknown; cap: number }> = [
			{
				value: {
					version: 1,
					checks: Array.from({ length: PROJECT_VERIFIER_CATALOG_CAPS.checks + 1 }, (_, index) =>
						baseCheck({ id: `test-${index}` }),
					),
				},
				cap: PROJECT_VERIFIER_CATALOG_CAPS.checks,
			},
			{
				value: { version: 1, checks: [baseCheck({ id: "a".repeat(PROJECT_VERIFIER_CATALOG_CAPS.idBytes + 1) })] },
				cap: PROJECT_VERIFIER_CATALOG_CAPS.idBytes,
			},
			{
				value: {
					version: 1,
					checks: [baseCheck({ description: "a".repeat(PROJECT_VERIFIER_CATALOG_CAPS.descriptionBytes + 1) })],
				},
				cap: PROJECT_VERIFIER_CATALOG_CAPS.descriptionBytes,
			},
			{
				value: {
					version: 1,
					checks: [baseCheck({ command: Array(PROJECT_VERIFIER_CATALOG_CAPS.argvEntries + 1).fill("node") })],
				},
				cap: PROJECT_VERIFIER_CATALOG_CAPS.argvEntries,
			},
			{
				value: {
					version: 1,
					checks: [baseCheck({ command: [process.execPath, "a".repeat(PROJECT_VERIFIER_CATALOG_CAPS.argumentBytes + 1)] })],
				},
				cap: PROJECT_VERIFIER_CATALOG_CAPS.argumentBytes,
			},
			{
				value: {
					version: 1,
					checks: [baseCheck({ cwd: "a".repeat(PROJECT_VERIFIER_CATALOG_CAPS.cwdBytes + 1) })],
				},
				cap: PROJECT_VERIFIER_CATALOG_CAPS.cwdBytes,
			},
			{
				value: {
					version: 1,
					checks: [baseCheck({ timeoutMs: PROJECT_VERIFIER_CATALOG_CAPS.timeoutMs + 1 })],
				},
				cap: PROJECT_VERIFIER_CATALOG_CAPS.timeoutMs,
			},
			{
				value: {
					version: 1,
					checks: [
						baseCheck({
							tags: Array.from({ length: PROJECT_VERIFIER_CATALOG_CAPS.tags + 1 }, (_, index) => `tag-${index}`),
						}),
					],
				},
				cap: PROJECT_VERIFIER_CATALOG_CAPS.tags,
			},
			{
				value: {
					version: 1,
					checks: [baseCheck({ tags: ["a".repeat(PROJECT_VERIFIER_CATALOG_CAPS.tagBytes + 1)] })],
				},
				cap: PROJECT_VERIFIER_CATALOG_CAPS.tagBytes,
			},
		];
		for (const testCase of capCases) {
			writeCatalog(testCase.value);
			match(catalogError(), new RegExp(String(testCase.cap)));
		}
	});

	it("fails closed on package-provider collisions and identifies both sources", async () => {
		writeFileSync(join(workspace, "package.json"), '{"scripts":{"test":"node --test"}}\n', "utf8");
		writeCatalog({ version: 1, checks: [baseCheck()] });
		for (const args of [{}, { check: "test" }]) {
			const result = await verifyTool.run(args);
			strictEqual(result.kind, "error");
			if (result.kind !== "error") continue;
			match(result.message, /duplicate declared check id 'test'/u);
			ok(result.message.includes(join(workspace, "package.json")), result.message);
			ok(result.message.includes(join(workspace, PROJECT_VERIFIER_CATALOG_RELATIVE_PATH)), result.message);
		}
	});

	it("fails verify closed when a catalog is malformed even if a package check exists", async () => {
		writeFileSync(join(workspace, "package.json"), '{"scripts":{"test":"node --test"}}\n', "utf8");
		writeRawCatalog("version: 1\nchecks: [\n");
		const result = await verifyTool.run({ check: "test" });
		strictEqual(result.kind, "error");
		if (result.kind === "error") match(result.message, /verifiers\.yaml: invalid YAML/u);
	});

	it("rejects a catalog cwd that escapes through a symbolic link", () => {
		const external = mkdtempSync(join(tmpdir(), "clio-verifier-external-"));
		extraRoots.push(external);
		symlinkSync(external, join(workspace, "escape"), "dir");
		writeCatalog({ version: 1, checks: [baseCheck({ cwd: "escape" })] });
		match(catalogError(), /escapes the workspace root through a symbolic link/u);
	});

	it("revalidates catalog cwd authority at execution after an admitted symlink is swapped", async () => {
		const admittedTarget = join(workspace, "admitted-target");
		const admittedLink = join(workspace, "admitted-link");
		const external = mkdtempSync(join(tmpdir(), "clio-verifier-swapped-cwd-"));
		extraRoots.push(external);
		mkdirSync(admittedTarget);
		symlinkSync(admittedTarget, admittedLink, "dir");
		writeCatalog({
			version: 1,
			checks: [
				baseCheck({
					id: "swapped-cwd",
					cwd: "admitted-link",
					command: [process.execPath, "-e", "require('node:fs').writeFileSync('escaped', 'yes')"],
				}),
			],
		});

		const loaded = loadProjectVerifierCatalog(workspace);
		strictEqual(loaded.ok, true, JSON.stringify(loaded));
		if (!loaded.ok || loaded.source === null) return;
		const check = loaded.source.checks[0];
		ok(check);

		unlinkSync(admittedLink);
		symlinkSync(external, admittedLink, "dir");
		const result = await runProjectCheck(check);
		strictEqual(result.kind, "error");
		if (result.kind === "error") match(result.message, /escapes the workspace root through a symbolic link/u);
		strictEqual(existsSync(join(external, "escaped")), false);
	});

	it("classifies stable project check calls as typed validation evidence", () => {
		strictEqual(typedValidationSummary("verify", { args: { check: "rust-workspace" } }), "verify rust-workspace");
		strictEqual(typedValidationSummary("verify", { args: { check: "Rust/Test" } }), null);
	});
});
