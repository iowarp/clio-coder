import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV_KEYS = ["CLIO_HOME", "CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"] as const;

async function main(): Promise<void> {
	const home = mkdtempSync(join(tmpdir(), "clio-verify-session-"));
	const snapshot = new Map<string, string | undefined>();
	for (const key of ENV_KEYS) snapshot.set(key, process.env[key]);
	for (const key of ["CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"] as const) {
		delete process.env[key];
	}
	process.env.CLIO_HOME = home;

	try {
		const { resetXdgCache } = await import("../src/core/xdg.js");
		resetXdgCache();
		const { resetPackageRootCache } = await import("../src/core/package-root.js");
		resetPackageRootCache();
		const { createSession, openSession, sessionPaths } = await import("../src/engine/session.js");

		const { meta, writer } = createSession({ cwd: process.cwd() });
		const firstAt = new Date().toISOString();
		const secondAt = new Date(Date.now() + 1).toISOString();
		const thirdAt = new Date(Date.now() + 2).toISOString();

		writer.append({
			id: "t1",
			parentId: null,
			kind: "user",
			payload: { text: "hi" },
			at: firstAt,
		});
		writer.append({
			id: "t2",
			parentId: "t1",
			kind: "assistant",
			payload: { text: "hello" },
			at: secondAt,
		});
		writer.append({
			id: "t3",
			parentId: "t2",
			kind: "user",
			payload: { text: "more" },
			at: thirdAt,
		});
		await writer.persistTree();
		await writer.close();

		const reader = openSession(meta.id);
		const turns = reader.turns();
		assert.equal(turns.length, 3);
		assert.equal(turns[0]?.id, "t1");
		assert.equal(turns[0]?.parentId, null);
		assert.equal(turns[1]?.id, "t2");
		assert.equal(turns[1]?.parentId, "t1");
		assert.equal(turns[2]?.id, "t3");
		assert.equal(turns[2]?.parentId, "t2");

		const paths = sessionPaths(meta);
		assert.equal(existsSync(paths.current), true, `missing ${paths.current}`);
		assert.equal(existsSync(paths.tree), true, `missing ${paths.tree}`);
		assert.ok(statSync(paths.current).size > 0, `${paths.current} is empty`);
		assert.ok(statSync(paths.tree).size > 0, `${paths.tree} is empty`);

		process.stdout.write("verify-session: OK\n");
	} finally {
		try {
			rmSync(home, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
		for (const [key, value] of snapshot) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

main().catch((err) => {
	process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
	process.exit(1);
});
