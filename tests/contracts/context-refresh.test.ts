import { notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	computeFingerprint,
	renderPromptContext,
	restampFingerprintFooter,
	runContextRefresh,
	serializeClioMd,
} from "../../src/domains/context/index.js";
import { readClioState } from "../../src/domains/context/state.js";

const scratchRoots: string[] = [];

afterEach(() => {
	for (const root of scratchRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function scratchProject(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-refresh-"));
	scratchRoots.push(root);
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "refresh-fixture", type: "module" }), "utf8");
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "index.ts"), "export const refreshFixtureSymbol = true;\n", "utf8");
	return root;
}

function writeFixtureClioMd(cwd: string): string {
	const text = serializeClioMd({
		projectName: "Refresh Fixture",
		identity: "Refresh Fixture is a TypeScript project used to test context refresh.",
		conventions: ["Keep prose byte-stable across refresh."],
		invariants: ["Refresh never edits prose."],
		fingerprint: {
			initAt: "2026-05-01T00:00:00.000Z",
			model: "test-model",
			gitHead: null,
			treeHash: "0".repeat(64),
			loc: 1,
		},
	});
	writeFileSync(join(cwd, "CLIO.md"), text, "utf8");
	return text;
}

function proseBeforeFooter(source: string): string {
	const index = source.indexOf("<!-- clio:fingerprint v1");
	return index === -1 ? source : source.slice(0, index);
}

describe("contracts/context-refresh", () => {
	it("rebuilds the codewiki and restamps only the fingerprint footer", async () => {
		const cwd = scratchProject();
		const before = writeFixtureClioMd(cwd);

		const result = await runContextRefresh({ cwd, now: () => new Date("2026-07-02T00:00:00.000Z") });
		strictEqual(result.action, "refreshed");
		ok(result.codewikiEntries >= 1, "codewiki indexed at least the fixture source file");
		strictEqual(result.clioMdRestamped, true);

		const after = readFileSync(join(cwd, "CLIO.md"), "utf8");
		notStrictEqual(after, before);
		// Prose byte-identical: only the footer comment changed.
		strictEqual(proseBeforeFooter(after), proseBeforeFooter(before));
		const footer = /<!-- clio:fingerprint v1\n([\s\S]*?)\n-->/.exec(after)?.[1] ?? "";
		const parsedFooter = JSON.parse(footer) as { initAt: string; model: string; treeHash: string; loc: number };
		strictEqual(parsedFooter.initAt, "2026-05-01T00:00:00.000Z");
		strictEqual(parsedFooter.model, "test-model");
		notStrictEqual(parsedFooter.treeHash, "0".repeat(64));
		ok(parsedFooter.loc >= 1);

		ok(existsSync(join(cwd, ".clio", "codewiki.json")), "codewiki.json written");
		const state = readClioState(cwd);
		strictEqual(state?.fingerprint.treeHash, computeFingerprint(cwd).treeHash);
	});

	it("clears the stale codewiki marker in the rendered project context", async () => {
		const cwd = scratchProject();
		writeFixtureClioMd(cwd);
		await runContextRefresh({ cwd });

		// Drift the tree, then confirm the marker points at /context refresh.
		writeFileSync(join(cwd, "src", "extra.ts"), "export const extra = 1;\n", "utf8");
		const stale = renderPromptContext(cwd);
		ok(stale.text.includes("(stale; run /context refresh)"));

		await runContextRefresh({ cwd });
		const fresh = renderPromptContext(cwd);
		strictEqual(fresh.text.includes("(stale;"), false);
		ok(fresh.text.includes("<codewiki>available; use code_nav</codewiki>"));
	});

	it("refreshes without CLIO.md and reports no restamp", async () => {
		const cwd = scratchProject();
		const result = await runContextRefresh({ cwd });
		strictEqual(result.clioMdRestamped, false);
		ok(existsSync(join(cwd, ".clio", "codewiki.json")));
		strictEqual(existsSync(join(cwd, "CLIO.md")), false);
	});

	it("restampFingerprintFooter leaves sources without a parseable footer untouched", () => {
		const fingerprint = { treeHash: "a".repeat(64), gitHead: "abc123", loc: 42 };
		strictEqual(restampFingerprintFooter("# No footer here\n", fingerprint), null);
		strictEqual(restampFingerprintFooter("<!-- clio:fingerprint v1\nnot json\n-->", fingerprint), null);

		const source =
			'# Title\n\nBody prose.\n\n<!-- clio:fingerprint v1\n{\n  "initAt": "x",\n  "model": "m",\n  "gitHead": null,\n  "treeHash": "old",\n  "loc": 1\n}\n-->\n';
		const restamped = restampFingerprintFooter(source, fingerprint);
		ok(restamped);
		ok(restamped.startsWith("# Title\n\nBody prose.\n\n<!-- clio:fingerprint v1\n"));
		ok(restamped.endsWith("-->\n"));
		ok(restamped.includes(`"treeHash": "${"a".repeat(64)}"`));
		ok(restamped.includes('"gitHead": "abc123"'));
		ok(restamped.includes('"loc": 42'));
		ok(restamped.includes('"initAt": "x"'), "provenance fields preserved");
	});
});
