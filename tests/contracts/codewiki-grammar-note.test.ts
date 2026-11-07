import { equal, match, ok } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { scratchClioEnvVars } from "../harness/scratch-env.js";

// A code map written before files recorded whether their first-use grammar loaded (review-a3-6) has no
// per-file record. For those files the grammar's cache file is the only evidence left: without it on disk no
// process could have parsed them, so code_nav must keep saying their symbols came from line patterns.
const home = mkdtempSync(join(tmpdir(), "clio-coder-grammar-note-"));
Object.assign(process.env, scratchClioEnvVars(home), { HOME: home });
const { resetXdgCache } = await import("../../src/core/xdg.js");
resetXdgCache();
const { readCodewiki, codemapPath, codewikiNeedsBackfill } = await import(
	"../../src/domains/context/codewiki/artifact.js"
);
const { buildCodewiki, codewikiPathsNeedUpdate, syncCodewiki } = await import(
	"../../src/domains/context/codewiki/indexer.js"
);
const { fetchedGrammarAsset, missingGrammarNote } = await import(
	"../../src/domains/context/codewiki/fetched-grammars.js"
);
const { FETCHED_GRAMMARS } = await import("../../src/domains/context/codewiki/grammar-assets.js");
after(() => rmSync(home, { recursive: true, force: true }));

function cacheRubyGrammar(): void {
	const ruby = FETCHED_GRAMMARS.find((grammar) => grammar.lang === "ruby");
	ok(ruby);
	const asset = fetchedGrammarAsset(ruby);
	mkdirSync(dirname(asset.path), { recursive: true });
	writeFileSync(
		asset.path,
		readFileSync(new URL("../../node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-ruby.wasm", import.meta.url)),
	);
}

const project = join(home, "legacy-ruby");
const legacyMap = {
	version: 5,
	language: "unknown",
	files: [
		{
			id: "f_1",
			path: "lib/a.rb",
			lang: "ruby",
			loc: 3,
			bytes: 17,
			role: "module",
			hash: "0123456789abcdef",
			imports: [],
		},
	],
	symbols: [{ name: "one", kind: "func", fileId: "f_1", line: 1 }],
	edges: [],
};

describe("code_nav grammar note for a map without per-file grammar records", () => {
	it("warns about a Ruby file while the Ruby grammar is not on disk", () => {
		mkdirSync(dirname(codemapPath(project)), { recursive: true });
		writeFileSync(codemapPath(project), `${JSON.stringify(legacyMap)}\n`);
		const files = readCodewiki(project)?.files;
		ok(files, "the existing map still loads");
		equal(files[0]?.grammarMissing, undefined);
		match(missingGrammarNote(files) ?? "", /^Ruby symbols come from line patterns/);
	});

	it("stops warning once the Ruby grammar is cached", () => {
		cacheRubyGrammar();
		equal(missingGrammarNote(readCodewiki(project)?.files ?? []), undefined);
	});
});

describe("a file indexed without its first-use grammar", () => {
	it("is parsed again once the grammar is cached, though its bytes did not change", async () => {
		const ruby = FETCHED_GRAMMARS.find((grammar) => grammar.lang === "ruby");
		ok(ruby);
		rmSync(dirname(fetchedGrammarAsset(ruby).path), { recursive: true, force: true });
		const offlineProject = join(home, "offline-ruby");
		mkdirSync(offlineProject, { recursive: true });
		writeFileSync(join(offlineProject, "a.rb"), "class Two\n  def two\n    2\n  end\nend\n");
		const original = globalThis.fetch;
		globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
		let offline: Awaited<ReturnType<typeof buildCodewiki>>;
		try {
			offline = await buildCodewiki({ cwd: offlineProject, language: "unknown" });
		} finally {
			globalThis.fetch = original;
		}
		equal(offline.files[0]?.grammarMissing, true);
		equal(codewikiNeedsBackfill(offline), false, "nothing to reparse while the grammar is absent");

		cacheRubyGrammar();
		equal(codewikiNeedsBackfill(offline), true, "an unchanged fingerprint must not skip the reparse");
		equal(codewikiPathsNeedUpdate(offlineProject, offline, ["a.rb"]), true);
		const synced = await syncCodewiki(offlineProject, offline);
		equal(synced.files[0]?.grammarMissing, false);
		equal(missingGrammarNote(synced.files), undefined);
		equal(codewikiNeedsBackfill(synced), false);
	});
});
