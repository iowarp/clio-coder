import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { validateModelChoice } from "../../../src/cli/validate-model.js";

const knownClaude = ["claude-opus-4-7", "claude-haiku-4-5-20251001", "claude-sonnet-4-6"];

describe("cli/validate-model", () => {
	it("accepts a known model silently", () => {
		const result = validateModelChoice({
			runtimeId: "claude-code-cli",
			modelId: "claude-opus-4-7",
			knownModels: knownClaude,
			force: false,
		});
		deepStrictEqual(result, { ok: true });
	});

	it("rejects an unknown model when force is false", () => {
		const result = validateModelChoice({
			runtimeId: "codex-cli",
			modelId: "gpt-5.1-codex-mini",
			knownModels: ["gpt-5.4", "gpt-5.4-mini"],
			force: false,
		});
		strictEqual(result.ok, false);
		if (result.ok) throw new Error("unreachable");
		strictEqual(result.reason.includes("not in codex-cli catalog"), true);
		strictEqual(result.reason.includes("gpt-5.4, gpt-5.4-mini"), true);
		strictEqual(result.knownModels.length, 2);
	});

	it("accepts an unknown model when force is true", () => {
		const result = validateModelChoice({
			runtimeId: "codex-cli",
			modelId: "exotic",
			knownModels: ["gpt-5.4"],
			force: true,
		});
		deepStrictEqual(result, {
			ok: true,
			warning: "model 'exotic' not in codex-cli catalog (use without --force to reject)",
		});
	});

	it("treats empty knownModels as accept-all (no catalog available)", () => {
		const result = validateModelChoice({
			runtimeId: "custom",
			modelId: "anything",
			knownModels: [],
			force: false,
		});
		deepStrictEqual(result, { ok: true });
	});

	it("trims and lists up to 10 models in the rejection message", () => {
		const knownLong = Array.from({ length: 15 }, (_, i) => `m${i}`);
		const result = validateModelChoice({ runtimeId: "x", modelId: "z", knownModels: knownLong, force: false });
		strictEqual(result.ok, false);
		if (result.ok) throw new Error("unreachable");
		const listed = result.reason.match(/m\d+/g) ?? [];
		strictEqual(listed.length, 10);
	});
});
