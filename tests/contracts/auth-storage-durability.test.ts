/**
 * Every write to the credentials store is a whole-file rewrite of the parsed
 * view, and there is no backup. So the store must never serialize a view that
 * lost something on the way in.
 *
 * The failure this guards: two keys stored, the file corrupted, `clio-coder auth
 * list` reporting both as "disconnected" (the same word it uses for never
 * logged in), and the obvious recovery of logging in again taking the file from
 * 211 bytes to 112 with only the new entry left.
 */
import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { FileAuthStorageBackend } from "../../src/domains/providers/auth/backend-file.js";
import { InMemoryAuthStorageBackend } from "../../src/domains/providers/auth/backend-memory.js";
import {
	AuthStorage,
	type AuthStorageBackend,
	AuthStorageDamagedError,
	resolveRuntimeAuthTarget,
} from "../../src/domains/providers/auth/storage.js";
import anthropicRuntime from "../../src/domains/providers/runtimes/cloud/anthropic.js";
import subscriptionRuntime from "../../src/domains/providers/runtimes/cloud/anthropic-max.js";

describe("contracts/auth storage durability", () => {
	let root: string;
	let path: string;
	const open = (): AuthStorage => new AuthStorage(new FileAuthStorageBackend(path));

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "clio-coder-auth-durability-"));
		path = join(root, "credentials.yaml");
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function storeTwoKeys(): string {
		const storage = open();
		storage.setApiKey("mistral", "sk-not-a-real-key-mistral");
		storage.setApiKey("openai", "sk-not-a-real-key-openai");
		return readFileSync(path, "utf8");
	}

	it("sees another process's re-login and logout without waiting for token expiry", async () => {
		const writer = open();
		writer.set("anthropic-max", {
			type: "oauth",
			access: "sk-ant-oat01-old",
			refresh: "refresh-old",
			expires: Date.now() + 3_600_000,
			updatedAt: "2026-10-07T00:00:00Z",
		});
		const running = open();
		writer.set("anthropic-max", {
			type: "oauth",
			access: "sk-ant-oat01-new",
			refresh: "refresh-new",
			expires: Date.now() + 3_600_000,
			updatedAt: "2026-10-07T01:00:00Z",
		});
		strictEqual((await running.resolveApiKey("anthropic-max")).apiKey, "sk-ant-oat01-new");
		writer.logout("anthropic-max");
		strictEqual((await running.resolveApiKey("anthropic-max")).apiKey, undefined);
		strictEqual(running.status("anthropic-max").available, false);
	});

	it("keeps subscription and API-key logins separate and refuses the wrong credential kind", async () => {
		const storage = open();
		const subscription = resolveRuntimeAuthTarget(subscriptionRuntime);
		const api = resolveRuntimeAuthTarget(anthropicRuntime);
		strictEqual(subscription.providerId, "anthropic-max");
		strictEqual(api.providerId, "anthropic");
		storage.set(subscription.providerId, {
			type: "oauth",
			access: "sk-ant-oat01-subscription",
			refresh: "refresh",
			expires: Date.now() + 3_600_000,
			updatedAt: "2026-10-07T00:00:00Z",
		});
		storage.setApiKey(api.providerId, "separate-api-key");
		strictEqual((await storage.resolveForTarget(subscription)).apiKey, "sk-ant-oat01-subscription");
		strictEqual((await storage.resolveForTarget(api)).apiKey, "separate-api-key");
		storage.setApiKey(subscription.providerId, "wrong-kind");
		strictEqual((await storage.resolveForTarget(subscription)).apiKey, undefined);
		strictEqual(storage.statusForTarget(subscription).available, false);
	});

	it("refuses to write over a store that is not valid YAML, and loses no bytes", () => {
		const original = storeTwoKeys();
		writeFileSync(path, `${original}\n\tstray: tab\n`, "utf8");
		const corrupted = readFileSync(path, "utf8");

		const storage = open();
		ok(storage.damageReason()?.includes("not valid YAML"), "the damage is reported, not swallowed");
		strictEqual(storage.listStored().length, 0, "a damaged store reads back as zero credentials");

		throws(
			() => storage.setApiKey("mistral", "sk-not-a-real-key-replacement"),
			AuthStorageDamagedError,
			"logging in again must not be allowed to rewrite the file",
		);
		strictEqual(readFileSync(path, "utf8"), corrupted, "the file on disk is byte-identical after the refusal");
		ok(readFileSync(path, "utf8").includes("sk-not-a-real-key-openai"), "the untouched provider's key survives");
	});

	it("refuses to write when an entry is stored in a shape this version cannot read", () => {
		storeTwoKeys();
		// Valid YAML, ours, but one entry carries a credential type from some
		// other version. Dropping it silently and rewriting would delete it.
		writeFileSync(
			path,
			[
				"version: 2",
				"entries:",
				"  mistral:",
				"    type: api_key",
				'    key: "sk-keep-me"',
				"  future:",
				"    type: passkey",
				"    handle: abc",
				"",
			].join("\n"),
			"utf8",
		);
		const before = readFileSync(path, "utf8");

		const storage = open();
		ok(storage.damageReason()?.includes("future"), "the unreadable entry is named");
		throws(() => storage.setApiKey("openai", "sk-not-a-real-key"), AuthStorageDamagedError);
		strictEqual(readFileSync(path, "utf8"), before, "the entry this version cannot read is still on disk");
	});

	it("refuses to remove a credential from a damaged store", () => {
		const original = storeTwoKeys();
		writeFileSync(path, `${original}\n\tstray: tab\n`, "utf8");
		const corrupted = readFileSync(path, "utf8");

		throws(() => open().logout("mistral"), AuthStorageDamagedError);
		strictEqual(readFileSync(path, "utf8"), corrupted, "a refused logout changes nothing");
	});

	// The refusal must not fire on the ordinary paths, or first login breaks.
	it("treats an absent, empty, or comment-only store as clean rather than damaged", () => {
		strictEqual(open().damageReason(), null, "an absent file is not damage");

		writeFileSync(path, "", "utf8");
		strictEqual(open().damageReason(), null, "an empty file is not damage");

		writeFileSync(path, "# nothing here yet\n", "utf8");
		strictEqual(open().damageReason(), null, "a comment-only file is not damage");

		writeFileSync(path, "version: 2\nentries:\n", "utf8");
		strictEqual(open().damageReason(), null, "a written-empty store is not damage");

		const storage = open();
		storage.setApiKey("mistral", "sk-not-a-real-key");
		strictEqual(open().listStored().length, 1, "a first login still writes");
	});

	/**
	 * The exact bytes `initializeClioHome` scaffolds at src/core/init.ts:80. A
	 * first guard at this shape called the product's own fresh file damaged, so a
	 * brand-new install could not log in at all and `clio-coder configure --api-key`
	 * died with it. Pinned to the literal scaffold so a change to one side has to
	 * be a change to both.
	 */
	it("accepts the credentials scaffold a fresh install ships", () => {
		const scaffold = "# Managed via `clio-coder auth`. Do not edit manually unless you know what you are doing.\n{}\n";
		writeFileSync(path, scaffold, "utf8");

		strictEqual(open().damageReason(), null, "the shipped scaffold is an empty store, not a damaged one");
		const storage = open();
		storage.setApiKey("openai", "sk-not-a-real-key-first-login");
		strictEqual(open().listStored().length, 1, "the very first login on a fresh install succeeds");
		ok(readFileSync(path, "utf8").includes("sk-not-a-real-key-first-login"));
	});

	it("still refuses a top-level mapping that is ours in neither shape", () => {
		writeFileSync(path, "mistral:\n  key: sk-not-a-real-key\n", "utf8");
		const storage = open();
		ok(storage.damageReason() !== null, "a bare provider map was never a readable shape");
		throws(() => storage.setApiKey("openai", "sk-not-a-real-key"), AuthStorageDamagedError);
	});

	it("round trips set, replace, and remove on a clean store", () => {
		const storage = open();
		storage.setApiKey("mistral", "sk-not-a-real-key-one");
		storage.setApiKey("openai", "sk-not-a-real-key-two");
		storage.setApiKey("mistral", "sk-not-a-real-key-three");
		storage.remove("openai");

		const reopened = open();
		strictEqual(reopened.damageReason(), null);
		strictEqual(reopened.listStored().length, 1);
		strictEqual(reopened.get("mistral")?.type, "api_key");
		ok(readFileSync(path, "utf8").includes("sk-not-a-real-key-three"), "the replacement key is the one persisted");
		ok(!readFileSync(path, "utf8").includes("sk-not-a-real-key-two"), "the removed credential is gone");
	});

	/**
	 * A write can fail for reasons the damage refusal never sees: a lock that
	 * cannot be taken, a read-only config dir, a full disk. Those went into an
	 * errors array with no consumer, so the store reported itself clean and
	 * `clio-coder auth status` and `clio-coder doctor` both said the credential was there
	 * while disk held none of it. damageReason() is the channel they read.
	 */
	it("reports a write that never reached disk instead of holding the error where nothing reads it", () => {
		const backend: AuthStorageBackend = {
			withLock(fn) {
				const { result, next } = fn(undefined);
				if (next !== undefined) throw new Error("EROFS: read-only file system, open 'credentials.yaml'");
				return result;
			},
			withLockAsync: async (fn) => (await fn(undefined)).result,
			describe: () => path,
		};

		const storage = new AuthStorage(backend);
		strictEqual(storage.damageReason(), null, "an unwritten store is clean before the failed write");

		storage.setApiKey("mistral", "sk-not-a-real-key");

		ok(
			storage.damageReason()?.includes("read-only file system"),
			`the refused write is reported, got: ${storage.damageReason()}`,
		);
		strictEqual(storage.hasStored("mistral"), false, "a failed commit cannot publish a credential in memory");
		strictEqual(storage.status("mistral").available, false);
	});

	it("keeps the last committed credentials after a failed replacement or removal", async () => {
		const committed = storeTwoKeys();
		const backend: AuthStorageBackend = {
			read: () => committed,
			withLock(fn) {
				const { result, next } = fn(committed);
				if (next !== undefined) throw new Error("ENOSPC: no space left on device");
				return result;
			},
			withLockAsync: async (fn) => (await fn(committed)).result,
		};
		const storage = new AuthStorage(backend);
		const before = storage.get("mistral");
		storage.setApiKey("mistral", "sk-not-a-real-key-replacement");
		deepStrictEqual(storage.get("mistral"), before, "a failed replacement retains the committed key");
		storage.remove("mistral");
		deepStrictEqual(storage.get("mistral"), before, "a failed removal retains the committed key");
		strictEqual(storage.listStored().length, 2);
		strictEqual((await storage.resolveApiKey("mistral")).apiKey, "sk-not-a-real-key-mistral");
		ok(storage.damageReason()?.includes("no space left on device"));
		strictEqual(readFileSync(path, "utf8"), committed);
	});

	it("does not report a stored credential the disk write refused", () => {
		const original = storeTwoKeys();
		writeFileSync(path, `${original}\n\tstray: tab\n`, "utf8");
		const storage = open();
		throws(() => storage.setApiKey("anthropic", "sk-not-a-real-key"), AuthStorageDamagedError);
		strictEqual(storage.hasStored("anthropic"), false, "a refused write must not read back as stored in memory");
	});

	it("serializes in-memory credential mutations and cancels queued work", async () => {
		const backend = new InMemoryAuthStorageBackend();
		let releaseFirst: () => void = () => {};
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = backend.withLockAsync(async (current) => {
			strictEqual(current, undefined);
			await firstGate;
			return { result: "first", next: "credential-one" };
		});
		const controller = new AbortController();
		let secondRan = false;
		const second = backend.withLockAsync(
			async () => {
				secondRan = true;
				return { result: "second", next: "credential-two" };
			},
			{ signal: controller.signal },
		);

		controller.abort(new Error("operator cancelled queued credential update"));
		await rejects(second, /operator cancelled queued credential update/);
		releaseFirst();
		strictEqual(await first, "first");
		await new Promise<void>((resolve) => setImmediate(resolve));
		strictEqual(secondRan, false, "cancelled work never runs after the earlier mutation leaves the lock");

		const current = await backend.withLockAsync(async (value) => ({ result: value }));
		strictEqual(current, "credential-one", "the cancelled mutation cannot overwrite the committed credential");
	});
});
