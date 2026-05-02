import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { FileKnowledgeBase } from "../../../src/domains/providers/types/knowledge-base.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "providers", "kb");
const SOURCE_MODELS_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"src",
	"domains",
	"providers",
	"models",
);

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

	it("walks nested cloud-models and local-models directories", () => {
		mkdirSync(join(scratch, "cloud-models"));
		mkdirSync(join(scratch, "local-models"));
		writeFileSync(
			join(scratch, "cloud-models", "claude.yaml"),
			["- family: claude", "  matchPatterns: [claude]", "  capabilities:", "    chat: true", ""].join("\n"),
			"utf8",
		);
		writeFileSync(
			join(scratch, "local-models", "qwen.yaml"),
			["- family: qwen", "  matchPatterns: [qwen]", "  capabilities:", "    reasoning: true", ""].join("\n"),
			"utf8",
		);
		const kb = new FileKnowledgeBase(scratch);
		strictEqual(kb.entries().length, 2);
		strictEqual(kb.lookup("claude-opus")?.entry.family, "claude");
		strictEqual(kb.lookup("qwen3-72b")?.entry.family, "qwen");
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

	it("ships only the self-dev local target families in the production KB", () => {
		const kb = new FileKnowledgeBase(SOURCE_MODELS_DIR);
		deepStrictEqual(
			kb
				.entries()
				.map((entry) => entry.family)
				.sort(),
			[
				"gemma-4-31b-it-nvfp4-turbo",
				"gemma4-26b-a4b",
				"gemopus-4-31b-it",
				"nemotron-3-nano-omni-30b-a3b-reasoning",
				"nemotron-cascade-2-30b-a3b",
				"qwen3.5-35b-a3b-claude-4.6-opus-reasoning-distilled",
				"qwen3.6-27b",
				"qwen3.6-35b-a3b",
				"qwopus3.5-9b-v3",
				"qwopus3.6-27b-v1-preview",
			],
		);
		const qwen = kb.lookup("Qwen3.6-35B-A3B-UD-Q4_K_XL");
		ok(qwen, "expected Qwen3.6 MoE to match the production KB");
		strictEqual(qwen.entry.capabilities.contextWindow, 262144);
		strictEqual(qwen.entry.capabilities.maxTokens, 65536);
		strictEqual(qwen.entry.capabilities.thinkingFormat, "qwen-chat-template");

		const gemma = kb.lookup("gemma-4-26B-A4B-it-Q4_K_M");
		ok(gemma, "expected Gemma 4 MoE to match the production KB");
		strictEqual(gemma.entry.capabilities.contextWindow, 262144);
		strictEqual(gemma.entry.capabilities.maxTokens, 65536);
		strictEqual(gemma.entry.capabilities.vision, true);

		const nemotron = kb.lookup("Nemotron-Cascade-2-30B-A3B");
		ok(nemotron, "expected Nemotron Cascade 2 to match the production KB");
		strictEqual(nemotron.entry.capabilities.contextWindow, 1048576);
		strictEqual(nemotron.entry.capabilities.maxTokens, 65536);
		strictEqual(nemotron.entry.capabilities.vision, false);
		ok(kb.lookup("Nemotron-Cascade-2-30B-A3B-i1-Q4_K_M"), "expected real mini Nemotron Cascade GGUF id to match");

		const omni = kb.lookup("nvidia-nemotron-3-nano-omni-30b-a3b-reasoning");
		ok(omni, "expected Nemotron Omni to match the production KB");
		strictEqual(omni.entry.capabilities.contextWindow, 1048576);
		strictEqual(omni.entry.capabilities.maxTokens, 131072);
		strictEqual(omni.entry.capabilities.vision, true);
		strictEqual(omni.entry.capabilities.audio, true);
		ok(
			kb.lookup("Nemotron-3-Nano-Omni-30B-A3B-Reasoning-UD-Q4_K_M"),
			"expected real mini Nemotron Omni GGUF id to match",
		);

		const qwopus = kb.lookup("qwopus3.5-9b-v3");
		ok(qwopus, "expected Qwopus 9B to match the production KB");
		strictEqual(qwopus.entry.capabilities.contextWindow, 262144);
		strictEqual(qwopus.entry.capabilities.maxTokens, 32768);
		strictEqual(kb.lookup("claude-opus-4.5"), null);
	});
});
