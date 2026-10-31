import { unobservedRunUsageFacts } from "../../core/telemetry/pricing.js";
import { runUsageFromCallRecords } from "../dispatch/run-call-usage.js";
import type { SessionCallJournalRead } from "./fork-journal.js";
import type { LedgerUsageCall } from "./usage.js";

/** Window attempts by settlement (start only while unclosed), retaining their identity and gap records (#434). */
export function runJournalsInWindow(
	session: SessionCallJournalRead,
	from: number,
	to: number,
): SessionCallJournalRead["runs"] {
	const result: SessionCallJournalRead["runs"] = new Map();
	const within = (timestamp: string) => {
		const time = Date.parse(timestamp);
		return time >= from && time <= to;
	};
	const referenced = new Set(
		session.records.flatMap(({ record }) =>
			(record.k === "run.linked" || record.k === "call.linked") && within(record.t) ? [record.data.runId] : [],
		),
	);
	const accounting = (row: SessionCallJournalRead["records"][number]) =>
		row.record.k === "run.usage_reported" || row.record.k === "call.started" || row.record.k === "call.settled";
	for (const [runId, journal] of session.runs) {
		const selected = new Map<string, boolean>();
		for (const { record } of journal.records) {
			if (record.k !== "call.started" && record.k !== "call.settled") continue;
			if (record.k === "call.settled" || !selected.has(record.data.attemptId))
				selected.set(record.data.attemptId, within(record.t));
		}
		const records = journal.records.filter(({ record }) =>
			record.k === "run.usage_reported"
				? within(record.t)
				: record.k === "call.started" || record.k === "call.settled"
					? selected.get(record.data.attemptId)
					: true,
		);
		if (records.some(accounting) || (!journal.records.some(accounting) && referenced.has(runId)))
			result.set(runId, { ...journal, records });
	}
	return result;
}

/** A referenced worker is one replaceable run contribution, including aggregate-only external peers (#434). */
export function usageCallsFromRunJournals(runs: Readonly<SessionCallJournalRead["runs"]>): LedgerUsageCall[] {
	return [...runs.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([runId, journal]) => {
			const records = journal.records.map(({ record }) => record);
			const usage = runUsageFromCallRecords(records);
			const source = records.find(
				(record) => record.k === "run.usage_reported" || record.k === "call.started" || record.k === "call.settled",
			);
			const target =
				source && (source.k === "run.usage_reported" || source.k === "call.started" || source.k === "call.settled")
					? source.data.target
					: undefined;
			const incomplete = !source || journal.skipped > 0 || journal.damaged > 0;
			return {
				runId,
				runJournalUnavailable: !source,
				runCutoff: journal.throughMs,
				usageFacts: usage.usageFacts,
				// A run whose journal is missing, skipped or damaged settles nothing it can vouch for (#434).
				runSpend: incomplete ? unobservedRunUsageFacts() : usage.facts,
				providerId: target?.targetId ?? "unknown",
				requestedModelId: target?.requestedModel ?? "unknown",
				attributedModelId: target?.requestedModel ?? "unknown",
				responseModelIdObservation: { state: "not-observed" },
			};
		});
}
