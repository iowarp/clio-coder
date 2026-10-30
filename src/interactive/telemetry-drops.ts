import type { HealthV1 } from "../core/telemetry/dto.js";
import { renderCount } from "../core/telemetry/render.js";

/**
 * Journal drop alerts (#434 §14). A journal that drops, rejects or fails to write records leaves every total it
 * feeds partial, so the operator hears of it, once per owner per minute; `/health` carries the counts.
 */
export const DROP_ALERT_WINDOW_MS = 60_000;

export interface DropAlert {
	owner: string;
	/** Notification key: a later alert for the same owner replaces the earlier one. */
	key: string;
	text: string;
}

interface Losses {
	dropped: number;
	invalid: number;
	writeErrors: number;
}

const NONE: Losses = { dropped: 0, invalid: 0, writeErrors: 0 };
const counted = (quantity: HealthV1["journals"][number]["dropped"]) =>
	quantity.fact.kind === "measured" ? quantity.fact.value : 0;
const plural = (count: number, noun: string) => `${renderCount(count)} ${noun}${count === 1 ? "" : "s"}`;

function describe(owner: string, rise: Losses): string {
	const parts = [
		...(rise.dropped > 0 ? [`${plural(rise.dropped, "record")} dropped`] : []),
		...(rise.invalid > 0 ? [`${renderCount(rise.invalid)} invalid`] : []),
		...(rise.writeErrors > 0 ? [plural(rise.writeErrors, "write error")] : []),
	];
	return `Telemetry journal ${owner.replace(":", " ")}: ${parts.join(", ")}. Totals it feeds are partial; /health has the detail.`;
}

export interface DropAlerts {
	/** Alerts for the owners whose losses rose since their last alert, outside that owner's window. */
	observe(health: HealthV1, nowMs: number): DropAlert[];
	/** When a rise held back by its owner's window becomes due, or null when none is held. */
	nextCheckAt(): number | null;
}

export function createDropAlerts(): DropAlerts {
	/** Losses as of each owner's last alert; a rise is measured from here. */
	const reported = new Map<string, Losses>();
	const alertedAt = new Map<string, number>();
	const held = new Set<string>();
	return {
		observe(health, nowMs) {
			const alerts: DropAlert[] = [];
			const open = new Set<string>();
			for (const journal of health.journals) {
				const owner = journal.owner;
				open.add(owner);
				const losses = {
					dropped: counted(journal.dropped),
					invalid: counted(journal.invalid),
					writeErrors: counted(journal.writeErrors),
				};
				let base = reported.get(owner) ?? NONE;
				// A reopened writer starts its counters again at zero.
				if (losses.dropped < base.dropped || losses.invalid < base.invalid || losses.writeErrors < base.writeErrors)
					base = NONE;
				const rise = {
					dropped: losses.dropped - base.dropped,
					invalid: losses.invalid - base.invalid,
					writeErrors: losses.writeErrors - base.writeErrors,
				};
				reported.set(owner, base);
				if (rise.dropped + rise.invalid + rise.writeErrors === 0) continue;
				const last = alertedAt.get(owner);
				if (last !== undefined && nowMs - last < DROP_ALERT_WINDOW_MS) {
					held.add(owner);
					continue;
				}
				alertedAt.set(owner, nowMs);
				reported.set(owner, losses);
				held.delete(owner);
				alerts.push({ owner, key: `telemetry-drop:${owner}`, text: describe(owner, rise) });
			}
			// A closed writer's counts are gone; the window still holds if the owner reopens within it.
			for (const owner of [...reported.keys()])
				if (!open.has(owner)) {
					reported.delete(owner);
					held.delete(owner);
				}
			for (const [owner, at] of alertedAt) if (nowMs - at >= DROP_ALERT_WINDOW_MS) alertedAt.delete(owner);
			return alerts;
		},
		nextCheckAt() {
			let due: number | null = null;
			for (const owner of held) {
				const at = alertedAt.get(owner);
				if (at !== undefined && (due === null || at + DROP_ALERT_WINDOW_MS < due)) due = at + DROP_ALERT_WINDOW_MS;
			}
			return due;
		},
	};
}
