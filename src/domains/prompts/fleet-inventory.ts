import type { ClioSettings } from "../../core/config.js";
import { sessionFleetNode } from "../dispatch/fleet-placement-preference.js";
import { fleetPreflightVerdict, readFleetPreflightRecords } from "../dispatch/fleet-preflight.js";
import type { SchedulingContract } from "../scheduling/contract.js";

/** Stable observations keep worker activity and ticking ages out of the cached system prompt. */
export function renderFleetInventory(
	settings: Readonly<ClioSettings> | undefined,
	scheduling: SchedulingContract | undefined,
	cwd: string,
	sessionId: string,
): string {
	const nodes = settings?.fleet.nodes ?? [];
	if (nodes.length === 0) return "";
	const records = readFleetPreflightRecords();
	const short = (value: string) =>
		[...value]
			.map((char) => (char.charCodeAt(0) < 32 ? " " : char))
			.join("")
			.slice(0, 100);
	const rows = [
		"# Worker fleet observations",
		`Placement: session=${sessionFleetNode(sessionId) ?? "unset"}; standing=${settings?.fleet.defaultNode ?? "unset"}; unpinned default=local.`,
		`local: configured capacity=${settings?.fleet.concurrency ?? "unknown"}.`,
	];
	for (const node of nodes.slice(0, 8)) {
		const record = records.find((item) => item.nodeId === node.id && item.projectRoot === cwd);
		const verdict = fleetPreflightVerdict(node, cwd, records);
		const snapshot = scheduling?.fleet?.get(node.id);
		const resources = record?.resources;
		rows.push(
			`${short(node.id)}: SSH ${short(node.host)}; readiness=${snapshot?.state === "offline" ? "offline" : verdict.ok ? "ready for this project" : record ? "needs attention" : "not checked"}; checkedAt=${short(record?.checkedAt ?? "never")}; capacity=${node.maxWorkers}; declared labels=${(node.labels ?? []).slice(0, 6).map(short).join(",") || "none"}; observed CPU=${resources?.cpuCount ?? "unknown"}, RAM bytes=${resources?.totalMemoryBytes ?? "unknown"}, GPUs=${resources?.gpuCount ?? "unknown"}, VRAM bytes=${resources?.vramBytes ?? "unknown"}; project=${record?.project?.kind ?? "unverified"}.`,
		);
		for (const target of (record?.targets ?? []).slice(0, 2))
			rows.push(
				`  target=${short(target.targetId)}: network=${target.reachable}; listing access=${target.authentication ?? "unknown"}; catalog model=${target.modelAvailable}; runtime=${target.runtimeCompatible}; observed=${short(target.probedAt)}.`,
			);
	}
	if (nodes.length > 8) rows.push(`${nodes.length - 8} more nodes omitted; fleet nodes list shows all.`);
	rows.push(
		"Delegated ACP peers are separate helpers, not SSH capacity or evidence of access to these files. Catalog presence does not prove generation support or model residency. Resource observations and checks may be stale.",
	);
	return rows.join("\n");
}
