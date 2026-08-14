/**
 * Slice 4: rigor resolution. Rigor is one attribute, orthogonal to autonomy.
 * These contracts pin the override grammar (`CLIO_CODER_RIGOR` parsing), the
 * repo-derived default keyed off a validation-contract file at the workspace
 * root, and the precedence of an explicit override over the repo default.
 */

import { strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseRigorOverride, resolveRigor } from "../../src/domains/safety/rigor.js";

describe("contracts/rigor parseRigorOverride", () => {
	it("accepts high and normal case-insensitively after trimming", () => {
		strictEqual(parseRigorOverride("high"), "high");
		strictEqual(parseRigorOverride("normal"), "normal");
		strictEqual(parseRigorOverride("  HIGH "), "high");
		strictEqual(parseRigorOverride("Normal"), "normal");
	});

	it("rejects anything else as no override", () => {
		strictEqual(parseRigorOverride(""), null);
		strictEqual(parseRigorOverride("strict"), null);
		strictEqual(parseRigorOverride(null), null);
		strictEqual(parseRigorOverride(undefined), null);
	});
});

describe("contracts/rigor resolveRigor", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "clio-rigor-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("defaults to normal when no validation contract is present", () => {
		strictEqual(resolveRigor({ cwd: dir }), "normal");
	});

	it("derives high when a root validation contract is present", () => {
		writeFileSync(path.join(dir, "validation.yaml"), "rules: []\n");
		strictEqual(resolveRigor({ cwd: dir }), "high");
	});

	it("recognizes the .clio-coder/validation.yaml convention too", () => {
		mkdirSync(path.join(dir, ".clio-coder"), { recursive: true });
		writeFileSync(path.join(dir, ".clio-coder", "validation.yaml"), "rules: []\n");
		strictEqual(resolveRigor({ cwd: dir }), "high");
	});

	it("lets an explicit override win over the repo-derived default", () => {
		writeFileSync(path.join(dir, "validation.yaml"), "rules: []\n");
		strictEqual(resolveRigor({ cwd: dir, override: "normal" }), "normal");
		strictEqual(resolveRigor({ cwd: dir, override: "high" }), "high");
		// A null override falls back to the repo-derived default.
		strictEqual(resolveRigor({ cwd: dir, override: null }), "high");
	});
});
