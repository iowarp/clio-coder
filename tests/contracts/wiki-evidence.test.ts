import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { validateWikiPageEvidence } from "../../src/domains/context/wiki/evidence.js";

let sandbox: string;
let root: string;
function check(content: string) {
	return validateWikiPageEvidence({ sourceRoot: root, pagePath: "area.md", content });
}
function page(reference = "src/main.ts", body = "The entry point is implemented here.") {
	return `---\nsources: [${JSON.stringify(reference)}]\n---\n# Area\n\n${body}\n`;
}

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "wiki-evidence-"));
	root = join(sandbox, "repo");
	mkdirSync(join(root, "src"), { recursive: true });
	mkdirSync(join(root, "tests"));
	writeFileSync(join(root, "src/main.ts"), "first\nsecond\nthird\n");
	writeFileSync(join(root, "tests/main.test.ts"), "test\n");
	writeFileSync(join(root, "package.json"), "{}\n");
	writeFileSync(join(root, "Makefile"), "all:\n");
});
afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

describe("wiki mechanical evidence gate", () => {
	it("accepts readable pages without a mandatory template and resolves JS source aliases", () => {
		deepStrictEqual(check(page("src/main.js", "See `src/main.js:1-3` and `tests/main.test.ts#L1`.")), {
			ok: true,
			reasons: [],
		});
		strictEqual(check("See `package.json:1` and `Makefile`. No frontmatter is required.").ok, true);
	});

	it("rejects empty, metadata-only, headings-only and comments-only bodies", () => {
		for (const body of ["", "# Heading", "<!-- placeholder -->", "# Heading\n\n<!-- placeholder -->"]) {
			const result = check(page("src/main.ts", body));
			strictEqual(result.ok, false);
			match(result.reasons.join(" "), /nonempty page body/);
		}
		strictEqual(check("This page has no source evidence.").ok, false);
	});

	it("rejects every unresolved authored source/test before metadata repair can discard it", () => {
		const content = "---\nsources: [src/main.ts, src/invented.ts]\ntests: [tests/invented.test.ts]\n---\nBody.";
		const result = check(content);
		strictEqual(result.ok, false);
		match(result.reasons.join(" "), /src\/invented.ts/);
		match(result.reasons.join(" "), /tests\/invented.test.ts/);
		strictEqual(check(page("src/main.ts", "See `other/invented.py:2` or `missing.py`.")).ok, false);
	});

	it("rejects malformed metadata instead of certifying the parser's fallback", () => {
		for (const block of [
			"sources: src/main.ts",
			"tests: [123]",
			"sources: [",
			"sources: []\nsources: []",
			"- src/main.ts",
		]) {
			strictEqual(check(`---\n${block}\n---\nSee \`src/main.ts\`.`).ok, false);
		}
		strictEqual(check("---\nsources: [src/main.ts]\nSee `src/main.ts`.").ok, false);
	});

	it("keeps frontmatter references compatible with assembly resolution", () => {
		strictEqual(check(page("src/main.ts:1")).ok, false);
	});

	it("checks inclusive line bounds, zero, reversed, malformed and absent final-newline cases", () => {
		for (const ref of [
			"src/main.ts:0",
			"src/main.ts:4",
			"src/main.ts:3-2",
			"src/main.ts:2-4",
			"src/main.ts#L1-L4",
			"src/main.ts:-2",
			"src/main.ts:1-",
			"src/main.ts:9007199254740993",
		]) {
			strictEqual(check(page("src/main.ts", `See \`${ref}\`.`)).ok, false, ref);
		}
		writeFileSync(join(root, "src/main.ts"), "first\nsecond");
		strictEqual(check(page("src/main.ts", "See `src/main.ts:2:main`.")).ok, true);
		strictEqual(check(page("src/main.ts", "See `src/main.ts#L2-L3`.")).ok, false);
		writeFileSync(join(root, "src/main.ts"), "");
		strictEqual(check(page("src/main.ts", "See `src/main.ts:1`.")).ok, false);
	});

	it("rejects traversal, absolute paths, directories and symlink escapes but permits internal aliases", () => {
		writeFileSync(join(sandbox, "outside.ts"), "outside\n");
		symlinkSync(join(sandbox, "outside.ts"), join(root, "src/escape.ts"));
		symlinkSync(sandbox, join(root, "external"));
		symlinkSync(join(root, "src/main.ts"), join(root, "src/alias.ts"));
		for (const ref of ["../outside.ts", join(sandbox, "outside.ts"), "src/escape.ts", "external/outside.ts", "src"]) {
			strictEqual(check(page(ref)).ok, false, ref);
		}
		strictEqual(check(page("src/main.ts", "See `../outside.ts:1`.")).ok, false);
		strictEqual(check(page("src/alias.ts", "See `src/alias.ts:1`.")).ok, true);
	});

	it("does not interpret commands, config keys, versions, decision refs, fences or wiki links as evidence", () => {
		const prose =
			"Run `npm test -- src/missing.ts`; set `cache.enabled`; version `1.2.3`; decision `set/key`; [next](missing.md); `https://host/missing.ts`.\n\n```ts\nconst example = `src/example.ts`;\n```";
		strictEqual(check(page("src/main.ts", prose)).ok, true);
		strictEqual(check(prose).ok, false);
	});

	it("fails closed on unavailable roots and bounds retry reasons and IO", () => {
		const content = page("src/main.ts");
		rmSync(root, { recursive: true });
		strictEqual(check(content).ok, false);
		mkdirSync(root);
		const refs = Array.from({ length: 20 }, (_, i) => `missing-${i}.ts`);
		const result = check(`---\nsources: ${JSON.stringify(refs)}\n---\nBody.`);
		strictEqual(result.reasons.length, 8);
		strictEqual(
			result.reasons.every((reason) => reason.length <= 300),
			true,
		);
		strictEqual(check("x".repeat(2 * 1024 * 1024 + 1)).ok, false);
		strictEqual(
			check(`---\nsources: ${JSON.stringify(Array.from({ length: 513 }, (_, i) => `f${i}.ts`))}\n---\nBody.`).ok,
			false,
		);
		writeFileSync(join(root, "large.ts"), "");
		truncateSync(join(root, "large.ts"), 4 * 1024 * 1024 + 1);
		match(check("See `large.ts:1`.").reasons.join(" "), /exceeds 4 MiB/);
	});
});
