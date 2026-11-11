import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	storePut as cliPut,
	storeAdopt,
	storeCommandResult,
	storeRemoveTag,
	storeTags,
	storeVerify,
	storeWhere,
} from "../../src/cli/store.js";
import { storeBlobPath } from "../../src/core/store-paths.js";
import { openStoreBackend } from "../../src/domains/store/index.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

/** Puts into a tag created beforehand, so a test isolates put from tag creation. */
async function storePut(root: string, tag: string, file: string) {
	await (await openStoreBackend(root)).getOrCreateTag(tag);
	return cliPut(root, tag, file);
}

async function withWorkspace(fn: (root: string, dir: string) => Promise<void>): Promise<void> {
	const env = await isolateClioEnv("clio-coder-store-cli-");
	try {
		const root = join(env.dir, "workspace");
		mkdirSync(root, { recursive: true });
		await fn(root, env.dir);
	} finally {
		env.restore();
	}
}

describe("clio-coder store", () => {
	it("verify classifies ok, changed, missing and unrecorded blobs", () =>
		withWorkspace(async (root) => {
			for (const name of ["a.dat", "b.dat", "c.dat"]) {
				writeFileSync(join(root, name), `${name} bytes\n`);
				await storePut(root, "sim", name);
			}
			const backend = await openStoreBackend(root);
			// `get` hands out a read-only copy, so edit the stored file itself.
			const b = storeBlobPath(root, "sim", "b.dat");
			// Same size, new bytes and mtime: edited behind Clio.
			writeFileSync(b, "B.DAT BYTES\n");
			utimesSync(b, new Date(), new Date(Date.now() + 5000));
			rmSync(storeBlobPath(root, "sim", "c.dat"));
			writeFileSync(join(root, "d.dat"), "dropped\n");
			await backend.putBlobFromFile("sim", "d.dat", join(root, "d.dat"));

			const result = await storeVerify(root, "sim");
			deepStrictEqual(result.counts, { ok: 1, changed: 1, missing: 1, unrecorded: 1 });
			deepStrictEqual(
				result.blobs.map((blob) => [blob.blob, blob.status]),
				[
					["a.dat", "ok"],
					["b.dat", "changed"],
					["c.dat", "missing"],
					["d.dat", "unrecorded"],
				],
			);
		}));

	it("rm-tag deletes nothing without --yes", () =>
		withWorkspace(async (root) => {
			writeFileSync(join(root, "a.dat"), "12345");
			await storePut(root, "sim", "a.dat");
			deepStrictEqual(await storeRemoveTag(root, "sim", false), {
				tag: "sim",
				blobs: 1,
				bytes: 5,
				records: true,
				deleted: false,
			});
			strictEqual((await storeTags(root)).tags.length, 1);
			strictEqual((await storeRemoveTag(root, "sim", true)).deleted, true);
			const backend = await openStoreBackend(root);
			deepStrictEqual(await backend.listTags(), []);
		}));

	it("put creates a missing tag as an input tag", () =>
		withWorkspace(async (root) => {
			writeFileSync(join(root, "a.dat"), "x");
			const result = await cliPut(root, "fresh", "a.dat");
			strictEqual(result.createdTag, true);
			const backend = await openStoreBackend(root);
			strictEqual(await backend.tagExists("fresh"), true);
		}));

	it("rm-tag dry run exits 0 and a missing tag exits non-zero", () =>
		withWorkspace(async (root) => {
			writeFileSync(join(root, "a.dat"), "x");
			await storePut(root, "sim", "a.dat");
			strictEqual((await storeCommandResult(["rm-tag", "sim"], root)).code, 0);
			await rejects(storeCommandResult(["rm-tag", "absent"], root), /no tag named absent/u);
		}));

	it("rm removes one blob only with --yes", () =>
		withWorkspace(async (root) => {
			for (const name of ["a.dat", "b.dat"]) {
				writeFileSync(join(root, name), name);
				await storePut(root, "sim", name);
			}
			const backend = await openStoreBackend(root);
			strictEqual((await storeCommandResult(["rm", "sim:a.dat"], root)).code, 0);
			ok((await backend.statBlob("sim", "a.dat")) !== null);
			strictEqual((await storeCommandResult(["rm", "sim:a.dat", "--yes"], root)).code, 0);
			strictEqual(await backend.statBlob("sim", "a.dat"), null);
			ok((await backend.statBlob("sim", "b.dat")) !== null);
			await rejects(storeCommandResult(["rm", "sim:a.dat"], root), /not in the store/u);
		}));

	it("adopt moves a moved repository's store and refuses a clash", () =>
		withWorkspace(async (oldRoot, dir) => {
			writeFileSync(join(oldRoot, "a.dat"), "data");
			await storePut(oldRoot, "sim", "a.dat");
			const oldKey = storeWhere(oldRoot).projectKey;
			const newRoot = join(dir, "moved");
			renameSync(oldRoot, newRoot);

			const listed = await storeAdopt(newRoot);
			ok(!listed.adopted && listed.orphans.some((orphan) => orphan.key === oldKey));
			const adopted = await storeAdopt(newRoot, oldKey);
			ok(adopted.adopted);
			deepStrictEqual(
				(await storeTags(newRoot)).tags.map((tag) => tag.tag),
				["sim"],
			);

			mkdirSync(oldRoot);
			writeFileSync(join(oldRoot, "b.dat"), "other");
			await storePut(oldRoot, "other", "b.dat");
			rmSync(oldRoot, { recursive: true });
			await rejects(storeAdopt(newRoot, oldKey), /already has a store/u);
		}));
});
