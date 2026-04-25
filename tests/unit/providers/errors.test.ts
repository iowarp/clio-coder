import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import {
	ContextOverflowError,
	isContextOverflowError,
	toContextOverflowError,
} from "../../../src/domains/providers/errors.js";

describe("providers/errors context overflow", () => {
	it("delegates provider overflow matching to pi-ai", () => {
		const err = toContextOverflowError(new Error("input token count exceeds the maximum allowed for this Gemini model"));
		ok(err instanceof ContextOverflowError);
		strictEqual(err.kind, "context-overflow");
	});

	it("preserves transported context-overflow classifications", () => {
		const err = toContextOverflowError({ kind: "context-overflow", message: "context overflow" });
		ok(err instanceof ContextOverflowError);
		strictEqual(isContextOverflowError(err), true);
		strictEqual(err.original && typeof err.original === "object", true);
	});

	it("leaves unrelated provider errors untouched", () => {
		strictEqual(toContextOverflowError(new Error("rate limit exceeded")), null);
	});
});
