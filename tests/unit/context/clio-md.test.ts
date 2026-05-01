import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { parseClioMd, serializeClioMd } from "../../../src/domains/context/clio-md.js";

const fingerprint = {
	initAt: "2026-05-01T00:00:00.000Z",
	model: "test-model",
	gitHead: null,
	treeHash: "0".repeat(64),
	loc: 12,
};

describe("context/clio-md", () => {
	it("parses a generated CLIO.md with a fingerprint footer", () => {
		const text = serializeClioMd({
			projectName: "Sample",
			identity: "Sample is a TypeScript project. It exists to test CLIO.md parsing.",
			conventions: ["Local imports end in `.js`."],
			invariants: ["Engine boundary. Only `src/engine/**` may value-import `@mariozechner/pi-*`."],
			fingerprint,
		});
		const parsed = parseClioMd(text);
		ok(parsed.ok);
		if (parsed.ok) {
			strictEqual(parsed.value.projectName, "Sample");
			strictEqual(parsed.value.firstInit, false);
			strictEqual(parsed.value.fingerprint?.treeHash, fingerprint.treeHash);
			strictEqual(parsed.value.conventions.length, 1);
			strictEqual(parsed.value.invariants.length, 1);
		}
	});

	it("allows user-authored CLIO.md without a footer", () => {
		const parsed = parseClioMd("# Sample\n\nSample is a project with a hand-written CLIO file.\n");
		ok(parsed.ok);
		if (parsed.ok) strictEqual(parsed.value.firstInit, true);
	});

	it("rejects more than six convention bullets", () => {
		const bullets = Array.from({ length: 7 }, (_, index) => `- rule ${index}`).join("\n");
		const parsed = parseClioMd(`# Sample\n\nSample is a project with too many rules.\n\n## Conventions\n\n${bullets}\n`);
		strictEqual(parsed.ok, false);
		if (!parsed.ok) ok(parsed.errors.some((error) => error.includes("at most 6")));
	});

	it("rejects a malformed generated footer", () => {
		const parsed = parseClioMd("# Sample\n\nSample is a project.\n\n<!-- clio:fingerprint v1\nnot json\n-->\n");
		strictEqual(parsed.ok, false);
	});
});
