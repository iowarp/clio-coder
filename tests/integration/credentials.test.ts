import { ok, strictEqual, throws } from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resetXdgCache } from "../../src/core/xdg.js";
import { openCredentialStore } from "../../src/domains/providers/credentials.js";

const ORIGINAL_ENV = { ...process.env };

describe("providers/credentials", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-creds-"));
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

	it("set then get round-trip", () => {
		const store = openCredentialStore();
		store.set("anthropic", "sk-test-key");
		const got = store.get("anthropic");
		strictEqual(got?.key, "sk-test-key");
		strictEqual(got?.providerId, "anthropic");
	});

	it("get returns null for unknown provider", () => {
		const store = openCredentialStore();
		strictEqual(store.get("nope"), null);
	});

	it("remove deletes entry", () => {
		const store = openCredentialStore();
		store.set("anthropic", "x");
		store.remove("anthropic");
		strictEqual(store.get("anthropic"), null);
	});

	it("list returns entries without the key value", () => {
		const store = openCredentialStore();
		store.set("anthropic", "a");
		store.set("openai", "b");
		const listed = store.list();
		strictEqual(listed.length, 2);
		for (const entry of listed) {
			ok(!("key" in entry));
		}
	});

	it("set with empty key throws", () => {
		const store = openCredentialStore();
		throws(() => store.set("anthropic", ""));
	});

	it("credentials file has mode 0600", () => {
		const store = openCredentialStore();
		store.set("anthropic", "x");
		const credsPath = join(scratch, "config", "credentials.yaml");
		ok(existsSync(credsPath));
		// mode bits: skip on windows where permissions don't map
		if (process.platform !== "win32") {
			const mode = statSync(credsPath).mode & 0o777;
			strictEqual(mode, 0o600);
		}
	});
});
