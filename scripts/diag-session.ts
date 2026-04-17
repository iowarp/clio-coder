import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Phase 3 slice 5 diag. Wires Config + Safety + Modes + Session against an
 * ephemeral CLIO_HOME and exercises the full session contract lifecycle.
 */

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-session] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-session] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

async function run(): Promise<void> {
	const home = mkdtempSync(join(tmpdir(), "clio-diag-session-dom-"));
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
		const { resetSharedBus } = await import("../src/core/shared-bus.js");
		resetSharedBus();

		// Touch settings.yaml so config domain has a target to watch.
		writeFileSync(join(home, "settings.yaml"), "");

		const { loadDomains } = await import("../src/core/domain-loader.js");
		const { ConfigDomainModule } = await import("../src/domains/config/index.js");
		const { SafetyDomainModule } = await import("../src/domains/safety/index.js");
		const { ModesDomainModule } = await import("../src/domains/modes/index.js");
		const { SessionDomainModule } = await import("../src/domains/session/index.js");
		const sessionEngine = await import("../src/engine/session.js");

		const result = await loadDomains([ConfigDomainModule, SafetyDomainModule, ModesDomainModule, SessionDomainModule]);
		check("domain:loaded", result.loaded.includes("session"), `loaded=${result.loaded.join(",")}`);

		type SessionContractType = import("../src/domains/session/contract.js").SessionContract;
		const session = result.getContract<SessionContractType>("session");
		check("domain:contract-exposed", session !== undefined);
		if (!session) {
			await result.stop();
			return;
		}

		const workdir = join(home, "project");
		const meta = session.create({ cwd: workdir });
		check("create:meta-id-nonempty", meta.id.length > 0, `id=${meta.id}`);
		check("create:meta-cwd-resolved", meta.cwd.endsWith("project"), `cwd=${meta.cwd}`);
		check("create:current-reflects-meta", session.current()?.id === meta.id);

		const paths = sessionEngine.sessionPaths(meta);
		check("create:meta.json-exists", existsSync(paths.meta));
		check("create:current.jsonl-exists", existsSync(paths.current));
		check("create:tree.json-exists", existsSync(paths.tree));
		check("create:under-data-dir", paths.meta.startsWith(clioDataDir()));

		const t1 = session.append({ kind: "user", parentId: null, payload: { text: "hi" } });
		check("append:t1-has-id", typeof t1.id === "string" && t1.id.length > 0, `id=${t1.id}`);
		check("append:t1-has-at", typeof t1.at === "string" && t1.at.length > 0);
		check("append:t1-kind", t1.kind === "user");

		const t2 = session.append({ kind: "assistant", parentId: t1.id, payload: { text: "hello" } });
		check("append:t2-parent-link", t2.parentId === t1.id, `got ${String(t2.parentId)}`);

		await session.checkpoint("test");
		const treeAfterCheckpoint = JSON.parse(readFileSync(paths.tree, "utf8")) as Array<{
			id: string;
			parentId: string | null;
		}>;
		check("checkpoint:tree-has-2", treeAfterCheckpoint.length === 2, `len=${treeAfterCheckpoint.length}`);
		check(
			"checkpoint:tree-parent-link",
			treeAfterCheckpoint[0]?.id === t1.id && treeAfterCheckpoint[1]?.parentId === t1.id,
		);

		const metaAfterCheckpoint = JSON.parse(readFileSync(paths.meta, "utf8")) as {
			lastCheckpointAt?: string;
			lastCheckpointReason?: string;
		};
		check(
			"checkpoint:meta-updated",
			typeof metaAfterCheckpoint.lastCheckpointAt === "string" && metaAfterCheckpoint.lastCheckpointAt.length > 0,
			`lastCheckpointAt=${String(metaAfterCheckpoint.lastCheckpointAt)}`,
		);
		check("checkpoint:meta-reason", metaAfterCheckpoint.lastCheckpointReason === "test");

		const resumed = session.resume(meta.id);
		check("resume:same-meta-id", resumed.id === meta.id);
		const reader = sessionEngine.openSession(meta.id);
		const turns = reader.turns();
		check("resume:reader-2-turns", turns.length === 2, `turns=${turns.length}`);
		check("resume:reader-parent-link", turns[1]?.parentId === t1.id);

		// Fork from t1 → new session with parent pointers
		const fork = session.fork(t1.id);
		check("fork:new-id", fork.id !== meta.id, `forkId=${fork.id} parentId=${meta.id}`);
		check("fork:parent-session", fork.parentSessionId === meta.id, `parentSessionId=${String(fork.parentSessionId)}`);
		check("fork:parent-turn", fork.parentTurnId === t1.id, `parentTurnId=${String(fork.parentTurnId)}`);

		const forkPaths = sessionEngine.sessionPaths(fork);
		const forkMetaOnDisk = JSON.parse(readFileSync(forkPaths.meta, "utf8")) as {
			parentSessionId?: string;
			parentTurnId?: string;
		};
		check(
			"fork:parent-session-persisted",
			forkMetaOnDisk.parentSessionId === meta.id,
			`disk parentSessionId=${String(forkMetaOnDisk.parentSessionId)}`,
		);
		check(
			"fork:parent-turn-persisted",
			forkMetaOnDisk.parentTurnId === t1.id,
			`disk parentTurnId=${String(forkMetaOnDisk.parentTurnId)}`,
		);

		const hist = session.history();
		check("history:contains-both", hist.length >= 2, `len=${hist.length}`);
		const ids = hist.map((m) => m.id);
		check("history:has-parent-id", ids.includes(meta.id));
		check("history:has-fork-id", ids.includes(fork.id));
		const oldestCreated = hist[hist.length - 1]?.createdAt;
		check(
			"history:newest-first",
			hist[0] !== undefined && oldestCreated !== undefined && hist[0].createdAt >= oldestCreated,
		);

		await session.close();
		check("close:current-cleared", session.current() === null);
		const forkMetaAfterClose = JSON.parse(readFileSync(forkPaths.meta, "utf8")) as { endedAt: string | null };
		check(
			"close:endedAt-set",
			typeof forkMetaAfterClose.endedAt === "string" && forkMetaAfterClose.endedAt.length > 0,
			`endedAt=${String(forkMetaAfterClose.endedAt)}`,
		);

		await result.stop();
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
}

async function main(): Promise<void> {
	await run();
	if (failures.length > 0) {
		process.stderr.write(`[diag-session] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-session] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-session] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
