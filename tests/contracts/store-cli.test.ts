import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { storeAdopt, storePut, storeRemoveTag, storeTags, storeVerify, storeWhere } from "../../src/cli/store.js";
import { openStoreBackend } from "../../src/domains/store/index.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

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
			const b = (await backend.getBlobAsPath("sim", "b.dat")).path;
			// Same size, new bytes and mtime: edited behind Clio.
			writeFileSync(b, "B.DAT BYTES\n");
			utimesSync(b, new Date(), new Date(Date.now() + 5000));
			rmSync((await backend.getBlobAsPath("sim", "c.dat")).path);
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
