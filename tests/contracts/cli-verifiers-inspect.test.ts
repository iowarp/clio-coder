/**
 * `clio-coder verifiers inspect --json`, the fixed read a GUI host may run.
 *
 * A verification check is declared as an exact argument vector, and the catalog
 * schema permits its entries to be absolute paths: only `cwd` is required to be
 * repository-relative. So the vector has no safe projection at any width, and
 * these assert the call that follows from that. The executable is classified
 * against a closed set of toolchains, the arguments are counted, the declared
 * working directory crosses only as "is it the root", and the source file path
 * and every discovery diagnostic stay host-side.
 *
 * They also assert the two verdicts an operator needs kept apart: a catalog
 * that does not parse and a catalog whose ids collide with package.json are
 * different failures with different repairs, and the read says which.
 */

import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runVerifiersInspect, verifiersInspectSnapshot } from "../../src/cli/verifiers-inspect.js";

const AT = "2026-08-31T12:00:00.000Z";
const now = (): number => Date.parse(AT);

interface Workspace {
	readonly dir: string;
	readonly remove: () => void;
}

function workspace(files: Record<string, string>): Workspace {
	const dir = mkdtempSync(join(tmpdir(), "clio-verifiers-inspect-"));
	for (const [relative, content] of Object.entries(files)) {
		const target = join(dir, relative);
		mkdirSync(join(target, ".."), { recursive: true });
		writeFileSync(target, content);
	}
	return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

function packageJson(scripts: Record<string, string>): string {
	return JSON.stringify({ name: "fixture", version: "0.0.0", scripts }, null, 2);
}

describe("verifiers inspect projection", () => {
	it("classifies a catalog check's toolchain and counts its arguments without carrying either", () => {
		const scratch = workspace({
			"package.json": packageJson({ test: "node --test" }),
			"verifier-scope/keep": "",
			".clio-coder/verifiers.yaml": [
				"version: 1",
				"checks:",
				"  - id: rust.lint",
				"    description: Lint the declared workspace.",
				// An absolute argument, which the schema permits and this boundary
				// must therefore never repeat.
				'    command: ["cargo", "clippy", "--manifest-path", "/home/operator/private/Cargo.toml"]',
				"    cwd: verifier-scope",
				"    timeoutMs: 300000",
				'    tags: ["lint", "rust"]',
				"",
			].join("\n"),
		});
		try {
			const snapshot = verifiersInspectSnapshot(now, scratch.dir);
			strictEqual(snapshot.discovery, "complete");
			strictEqual(snapshot.catalogPresent, true);
			strictEqual(snapshot.catalogValid, true);
			strictEqual(snapshot.rejection, null);

			const rust = snapshot.checks.find((check) => check.id === "rust.lint");
			ok(rust !== undefined, "the catalog check must reach the projection");
			strictEqual(rust.origin, "catalog");
			strictEqual(rust.signal, "project-catalog");
			strictEqual(rust.runner, "cargo");
			strictEqual(rust.argumentCount, 3);
			strictEqual(rust.runsAtRepositoryRoot, false);
			// A catalog check goes through safe-exec with its own vector.
			strictEqual(rust.argvFixed, true);

			// A package script is the one origin verify does not pin: it runs npm
			// with the declared script name and may accept extra argv.
			const test = snapshot.checks.find((check) => check.id === "test");
			ok(test !== undefined);
			strictEqual(test.origin, "package-script");
			strictEqual(test.argvFixed, false);
			strictEqual(test.runner, "npm");

			const serialized = JSON.stringify(snapshot);
			for (const forbidden of [
				"clippy",
				"--manifest-path",
				"/home/operator",
				"verifier-scope",
				scratch.dir,
				"verifiers.yaml",
			]) {
				strictEqual(serialized.includes(forbidden), false, `the read leaked ${forbidden}`);
			}
		} finally {
			scratch.remove();
		}
	});

	it("classifies a refused catalog by schema location instead of quoting the parser", () => {
		const scratch = workspace({
			"package.json": packageJson({ test: "node --test" }),
			".clio-coder/verifiers.yaml": [
				"version: 1",
				"checks:",
				"  - id: shell",
				"    description: Run the suite through a shell.",
				'    command: ["bash", "-lc", "npm test"]',
				"    cwd: .",
				"    timeoutMs: 120000",
				"    tags: []",
				"",
			].join("\n"),
		});
		try {
			const snapshot = verifiersInspectSnapshot(now, scratch.dir);
			strictEqual(snapshot.catalogPresent, true);
			strictEqual(snapshot.catalogValid, false);
			strictEqual(snapshot.rejection, "shell-command");
			strictEqual(snapshot.rejectedAt, "checks[0].command[0]");
			// Discovery reads the same catalog through the same parser, so a refused
			// catalog blocks the whole plane rather than yielding a partial one.
			strictEqual(snapshot.discovery, "blocked");
			strictEqual(snapshot.blockedBy, "catalog-rejected");
			strictEqual(snapshot.checks.length, 0);
			const serialized = JSON.stringify(snapshot);
			for (const forbidden of ["bash", "npm test", "shell executable"]) {
				strictEqual(serialized.includes(forbidden), false, `the read leaked ${forbidden}`);
			}
		} finally {
			scratch.remove();
		}
	});

	it("keeps a broken catalog and a colliding identifier apart, because their repairs differ", () => {
		const scratch = workspace({
			"package.json": packageJson({ lint: "biome check" }),
			".clio-coder/verifiers.yaml": [
				"version: 1",
				"checks:",
				"  - id: lint",
				"    description: Lint the workspace.",
				'    command: ["deno", "lint"]',
				"    cwd: .",
				"    timeoutMs: 120000",
				"    tags: []",
				"",
			].join("\n"),
		});
		try {
			const snapshot = verifiersInspectSnapshot(now, scratch.dir);
			// The catalog itself is fine. What is broken is that two declarations
			// claim the same id, and saying "your catalog is invalid" would send the
			// operator to the wrong file.
			strictEqual(snapshot.catalogValid, true);
			strictEqual(snapshot.rejection, null);
			strictEqual(snapshot.discovery, "blocked");
			strictEqual(snapshot.blockedBy, "id-collision");
			strictEqual(snapshot.checks.length, 0);
		} finally {
			scratch.remove();
		}
	});

	it("says a project has no catalog rather than that its catalog is empty", () => {
		const scratch = workspace({ "package.json": packageJson({ build: "tsc -p ." }) });
		try {
			const snapshot = verifiersInspectSnapshot(now, scratch.dir);
			strictEqual(snapshot.catalogPresent, false);
			// A verdict about a file that does not exist would be a claim this read
			// never established.
			strictEqual(snapshot.catalogValid, null);
			strictEqual(snapshot.rejection, null);
			strictEqual(snapshot.rejectedAt, null);
			strictEqual(snapshot.discovery, "complete");
			strictEqual(
				snapshot.checks.every((check) => check.origin !== "catalog"),
				true,
			);
		} finally {
			scratch.remove();
		}
	});

	it("holds the invariants a declared check cannot violate", () => {
		const scratch = workspace({
			"package.json": packageJson({ test: "node --test", "lint:rust": "cargo clippy" }),
			"Cargo.toml": '[package]\nname = "fixture"\nversion = "0.1.0"\n',
			".clio-coder/verifiers.yaml": [
				"version: 1",
				"checks:",
				"  - id: contract",
				"    description: Run the declared contract suite.",
				// An executable outside the classified set still crosses as a check;
				// what it does not do is spend its own name as a label.
				'    command: ["./scripts/private-contract.sh", "--strict"]',
				"    cwd: .",
				"    timeoutMs: 120000",
				'    tags: ["contract"]',
				"",
			].join("\n"),
		});
		try {
			const snapshot = verifiersInspectSnapshot(now, scratch.dir);
			ok(snapshot.checks.length > 0, "the fixture must declare checks");
			const contract = snapshot.checks.find((check) => check.id === "contract");
			ok(contract !== undefined);
			strictEqual(contract.runner, "other");
			ok(!JSON.stringify(snapshot).includes("private-contract"));
			for (const check of snapshot.checks) {
				// A package script is the one origin package.json can have produced,
				// and the one origin verify does not pin.
				strictEqual(
					check.origin === "package-script",
					check.signal === "package-script",
					`${check.id} signal must track its origin`,
				);
				strictEqual(check.argvFixed, check.origin !== "package-script", `${check.id} argv binding`);
				// Only a proposal comes from a toolchain declaration the harness read.
				if (check.authority === "toolchain-defined") strictEqual(check.origin, "proposed");
				// The authoring flow mints manual-entry; a discovery read never can.
				ok(check.signal !== "manual-entry", `${check.id} must not report a manual entry`);
				ok(check.timeoutMs > 0 && check.timeoutMs <= 900_000, `${check.id} timeout bound`);
			}
			// A proposal for a declaration the catalog already represents is not
			// offered twice, so the ids stay unique across the whole plane.
			strictEqual(new Set(snapshot.checks.map((check) => check.id)).size, snapshot.checks.length);
		} finally {
			scratch.remove();
		}
	});

	it("emits nothing but a usage error for any argv other than the fixed one", () => {
		const written: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string) => {
			written.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			strictEqual(runVerifiersInspect([]), 2);
			strictEqual(runVerifiersInspect(["--json", "--all"]), 2);
			strictEqual(runVerifiersInspect(["contract"]), 2);
			strictEqual(runVerifiersInspect(["--json=1"]), 2);
		} finally {
			process.stderr.write = original;
		}
		strictEqual(written.length, 4);
		ok(written.every((line) => line.includes("usage:")));
	});
});
