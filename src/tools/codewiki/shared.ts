import { statSync } from "node:fs";
import { resolve } from "node:path";
import { codewikiPath, readCodewiki } from "../../domains/context/codewiki/artifact.js";
import { reconcileCodewikiCandidate } from "../../domains/context/codewiki/coordinator.js";
import type { Codewiki } from "../../domains/context/codewiki/schema.js";
import { readClioState } from "../../domains/context/state.js";

const CODEWIKI_ARTIFACT_CACHE_LIMIT = 4;

interface CodewikiArtifactIdentity {
	dev: bigint;
	ino: bigint;
	mtimeNs: bigint;
	size: bigint;
}

interface CodewikiArtifactCacheEntry {
	identity: CodewikiArtifactIdentity;
	codewiki: Codewiki;
}

const transientCodewikis = new Map<
	string,
	{
		codewiki: Codewiki;
		fingerprint: import("../../domains/context/fingerprint.js").Fingerprint;
		identity: CodewikiArtifactIdentity | null;
	}
>();

const codewikiArtifactCache = new Map<string, CodewikiArtifactCacheEntry>();

function codewikiArtifactIdentity(cwd: string): CodewikiArtifactIdentity | null {
	try {
		const stats = statSync(codewikiPath(cwd), { bigint: true });
		if (!stats.isFile()) return null;
		return { dev: stats.dev, ino: stats.ino, mtimeNs: stats.mtimeNs, size: stats.size };
	} catch {
		return null;
	}
}

function sameArtifactIdentity(a: CodewikiArtifactIdentity, b: CodewikiArtifactIdentity): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.size === b.size;
}

function rememberCodewikiArtifact(cwd: string, identity: CodewikiArtifactIdentity, codewiki: Codewiki): void {
	const key = codewikiPath(cwd);
	codewikiArtifactCache.delete(key);
	codewikiArtifactCache.set(key, { identity, codewiki });
	while (codewikiArtifactCache.size > CODEWIKI_ARTIFACT_CACHE_LIMIT) {
		const oldest = codewikiArtifactCache.keys().next().value;
		if (oldest === undefined) break;
		codewikiArtifactCache.delete(oldest);
	}
}

function readCodewikiForTool(cwd: string): Codewiki | null {
	const key = codewikiPath(cwd);
	const identity = codewikiArtifactIdentity(cwd);
	if (!identity) {
		codewikiArtifactCache.delete(key);
		return null;
	}
	const cached = codewikiArtifactCache.get(key);
	if (cached && sameArtifactIdentity(cached.identity, identity)) {
		rememberCodewikiArtifact(cwd, identity, cached.codewiki);
		return cached.codewiki;
	}
	const codewiki = readCodewiki(cwd);
	if (!codewiki) {
		codewikiArtifactCache.delete(key);
		return null;
	}
	rememberCodewikiArtifact(cwd, identity, codewiki);
	return codewiki;
}

/**
 * The current code map for a tool call, reconciled with the working tree in
 * memory. Nothing is written: the result is held per workspace, keyed to the
 * artifact on disk, so the next call checks freshness from it instead of
 * reindexing.
 */
export async function loadCodewikiForTool(
	cwd: string = process.cwd(),
): Promise<
	| { ok: true; codewiki: Codewiki; fingerprint: import("../../domains/context/fingerprint.js").Fingerprint }
	| { ok: false; message: string }
> {
	try {
		const workspace = resolve(cwd);
		const identity = codewikiArtifactIdentity(workspace);
		const cached = transientCodewikis.get(workspace);
		const sameDisk =
			cached &&
			(identity === null
				? cached.identity === null
				: cached.identity !== null && sameArtifactIdentity(identity, cached.identity));
		const state = readClioState(workspace);
		const current = sameDisk ? cached.codewiki : readCodewikiForTool(workspace);
		const language = state?.projectType ?? current?.language;
		const result = await reconcileCodewikiCandidate({
			kind: "ensure",
			cwd: workspace,
			current,
			previous: sameDisk ? cached.fingerprint : (state?.fingerprint ?? null),
			...(language ? { language } : {}),
		});
		transientCodewikis.delete(workspace);
		transientCodewikis.set(workspace, { codewiki: result.codewiki, fingerprint: result.fingerprint, identity });
		while (transientCodewikis.size > CODEWIKI_ARTIFACT_CACHE_LIMIT) {
			const oldest = transientCodewikis.keys().next().value;
			if (oldest !== undefined) transientCodewikis.delete(oldest);
		}
		return { ok: true, codewiki: result.codewiki, fingerprint: result.fingerprint };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, message: `codemap unavailable. run /context refresh to rebuild it. ${msg}` };
	}
}

export function renderJson(value: unknown): string {
	return JSON.stringify(value);
}
