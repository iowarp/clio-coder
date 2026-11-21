import {
	auditDispatchAdmissionStore,
	type DispatchAdmissionStoreAudit,
	type InvalidAdmissionRecord,
	repairDispatchAdmissionStore,
} from "../domains/dispatch/capacity-lease.js";
import type { DoctorFinding } from "../domains/lifecycle/doctor.js";

const KINDS = [
	{
		kind: "reservation",
		name: "dispatch reservations",
		count: (audit: DispatchAdmissionStoreAudit) => audit.reservations,
	},
	{
		kind: "capacity lease",
		name: "dispatch capacity leases",
		count: (audit: DispatchAdmissionStoreAudit) => audit.leases,
	},
] as const;

function labels(records: ReadonlyArray<InvalidAdmissionRecord>): string {
	const shown = records.slice(0, 3).map((record) => record.label);
	return records.length > 3 ? `${shown.join(", ")} and ${records.length - 3} more` : shown.join(", ");
}

function plural(count: number, one: string): string {
	return `${count} ${one}${count === 1 ? "" : "s"}`;
}

/**
 * The admission store (`dispatch-admission.json`) holds both plan reservations and capacity leases. A record no
 * current reader accepts is dropped on read when it is settled; a live one refuses dispatch until `--fix` drops it,
 * and `--fix` resets a file that cannot be read at all. Leases and reservations are process-lifetime state.
 */
export function dispatchAdmissionFindings(options: { fix?: boolean; nowMs?: number } = {}): DoctorFinding[] {
	const nowMs = options.nowMs ?? Date.now();
	let audit: DispatchAdmissionStoreAudit | null;
	try {
		audit = options.fix === true ? repairDispatchAdmissionStore(nowMs) : auditDispatchAdmissionStore(nowMs);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return [{ ok: false, name: "dispatch admission store", detail: message }];
	}
	if (audit === null) return KINDS.map(({ name }) => ({ ok: true, name, detail: "none recorded" }));
	if (audit.problem !== null) {
		return [
			options.fix === true
				? { ok: true, name: "dispatch admission store", detail: `reset ${audit.path}: ${audit.problem}` }
				: { ok: false, name: "dispatch admission store", detail: `${audit.problem}; clio-coder doctor --fix resets it` },
		];
	}
	const current = audit;
	return KINDS.map(({ kind, name, count }): DoctorFinding => {
		const invalid = current.invalid.filter((record) => record.kind === kind);
		const valid = plural(count(current), "valid record");
		if (invalid.length === 0) return { ok: true, name, detail: valid };
		if (options.fix === true) {
			return {
				ok: true,
				name,
				detail: `${valid}; dropped ${plural(invalid.length, "invalid record")} (${labels(invalid)})`,
			};
		}
		const live = invalid.filter((record) => record.live);
		if (live.length > 0) {
			return {
				ok: false,
				name,
				detail: `${valid}; ${plural(live.length, "invalid live record")} (${labels(live)}) refuse dispatch; if the owner is gone, clio-coder doctor --fix drops them`,
			};
		}
		return {
			ok: true,
			level: "warn",
			name,
			detail: `${valid}; ${plural(invalid.length, "invalid settled record")} (${labels(invalid)}), dropped at the next start or by clio-coder doctor --fix`,
		};
	});
}
