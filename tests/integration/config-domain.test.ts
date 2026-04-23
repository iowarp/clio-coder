import { strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { type ClioSettings, readSettings } from "../../src/core/config.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { initializeClioHome } from "../../src/core/init.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import { createConfigBundle } from "../../src/domains/config/extension.js";

const ORIGINAL_ENV = { ...process.env };

function makeContext(): DomainContext {
	return {
		bus: createSafeEventBus(),
		getContract: () => undefined,
	};
}

describe("config domain write-through updates", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-config-domain-"));
		process.env.CLIO_HOME = scratch;
		process.env.CLIO_CONFIG_DIR = join(scratch, "config");
		process.env.CLIO_DATA_DIR = join(scratch, "data");
		process.env.CLIO_CACHE_DIR = join(scratch, "cache");
		resetXdgCache();
		initializeClioHome();
	});

	afterEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, key);
		}
		for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
			if (value !== undefined) process.env[key] = value;
		}
		rmSync(scratch, { recursive: true, force: true });
		resetXdgCache();
	});

	it("updates the in-memory snapshot immediately when set() writes settings", async () => {
		const bundle = createConfigBundle(makeContext());
		await bundle.extension.start();
		try {
			let nextTurnCount = 0;
			bundle.contract.onChange("nextTurn", () => {
				nextTurnCount += 1;
			});

			const next = structuredClone(bundle.contract.get()) as ClioSettings;
			next.endpoints = [{ id: "openai-codex", runtime: "openai-codex", defaultModel: "gpt-5.4-mini" }];
			next.orchestrator.endpoint = "openai-codex";
			next.orchestrator.model = "gpt-5.4-mini";
			next.workers.default.endpoint = "openai-codex";
			next.workers.default.model = "gpt-5.4-mini";

			bundle.contract.set?.(next);

			strictEqual(bundle.contract.get().orchestrator.endpoint, "openai-codex");
			strictEqual(bundle.contract.get().orchestrator.model, "gpt-5.4-mini");
			strictEqual(readSettings().orchestrator.model, "gpt-5.4-mini");
			strictEqual(nextTurnCount, 1);
		} finally {
			await bundle.extension.stop?.();
		}
	});
});
