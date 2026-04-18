import { ok, strictEqual, throws } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { FileKnowledgeBase } from "../../../src/domains/providers/types/knowledge-base.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "providers", "kb");

describe("providers/knowledge-base FileKnowledgeBase", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-kb-"));
	});

	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it("succeeds on an empty directory with zero entries", () => {
		const kb = new FileKnowledgeBase(scratch);
		strictEqual(kb.entries().length, 0);
		strictEqual(kb.lookup("anything"), null);
	});

	it("throws from the constructor when the directory does not exist", () => {
		throws(() => new FileKnowledgeBase(join(scratch, "missing")));
	});

	it("accepts both .yaml and .yml files", () => {
		writeFileSync(
			join(scratch, "a.yaml"),
			["- family: fa", "  matchPatterns: [fa]", "  capabilities:", "    chat: true", ""].join("\n"),
			"utf8",
		);
		writeFileSync(
			join(scratch, "b.yml"),
			["- family: fb", "  matchPatterns: [fb]", "  capabilities:", "    tools: true", ""].join("\n"),
			"utf8",
		);
		const kb = new FileKnowledgeBase(scratch);
		strictEqual(kb.entries().length, 2);
	});

	it("raises a helpful error when a YAML file is not a list of entries", () => {
		writeFileSync(join(scratch, "bad.yaml"), ["family: not-a-list", "capabilities: {}", ""].join("\n"), "utf8");
		throws(
			() => new FileKnowledgeBase(scratch),
			(err: Error) => err.message.includes("must be a YAML list"),
		);
	});

	it("rejects entries that omit the 'family' string", () => {
		writeFileSync(join(scratch, "no-family.yaml"), ["- matchPatterns: [x]", "  capabilities: {}", ""].join("\n"), "utf8");
		throws(
			() => new FileKnowledgeBase(scratch),
			(err: Error) => err.message.includes("'family'"),
		);
	});

	it("lookup('qwen3-72b') hits the qwen3 entry from the shared fixture", () => {
		const kb = new FileKnowledgeBase(FIXTURE_DIR);
		const hit = kb.lookup("qwen3-72b");
		ok(hit, "expected a knowledge base hit for qwen3-72b");
		strictEqual(hit.entry.family, "qwen3");
		strictEqual(hit.entry.capabilities.reasoning, true);
	});

	it("longest matching pattern wins on ties", () => {
		writeFileSync(
			join(scratch, "ties.yaml"),
			[
				"- family: short",
				"  matchPatterns: [q]",
				"  capabilities:",
				"    chat: true",
				"",
				"- family: long",
				"  matchPatterns: [qwen3-72b]",
				"  capabilities:",
				"    tools: true",
				"",
			].join("\n"),
			"utf8",
		);
		const kb = new FileKnowledgeBase(scratch);
		const hit = kb.lookup("qwen3-72b");
		ok(hit);
		strictEqual(hit.entry.family, "long");
	});

	it("returns null when no pattern substring matches the id", () => {
		const kb = new FileKnowledgeBase(FIXTURE_DIR);
		strictEqual(kb.lookup("entirely-different-model"), null);
	});
});
