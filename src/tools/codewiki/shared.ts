import { statSync } from "node:fs";
import { codewikiPath, readCodewiki } from "../../domains/context/codewiki/artifact.js";
import { coordinateCodewikiWrite } from "../../domains/context/codewiki/coordinator.js";
import type { Codewiki } from "../../domains/context/codewiki/schema.js";
import { readClioState, writeClioState } from "../../domains/context/state.js";

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

export async function loadCodewikiForTool(
	cwd: string = process.cwd(),
): Promise<{ ok: true; codewiki: Codewiki } | { ok: false; message: string }> {
	try {
		const generatedAt = new Date().toISOString();
		const coordinated = await coordinateCodewikiWrite(
			cwd,
			(current, workspace) => {
				const language = readClioState(workspace)?.projectType ?? current?.language;
				return {
					kind: "ensure",
					cwd,
					...(language ? { language } : {}),
					current,
					previous: readClioState(workspace)?.fingerprint ?? null,
				};
			},
			{
				readCurrent: (workspace) => readCodewikiForTool(workspace) ?? undefined,
				afterCommit: ({ codewiki: committed, fingerprint, changed }, workspace) => {
					const prev = readClioState(workspace);
					if (!changed && prev) return;
					writeClioState(workspace, {
						version: 1,
						projectType: prev?.projectType ?? committed.language,
						fingerprint,
						codewikiVersion: committed.version,
						...(prev?.contextSources ? { contextSources: prev.contextSources } : {}),
						...(prev?.contextSourceHash ? { contextSourceHash: prev.contextSourceHash } : {}),
						...(prev?.lastBootstrap ? { lastBootstrap: prev.lastBootstrap } : {}),
						...(prev?.lastInitAt ? { lastInitAt: prev.lastInitAt } : {}),
						lastSessionAt: prev?.lastSessionAt ?? generatedAt,
						lastIndexedAt: generatedAt,
					});
				},
			},
		);
		if (!coordinated) throw new Error("codewiki coordinator did not admit the demand build");
		// Not cached here: a post-write stat could pair a concurrent writer's identity
		// with this object. The next call re-reads once and caches from a clean stat.
		return { ok: true, codewiki: coordinated.codewiki };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, message: `codewiki unavailable. run /context refresh to rebuild it. ${msg}` };
	}
}

export function renderJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}
