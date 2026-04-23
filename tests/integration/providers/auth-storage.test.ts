import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { resetXdgCache } from "../../../src/core/xdg.js";
import { openAuthStorage } from "../../../src/domains/providers/auth/index.js";

const ORIGINAL_ENV = { ...process.env };

describe("providers/auth file backend", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-auth-"));
		process.env.CLIO_HOME = scratch;
		process.env.CLIO_CONFIG_DIR = join(scratch, "config");
		process.env.CLIO_DATA_DIR = join(scratch, "data");
		process.env.CLIO_CACHE_DIR = join(scratch, "cache");
		resetXdgCache();
	});

	afterEach(() => {
		for (const k of Object.keys(process.env)) {
			if (!(k in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, k);
		}
		for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
			if (v !== undefined) process.env[k] = v;
		}
		rmSync(scratch, { recursive: true, force: true });
		resetXdgCache();
	});

	it("round-trips api-key credentials through credentials.yaml", () => {
		const auth = openAuthStorage();
		auth.setApiKey("openai", "sk-test");

		const reloaded = openAuthStorage();
		const stored = reloaded.get("openai");
		ok(stored && stored.type === "api_key");
		strictEqual(stored.key, "sk-test");
	});

	it("writes credentials.yaml with mode 0600", () => {
		const auth = openAuthStorage();
		auth.setApiKey("anthropic", "sk-ant");

		const authPath = join(scratch, "config", "credentials.yaml");
		ok(existsSync(authPath));
		if (process.platform !== "win32") {
			const mode = statSync(authPath).mode & 0o777;
			strictEqual(mode, 0o600);
		}
	});
});
