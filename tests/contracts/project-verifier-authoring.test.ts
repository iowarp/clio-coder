import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runVerifiersCommand } from "../../src/cli/verifiers.js";
import {
	createVerifierDraft,
	deterministicVerifierId,
	discoverVerifierAuthoring,
	previewVerifierDraft,
	reviseVerifierDraft,
	runVerifierAuthoringWorkflow,
	type VerifierRevision,
	validateVerifierDraft,
} from "../../src/tools/verify/authoring.js";
import { loadProjectVerifierCatalog, PROJECT_VERIFIER_CATALOG_RELATIVE_PATH } from "../../src/tools/verify/catalog.js";
import { verifyTool } from "../../src/tools/verify/index.js";

async function captureProcessWrites<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string; stderr: string }> {
	const originalStdout = process.stdout.write;
	const originalStderr = process.stderr.write;
	let stdout = "";
	let stderr = "";
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdout += chunk.toString();
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr += chunk.toString();
		return true;
	}) as typeof process.stderr.write;
	try {
		return { result: await fn(), stdout, stderr };
	} finally {
		process.stdout.write = originalStdout;
		process.stderr.write = originalStderr;
	}
}

describe("contracts/project verifier authoring", { concurrency: false }, () => {
	let workspace: string;
	let previousCwd: string;

	beforeEach(() => {
		previousCwd = process.cwd();
		workspace = mkdtempSync(join(tmpdir(), "clio-verifier-authoring-"));
		process.chdir(workspace);
	});

	afterEach(() => {
		process.chdir(previousCwd);
		rmSync(workspace, { recursive: true, force: true });
	});

	function write(relative: string, content: string): void {
		mkdirSync(join(workspace, relative, ".."), { recursive: true });
		writeFileSync(join(workspace, relative), content, "utf8");
	}

	it("discovers declared package, Cargo, CMake, Python, Go, and validation signals with exact provenance", () => {
		write("package.json", JSON.stringify({ scripts: { test: "node --test", dev: "node server.js" } }));
		write("Cargo.toml", '[workspace]\nmembers = ["crates/core"]\n');
		write(
			"CMakePresets.json",
			JSON.stringify({
				version: 6,
				testPresets: [{ name: "smoke" }, { name: "template", hidden: true }],
				buildPresets: [{ name: "debug" }],
			}),
		);
		write("pyproject.toml", '[tool.pytest.ini_options]\naddopts = "-q"\n\n[project.scripts]\nlint = "demo.cli:lint"\n');
		write("go.mod", "module example.org/demo\n\ngo 1.24\n");
		write(
			"validation.yaml",
			[
				"version: 1",
				"validators:",
				"  - \"python tools/check_grid.py 'out/grid.nc'\"",
				"  - [ncdump, -h, out/grid.nc]",
				'  - "python ambiguous.py | tee result.txt"',
				"",
			].join("\n"),
		);

		const discovery = discoverVerifierAuthoring();
		strictEqual(discovery.ok, true, discovery.ok ? "" : discovery.reason);
		if (!discovery.ok) return;
		deepStrictEqual(
			discovery.activeChecks.map((check) => check.id),
			["test"],
		);
		deepStrictEqual(discovery.activeChecks[0]?.command, ["npm", "run", "test"]);
		deepStrictEqual(discovery.activeChecks[0]?.provenance, {
			kind: "package-script",
			path: "package.json",
			detail: "package.json script 'test'",
			authority: "project-declared",
		});

		const byKind = (kind: string) => discovery.proposals.filter((check) => check.provenance.kind === kind);
		deepStrictEqual(
			byKind("cargo").map((check) => check.command),
			[["cargo", "test", "--workspace"]],
		);
		deepStrictEqual(
			byKind("cmake-preset").map((check) => check.command),
			[
				["cmake", "--build", "--preset", "debug"],
				["ctest", "--preset", "smoke"],
			],
		);
		deepStrictEqual(
			byKind("python-runner").map((check) => [check.command, check.provenance.authority]),
			[
				[["lint"], "project-declared"],
				[["python", "-m", "pytest"], "toolchain-defined"],
			],
		);
		deepStrictEqual(
			byKind("go-module").map((check) => check.command),
			[["go", "test", "./..."]],
		);
		deepStrictEqual(
			byKind("validation-contract").map((check) => [check.command, check.provenance.detail]),
			[
				[["python", "tools/check_grid.py", "out/grid.nc"], "validators[0]"],
				[["ncdump", "-h", "out/grid.nc"], "validators[1]"],
			],
		);
		ok(discovery.proposals.every((check) => check.command.every((entry) => typeof entry === "string")));
		ok(byKind("cargo").every((check) => check.provenance.authority === "toolchain-defined"));
		match(discovery.diagnostics.join("\n"), /validators\[2\] is ambiguous/u);
	});

	it("keeps discovery and authority preview read-only while pinning every effective field", () => {
		write("go.mod", "module example.org/demo\n");
		mkdirSync(join(workspace, "build"));
		const discovery = discoverVerifierAuthoring();
		strictEqual(discovery.ok, true);
		if (!discovery.ok) return;
		const preview = previewVerifierDraft(createVerifierDraft(discovery));
		match(preview, new RegExp(`Catalog path: ${workspace.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`));
		match(preview, /path: .*\.clio-coder\/verifiers\.yaml/u);
		match(preview, /source: go\.mod \(Go module directive; toolchain-defined\)/u);
		match(preview, /argv: \["go","test","\.\/\.\.\."\]/u);
		match(preview, /cwd: \./u);
		match(preview, /timeoutMs: 120000/u);
		match(preview, /tags: \["go","test"\]/u);
		match(preview, /effective execution authority: exact catalog authority after confirmation/u);
		match(preview, /no file has been written and no check has been executed/u);
		strictEqual(existsSync(join(workspace, PROJECT_VERIFIER_CATALOG_RELATIVE_PATH)), false);
		strictEqual(existsSync(join(workspace, "ran")), false);
	});

	it("rejects explicitly without writing and exposes authoring from an empty verify result", async () => {
		write("go.mod", "module example.org/reject\n");
		const result = await runVerifierAuthoringWorkflow({
			decide(context) {
				match(context.preview, /go-test/u);
				return { kind: "reject" };
			},
		});
		strictEqual(result.status, "rejected");
		strictEqual(result.wrote, false);
		strictEqual(existsSync(join(workspace, PROJECT_VERIFIER_CATALOG_RELATIVE_PATH)), false);

		rmSync(join(workspace, "go.mod"));
		const empty = await verifyTool.run({});
		strictEqual(empty.kind, "ok");
		if (empty.kind === "ok") match(empty.output, /clio-coder verifiers author/u);
	});

	it("revises before confirmation and validates the written catalog through the production parser", async () => {
		write("go.mod", "module example.org/revise\n");
		let decisions = 0;
		const result = await runVerifierAuthoringWorkflow({
			decide(context) {
				decisions += 1;
				strictEqual(existsSync(join(workspace, PROJECT_VERIFIER_CATALOG_RELATIVE_PATH)), false);
				if (context.revision === 0) {
					return {
						kind: "revise",
						revisions: [
							{ kind: "edit", id: "go-test", changes: { timeoutMs: 5_000, tags: ["go", "revised"] } },
							{ kind: "rename", id: "go-test", newId: "go-suite" },
						],
					};
				}
				strictEqual(context.validation.ok, true);
				match(context.preview, /go-suite/u);
				return { kind: "confirm" };
			},
		});
		strictEqual(decisions, 2);
		strictEqual(result.status, "written", result.status === "invalid" ? result.reason : "");
		const loaded = loadProjectVerifierCatalog(workspace);
		strictEqual(loaded.ok, true, JSON.stringify(loaded));
		if (!loaded.ok || loaded.source === null) return;
		deepStrictEqual(
			loaded.source.checks.map((check) => check.id),
			["go-suite"],
		);
		strictEqual(loaded.source.checks[0]?.timeoutMs, 5_000);
		deepStrictEqual(loaded.source.checks[0]?.tags, ["go", "revised"]);
	});

	it("dry-runs selected checks only after confirmation through the production verify executor", async () => {
		const marker = join(workspace, "dry-run-marker");
		write(
			"validation.yaml",
			JSON.stringify({
				validators: [
					{
						id: "exec-check",
						description: "Write the dry-run marker",
						command: [
							process.execPath,
							"-e",
							"require('node:fs').writeFileSync('dry-run-marker', 'ran'); process.stdout.write('dry ok')",
						],
						cwd: ".",
						timeoutMs: 10_000,
						tags: ["validation"],
					},
				],
			}),
		);
		const result = await runVerifierAuthoringWorkflow({
			decide() {
				strictEqual(existsSync(marker), false);
				return { kind: "confirm", dryRunCheckIds: ["exec-check"] };
			},
		});
		strictEqual(result.status, "written", result.status === "invalid" ? result.reason : "");
		if (result.status !== "written") return;
		strictEqual(existsSync(marker), true);
		strictEqual(result.dryRuns.length, 1);
		strictEqual(result.dryRuns[0]?.result.kind, "ok");
		strictEqual(result.dryRuns[0]?.result.details?.check, "exec-check");
		strictEqual((result.dryRuns[0]?.result.details?.source as { kind?: string })?.kind, "project-catalog");
		deepStrictEqual(result.dryRuns[0]?.result.details?.declaredCommand, [
			process.execPath,
			"-e",
			"require('node:fs').writeFileSync('dry-run-marker', 'ran'); process.stdout.write('dry ok')",
		]);
	});

	it("fails closed on a malformed existing catalog without asking for or applying a decision", async () => {
		write(PROJECT_VERIFIER_CATALOG_RELATIVE_PATH, "version: 1\nchecks: [\n");
		const before = readFileSync(join(workspace, PROJECT_VERIFIER_CATALOG_RELATIVE_PATH), "utf8");
		let decisions = 0;
		const result = await runVerifierAuthoringWorkflow({
			decide() {
				decisions += 1;
				return { kind: "confirm" };
			},
		});
		strictEqual(result.status, "invalid");
		if (result.status === "invalid") match(result.reason, /existing verifier authority:.*invalid YAML/u);
		strictEqual(decisions, 0);
		strictEqual(readFileSync(join(workspace, PROJECT_VERIFIER_CATALOG_RELATIVE_PATH), "utf8"), before);
	});

	it("offers exact manual entry instead of guessing commands from directory names", () => {
		for (const directory of ["build", "cargo", "python", "go", "tests"]) mkdirSync(join(workspace, directory));
		const discovery = discoverVerifierAuthoring();
		strictEqual(discovery.ok, true);
		if (!discovery.ok) return;
		deepStrictEqual(discovery.proposals, []);
		deepStrictEqual(discovery.activeChecks, []);
		match(discovery.diagnostics.join("\n"), /No package verification script, supported toolchain declaration/u);
		match(discovery.manualEntry, /--command.*JSON argv array/u);
		strictEqual(existsSync(join(workspace, PROJECT_VERIFIER_CATALOG_RELATIVE_PATH)), false);
	});

	it("does not read declared signals or write a catalog through workspace-escaping symlinks", async () => {
		const external = mkdtempSync(join(tmpdir(), "clio-verifier-authoring-external-"));
		try {
			writeFileSync(join(external, "Cargo.toml"), "[workspace]\n", "utf8");
			symlinkSync(join(external, "Cargo.toml"), join(workspace, "Cargo.toml"));
			const discovery = discoverVerifierAuthoring();
			strictEqual(discovery.ok, true);
			if (!discovery.ok) return;
			deepStrictEqual(discovery.proposals, []);
			match(discovery.diagnostics.join("\n"), /Cargo\.toml: cwd escapes workspace root/u);

			rmSync(join(workspace, "Cargo.toml"));
			write("go.mod", "module example.org/symlink\n");
			symlinkSync(external, join(workspace, ".clio-coder"), "dir");
			const result = await runVerifierAuthoringWorkflow({
				decide: () => ({ kind: "confirm" }),
			});
			strictEqual(result.status, "invalid");
			if (result.status === "invalid") match(result.reason, /cwd escapes workspace root/u);
			strictEqual(existsSync(join(external, "verifiers.yaml")), false);
		} finally {
			rmSync(external, { recursive: true, force: true });
		}
	});

	it("keeps IDs deterministic across edit, rename collision, and removal diagnostics", () => {
		const discovery = discoverVerifierAuthoring();
		strictEqual(discovery.ok, true);
		if (!discovery.ok) return;
		const draft = createVerifierDraft(discovery);
		const add: VerifierRevision[] = [
			{
				kind: "add",
				check: {
					id: "alpha",
					description: "Run alpha",
					command: [process.execPath, "--version"],
					cwd: ".",
					timeoutMs: 10_000,
					tags: ["test"],
				},
			},
			{
				kind: "add",
				check: {
					id: "beta",
					description: "Run beta",
					command: [process.execPath, "-p", "1"],
					cwd: ".",
					timeoutMs: 10_000,
					tags: ["test"],
				},
			},
		];
		const added = reviseVerifierDraft(draft, add);
		strictEqual(added.ok, true, added.ok ? "" : added.reason);
		if (!added.ok) return;
		const edited = reviseVerifierDraft(added.draft, [
			{ kind: "edit", id: "alpha", changes: { description: "Run revised alpha" } },
		]);
		strictEqual(edited.ok, true, edited.ok ? "" : edited.reason);
		if (!edited.ok) return;
		deepStrictEqual(
			edited.draft.checks.map((check) => check.id),
			["alpha", "beta"],
		);
		match(edited.diagnostics.join("\n"), /without changing its deterministic ID/u);

		const collision = reviseVerifierDraft(edited.draft, [{ kind: "rename", id: "alpha", newId: "beta" }]);
		strictEqual(collision.ok, false);
		if (!collision.ok) match(collision.reason, /that ID already exists/u);
		deepStrictEqual(
			collision.draft.checks.map((check) => check.id),
			["alpha", "beta"],
		);

		const removed = reviseVerifierDraft(edited.draft, [{ kind: "remove", id: "alpha" }]);
		strictEqual(removed.ok, true, removed.ok ? "" : removed.reason);
		if (!removed.ok) return;
		deepStrictEqual(
			removed.draft.checks.map((check) => check.id),
			["beta"],
		);
		match(removed.diagnostics.join("\n"), /no longer executable through the catalog/u);
		strictEqual(deterministicVerifierId("go-test", new Set(["go-test"])), "go-test-2");
		strictEqual(deterministicVerifierId("go-test", new Set(["go-test"])), "go-test-2");
		strictEqual(validateVerifierDraft(removed.draft).ok, true);
	});

	it("assigns the same deterministic suffix when a discovered proposal collides with an existing ID", () => {
		write("go.mod", "module example.org/collision\n");
		write(
			PROJECT_VERIFIER_CATALOG_RELATIVE_PATH,
			JSON.stringify({
				version: 1,
				checks: [
					{
						id: "go-test",
						description: "An existing check with a different vector",
						command: [process.execPath, "--version"],
						cwd: ".",
						timeoutMs: 10_000,
						tags: ["existing"],
					},
				],
			}),
		);
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const discovery = discoverVerifierAuthoring();
			strictEqual(discovery.ok, true);
			if (!discovery.ok) return;
			deepStrictEqual(
				discovery.proposals.map((check) => check.id),
				["go-test-2"],
			);
			match(discovery.diagnostics.join("\n"), /'go-test' collides with declared authority; using 'go-test-2'/u);
		}
	});

	it("rejects package collisions and provides CLI preview, confirmation, validation, and removal", async () => {
		write("package.json", JSON.stringify({ scripts: { test: "node --test" } }));
		const discovery = discoverVerifierAuthoring();
		strictEqual(discovery.ok, true);
		if (!discovery.ok) return;
		const collision = reviseVerifierDraft(createVerifierDraft(discovery), [
			{
				kind: "add",
				check: {
					id: "test",
					description: "Collide with package test",
					command: [process.execPath, "--version"],
					cwd: ".",
					timeoutMs: 10_000,
					tags: ["test"],
				},
			},
		]);
		strictEqual(collision.ok, false);
		if (!collision.ok) match(collision.reason, /collides with an active package check/u);

		write("go.mod", "module example.org/cli\n");
		const preview = await captureProcessWrites(() => runVerifiersCommand(["author"]));
		strictEqual(preview.result, 0);
		match(preview.stdout, /Project verifier authority preview/u);
		match(preview.stdout, /Nothing changed/u);
		strictEqual(existsSync(join(workspace, PROJECT_VERIFIER_CATALOG_RELATIVE_PATH)), false);

		const created = await captureProcessWrites(() => runVerifiersCommand(["author", "--yes"]));
		strictEqual(created.result, 0, created.stderr);
		match(created.stdout, /ok: wrote .*production parser accepted/u);
		strictEqual(existsSync(join(workspace, PROJECT_VERIFIER_CATALOG_RELATIVE_PATH)), true);

		const validated = await captureProcessWrites(() => runVerifiersCommand(["validate"]));
		strictEqual(validated.result, 0);
		match(validated.stdout, /production catalog parser accepted/u);

		const rejectedRemoval = await captureProcessWrites(() => runVerifiersCommand(["remove", "go-test"]));
		strictEqual(rejectedRemoval.result, 0);
		match(readFileSync(join(workspace, PROJECT_VERIFIER_CATALOG_RELATIVE_PATH), "utf8"), /id: go-test/u);

		const removal = await captureProcessWrites(() => runVerifiersCommand(["remove", "go-test", "--yes"]));
		strictEqual(removal.result, 0, removal.stderr);
		const loaded = loadProjectVerifierCatalog(workspace);
		strictEqual(loaded.ok, true);
		if (loaded.ok) deepStrictEqual(loaded.source?.checks ?? [], []);
	});
});
