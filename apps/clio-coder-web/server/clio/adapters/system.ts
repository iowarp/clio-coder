import { homedir } from "node:os";
import { resolveClioDirs } from "../../../../../src/core/xdg.js";
import {
	detectInteropAgents,
	discoverInteropInventory,
	INTEROP_AGENT_KINDS,
	resolveOnPath,
} from "../../../../../src/domains/interop/index.js";
import { runDoctor } from "../../../../../src/domains/lifecycle/doctor.js";

export function inspectSystem() {
	return {
		checkedAt: new Date().toISOString(),
		paths: resolveClioDirs(),
		findings: runDoctor({ fix: false }).map((row) => {
			// Failed parsers can quote credential values or the offending YAML line.
			const detailRedacted = !row.ok && ["settings.yaml", "credentials"].includes(row.name);
			return {
				...row,
				level: row.level ?? (row.ok ? "ok" : "error"),
				detailRedacted,
				detail: detailRedacted
					? `Clio reported a problem with ${row.name}. Inspect the source locally with clio-coder doctor; parser details are withheld to protect credentials.`
					: row.detail,
			};
		}),
	};
}
export async function inspectInterop(cwd: string, fixture = false) {
	const home = fixture ? process.env.CLIO_CODER_HOME : undefined;
	const report = await detectInteropAgents({ cwd, inventory: true, probeVersion: true, ...(home ? { home } : {}) });
	return {
		detectedAt: report.detectedAt,
		agents: INTEROP_AGENT_KINDS.map((kind) => {
			const row = report.agents.find((row) => row.kind === kind.id);
			const resolved = row ?? resolveOnPath(kind.binaryNames);
			return {
				kind: kind.id,
				label: kind.label,
				hasExecutable: kind.binaryNames.length > 0,
				presence: resolved.presence,
				binary: resolved.binary ?? null,
				version: row?.version ?? null,
				installDir: row?.installDir ?? null,
				adapter: row?.adapter ?? null,
				decision: row?.decision ?? null,
				skillCount: row?.skillCount ?? null,
				projectArtifacts: row?.projectArtifacts ?? null,
				inventory: row?.inventory ?? discoverInteropInventory(kind, home ?? homedir(), cwd, home ? {} : process.env),
			};
		}),
	};
}
