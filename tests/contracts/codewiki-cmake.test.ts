import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { serializeCodewiki } from "../../src/domains/context/codewiki/indexer.js";
import {
	buildCodewiki,
	computeFingerprint,
	updateCodewikiPaths,
	writeClioState,
	writeCodewiki,
} from "../../src/domains/context/index.js";
import { codeNavTool } from "../../src/tools/codewiki/code-nav.js";

type BuiltCodewiki = Awaited<ReturnType<typeof buildCodewiki>>;

const CMAKE_DYNAMIC_SOURCES = "$" + "{DYNAMIC_SOURCES}";
const CMAKE_DYNAMIC_TARGET = "$" + "{DYNAMIC_TARGET}";

const ROOT_CMAKE = [
	"cmake_minimum_required(VERSION 3.24)",
	"project(static_graph LANGUAGES CXX)",
	"",
	"# add_executable(commented_out src/commented.cpp)",
	"#[=[",
	"add_library(bracket_commented src/bracket.cpp)",
	"]=]",
	'set(NOT_A_COMMAND "add_library(quoted_fake src/quoted-fake.cpp)")',
	"",
	"add_subdirectory(",
	'  "lib" # a comment inside a multiline invocation',
	")",
	"",
	"add_executable(",
	"  app",
	"  src/main.cpp",
	'  "src/quoted file.cc"',
	`  ${CMAKE_DYNAMIC_SOURCES}`,
	'  "$<$<CONFIG:Debug>:src/debug.cpp>"',
	")",
	"target_sources(app PRIVATE src/extra.cpp)",
	"",
	`add_library(${CMAKE_DYNAMIC_TARGET} src/dynamic-target.cpp)`,
	"custom_target_macro(custom src/custom.cpp)",
	"add_library(core_alias ALIAS real.cpp)",
	'add_library(quoted_list "src/first.cpp;src/second.cpp")',
	"add_library(unquoted_list src/first.cpp;src/second.cpp)",
	"",
].join("\n");

const LIB_CMAKE = [
	"add_library",
	"# trivia between the command name and its balanced argument list",
	"(",
	"  core STATIC",
	"  core.cpp",
	"  include/core.hpp",
	")",
	"",
].join("\n");

function writeFixture(cwd: string): void {
	mkdirSync(join(cwd, "src"), { recursive: true });
	mkdirSync(join(cwd, "lib", "include"), { recursive: true });
	mkdirSync(join(cwd, "cmake"), { recursive: true });
	writeFileSync(join(cwd, "CMakeLists.txt"), ROOT_CMAKE, "utf8");
	writeFileSync(join(cwd, "src", "main.cpp"), "int main() { return 0; }\n", "utf8");
	writeFileSync(join(cwd, "src", "quoted file.cc"), "int quoted() { return 1; }\n", "utf8");
	writeFileSync(join(cwd, "src", "extra.cpp"), "int extra() { return 2; }\n", "utf8");
	writeFileSync(join(cwd, "src", "dynamic-target.cpp"), "int dynamic_target() { return 3; }\n", "utf8");
	writeFileSync(join(cwd, "src", "custom.cpp"), "int custom() { return 4; }\n", "utf8");
	writeFileSync(join(cwd, "real.cpp"), "int real_target() { return 5; }\n", "utf8");
	writeFileSync(join(cwd, "src", "first.cpp"), "int first() { return 5; }\n", "utf8");
	writeFileSync(join(cwd, "src", "second.cpp"), "int second() { return 5; }\n", "utf8");
	writeFileSync(join(cwd, "lib", "CMakeLists.txt"), LIB_CMAKE, "utf8");
	writeFileSync(join(cwd, "lib", "core.cpp"), "int core() { return 5; }\n", "utf8");
	writeFileSync(join(cwd, "lib", "include", "core.hpp"), "int core();\n", "utf8");
	writeFileSync(join(cwd, "cmake", "Plugin.cmake"), "add_library(plugin MODULE\n  plugin.cpp\n)\n", "utf8");
	writeFileSync(join(cwd, "cmake", "plugin.cpp"), "int plugin() { return 6; }\n", "utf8");
}

function fileFor(codewiki: BuiltCodewiki, path: string): BuiltCodewiki["files"][number] | undefined {
	return codewiki.files.find((file) => file.path === path);
}

function hasInternalEdge(codewiki: BuiltCodewiki, fromPath: string, toPath: string): boolean {
	const from = fileFor(codewiki, fromPath);
	const to = fileFor(codewiki, toPath);
	if (!from || !to) return false;
	return codewiki.edges.some((edge) => edge.fileId === from.id && "toFileId" in edge && edge.toFileId === to.id);
}

function symbolAt(codewiki: BuiltCodewiki, path: string, name: string): BuiltCodewiki["symbols"][number] | undefined {
	const file = fileFor(codewiki, path);
	return file ? codewiki.symbols.find((symbol) => symbol.fileId === file.id && symbol.name === name) : undefined;
}

function parseToolOutput(output: string): Record<string, unknown> {
	const json = output.split("\n[", 1)[0] ?? output;
	const value: unknown = JSON.parse(json);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object tool output");
	return value as Record<string, unknown>;
}

describe("contracts/codewiki-cmake", () => {
	let scratch: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		scratch = mkdtempSync(join(tmpdir(), "clio-codewiki-cmake-"));
		writeFixture(scratch);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(scratch, { recursive: true, force: true });
	});

	it("indexes only literal declared-static targets, subdirectories, and source edges", async () => {
		const codewiki = await buildCodewiki({ cwd: scratch, language: "c++" });
		const expectedAppLine = ROOT_CMAKE.split("\n").indexOf("add_executable(") + 1;

		strictEqual(fileFor(codewiki, "CMakeLists.txt")?.lang, "config");
		strictEqual(fileFor(codewiki, "cmake/Plugin.cmake")?.lang, "config");
		deepStrictEqual(symbolAt(codewiki, "CMakeLists.txt", "app"), {
			name: "app",
			kind: "const",
			fileId: fileFor(codewiki, "CMakeLists.txt")?.id,
			line: expectedAppLine,
		});
		strictEqual(symbolAt(codewiki, "lib/CMakeLists.txt", "core")?.line, 1);
		strictEqual(symbolAt(codewiki, "cmake/Plugin.cmake", "plugin")?.line, 1);
		for (const excluded of ["commented_out", "bracket_commented", "quoted_fake", CMAKE_DYNAMIC_TARGET, "custom"]) {
			strictEqual(symbolAt(codewiki, "CMakeLists.txt", excluded), undefined, `${excluded} stays excluded`);
		}

		for (const dependency of ["lib/CMakeLists.txt", "src/main.cpp", "src/quoted file.cc", "src/extra.cpp"]) {
			ok(hasInternalEdge(codewiki, "CMakeLists.txt", dependency), `${dependency} is a root CMake dependency`);
		}
		ok(hasInternalEdge(codewiki, "lib/CMakeLists.txt", "lib/core.cpp"));
		ok(hasInternalEdge(codewiki, "lib/CMakeLists.txt", "lib/include/core.hpp"));
		ok(hasInternalEdge(codewiki, "cmake/Plugin.cmake", "cmake/plugin.cpp"));
		strictEqual(hasInternalEdge(codewiki, "CMakeLists.txt", "src/dynamic-target.cpp"), false);
		strictEqual(hasInternalEdge(codewiki, "CMakeLists.txt", "src/custom.cpp"), false);
		strictEqual(hasInternalEdge(codewiki, "CMakeLists.txt", "real.cpp"), false, "ALIAS target is not a source");
		ok(hasInternalEdge(codewiki, "CMakeLists.txt", "src/first.cpp"), "unquoted literal lists split safely");
		ok(hasInternalEdge(codewiki, "CMakeLists.txt", "src/second.cpp"), "unquoted literal lists split safely");
		strictEqual(
			fileFor(codewiki, "CMakeLists.txt")?.imports.includes("./src/first.cpp;src/second.cpp"),
			false,
			"quoted semicolon lists never become a synthetic path",
		);
	});

	it("serves CMake targets, dependencies, and source dependents through code_nav", async () => {
		const codewiki = await buildCodewiki({ cwd: scratch, language: "c++" });
		writeCodewiki(scratch, codewiki);
		const indexedAt = new Date().toISOString();
		writeClioState(scratch, {
			version: 1,
			projectType: "c++",
			fingerprint: computeFingerprint(scratch, codewiki),
			codewikiVersion: codewiki.version,
			lastSessionAt: indexedAt,
			lastIndexedAt: indexedAt,
		});
		process.chdir(scratch);

		const symbol = await codeNavTool.run({ mode: "symbol", query: "core" });
		strictEqual(symbol.kind, "ok");
		const symbolPayload = parseToolOutput(symbol.output);
		ok(
			Array.isArray(symbolPayload.symbols) &&
				symbolPayload.symbols.some(
					(item) =>
						typeof item === "object" &&
						item !== null &&
						(item as Record<string, unknown>).path === "lib/CMakeLists.txt" &&
						(item as Record<string, unknown>).line === 1,
				),
		);

		const deps = await codeNavTool.run({ mode: "deps", query: "CMakeLists.txt" });
		strictEqual(deps.kind, "ok");
		const depLists = parseToolOutput(deps.output).deps as { internal?: unknown };
		ok(Array.isArray(depLists.internal) && depLists.internal.includes("lib/CMakeLists.txt"));
		ok(Array.isArray(depLists.internal) && depLists.internal.includes("src/main.cpp"));

		const dependents = await codeNavTool.run({ mode: "dependents", query: "src/main.cpp" });
		strictEqual(dependents.kind, "ok");
		const importerPaths = parseToolOutput(dependents.output).dependents;
		ok(Array.isArray(importerPaths) && importerPaths.includes("CMakeLists.txt"));
	});

	it("keeps incremental CMake updates byte-equal to a full rebuild", async () => {
		const initial = await buildCodewiki({ cwd: scratch, language: "c++" });
		writeFileSync(join(scratch, "src", "late.cpp"), "int late() { return 7; }\n", "utf8");
		writeFileSync(join(scratch, "CMakeLists.txt"), `${ROOT_CMAKE}target_sources(app PRIVATE src/late.cpp)\n`, "utf8");

		const incremental = await updateCodewikiPaths(scratch, initial, ["CMakeLists.txt", "src/late.cpp"]);
		const rebuilt = await buildCodewiki({ cwd: scratch, language: "c++" });

		strictEqual(serializeCodewiki(incremental), serializeCodewiki(rebuilt));
		ok(hasInternalEdge(incremental, "CMakeLists.txt", "src/late.cpp"));
	});
});
