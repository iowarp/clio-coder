import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createTreeSitterExtractor } from "../../src/domains/context/codewiki/tree-sitter.js";
import { buildCodewiki, structuralCodewikiHash, updateCodewikiPaths } from "../../src/domains/context/index.js";

type BuiltCodewiki = Awaited<ReturnType<typeof buildCodewiki>>;

function fileFor(codewiki: BuiltCodewiki, path: string): BuiltCodewiki["files"][number] | undefined {
	return codewiki.files.find((item) => item.path === path);
}

function hasSymbol(codewiki: BuiltCodewiki, path: string, name: string, kind?: string): boolean {
	const file = fileFor(codewiki, path);
	if (!file) return false;
	return codewiki.symbols.some(
		(symbol) => symbol.fileId === file.id && symbol.name === name && (!kind || symbol.kind === kind),
	);
}

function hasInternalEdge(codewiki: BuiltCodewiki, fromPath: string, toPath: string): boolean {
	const from = fileFor(codewiki, fromPath);
	const to = fileFor(codewiki, toPath);
	if (!from || !to) return false;
	return codewiki.edges.some((edge) => edge.fileId === from.id && "toFileId" in edge && edge.toFileId === to.id);
}

const PURE_C_HEADER = [
	"#ifndef VEC2_H_",
	"#define VEC2_H_",
	"",
	"#include <stddef.h>",
	"",
	"struct vec2 {",
	"  float x;",
	"  float y;",
	"};",
	"",
	"static inline size_t vec2_size(void) { return sizeof(struct vec2); }",
	"",
	"size_t vec2_dot(struct vec2 a, struct vec2 b);",
	"",
	"#endif",
	"",
].join("\n");

const EXTERN_C_WRAPPED_HEADER = [
	"#ifndef CAPI_H_",
	"#define CAPI_H_",
	"",
	"#ifdef __cplusplus",
	'extern "C" {',
	"#endif",
	"",
	"int capi_open(const char *path);",
	"static inline int capi_flag(void) { return 1; }",
	"",
	"#ifdef __cplusplus",
	"}",
	"#endif",
	"",
	"#endif",
	"",
].join("\n");

const CPP_HEADER = [
	"#ifndef SEEK_MODE_CONV_H_",
	"#define SEEK_MODE_CONV_H_",
	"",
	"#include <memory>",
	"",
	"namespace cte {",
	"",
	"enum class SeekMode { kNone, kSet };",
	"",
	"template <typename PosT>",
	"class SeekModeConv {",
	" public:",
	"  static SeekMode Normalize(int mpi_seek) {",
	"    return mpi_seek == 0 ? SeekMode::kSet : SeekMode::kNone;",
	"  }",
	"};",
	"",
	"}  // namespace cte",
	"",
	"#endif",
	"",
].join("\n");

const CUDA_HEADER = [
	"#ifndef FILL_KERNELS_CUH_",
	"#define FILL_KERNELS_CUH_",
	"",
	"namespace gpu {",
	"",
	"template <typename T>",
	"__global__ void fill_kernel(T *data, unsigned n) {",
	"  unsigned i = blockIdx.x * blockDim.x + threadIdx.x;",
	"  if (i < n) data[i] = T{};",
	"}",
	"",
	"class DeviceBuffer {",
	" public:",
	"  void *Get() { return data_; }",
	"",
	" private:",
	"  void *data_;",
	"};",
	"",
	"}  // namespace gpu",
	"",
	"#endif",
	"",
].join("\n");

const CUDA_SOURCE = [
	'#include "gpu/fill_kernels.cuh"',
	"",
	"int run_fill(float *data, unsigned n) {",
	"  gpu::fill_kernel<float><<<64, 256>>>(data, n);",
	"  return 0;",
	"}",
	"",
].join("\n");

describe("contracts/codewiki-c-family", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-codewiki-c-family-"));
	});

	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it("keeps pure C headers C, including extern C wrappers, with function symbols", async () => {
		mkdirSync(join(scratch, "include"), { recursive: true });
		writeFileSync(join(scratch, "include", "vec2.h"), PURE_C_HEADER, "utf8");
		writeFileSync(join(scratch, "include", "capi.h"), EXTERN_C_WRAPPED_HEADER, "utf8");

		const codewiki = await buildCodewiki({ cwd: scratch, language: "c" });

		strictEqual(fileFor(codewiki, "include/vec2.h")?.lang, "c");
		strictEqual(fileFor(codewiki, "include/capi.h")?.lang, "c");
		ok(hasSymbol(codewiki, "include/vec2.h", "vec2_size", "func"));
		ok(hasSymbol(codewiki, "include/vec2.h", "vec2_dot", "func"));
		ok(hasSymbol(codewiki, "include/vec2.h", "vec2", "type"));
		ok(hasSymbol(codewiki, "include/capi.h", "capi_flag", "func"));
		ok(hasSymbol(codewiki, "include/capi.h", "capi_open", "func"));
	});

	it("keeps quoted local C headers C instead of treating their names as standard C++ includes", async () => {
		writeFileSync(join(scratch, "local_string.h"), '#include "string"\nint local_string_size(void);\n', "utf8");

		const codewiki = await buildCodewiki({ cwd: scratch, language: "c" });
		strictEqual(fileFor(codewiki, "local_string.h")?.lang, "c");
		ok(hasSymbol(codewiki, "local_string.h", "local_string_size", "func"));
	});

	it("indexes declaration-only C++ APIs and out-of-class method definitions", async () => {
		const header = [
			"struct Widget {",
			"  Widget();",
			"  ~Widget();",
			"  int Get() const;",
			"  static void Put(int value);",
			"  int (*callback)(int);",
			"};",
			"int free_api(double value);",
			"",
		].join("\n");
		writeFileSync(join(scratch, "widget.h"), header, "utf8");
		writeFileSync(join(scratch, "widget.cpp"), '#include "widget.h"\nint Widget::Get() const { return 1; }\n', "utf8");

		const codewiki = await buildCodewiki({ cwd: scratch, language: "c++" });
		strictEqual(fileFor(codewiki, "widget.h")?.lang, "c++");
		for (const name of ["Widget", "~Widget", "Get", "Put"]) {
			ok(hasSymbol(codewiki, "widget.h", name, "method"), name);
		}
		ok(hasSymbol(codewiki, "widget.h", "free_api", "func"));
		strictEqual(hasSymbol(codewiki, "widget.h", "callback"), false);
		ok(hasSymbol(codewiki, "widget.cpp", "Get", "method"));
	});

	it("distinguishes namespace-qualified free functions from class methods", async () => {
		writeFileSync(
			join(scratch, "qualified.cpp"),
			["int science::run() { return 0; }", "int Solver::Step() { return 1; }", ""].join("\n"),
			"utf8",
		);

		const codewiki = await buildCodewiki({ cwd: scratch, language: "c++" });
		ok(hasSymbol(codewiki, "qualified.cpp", "run", "func"));
		strictEqual(hasSymbol(codewiki, "qualified.cpp", "run", "method"), false);
		ok(hasSymbol(codewiki, "qualified.cpp", "Step", "method"));
	});

	it("classifies reference-return and trailing-return free APIs as C++", async () => {
		writeFileSync(join(scratch, "free_api.h"), "int &value();\nauto count() -> int;\n", "utf8");

		const codewiki = await buildCodewiki({ cwd: scratch, language: "c++" });
		strictEqual(fileFor(codewiki, "free_api.h")?.lang, "c++");
		ok(hasSymbol(codewiki, "free_api.h", "value", "func"));
		ok(hasSymbol(codewiki, "free_api.h", "count", "func"));
	});

	it("classifies C++ headers from content and extracts class, method, and type symbols", async () => {
		mkdirSync(join(scratch, "adapter"), { recursive: true });
		writeFileSync(join(scratch, "adapter", "seek_mode_conv.h"), CPP_HEADER, "utf8");

		const codewiki = await buildCodewiki({ cwd: scratch, language: "c++" });

		const header = fileFor(codewiki, "adapter/seek_mode_conv.h");
		strictEqual(header?.lang, "c++");
		ok(header?.imports.includes("memory"));
		ok(hasSymbol(codewiki, "adapter/seek_mode_conv.h", "SeekModeConv", "class"));
		ok(hasSymbol(codewiki, "adapter/seek_mode_conv.h", "Normalize", "method"));
		ok(hasSymbol(codewiki, "adapter/seek_mode_conv.h", "SeekMode", "type"));
		// The return type of a definition must never be indexed as its name.
		strictEqual(hasSymbol(codewiki, "adapter/seek_mode_conv.h", "SeekMode", "method"), false);
	});

	it("indexes .cu and .cuh sources as C++ with symbols and include edges", async () => {
		mkdirSync(join(scratch, "gpu"), { recursive: true });
		writeFileSync(join(scratch, "gpu", "fill_kernels.cuh"), CUDA_HEADER, "utf8");
		writeFileSync(join(scratch, "launch.cu"), CUDA_SOURCE, "utf8");

		const codewiki = await buildCodewiki({ cwd: scratch, language: "c++" });

		strictEqual(fileFor(codewiki, "gpu/fill_kernels.cuh")?.lang, "c++");
		strictEqual(fileFor(codewiki, "launch.cu")?.lang, "c++");
		ok(hasSymbol(codewiki, "gpu/fill_kernels.cuh", "fill_kernel", "func"));
		ok(hasSymbol(codewiki, "gpu/fill_kernels.cuh", "DeviceBuffer", "class"));
		ok(hasSymbol(codewiki, "gpu/fill_kernels.cuh", "Get", "method"));
		ok(hasSymbol(codewiki, "launch.cu", "run_fill", "func"));
		ok(hasInternalEdge(codewiki, "launch.cu", "gpu/fill_kernels.cuh"));
	});

	it("switches ambiguous header classification when incremental updates change content", async () => {
		mkdirSync(join(scratch, "api"), { recursive: true });
		const headerPath = join(scratch, "api", "handle.h");
		writeFileSync(headerPath, PURE_C_HEADER, "utf8");
		const initial = await buildCodewiki({ cwd: scratch, language: "c" });
		strictEqual(fileFor(initial, "api/handle.h")?.lang, "c");

		writeFileSync(headerPath, CPP_HEADER, "utf8");
		const asCpp = await updateCodewikiPaths(scratch, initial, ["api/handle.h"]);
		strictEqual(fileFor(asCpp, "api/handle.h")?.lang, "c++");
		ok(hasSymbol(asCpp, "api/handle.h", "SeekModeConv", "class"));
		strictEqual(hasSymbol(asCpp, "api/handle.h", "vec2_size"), false);
		deepStrictEqual(asCpp, await buildCodewiki({ cwd: scratch, language: "c" }));

		writeFileSync(headerPath, PURE_C_HEADER, "utf8");
		const backToC = await updateCodewikiPaths(scratch, asCpp, ["api/handle.h"]);
		strictEqual(fileFor(backToC, "api/handle.h")?.lang, "c");
		ok(hasSymbol(backToC, "api/handle.h", "vec2_size", "func"));
		deepStrictEqual(backToC, await buildCodewiki({ cwd: scratch, language: "c" }));
	});

	it("rebuilds mixed C, C++, and CUDA trees deterministically", async () => {
		mkdirSync(join(scratch, "include"), { recursive: true });
		mkdirSync(join(scratch, "gpu"), { recursive: true });
		writeFileSync(join(scratch, "include", "vec2.h"), PURE_C_HEADER, "utf8");
		writeFileSync(join(scratch, "include", "seek_mode_conv.h"), CPP_HEADER, "utf8");
		writeFileSync(join(scratch, "gpu", "fill_kernels.cuh"), CUDA_HEADER, "utf8");
		writeFileSync(join(scratch, "launch.cu"), CUDA_SOURCE, "utf8");

		const first = await buildCodewiki({ cwd: scratch, language: "polyglot" });
		const second = await buildCodewiki({ cwd: scratch, language: "polyglot" });

		deepStrictEqual(first, second);
		strictEqual(structuralCodewikiHash(first), structuralCodewikiHash(second));
	});

	it("preloads both grammars an ambiguous header can select", async () => {
		const extractor = await createTreeSitterExtractor();
		await extractor.ensureGrammarsForPaths(["adapter/conv.h"]);

		// Content-classified C++ must reach the cpp grammar instead of throwing
		// into the regex fallback because only the C grammar was loaded.
		const cpp = extractor.extract("adapter/conv.h", "namespace cte {\nclass Conv {};\n}\n");
		ok(cpp.symbols.some((symbol) => symbol.name === "Conv" && symbol.kind === "class"));

		const c = extractor.extract("adapter/conv.h", "static inline int conv_flag(void) { return 1; }\n");
		ok(c.symbols.some((symbol) => symbol.name === "conv_flag" && symbol.kind === "func"));
	});
});
