import { notStrictEqual, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
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
