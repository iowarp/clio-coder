import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { RUN_OVERRIDES_ENV, runOverrides, withRunOverrides } from "../../src/core/run-overrides.js";

describe("contracts/run-overrides scoped transport", () => {
	it("round-trips typed overrides through the single env var and restores on exit", async () => {
		strictEqual(process.env[RUN_OVERRIDES_ENV], undefined, "test assumes a clean scope");
		await withRunOverrides({ maxContextTokens: 4096, kvCacheMode: "q8_0" }, async () => {
			deepStrictEqual(runOverrides(), { maxContextTokens: 4096, kvCacheMode: "q8_0" });
			// Nested scopes merge over the outer one and restore it afterwards.
			await withRunOverrides({ sampling: { temperature: 0.2 } }, async () => {
				deepStrictEqual(runOverrides(), {
					maxContextTokens: 4096,
					kvCacheMode: "q8_0",
					sampling: { temperature: 0.2 },
				});
			});
			deepStrictEqual(runOverrides(), { maxContextTokens: 4096, kvCacheMode: "q8_0" });
		});
		strictEqual(process.env[RUN_OVERRIDES_ENV], undefined, "scope fully restored");
	});

	it("restores the previous scope when the wrapped function throws", async () => {
		await withRunOverrides({ maxContextTokens: 1024 }, async () => {
			await withRunOverrides({ maxContextTokens: 2048 }, async () => {
				throw new Error("boom");
			}).catch(() => {});
			strictEqual(runOverrides().maxContextTokens, 1024);
		});
	});

	it("drops malformed payloads and invalid fields instead of throwing", () => {
		const previous = process.env[RUN_OVERRIDES_ENV];
		try {
			process.env[RUN_OVERRIDES_ENV] = "not json";
			deepStrictEqual(runOverrides(), {});
			process.env[RUN_OVERRIDES_ENV] = JSON.stringify({
				maxContextTokens: -5,
				kvCacheMode: "",
				sampling: { temperature: "hot", topP: 0.9 },
			});
			deepStrictEqual(runOverrides(), { sampling: { topP: 0.9 } });
		} finally {
			if (previous === undefined) delete process.env[RUN_OVERRIDES_ENV];
			else process.env[RUN_OVERRIDES_ENV] = previous;
		}
	});

	it("is a no-op wrapper when no overrides are supplied", async () => {
		await withRunOverrides({}, async () => {
			strictEqual(process.env[RUN_OVERRIDES_ENV], undefined, "empty overrides never touch the env");
		});
	});
});
