import { ok, strictEqual } from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, it } from "node:test";

const DIST = new URL("../../dist/", import.meta.url).pathname;

function chunkContaining(marker: string): string {
	const match = readdirSync(DIST)
		.filter((file) => file.endsWith(".js"))
		.find((file) => readFileSync(join(DIST, file), "utf8").includes(marker));
	ok(match, `built chunk containing ${JSON.stringify(marker)}`);
	return match;
}

function staticImports(source: string): string[] {
	const imports: string[] = [];
	for (const pattern of [
		/^import\s+["']\.\/(.*?\.js)["'];/gmu,
		/^import\s+[\s\S]*?\sfrom\s+["']\.\/(.*?\.js)["'];/gmu,
	]) {
		for (const match of source.matchAll(pattern)) imports.push(match[1] ?? "");
	}
	return imports.filter(Boolean);
}

function staticClosure(entry: string): string[] {
	const seen = new Set<string>();
	function visit(file: string): void {
		if (seen.has(file)) return;
		seen.add(file);
		for (const dependency of staticImports(readFileSync(join(DIST, file), "utf8"))) visit(dependency);
	}
	visit(entry);
	return [...seen];
}

describe("instant-shell built import graph", () => {
	it("keeps the Stage 0 owner in a small leaf closure", () => {
		const entry = chunkContaining("src/interactive/terminal-lease.ts");
		const closure = staticClosure(entry);
		const bytes = closure.reduce((total, file) => total + statSync(join(DIST, file)).size, 0);
		const source = closure.map((file) => readFileSync(join(DIST, file), "utf8")).join("\n");

		strictEqual(closure.length <= 6, true, `Stage 0 closure grew to ${closure.length} chunks: ${closure.join(", ")}`);
		strictEqual(bytes <= 110_000, true, `Stage 0 closure grew to ${bytes} bytes`);
		for (const forbidden of [
			"src/entry/orchestrator.ts",
			"@earendil-works/pi-ai",
			"tree-sitter",
			"src/domains/tools/",
			"src/domains/context/codewiki/",
			"src/domains/providers/runtimes/cloud/",
		]) {
			strictEqual(source.includes(forbidden), false, `${basename(entry)} eagerly contains ${forbidden}`);
		}
	});

	it("keeps the pre-Stage 0 target check off provider implementation graphs", () => {
		const entry = chunkContaining("injected Stage 1 hydration failure");
		const source = staticClosure(entry)
			.map((file) => readFileSync(join(DIST, file), "utf8"))
			.join("\n");
		for (const forbidden of [
			'from "@earendil-works/pi-ai',
			"src/engine/oauth.ts",
			"src/domains/providers/runtimes/cloud/",
		]) {
			strictEqual(source.includes(forbidden), false, `interactive preflight eagerly contains ${forbidden}`);
		}
	});
});
