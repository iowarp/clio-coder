import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { storeProjectDir, storeTagDir } from "../../src/core/store-paths.js";
import type { StoreBackend } from "../../src/domains/store/backend.js";
import { openStoreBackend } from "../../src/domains/store/index.js";
import { StoreRefusal } from "../../src/domains/store/types.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function refusedWith(reason: string) {
	return (error: unknown) => error instanceof StoreRefusal && error.reason === reason;
}

/** The contract every backend must pass; a clio-core backend calls this with its own factory later. */
export function runStoreBackendConformance(name: string, make: (cwd: string) => Promise<StoreBackend>): void {
	async function withBackend(fn: (backend: StoreBackend, scratch: string, cwd: string) => Promise<void>) {
		const env = await isolateClioEnv("clio-coder-store-");
		try {
			const cwd = join(env.dir, "workspace");
			mkdirSync(cwd, { recursive: true });
			await fn(await make(cwd), env.dir, cwd);
		} finally {
			env.restore();
		}
	}

	test(`${name}: a put replaces the whole blob and never touches the source`, () =>
		withBackend(async (backend, scratch) => {
			deepStrictEqual(await backend.getOrCreateTag("sim/run7"), { created: true });
			deepStrictEqual(await backend.getOrCreateTag("sim/run7"), { created: false });
			const source = join(scratch, "source.bin");
			writeFileSync(source, "first version, longer");
			const first = await backend.putBlobFromFile("sim/run7", "out/data.bin", source);
			strictEqual(first.bytes, 21);
			strictEqual(first.version, null);
			const { path } = await backend.getBlobAsPath("sim/run7", "out/data.bin");
			strictEqual(readFileSync(path, "utf8"), "first version, longer");
			writeFileSync(source, "second");
			await backend.putBlobFromFile("sim/run7", "out/data.bin", source);
			const again = await backend.getBlobAsPath("sim/run7", "out/data.bin");
			strictEqual(readFileSync(again.path, "utf8"), "second");
			strictEqual(readFileSync(source, "utf8"), "second");
			const facts = await backend.facts();
			// Only the local backend has no tiers; clio-core lists its runtime's targets.
			strictEqual(facts.tiers === false, backend.kind === "local");
			strictEqual(facts.blobVersions, false);
		}));

	test(`${name}: get hands back a path whose writes cannot change the stored blob`, () =>
		withBackend(async (backend, scratch) => {
			await backend.getOrCreateTag("t");
			const source = join(scratch, "source.bin");
			writeFileSync(source, "stored");
			await backend.putBlobFromFile("t", "b", source);
			const got = await backend.getBlobAsPath("t", "b");
			strictEqual(got.copied, true);
			strictEqual(lstatSync(got.path).mode & 0o222, 0);
			try {
				writeFileSync(got.path, "tampered");
			} catch {
				// A read-only copy refuses the write outright.
			}
			const fresh = await backend.getBlobAsPath("t", "b");
			strictEqual(readFileSync(fresh.path, "utf8"), "stored");
		}));

	test(`${name}: an aborted put leaves no change and no temp file`, () =>
		withBackend(async (backend, scratch) => {
			await backend.getOrCreateTag("t");
			const source = join(scratch, "source.bin");
			writeFileSync(source, "kept");
			await backend.putBlobFromFile("t", "b", source);
			writeFileSync(source, "x".repeat(1 << 20));
			await rejects(backend.putBlobFromFile("t", "b", source, AbortSignal.abort()), refusedWith("io"));
			const { path } = await backend.getBlobAsPath("t", "b");
			strictEqual(readFileSync(path, "utf8"), "kept");
			deepStrictEqual(readdirSync(join(path, "..")), ["b"]);
		}));

	test(`${name}: put-if-absent has exactly one winner`, () =>
		withBackend(async (backend) => {
			const results = await Promise.all(
				Array.from({ length: 20 }, (_, i) => backend.putRecordIfAbsent("t/.records", "r#00000001", Buffer.from(`w${i}`))),
			);
			strictEqual(results.filter((result) => result === "written").length, 1);
			ok((await backend.getRecord("t/.records", "r#00000001")) !== null);
		}));

	test(`${name}: listBlobs pages in order, full-matches the pattern and skips links`, () =>
		withBackend(async (backend, scratch, cwd) => {
			await backend.getOrCreateTag("t");
			const source = join(scratch, "s");
			writeFileSync(source, "s");
			for (const blob of ["a/b", "a-c", "b.txt", "c.txt", "d/e.txt", "keep.tmp"])
				await backend.putBlobFromFile("t", blob, source);
			// Links can be planted only in the local layout; clio-core names never resolve on a local file system.
			if (backend.kind === "local") {
				const outside = join(scratch, "outside");
				mkdirSync(outside);
				writeFileSync(join(outside, "x.txt"), "x");
				symlinkSync(outside, join(storeTagDir(cwd, "t"), "blobs", "link"));
			}
			deepStrictEqual(await backend.listBlobs("t", { offset: 0, limit: 2 }), { names: ["a-c", "a/b"], hasMore: true });
			deepStrictEqual(await backend.listBlobs("t", { offset: 2, limit: 4 }), {
				names: ["b.txt", "c.txt", "d/e.txt", "keep.tmp"],
				hasMore: false,
			});
			deepStrictEqual(await backend.listBlobs("t", { pattern: ".*\\.txt", offset: 0, limit: 10 }), {
				names: ["b.txt", "c.txt", "d/e.txt"],
				hasMore: false,
			});
			deepStrictEqual((await backend.listBlobs("t", { pattern: "txt", offset: 0, limit: 10 })).names, []);
			await rejects(backend.listBlobs("t", { pattern: "(", offset: 0, limit: 1 }), refusedWith("invalid-name"));
		}));

	test(`${name}: links in a blob's parents and tags resolving outside the project are refused`, (t) =>
		withBackend(async (backend, scratch, cwd) => {
			if (backend.kind !== "local") {
				t.skip("links can be planted only in the local layout");
				return;
			}
			await backend.getOrCreateTag("t");
			const source = join(scratch, "s");
			writeFileSync(source, "s");
			const outside = join(scratch, "outside");
			mkdirSync(outside);
			symlinkSync(outside, join(storeTagDir(cwd, "t"), "blobs", "dir"));
			await rejects(backend.putBlobFromFile("t", "dir/x", source), refusedWith("is-link"));
			deepStrictEqual(readdirSync(outside), []);
			const tagsDir = join(storeTagDir(cwd, "t"), "..");
			mkdirSync(join(outside, "evil", "blobs"), { recursive: true });
			writeFileSync(join(outside, "evil", "tag.json"), "{}");
			symlinkSync(join(outside, "evil"), join(tagsDir, "evil"));
			await rejects(backend.putBlobFromFile("evil", "x", source), refusedWith("is-link"));
			await rejects(backend.delTag("evil"), refusedWith("is-link"));
		}));

	test(`${name}: tag attributes keep the CTE size limits`, () =>
		withBackend(async (backend) => {
			await backend.getOrCreateTag("t");
			await backend.setTagXattr("t", "class", "output");
			await backend.setTagXattr("t", "k".repeat(255), "v".repeat(64 * 1024));
			strictEqual((await backend.getTagXattrs("t")).class, "output");
			await rejects(backend.setTagXattr("t", "k".repeat(256), "v"), refusedWith("invalid-name"));
			await rejects(backend.setTagXattr("t", "k", "v".repeat(64 * 1024 + 1)), refusedWith("invalid-name"));
		}));
}

runStoreBackendConformance("local", openStoreBackend);

test("local: a blob named *.tmp is listed; only the backend's own temp siblings are hidden", async () => {
	const env = await isolateClioEnv("clio-coder-store-tmp-");
	try {
		const cwd = join(env.dir, "workspace");
		mkdirSync(cwd, { recursive: true });
		const backend = await openStoreBackend(cwd);
		const source = join(env.dir, "s");
		writeFileSync(source, "s");
		await backend.getOrCreateTag("t");
		await backend.putBlobFromFile("t", "keep.tmp", source);
		writeFileSync(join(storeTagDir(cwd, "t"), ".keep.tmp.123.0123456789ab.tmp"), "in flight");
		deepStrictEqual((await backend.listBlobs("t", { offset: 0, limit: 10 })).names, ["keep.tmp"]);
	} finally {
		env.restore();
	}
});

test("local: a blob nested under a blob, or named like a blob directory, is refused cleanly", async () => {
	const env = await isolateClioEnv("clio-coder-store-nest-");
	try {
		const cwd = join(env.dir, "workspace");
		mkdirSync(cwd, { recursive: true });
		const backend = await openStoreBackend(cwd);
		const source = join(env.dir, "s");
		writeFileSync(source, "s");
		await backend.getOrCreateTag("t");
		await backend.putBlobFromFile("t", "a", source);
		await rejects(
			backend.putBlobFromFile("t", "a/b", source),
			(error: unknown) =>
				error instanceof StoreRefusal &&
				error.reason === "exists" &&
				/blob a\b/u.test(error.message) &&
				!/E(EXIST|NOTDIR|ISDIR)/u.test(error.message),
		);
		await backend.putBlobFromFile("t", "c/d", source);
		await rejects(
			backend.putBlobFromFile("t", "c", source),
			(error: unknown) =>
				error instanceof StoreRefusal &&
				error.reason === "exists" &&
				/c\/d/u.test(error.message) &&
				!/E(EXIST|NOTDIR|ISDIR)/u.test(error.message),
		);
		deepStrictEqual((await backend.listBlobs("t", { offset: 0, limit: 10 })).names, ["a", "c/d"]);
		deepStrictEqual(readdirSync(join(storeTagDir(cwd, "t"), "blobs")).sort(), ["a", "c"]);
		deepStrictEqual(readdirSync(join(storeTagDir(cwd, "t"), "blobs", "c")), ["d"]);
	} finally {
		env.restore();
	}
});

test("local: every store directory is 0700 and every file 0600 under umask 022", async () => {
	const env = await isolateClioEnv("clio-coder-store-modes-");
	const umask = process.umask(0o022);
	try {
		const cwd = join(env.dir, "workspace");
		mkdirSync(cwd, { recursive: true });
		const backend = await openStoreBackend(cwd);
		const source = join(env.dir, "s");
		writeFileSync(source, "s");
		await backend.getOrCreateTag("t");
		await backend.setTagXattr("t", "class", "output");
		await backend.putBlobFromFile("t", "out/a.bin", source);
		await backend.putRecordIfAbsent("t/.records", "r#00000001", Buffer.from("argv"));
		const modes: string[] = [];
		const walk = (dir: string): void => {
			for (const name of readdirSync(dir)) {
				const entry = join(dir, name);
				const stat = lstatSync(entry);
				modes.push(`${(stat.mode & 0o777).toString(8)} ${name}`);
				if (stat.isDirectory()) walk(entry);
			}
		};
		walk(storeProjectDir(cwd));
		ok(modes.some((line) => line.endsWith(" a.bin")));
		deepStrictEqual(
			modes.filter((line) => !line.startsWith("700 ") && !line.startsWith("600 ")),
			[],
		);
		strictEqual(lstatSync(storeProjectDir(cwd)).mode & 0o777, 0o700);
	} finally {
		process.umask(umask);
		env.restore();
	}
});
