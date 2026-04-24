import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { resetXdgCache } from "../../../src/core/xdg.js";
import { getRuntimeRegistry } from "../../../src/domains/providers/registry.js";
import { resolveWorkerRuntime } from "../../../src/worker/runtime-registry.js";

const ORIGINAL_ENV = { ...process.env };

function writeSdkPlugin(configDir: string): void {
	const runtimeDir = join(configDir, "runtimes");
	mkdirSync(runtimeDir, { recursive: true });
	writeFileSync(
		join(runtimeDir, "out-of-tree-sdk.js"),
		`
const caps = { chat: true, tools: false, reasoning: false, vision: false, audio: false, embeddings: false, rerank: false, fim: false, contextWindow: 1024, maxTokens: 128 };
export default {
  id: "out-of-tree-sdk",
  displayName: "Out Of Tree SDK",
  kind: "sdk",
  tier: "sdk",
  apiFamily: "example-sdk",
  auth: "none",
  knownModels: ["faux-model"],
  defaultCapabilities: caps,
  synthesizeModel(_endpoint, wireModelId) {
    return { id: wireModelId, provider: "faux" };
  },
};
`,
		"utf8",
	);
}

describe("worker entry runtime plugins", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-worker-plugin-"));
		process.env.CLIO_HOME = scratch;
		process.env.CLIO_CONFIG_DIR = join(scratch, "config");
		process.env.CLIO_DATA_DIR = join(scratch, "data");
		process.env.CLIO_CACHE_DIR = join(scratch, "cache");
		resetXdgCache();
		getRuntimeRegistry().clear();
		writeSdkPlugin(join(scratch, "config"));
	});

	afterEach(() => {
		getRuntimeRegistry().clear();
		for (const key of Object.keys(process.env)) {
			if (!(key in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, key);
		}
		for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
			if (value !== undefined) process.env[key] = value;
		}
		rmSync(scratch, { recursive: true, force: true });
		resetXdgCache();
	});

	it("rehydrates an out-of-tree SDK runtime before dispatch", async () => {
		const runtime = await resolveWorkerRuntime("out-of-tree-sdk");

		strictEqual(runtime?.kind, "sdk");
		strictEqual(runtime?.id, "out-of-tree-sdk");
		deepStrictEqual(runtime?.knownModels, ["faux-model"]);
	});
});
