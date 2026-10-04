import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { it } from "node:test";
import type { Codewiki } from "../../src/domains/context/codewiki/schema.js";
import { buildRepoMap, renderRepoMap } from "../../src/domains/context/wiki/repo-map.js";

function fixture(): Codewiki {
	return {
		version: 5,
		language: "typescript",
		files: [
			{ id: "app", path: "app/main.ts", lang: "typescript", role: "entry", loc: 10, hash: "app", imports: [] },
			{ id: "store", path: "store/value.ts", lang: "typescript", role: "module", loc: 10, hash: "store", imports: [] },
		],
		symbols: [{ name: "main", kind: "func", fileId: "app", line: 2 }],
		edges: [
			{ fileId: "app", toFileId: "store" },
			{ fileId: "app", externalModule: "@scope/pkg/deep" },
			{ fileId: "app", externalModule: "node:fs/promises" },
		],
	};
}

it("maps directional import evidence, symbols and external packages without conflating calls", () => {
	const map = buildRepoMap(fixture(), "Example");
	const from = map.areas.find((a) => a.path === "app");
	const to = map.areas.find((a) => a.path === "store");
	ok(from && to);
	deepStrictEqual(map.relationships, [
		{ from: from.id, to: to.id, imports: [{ path: "app/main.ts", target: "store/value.ts" }] },
	]);
	deepStrictEqual(map.dependencies, [{ name: "@scope/pkg", paths: ["app/main.ts"] }]);
	const html = renderRepoMap(map, { sourceState: "unknown" });
	match(html, /app\/main.ts:2/);
	match(html, /<details class="area"/);
	ok(!html.includes("/blob/"));
});

it("bounds the overview while keeping every file available in detail", () => {
	const wiki = fixture();
	const first = wiki.files[0];
	ok(first);
	for (let i = 0; i < 20; i++) wiki.files.push({ ...first, id: `extra-${i}`, path: `area-${i}/entry.ts` });
	const map = buildRepoMap(wiki, "Large");
	strictEqual(map.areas.length, 8);
	strictEqual(map.areas.flatMap((a) => a.files).length, wiki.files.length);
	const html = renderRepoMap(map, { sourceState: "dirty" });
	for (const file of wiki.files) ok(html.includes(file.path));
});

it("escapes repository text and only adds remote source links for a verified clean snapshot", () => {
	const wiki = fixture();
	const symbol = wiki.symbols[0];
	ok(symbol);
	symbol.name = '</script><img src=x onerror="alert(1)">';
	const map = buildRepoMap(wiki, "<script>alert(1)</script>");
	const repository = { url: "https://github.com/example/repo", revision: "a".repeat(40) };
	const clean = renderRepoMap(map, { sourceState: "clean", repository });
	match(clean, /repo\/blob\/a{40}\/app\/main.ts#L2/);
	ok(!clean.includes("<img src=x"));
	ok(!clean.includes("<script>alert(1)"));
	ok(!renderRepoMap(map, { sourceState: "dirty", repository }).includes("/blob/"));
	ok(
		!renderRepoMap(map, { sourceState: "clean", repository: { ...repository, url: "javascript:alert(1)" } }).includes(
			"/blob/",
		),
	);
});
