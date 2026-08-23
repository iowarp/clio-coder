import { strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createTomlFileReader } from "../../src/core/toml.js";
import { readProjectMetadata } from "../../src/domains/context/project-metadata.js";

const scratchRoots: string[] = [];

afterEach(() => {
	for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
	const cwd = mkdtempSync(join(tmpdir(), "clio-project-metadata-"));
	scratchRoots.push(cwd);
	for (const [relative, content] of Object.entries(files)) {
		const full = join(cwd, relative);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content, "utf8");
	}
	return cwd;
}

describe("contracts/project-metadata", () => {
	it("reads a Node package the way it always did", () => {
		const cwd = project({
			"package.json": JSON.stringify({ name: "@scope/thing", description: "a widget library" }),
		});
		const metadata = readProjectMetadata(cwd);
		strictEqual(metadata.name, "@scope/thing");
		strictEqual(metadata.description, "a widget library");
		strictEqual(metadata.descriptionSource, "package.json");
	});

	/**
	 * The case that sent every C and C++ repository to the model. A CMake
	 * project states its purpose in `project(... DESCRIPTION ...)` and nowhere
	 * else, and the old reader asked only `package.json` and `README.md`.
	 */
	it("reads a CMake project description and name", () => {
		const cwd = project({
			"CMakeLists.txt": [
				"cmake_minimum_required(VERSION 3.20)",
				"project(ChronoLog",
				"  VERSION 0.4.0",
				'  DESCRIPTION "a distributed shared log store for HPC activity traces"',
				"  LANGUAGES CXX)",
				"",
				"add_subdirectory(src)",
			].join("\n"),
		});
		const metadata = readProjectMetadata(cwd);
		strictEqual(metadata.name, "ChronoLog");
		strictEqual(metadata.description, "a distributed shared log store for HPC activity traces");
		strictEqual(metadata.descriptionSource, "CMakeLists.txt");
	});

	it("reads a Doxygen PROJECT_BRIEF when that is the only prose a Fortran code ships", () => {
		const cwd = project({
			Doxyfile: [
				'PROJECT_NAME           = "FlashX"',
				'PROJECT_BRIEF          = "an adaptive-mesh astrophysics code"',
				"OUTPUT_DIRECTORY       = doc",
			].join("\n"),
		});
		const metadata = readProjectMetadata(cwd);
		strictEqual(metadata.name, "FlashX");
		strictEqual(metadata.description, "an adaptive-mesh astrophysics code");
		strictEqual(metadata.descriptionSource, "Doxyfile");
	});

	it("reads pyproject and Cargo metadata through parsed TOML documents", () => {
		const python = project({
			"pyproject.toml": [
				"[build-system]",
				'requires = ["hatchling"]',
				"",
				"[project]",
				'name = "mdanalysis"',
				'description = "an MD trajectory analysis toolkit"',
			].join("\n"),
		});
		strictEqual(readProjectMetadata(python).description, "an MD trajectory analysis toolkit");
		strictEqual(readProjectMetadata(python).name, "mdanalysis");

		const rust = project({
			"Cargo.toml": [
				"[package]",
				'name = "petgraph"',
				'description = "a graph data structure library"',
				"",
				"[dependencies]",
			].join("\n"),
		});
		strictEqual(readProjectMetadata(rust).description, "a graph data structure library");

		const poetry = project({
			"pyproject.toml": ["[tool.poetry]", 'name = "legacy"', 'description = "an older Poetry layout"'].join("\n"),
		});
		strictEqual(readProjectMetadata(poetry).description, "an older Poetry layout");
	});

	it("supports structural TOML forms for Python metadata", () => {
		const dotted = project({
			"pyproject.toml": 'project.name = "dotted"\nproject.description = "metadata from dotted keys"\n',
		});
		strictEqual(readProjectMetadata(dotted).name, "dotted");
		strictEqual(readProjectMetadata(dotted).description, "metadata from dotted keys");

		const quoted = project({
			"pyproject.toml": '["tool"."poetry"]\n"name" = "quoted"\n"description" = "metadata from quoted keys"\n',
		});
		strictEqual(readProjectMetadata(quoted).name, "quoted");
		strictEqual(readProjectMetadata(quoted).description, "metadata from quoted keys");

		const inline = project({
			"pyproject.toml": 'project = { name = "inline", description = "metadata from an inline table" }\n',
		});
		strictEqual(readProjectMetadata(inline).name, "inline");
		strictEqual(readProjectMetadata(inline).description, "metadata from an inline table");
	});

	it("supports structural TOML forms for Cargo metadata", () => {
		const dotted = project({
			"Cargo.toml": 'package.name = "dotted-crate"\npackage.description = "metadata from dotted keys"\n',
		});
		strictEqual(readProjectMetadata(dotted).name, "dotted-crate");
		strictEqual(readProjectMetadata(dotted).description, "metadata from dotted keys");

		const quoted = project({
			"Cargo.toml": '["package"]\n"name" = "quoted-crate"\n"description" = "metadata from quoted keys"\n',
		});
		strictEqual(readProjectMetadata(quoted).name, "quoted-crate");
		strictEqual(readProjectMetadata(quoted).description, "metadata from quoted keys");

		const inline = project({
			"Cargo.toml": 'package = { name = "inline-crate", description = "metadata from an inline table" }\n',
		});
		strictEqual(readProjectMetadata(inline).name, "inline-crate");
		strictEqual(readProjectMetadata(inline).description, "metadata from an inline table");
	});

	it("does not treat an array of tables as a supported metadata table", () => {
		const cwd = project({
			"pyproject.toml": '[[project]]\nname = "array-project"\ndescription = "not PEP 621 metadata"\n',
			"Cargo.toml": '[[package]]\nname = "array-crate"\ndescription = "not Cargo package metadata"\n',
			"README.md": "# Fallback\n\nThe README supplies the supported metadata shape.\n",
		});
		const metadata = readProjectMetadata(cwd);
		strictEqual(metadata.name, "Fallback");
		strictEqual(metadata.description, "The README supplies the supported metadata shape");
		strictEqual(metadata.descriptionSource, "README.md");
	});

	/**
	 * Scientific software very often maintains `CITATION.cff` because a journal
	 * or a funder asked for it, while shipping no package manifest at all.
	 */
	it("reads a CITATION.cff abstract when no manifest describes the project", () => {
		const cwd = project({
			"CITATION.cff": [
				"cff-version: 1.2.0",
				"title: Hermes",
				"abstract: A multi-tiered I/O buffering system for high-performance computing.",
				"authors:",
				"  - family-names: Kougkas",
			].join("\n"),
		});
		const metadata = readProjectMetadata(cwd);
		strictEqual(metadata.name, "Hermes");
		strictEqual(metadata.description, "A multi-tiered I/O buffering system for high-performance computing");
		strictEqual(metadata.descriptionSource, "CITATION.cff");
	});

	/**
	 * `readReadmeSummary` opened `README.md` by name, so a repository that ships
	 * reStructuredText read as having no description whatsoever. That is the
	 * default for a large share of Python and C++ scientific code.
	 */
	it("reads a README.rst summary past its badge block and title underline", () => {
		const cwd = project({
			"README.rst": [
				"|build| |docs|",
				"",
				".. |build| image:: https://example.invalid/build.svg",
				"   :target: https://example.invalid/ci",
				"",
				"PETSc",
				"=====",
				"",
				"PETSc is a suite of data structures and routines for the scalable solution of",
				"partial differential equations on parallel machines.",
				"",
				"Installation",
				"------------",
			].join("\n"),
		});
		const metadata = readProjectMetadata(cwd);
		strictEqual(metadata.name, "PETSc");
		strictEqual(
			metadata.description,
			"PETSc is a suite of data structures and routines for the scalable solution of partial differential equations on parallel machines",
		);
		strictEqual(metadata.descriptionSource, "README.rst");
	});

	it("falls back through README variants including an extensionless one", () => {
		const cwd = project({
			README: ["MyTool", "======", "", "MyTool converts one thing into another thing reliably."].join("\n"),
		});
		strictEqual(readProjectMetadata(cwd).descriptionSource, "README");
		strictEqual(readProjectMetadata(cwd).description, "MyTool converts one thing into another thing reliably");
	});

	it("resolves name and description independently across two files", () => {
		const cwd = project({
			"CMakeLists.txt": "project(libfabric LANGUAGES C)\n",
			"README.md": [
				"# libfabric",
				"",
				"A framework focused on exporting fabric communication services to applications.",
			].join("\n"),
		});
		const metadata = readProjectMetadata(cwd);
		strictEqual(metadata.name, "libfabric");
		strictEqual(metadata.nameSource, "CMakeLists.txt");
		strictEqual(metadata.description, "A framework focused on exporting fabric communication services to applications");
		strictEqual(metadata.descriptionSource, "README.md");
	});

	/**
	 * Measured against the real ChronoLog README, which opens with a GitHub
	 * `> [!IMPORTANT]` callout advertising an MCP server. Taking that as the
	 * identity told a reader nothing about what ChronoLog is.
	 */
	it("skips a leading callout block and takes the paragraph that describes the project", () => {
		const cwd = project({
			"README.md": [
				"# ChronoLog",
				"",
				"> [!IMPORTANT]",
				"> ChronoLog MCP is now available.",
				"> Integrate ChronoLog directly with LLMs through our new MCP server.",
				"",
				"Distributed Shared Tiered Log Store.",
				"",
				"## Building",
			].join("\n"),
		});
		const metadata = readProjectMetadata(cwd);
		strictEqual(metadata.description, "Distributed Shared Tiered Log Store");
	});

	it("reports nothing rather than guessing when a repository describes itself nowhere", () => {
		const cwd = project({ "main.f90": "program main\nend program main\n" });
		const metadata = readProjectMetadata(cwd);
		strictEqual(metadata.name, null);
		strictEqual(metadata.description, null);
		strictEqual(metadata.descriptionSource, null);
	});

	it("treats a malformed manifest as an absent one", () => {
		const cwd = project({
			"package.json": "{ this is not json",
			"README.md": "# Fallback\n\nThe README still describes this project adequately.",
		});
		const metadata = readProjectMetadata(cwd);
		strictEqual(metadata.name, "Fallback");
		strictEqual(metadata.description, "The README still describes this project adequately");
	});

	it("fails safely on malformed TOML without inventing metadata", () => {
		const cwd = project({
			"pyproject.toml": '[project]\nname = "broken"\ndescription = [\n',
			"Cargo.toml": '[package]\nname = "also-broken"\ndescription = {\n',
			"README.md": "# Fallback\n\nOnly valid sources may supply project metadata.\n",
		});
		const metadata = readProjectMetadata(cwd);
		strictEqual(metadata.name, "Fallback");
		strictEqual(metadata.description, "Only valid sources may supply project metadata");
		strictEqual(metadata.descriptionSource, "README.md");
	});

	it("reuses each parsed TOML document within one metadata operation", () => {
		const cwd = project({
			"pyproject.toml": '[project]\nname = "first"\ndescription = "the initial document"\n',
		});
		const tomlFiles = createTomlFileReader(cwd);
		const first = tomlFiles.read("pyproject.toml");
		writeFileSync(join(cwd, "pyproject.toml"), '[project]\nname = "second"\ndescription = "a later document"\n', "utf8");
		strictEqual(tomlFiles.read("pyproject.toml"), first);
		const metadata = readProjectMetadata(cwd, tomlFiles);
		strictEqual(metadata.name, "first");
		strictEqual(metadata.description, "the initial document");
	});
});
