/**
 * Runs an "ensure" build under the codewiki write lease and records freshness
 * state, the way the session-start check and the bootstrap and wiki writers
 * do. code_nav's `loadCodewikiForTool` never writes, so tests that need the
 * artifact and state on disk reconciled with the tree drive this instead.
 * State is left alone when nothing changed and orientation is already recorded,
 * which lets a test assert that an unchanged ensure rewrites nothing.
 */
import { coordinateCodewikiWrite } from "../../src/domains/context/codewiki/coordinator.js";
import type { Codewiki } from "../../src/domains/context/codewiki/schema.js";
import type { Fingerprint } from "../../src/domains/context/fingerprint.js";
import { readClioState, writeClioState } from "../../src/domains/context/state.js";

export async function ensureCodewikiOnDisk(cwd: string): Promise<{ codewiki: Codewiki; fingerprint: Fingerprint }> {
	const indexedAt = new Date().toISOString();
	const coordinated = await coordinateCodewikiWrite(
		cwd,
		(current, workspace) => {
			const state = readClioState(workspace);
			const language = state?.projectType ?? current?.language;
			return { kind: "ensure", cwd, ...(language ? { language } : {}), current, previous: state?.fingerprint ?? null };
		},
		{
			afterCommit: ({ codewiki, fingerprint, changed }, workspace) => {
				const prev = readClioState(workspace);
				if (!changed && prev?.orientation) return;
				writeClioState(
					workspace,
					{
						...prev,
						version: 1,
						projectType: prev?.projectType ?? codewiki.language,
						fingerprint,
						codewikiVersion: codewiki.version,
						lastSessionAt: prev?.lastSessionAt ?? indexedAt,
						lastIndexedAt: indexedAt,
					},
					codewiki,
				);
			},
		},
	);
	if (!coordinated) throw new Error("codewiki coordinator did not admit the ensure build");
	return { codewiki: coordinated.codewiki, fingerprint: coordinated.worker.fingerprint };
}
