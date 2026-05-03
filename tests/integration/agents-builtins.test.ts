import { ok, strictEqual } from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../../src/domains/agents/frontmatter.js";
import { MODE_MATRIX, type ModeName } from "../../src/domains/modes/matrix.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const BUILTINS_DIR = path.join(REPO_ROOT, "src", "domains", "agents", "builtins");

const EXPECTED_IDS: ReadonlyArray<string> = [
	// existing
	"context-builder",
	"delegate",
	"planner",
	"researcher",
	"reviewer",
	"scout",
	"worker",
	// new in v0.1.4 (M9)
	"attributor",
	"benchmark-runner",
	"debugger",
	"evolver",
	"memory-curator",
	"middleware-author",
	"regression-scout",
	"scientific-validator",
];

const VALID_MODES: ReadonlyArray<ModeName> = ["advise", "default", "super"];

/**
 * Pattern that flags em-dash clause separators (the LLM "noun - clause" tell).
 * Matches: word, whitespace, dash, whitespace, word.
 * Does not match compound hyphens like `fire-and-forget` (no surrounding whitespace).
 */
const EM_DASH_CLAUSE = /\w\s-\s\w/;

interface Builtin {
	id: string;
	frontmatter: Record<string, unknown>;
	body: string;
	filepath: string;
}

function loadBuiltins(): ReadonlyArray<Builtin> {
	const entries = readdirSync(BUILTINS_DIR, { withFileTypes: true });
	const recipes: Builtin[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (!entry.name.endsWith(".md")) continue;
		const filepath = path.join(BUILTINS_DIR, entry.name);
		const id = path.basename(entry.name, ".md");
		const raw = readFileSync(filepath, "utf8");
		const { frontmatter, body } = parseFrontmatter(raw, filepath);
		recipes.push({ id, frontmatter, body, filepath });
	}
	recipes.sort((a, b) => a.id.localeCompare(b.id));
	return recipes;
}

describe("agents/builtins enumeration", () => {
	it("contains exactly the expected ids", () => {
		const recipes = loadBuiltins();
		const actual = recipes.map((r) => r.id).sort();
		const expected = [...EXPECTED_IDS].sort();
		strictEqual(
			actual.length,
			expected.length,
			`expected ${expected.length} builtins, got ${actual.length}: ${actual.join(",")}`,
		);
		for (let i = 0; i < expected.length; i += 1) {
			strictEqual(actual[i], expected[i], `mismatch at index ${i}: actual=${actual[i]} expected=${expected[i]}`);
		}
	});
});

describe("agents/builtins frontmatter", () => {
	for (const id of EXPECTED_IDS) {
		it(`${id}: frontmatter shape matches the recipe contract`, () => {
			const recipes = loadBuiltins();
			const recipe = recipes.find((r) => r.id === id);
			ok(recipe, `recipe ${id} not found`);
			const fm = recipe.frontmatter;

			ok(typeof fm.name === "string" && fm.name.length > 0, `${id}: name must be a non-empty string`);
			ok(typeof fm.description === "string" && fm.description.length > 0, `${id}: description must be a non-empty string`);
			const description = fm.description as string;
			ok(
				!EM_DASH_CLAUSE.test(description),
				`${id}: description contains em-dash clause separator: ${JSON.stringify(description)}`,
			);

			ok(
				typeof fm.mode === "string" && VALID_MODES.includes(fm.mode as ModeName),
				`${id}: mode must be one of ${VALID_MODES.join(",")}`,
			);

			ok(Array.isArray(fm.tools), `${id}: tools must be an array`);
			const tools = fm.tools as ReadonlyArray<unknown>;
			for (const t of tools) {
				ok(typeof t === "string" && t.length > 0, `${id}: every tool must be a non-empty string`);
			}

			strictEqual(fm.model, null, `${id}: model must be null`);
			strictEqual(fm.provider, null, `${id}: provider must be null`);
			strictEqual(fm.runtime, "native", `${id}: runtime must be 'native'`);
			ok(Array.isArray(fm.skills), `${id}: skills must be an array`);
			strictEqual((fm.skills as ReadonlyArray<unknown>).length, 0, `${id}: skills must be empty`);
		});
	}
});

describe("agents/builtins mode matrix subset", () => {
	for (const id of EXPECTED_IDS) {
		it(`${id}: declared tools are a subset of its mode allow-list`, () => {
			const recipes = loadBuiltins();
			const recipe = recipes.find((r) => r.id === id);
			ok(recipe, `recipe ${id} not found`);
			const mode = recipe.frontmatter.mode as ModeName;
			const tools = recipe.frontmatter.tools as ReadonlyArray<string>;

			// MODE_MATRIX is the canonical source of truth (src/domains/modes/matrix.ts).
			// Tool admission at the registry layer derives from this same matrix.
			const allowed = MODE_MATRIX[mode].tools;
			for (const t of tools) {
				ok(
					allowed.has(t as never),
					`${id}: tool '${t}' not allowed in mode '${mode}'. allowed=[${[...allowed].join(",")}]`,
				);
			}
		});
	}
});

describe("agents/builtins body sanity", () => {
	for (const id of EXPECTED_IDS) {
		it(`${id}: body is non-empty markdown without em-dash clause separators`, () => {
			const recipes = loadBuiltins();
			const recipe = recipes.find((r) => r.id === id);
			ok(recipe, `recipe ${id} not found`);
			const body = recipe.body;

			ok(body.length > 200, `${id}: body must be >200 chars (got ${body.length})`);
			const trimmed = body.replace(/^\s+/, "");
			ok(trimmed.startsWith("# "), `${id}: body must start with a markdown header '# '`);

			// Scan body for the same banned pattern as descriptions.
			const lines = body.split(/\r?\n/);
			for (let i = 0; i < lines.length; i += 1) {
				const line = lines[i];
				if (line === undefined) continue;
				ok(
					!EM_DASH_CLAUSE.test(line),
					`${id}: body line ${i + 1} contains em-dash clause separator: ${JSON.stringify(line)}`,
				);
			}
		});
	}
});
