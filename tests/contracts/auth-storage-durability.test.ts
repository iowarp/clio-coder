/**
 * Every write to the credentials store is a whole-file rewrite of the parsed
 * view, and there is no backup. So the store must never serialize a view that
 * lost something on the way in.
 *
 * The failure this guards: two keys stored, the file corrupted, `clio auth
 * list` reporting both as "disconnected" (the same word it uses for never
 * logged in), and the obvious recovery of logging in again taking the file from
 * 211 bytes to 112 with only the new entry left.
 */
import { ok, strictEqual, throws } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { FileAuthStorageBackend } from "../../src/domains/providers/auth/backend-file.js";
import {
	AuthStorage,
	type AuthStorageBackend,
	AuthStorageDamagedError,
} from "../../src/domains/providers/auth/storage.js";

describe("contracts/auth storage durability", () => {
	let root: string;
	let path: string;
	const open = (): AuthStorage => new AuthStorage(new FileAuthStorageBackend(path));

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "clio-auth-durability-"));
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
	 * brand-new install could not log in at all and `clio configure --api-key`
	 * died with it. Pinned to the literal scaffold so a change to one side has to
	 * be a change to both.
	 */
	it("accepts the credentials scaffold a fresh install ships", () => {
		const scaffold = "# Managed via `clio auth`. Do not edit manually unless you know what you are doing.\n{}\n";
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
	 * `clio auth status` and `clio doctor` both said the credential was there
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
	});

	it("does not report a stored credential the disk write refused", () => {
		const original = storeTwoKeys();
		writeFileSync(path, `${original}\n\tstray: tab\n`, "utf8");
		const storage = open();
		throws(() => storage.setApiKey("anthropic", "sk-not-a-real-key"), AuthStorageDamagedError);
		strictEqual(storage.hasStored("anthropic"), false, "a refused write must not read back as stored in memory");
	});
});
