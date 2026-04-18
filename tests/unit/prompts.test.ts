import { notStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import { canonicalJson, sha256 } from "../../src/domains/prompts/hash.js";

describe("prompts/hash", () => {
	it("sha256 known vector for empty string", () => {
		strictEqual(sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	});

	it("sha256 is stable", () => {
		strictEqual(sha256("clio"), sha256("clio"));
	});

	it("sha256 differs for different inputs", () => {
		notStrictEqual(sha256("a"), sha256("b"));
	});
});

describe("prompts/canonicalJson", () => {
	it("sorts object keys alphabetically", () => {
		strictEqual(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
	});

	it("preserves array element order", () => {
		strictEqual(canonicalJson([3, 1, 2]), "[3,1,2]");
	});

	it("drops undefined in objects", () => {
		strictEqual(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
	});

	it("serialises null", () => {
		strictEqual(canonicalJson(null), "null");
	});

	it("produces byte-identical output for structurally equal objects", () => {
		strictEqual(canonicalJson({ x: { a: 1, b: 2 }, y: [1, 2] }), canonicalJson({ y: [1, 2], x: { b: 2, a: 1 } }));
	});

	it("throws on non-finite numbers", () => {
		throws(() => canonicalJson(Number.POSITIVE_INFINITY));
		throws(() => canonicalJson(Number.NaN));
	});

	it("throws on bigint", () => {
		throws(() => canonicalJson(1n));
	});

	it("throws on function", () => {
		throws(() => canonicalJson(() => 0));
	});

	it("throws on undefined at root", () => {
		throws(() => canonicalJson(undefined));
	});
});

describe("prompts/fragments identity.clio anti-leak content", () => {
	it("loads identity.clio with the Clio repetition + vendor rejection clauses", () => {
		const table = loadFragments();
		const identity = table.byId.get("identity.clio");
		ok(identity, "identity.clio must be registered");
		const body = identity?.body ?? "";
		// Triple repetition anchors the name. Keeps Qwen3.6 from drifting to a
		// Claude-synthetic self-image on the first turn.
		ok(body.includes("You are Clio. You are Clio. You are Clio."), "identity must triple-assert the Clio name");
		// IOWarp is the organizational anchor. Without it the model hedges.
		ok(body.includes("IOWarp"), "identity must anchor the IOWarp org");
		// Explicit rejection list keeps Claude-synthetic output from bleeding
		// through the prompt.
		ok(body.includes("not Claude"), "identity must reject Claude origin");
		ok(body.includes("GPT"), "identity must reject GPT origin");
		ok(body.includes("Qwen"), "identity must reject Qwen origin");
		ok(body.includes("Anthropic"), "identity must reject Anthropic vendor");
		ok(body.includes("OpenAI"), "identity must reject OpenAI vendor");
		ok(body.includes("Alibaba"), "identity must reject Alibaba vendor");
	});

	it("identity.clio is static (no template placeholders)", () => {
		const table = loadFragments();
		const identity = table.byId.get("identity.clio");
		ok(identity);
		strictEqual(identity?.dynamic, false);
		strictEqual(/\{\{[A-Za-z][A-Za-z0-9]*\}\}/.test(identity?.body ?? ""), false);
	});

	it("identity.clio contentHash is deterministic across two loads", () => {
		const a = loadFragments();
		const b = loadFragments();
		strictEqual(a.byId.get("identity.clio")?.contentHash, b.byId.get("identity.clio")?.contentHash);
	});
});
