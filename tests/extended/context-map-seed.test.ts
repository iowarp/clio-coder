import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	Codewiki,
	CodewikiEdge,
	CodewikiFile,
	CodewikiSymbol,
} from "../../src/domains/context/codewiki/schema.js";
import {
	buildArchitectureSeed,
	MAX_SEED_COMPONENTS,
	MAX_SEED_CONNECTIONS,
	serializeArchitectureSeed,
} from "../../src/domains/context/wiki/map-seed.js";

/**
 * The architecture seed `clio-coder context map` writes: a model-free archify
 * spec whose components, connections, and source lines all come from the
 * codewiki index and nothing else.
 */

function file(id: string, path: string, loc: number, role: CodewikiFile["role"] = "module"): CodewikiFile {
	return { id, path, lang: "typescript", loc, role, hash: `h-${id}`, imports: [] };
}

/** A small repo: a cli area with entry points, an api area, a store area, and 14 tiny areas to overflow the cap. */
function fixture(): Codewiki {
	const files: CodewikiFile[] = [
		file("cli1", "src/cli/index.ts", 120, "entry"),
		file("cli2", "src/cli/run.ts", 80),
		file("cli3", "src/cli/help.ts", 20),
		file("cli4", "src/cli/flags.ts", 200),
		file("api1", "src/domains/api/router.ts", 300),
		file("api2", "src/domains/api/handlers.ts", 250),
		file("api3", "src/domains/api/errors.ts", 40),
		file("st1", "src/domains/store/db.ts", 500),
		file("st2", "src/domains/store/migrations.ts", 90),
		file("cfg", "package.json", 30, "config"),
	];
	for (let index = 0; index < 14; index += 1) {
		files.push(file(`tiny${index}`, `src/extras/area${index}/one.ts`, 10 + index));
	}
	const symbols: CodewikiSymbol[] = [
		{ name: "main", kind: "func", fileId: "cli1", line: 42 },
		{ name: "Flags", kind: "type", fileId: "cli4", line: 7 },
		{ name: "later", kind: "func", fileId: "cli4", line: 90 },
		{ name: "Router", kind: "class", fileId: "api1", line: 15 },
		{ name: "Db", kind: "class", fileId: "st1", line: 3 },
	];
	const edges: CodewikiEdge[] = [
		{ fileId: "cli1", toFileId: "api1" },
		{ fileId: "cli2", toFileId: "api1" },
		{ fileId: "cli1", toFileId: "cli2" },
		{ fileId: "api1", toFileId: "st1" },
		{ fileId: "api2", toFileId: "st1" },
		{ fileId: "api2", toFileId: "st2" },
		{ fileId: "api1", externalModule: "express" },
		{ fileId: "api2", externalModule: "express/lib/router" },
		{ fileId: "st1", externalModule: "pg" },
		{ fileId: "st1", externalModule: "node:fs" },
		{ fileId: "cli1", externalModule: "fs" },
	];
	return { version: 5, language: "typescript", files, symbols, edges };
}

// The fixture is a "simple" repository (under 150 files), so areas are one
// directory deep: every src/* file folds into the "src" area. Detailed area
// keys are exercised by forcing the size class up in the second test.
function detailedFixture(): Codewiki {
	const base = fixture();
	// Enough lines to classify as "detailed" (over 150k source lines) so the
	// area depth is 3 and src/domains/store is its own area.
	const padding: CodewikiFile[] = [];
	for (let index = 0; index < 20; index += 1) {
		padding.push(file(`pad${index}`, `src/padding/big${index}.ts`, 8000));
	}
	return { ...base, files: [...base.files, ...padding] };
}

const SHA = "0123456789abcdef0123456789abcdef01234567";
const PINNED = { url: "https://github.com/iowarp/clio-coder", revision: SHA };

describe("context map architecture seed", () => {
	it("keeps distinct directory and package identities when their display slugs collide", () => {
		const names = ["foo-bar", "foo_bar", "FOO-BAR", "foo-bar-2", "ext-react"];
		const files = names.map((name, index) => file(`f${index}`, `${name}/index.ts`, 10));
		const wiki: Codewiki = {
			version: 5,
			language: "typescript",
			files,
			symbols: [],
			edges: [
				{ fileId: "f0", toFileId: "f1" },
				...["react", "@scope/a", "scope-a"].map((externalModule) => ({ fileId: "f0", externalModule })),
			],
		};
		const seed = buildArchitectureSeed(wiki, { title: "colliding names" });
		strictEqual(seed.components.length, 8);
		strictEqual(seed.components.find((component) => component.label === "foo-bar-2")?.id, "foo-bar-2");
		strictEqual(seed.components.find((component) => component.label === "ext-react")?.id, "ext-react");
		strictEqual(new Set(seed.components.map((component) => component.id)).size, 8);
		strictEqual(new Set(seed.components.map((component) => `${component.row},${component.col}`)).size, 8);
		const from = seed.components.find((component) => component.label === "foo-bar");
		const to = seed.components.find((component) => component.label === "foo_bar");
		ok(from && to && from.id !== to.id);
		ok(seed.connections.some((edge) => edge.from === from.id && edge.to === to.id));
		ok(seed.components.every((component) => /^[a-z][a-z0-9_-]*$/i.test(component.id)));
		const permuted = { ...wiki, files: [...wiki.files].reverse(), edges: [...wiki.edges].reverse() };
		strictEqual(
			serializeArchitectureSeed(seed),
			serializeArchitectureSeed(buildArchitectureSeed(permuted, { title: "colliding names" })),
		);
	});

	it("keeps internal and external import counts separate when a directory matches a package", () => {
		const seed = buildArchitectureSeed(
			{
				version: 5,
				language: "typescript",
				symbols: [],
				files: [file("app", "app/index.ts", 10), file("react", "react/index.ts", 10)],
				edges: [
					{ fileId: "app", toFileId: "react" },
					{ fileId: "app", toFileId: "react" },
					{ fileId: "app", externalModule: "react" },
				],
			},
			{ title: "internal and external names" },
		);
		const internal = seed.components.find((component) => component.label === "react" && component.type !== "external");
		const external = seed.components.find((component) => component.label === "react" && component.type === "external");
		ok(internal && external);
		strictEqual(seed.connections.length, 2);
		strictEqual(seed.connections.find((edge) => edge.to === internal.id)?.label, "2 imports");
		strictEqual(seed.connections.find((edge) => edge.to === external.id)?.label, "1 import");
	});

	it("gives distinct connections unique ids when endpoint names contain the connection delimiter", () => {
		const seed = buildArchitectureSeed(
			{
				version: 5,
				language: "typescript",
				symbols: [],
				files: ["a", "a-to-b", "b-to-c", "b-to-c-2", "c"].map((name) => file(name, `${name}/index.ts`, 10)),
				edges: [
					{ fileId: "a", toFileId: "b-to-c" },
					{ fileId: "a-to-b", toFileId: "c" },
					{ fileId: "a", toFileId: "b-to-c-2" },
				],
			},
			{ title: "connection identities" },
		);
		strictEqual(seed.connections.length, 3);
		strictEqual(new Set(seed.connections.map((edge) => edge.id)).size, 3);
		strictEqual(seed.connections.find((edge) => edge.from === "a" && edge.to === "b-to-c-2")?.id, "a-to-b-to-c-2");
		deepStrictEqual(seed.connections.map(({ from, to }) => [from, to]).sort(), [
			["a", "b-to-c"],
			["a", "b-to-c-2"],
			["a-to-b", "c"],
		]);
	});

	it("caps primary components, maps types from directories and roles, and cites first-symbol lines", () => {
		const seed = buildArchitectureSeed(detailedFixture(), { title: "fixture", repository: PINNED });
		strictEqual(seed.schema_version, 1);
		strictEqual(seed.diagram_type, "architecture");
		strictEqual(seed.meta.quality_profile, "standard");
		deepStrictEqual(seed.layout.mode, "grid");
		strictEqual(seed.layout.cols, 4);
		const primary = seed.components.filter((component) => component.type !== "external");
		strictEqual(primary.length, MAX_SEED_COMPONENTS);
		// Descending file count: the padding area (20 files) leads, then cli (4), api (3), store (2).
		deepStrictEqual(
			primary.slice(0, 4).map((component) => component.label),
			["src/padding", "src/cli", "src/domains/api", "src/domains/store"],
		);
		const byId = new Map(seed.components.map((component) => [component.id, component]));
		strictEqual(byId.get("src-cli")?.type, "frontend");
		strictEqual(byId.get("src-domains-api")?.type, "backend");
		strictEqual(byId.get("src-domains-store")?.type, "database");
		strictEqual(byId.get("src-cli")?.sublabel, "4 files, 420 LOC");
		// Sources: top three by LOC, line = first symbol line; no symbol means no line.
		deepStrictEqual(byId.get("src-cli")?.sources, [
			{ line: 7, path: "src/cli/flags.ts" },
			{ line: 42, path: "src/cli/index.ts" },
			{ path: "src/cli/run.ts" },
		]);
		deepStrictEqual(byId.get("src-domains-store")?.sources, [
			{ line: 3, path: "src/domains/store/db.ts" },
			{ path: "src/domains/store/migrations.ts" },
		]);
		// Grid cells are unique and inside the column count.
		const cells = new Set(seed.components.map((component) => `${component.row},${component.col}`));
		strictEqual(cells.size, seed.components.length);
		ok(seed.components.every((component) => component.col < 4));
	});

	it("collapses import edges area to area, drops self edges, and adds top external packages", () => {
		const seed = buildArchitectureSeed(detailedFixture(), { title: "fixture" });
		const externals = seed.components.filter((component) => component.type === "external");
		deepStrictEqual(
			externals.map((component) => component.label),
			["express", "pg"],
			"runtime builtins are not dependencies; deep specifiers fold to their package",
		);
		const edges = new Map(seed.connections.map((connection) => [`${connection.from}>${connection.to}`, connection]));
		strictEqual(edges.get("src-cli>src-domains-api")?.label, "2 imports");
		strictEqual(edges.get("src-domains-api>src-domains-store")?.label, "3 imports");
		strictEqual(edges.get("src-domains-api>ext-express")?.label, "2 imports");
		strictEqual(edges.get("src-domains-store>ext-pg")?.label, "1 import");
		strictEqual(edges.has("src-cli>src-cli"), false);
		ok(seed.connections.length <= MAX_SEED_CONNECTIONS);
		ok(seed.connections.every((connection) => /^[a-z][a-z0-9_-]*$/i.test(connection.id)));
	});

	it("serializes deterministically with sorted keys", () => {
		const first = serializeArchitectureSeed(buildArchitectureSeed(fixture(), { title: "fixture" }));
		const second = serializeArchitectureSeed(buildArchitectureSeed(fixture(), { title: "fixture" }));
		strictEqual(first, second);
		const parsed = JSON.parse(first) as Record<string, unknown>;
		deepStrictEqual(Object.keys(parsed), [
			"components",
			"connections",
			"diagram_type",
			"layout",
			"meta",
			"schema_version",
		]);
	});

	it("records meta.repository only for a GitHub remote at a full revision, and cites sources only then", () => {
		const github = buildArchitectureSeed(fixture(), {
			title: "fixture",
			repository: { url: PINNED.url, revision: SHA.toUpperCase() },
		});
		deepStrictEqual(github.meta.repository, PINNED);
		ok(github.components.some((component) => component.sources !== undefined));
		const gitlab = buildArchitectureSeed(fixture(), {
			title: "fixture",
			repository: { url: "https://gitlab.com/iowarp/clio-coder", revision: SHA },
		});
		strictEqual(gitlab.meta.repository, undefined);
		const short = buildArchitectureSeed(fixture(), {
			title: "fixture",
			repository: { url: PINNED.url, revision: "abc1234" },
		});
		strictEqual(short.meta.repository, undefined);
		const none = buildArchitectureSeed(fixture(), { title: "fixture" });
		strictEqual(none.meta.repository, undefined);
		// Archify rejects `sources` without a pinned repository, so an unpinned
		// seed cites nothing instead of failing validation.
		ok(none.components.every((component) => component.sources === undefined));
		ok(gitlab.components.every((component) => component.sources === undefined));
	});
});
