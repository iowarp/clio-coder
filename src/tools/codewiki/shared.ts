import { statSync } from "node:fs";
import {
	buildCodewiki,
	type Codewiki,
	codewikiNeedsBackfill,
	codewikiPath,
	readCodewiki,
	writeCodewiki,
} from "../../domains/context/codewiki/indexer.js";
import { computeFingerprint, isStale } from "../../domains/context/fingerprint.js";
import { readClioState, writeClioState } from "../../domains/context/state.js";
import { detectProjectType } from "../../domains/session/workspace/project-type.js";

const CODEWIKI_ARTIFACT_CACHE_LIMIT = 4;

interface CodewikiArtifactIdentity {
	mtimeNs: bigint;
	size: bigint;
}

interface CodewikiArtifactCacheEntry {
	identity: CodewikiArtifactIdentity;
	codewiki: Codewiki;
}

const codewikiArtifactCache = new Map<string, CodewikiArtifactCacheEntry>();

function codewikiArtifactIdentity(cwd: string): CodewikiArtifactIdentity | null {
	try {
		const stats = statSync(codewikiPath(cwd), { bigint: true });
		if (!stats.isFile()) return null;
		return { mtimeNs: stats.mtimeNs, size: stats.size };
	} catch {
		return null;
	}
}

function sameArtifactIdentity(a: CodewikiArtifactIdentity, b: CodewikiArtifactIdentity): boolean {
	return a.mtimeNs === b.mtimeNs && a.size === b.size;
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

export async function loadCodewikiForTool(
	cwd: string = process.cwd(),
): Promise<{ ok: true; codewiki: Codewiki } | { ok: false; message: string }> {
	const codewiki = readCodewikiForTool(cwd);
	const state = readClioState(cwd);
	if (codewiki && !codewikiNeedsBackfill(codewiki)) {
		const fingerprint = computeFingerprint(cwd, codewiki);
		if (state && !isStale(state.fingerprint, fingerprint)) return { ok: true, codewiki };
	}
	try {
		const generatedAt = new Date().toISOString();
		const projectType = detectProjectType(cwd);
		const rebuilt = await buildCodewiki({ cwd, language: projectType, generatedAt });
		// Not cached here: a post-write stat could pair a concurrent writer's identity
		// with this object. The next call re-reads once and caches from a clean stat.
		writeCodewiki(cwd, rebuilt);
		const prev = state;
		writeClioState(cwd, {
			version: 1,
			projectType: prev?.projectType ?? projectType,
			fingerprint: computeFingerprint(cwd, rebuilt),
			codewikiVersion: rebuilt.version,
			...(prev?.contextSources ? { contextSources: prev.contextSources } : {}),
			...(prev?.contextSourceHash ? { contextSourceHash: prev.contextSourceHash } : {}),
			...(prev?.lastBootstrap ? { lastBootstrap: prev.lastBootstrap } : {}),
			...(prev?.lastInitAt ? { lastInitAt: prev.lastInitAt } : {}),
			lastSessionAt: prev?.lastSessionAt ?? generatedAt,
			lastIndexedAt: generatedAt,
		});
		return { ok: true, codewiki: rebuilt };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, message: `codewiki unavailable. run /context refresh to rebuild it. ${msg}` };
	}
}

export function renderJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}
