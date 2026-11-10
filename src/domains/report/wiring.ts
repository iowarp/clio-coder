import type { ReportSessionFacts } from "./environment.js";
import type { IdentitySettings } from "./scrub.js";
import type { ReportTextDeps, ReportTextHost } from "./text-flow.js";

export interface ReportWiringSource {
	stateDir: string;
	session: () => { id: string; cwd: string; model: string | null; target: string | null } | null | undefined;
	autonomy: () => string;
	identitySettings: () => IdentitySettings;
}

/**
 * What every report surface reads from the running session: the state dir, the workspace, and the session's id
 * and facts. Type-only imports, so the composition root wires it without loading the report domain.
 */
export function reportWiring(source: ReportWiringSource) {
	return {
		stateDir: source.stateDir,
		cwd: () => process.cwd(),
		session: (): { id: string; cwd: string; facts: ReportSessionFacts } | null => {
			const meta = source.session();
			if (!meta) return null;
			return {
				id: meta.id,
				cwd: meta.cwd,
				facts: {
					...(meta.model ? { model: meta.model } : {}),
					...(meta.target ? { runtime: meta.target } : {}),
					autonomy: source.autonomy(),
				},
			};
		},
		identitySettings: source.identitySettings,
	};
}

/** The ACP report host; the report domain loads on the first `/report`, never at boot. */
export function lazyReportTextHost(deps: ReportTextDeps): ReportTextHost {
	let loaded: Promise<ReportTextHost> | null = null;
	const load = (): Promise<ReportTextHost> => {
		loaded ??= import("./index.js").then(({ createReportTextHost }) => createReportTextHost(deps));
		return loaded;
	};
	return {
		plan: async (input) => (await load()).plan(input),
		send: async (draftId, choices) => (await load()).send(draftId, choices),
		status: async () => (await load()).status(),
		forget: async (id) => (await load()).forget(id),
	};
}
