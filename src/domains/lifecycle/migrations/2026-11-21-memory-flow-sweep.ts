import { existsSync, rmSync } from "node:fs";
import { clioDataDir } from "../../../core/xdg.js";
import { memoryFlowSweepMarkerPath, sweepRestrictedMemory } from "../../memory/flow-sweep.js";
import { projectDeclaresFlowRules } from "../../safety/flow-policy-snapshot.js";
import { FLOW_RESTRICTION_ENTRY_TYPE } from "../../session/history.js";
import type { Migration, MigrationReport } from "./index.js";

/**
 * Withdraws the lessons releases before 0.6.8 filed from sessions under an information-flow restriction
 * (`sweepRestrictedMemory`). Boot used to run this pass itself, behind a marker file in the state root; a home whose
 * marker says the pass already finished keeps every record as it is and loses only the marker.
 */
const migration: Migration = {
	id: "2026-11-21-memory-flow-sweep",
	async up(stateDir: string): Promise<MigrationReport> {
		const report: MigrationReport = { changed: [], attention: [] };
		const marker = memoryFlowSweepMarkerPath(stateDir);
		if (existsSync(marker)) {
			rmSync(marker, { force: true });
			return report;
		}
		const { openSession } = await import("../../../engine/session.js");
		const rejected = await sweepRestrictedMemory(clioDataDir(), {
			sessionFirstLabelAt: (sessionId) => {
				let first: string | null = null;
				for (const entry of openSession(sessionId).turns()) {
					if ((entry as { customType?: unknown }).customType !== FLOW_RESTRICTION_ENTRY_TYPE) continue;
					const at = (entry as { timestamp?: unknown }).timestamp;
					const stamp = typeof at === "string" ? at : new Date(0).toISOString();
					if (first === null || stamp < first) first = stamp;
				}
				return first;
			},
			repositoryDeclaresFlowRules: projectDeclaresFlowRules,
		});
		if (rejected.length > 0)
			report.changed.push(
				`Memory withdrew ${rejected.length} lesson${rejected.length === 1 ? "" : "s"} filed from sessions under an information-flow restriction: ${rejected.join(", ")}. Review with clio-coder memory list; clio-coder memory approve <id> restores one.`,
			);
		return report;
	},
};

export default migration;
