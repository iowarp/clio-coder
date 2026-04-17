import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Diag harness for src/engine/session.ts. Creates an ephemeral CLIO_HOME,
 * exercises create/append/persist/close/open/resume, and asserts the on-disk
 * layout + parent-link structure.
 */

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-session-engine] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-session-engine] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

async function main(): Promise<void> {
	const home = mkdtempSync(join(tmpdir(), "clio-diag-session-"));
	const ENV_KEYS = ["CLIO_HOME", "CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"] as const;
	const snapshot = new Map<string, string | undefined>();
	for (const k of ENV_KEYS) snapshot.set(k, process.env[k]);
	for (const k of ["CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"] as const) {
		delete process.env[k];
	}
	process.env.CLIO_HOME = home;

	try {
		const { resetXdgCache, clioDataDir } = await import("../src/core/xdg.js");
		resetXdgCache();
		const { resetPackageRootCache } = await import("../src/core/package-root.js");
		resetPackageRootCache();
		const session = await import("../src/engine/session.js");

		const workdir = join(home, "project");
		const { meta, writer } = session.createSession({
			cwd: workdir,
			model: "test-model",
			provider: "test-provider",
		});

		const paths = session.sessionPaths(meta);
		check("createSession:meta-file-exists", existsSync(paths.meta), paths.meta);
		check("createSession:current-file-touched", existsSync(paths.current), paths.current);
		check("createSession:tree-file-touched", existsSync(paths.tree), paths.tree);
		check("createSession:meta-cwdHash", meta.cwdHash === session.cwdHash(workdir));
		check(
			"createSession:meta-under-data-dir",
			paths.meta.startsWith(clioDataDir()),
			`meta=${paths.meta} data=${clioDataDir()}`,
		);
		check("createSession:meta-versions", meta.clioVersion.length > 0 && meta.piMonoVersion.length > 0);
		check("createSession:endedAt-null", meta.endedAt === null);

		writer.append({
			id: "t1",
			parentId: null,
			at: new Date().toISOString(),
			kind: "user",
			payload: { text: "hi" },
		});
		writer.append({
			id: "t2",
			parentId: "t1",
			at: new Date().toISOString(),
			kind: "assistant",
			payload: { text: "hello" },
		});

		await writer.persistTree();
		const treeRaw = readFileSync(paths.tree, "utf8");
		const tree = JSON.parse(treeRaw) as Array<{ id: string; parentId: string | null }>;
		check("persistTree:has-2-entries", tree.length === 2, `len=${tree.length}`);
		check("persistTree:ordering", tree[0]?.id === "t1" && tree[1]?.id === "t2");
		check("persistTree:parent-link", tree[1]?.parentId === "t1");

		const currentRaw = readFileSync(paths.current, "utf8");
		const currentLines = currentRaw.split("\n").filter((l) => l.length > 0);
		check("append:2-jsonl-lines", currentLines.length === 2, `lines=${currentLines.length}`);

		await writer.close();
		const metaAfterClose = JSON.parse(readFileSync(paths.meta, "utf8")) as { endedAt: string | null };
		check(
			"close:endedAt-set",
			typeof metaAfterClose.endedAt === "string" && metaAfterClose.endedAt.length > 0,
			`endedAt=${String(metaAfterClose.endedAt)}`,
		);

		let appendAfterCloseThrew = false;
		try {
			writer.append({
				id: "ghost",
				parentId: null,
				at: new Date().toISOString(),
				kind: "system",
				payload: null,
			});
		} catch {
			appendAfterCloseThrew = true;
		}
		check("close:append-after-close-throws", appendAfterCloseThrew);

		const reader = session.openSession(meta.id);
		check("openSession:meta-id", reader.meta().id === meta.id);
		const turns = reader.turns();
		check("openSession:2-turns", turns.length === 2, `turns=${turns.length}`);
		check("openSession:parent-link", turns[1]?.parentId === "t1");
		const treeFromReader = reader.tree();
		check("openSession:tree-2", treeFromReader.length === 2);

		const { writer: resumed } = session.resumeSession(meta.id);
		resumed.append({
			id: "t3",
			parentId: "t2",
			at: new Date().toISOString(),
			kind: "user",
			payload: { text: "follow up" },
		});
		await resumed.close();

		const reader2 = session.openSession(meta.id);
		check("resume:3-turns", reader2.turns().length === 3, `turns=${reader2.turns().length}`);
		check("resume:tree-3", reader2.tree().length === 3);
		check("resume:parent-chain", reader2.turns()[2]?.parentId === "t2");
		check("resume:endedAt-set-again", reader2.meta().endedAt !== null, `endedAt=${String(reader2.meta().endedAt)}`);

		// Unknown id must throw.
		let unknownThrew = false;
		try {
			session.openSession("nonexistent-id");
		} catch {
			unknownThrew = true;
		}
		check("openSession:unknown-id-throws", unknownThrew);
	} finally {
		for (const [k, v] of snapshot) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		try {
			rmSync(home, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}

	if (failures.length > 0) {
		process.stderr.write(`[diag-session-engine] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-session-engine] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-session-engine] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
