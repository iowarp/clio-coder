import { homedir } from "node:os";
import { readLayeredSettings } from "../../../../../src/core/settings-layers.js";
import { resolveClioDirs } from "../../../../../src/core/xdg.js";
import {
	detectInteropAgents,
	discoverInteropInventory,
	INTEROP_AGENT_KINDS,
	interopProposals,
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
/**
 * Opening the page reads files and nothing else. Only an explicit `probe` runs a foreign executable,
 * and then only a bounded `--version` inside a scratch home; without it the version is the last one
 * Clio Coder recorded for the same binary.
 */
export async function inspectInterop(cwd: string, probe: boolean, fixture = false) {
	const home = fixture ? process.env.CLIO_CODER_HOME : undefined;
	const report = await detectInteropAgents({ cwd, inventory: true, probeVersion: probe, ...(home ? { home } : {}) });
	// Wiring is decided by the same function the terminal review uses, so this page can never offer
	// or withhold an agent the review would treat differently.
	let wired: { configured: Set<string>; proposed: Set<string> } | undefined;
	try {
		const { settings } = readLayeredSettings(cwd);
		wired = {
			configured: new Set(settings.integrations.externalAgents.entries.map((agent) => agent.id)),
			proposed: new Set(interopProposals(report, settings).map((proposal) => proposal.kind)),
		};
	} catch {
		wired = undefined;
	}
	return {
		detectedAt: report.detectedAt,
		agents: INTEROP_AGENT_KINDS.map((kind) => {
			const row = report.agents.find((row) => row.kind === kind.id);
			const resolved = row ?? resolveOnPath(kind.binaryNames);
			const wiring = !wired
				? ("unknown" as const)
				: wired.configured.has(kind.id)
					? ("configured" as const)
					: kind.acp === undefined
						? ("not-acp" as const)
						: wired.proposed.has(kind.id)
							? ("proposed" as const)
							: row?.decision !== undefined
								? ("decided" as const)
								: ("not-offered" as const);
			return {
				kind: kind.id,
				label: kind.label,
				hasExecutable: kind.binaryNames.length > 0,
				presence: resolved.presence,
				binary: resolved.binary ?? null,
				version: row?.version ?? null,
				versionSource: row?.version === undefined ? null : probe ? ("probed" as const) : ("recorded" as const),
				installDir: row?.installDir ?? null,
				adapter: row?.adapter ?? null,
				decision: row?.decision ?? null,
				decidedAt: row?.decidedAt ?? null,
				decisionStale: row?.decision !== undefined && row.decidedFingerprint !== row.fingerprint,
				wiring,
				skillCount: row?.skillCount ?? null,
				projectArtifacts: row?.projectArtifacts ?? null,
				inventory: row?.inventory ?? discoverInteropInventory(kind, home ?? homedir(), cwd, home ? {} : process.env),
			};
		}),
	};
}
