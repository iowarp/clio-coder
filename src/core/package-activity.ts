import { randomUUID } from "node:crypto";
import { writeDiagnostic } from "./diagnostics.js";
import type { PackageIdentity } from "./package-identity.js";

export const EXTENSION_ACTIVITY = "clio_coder_extension_activity";
export const PLUGIN_RESOURCE_USE = "clio_coder_plugin_resource_use";
export interface PackageActivity {
	eventId: string;
	at: string;
	type: typeof EXTENSION_ACTIVITY | typeof PLUGIN_RESOURCE_USE;
	kind: string;
	owner: PackageIdentity;
	outcome?: string;
	sessionId?: string;
	turnId?: string;
	runId?: string;
	captureDroppedBefore?: number;
	details?: Readonly<Record<string, unknown>>;
}
type ActivityInput = Omit<PackageActivity, "eventId" | "at" | "type" | "captureDroppedBefore"> & {
	type?: PackageActivity["type"];
	at?: string;
};
const LIMIT = 200;
let sink: ((activity: PackageActivity) => boolean) | undefined;
const pending: PackageActivity[] = [];
const recent: PackageActivity[] = [];
let dropped = 0;
export function bindPackageActivitySink(next: (activity: PackageActivity) => boolean): () => void {
	sink = next;
	flushPackageActivities();
	return () => {
		if (sink !== next) return;
		sink = undefined;
		dropped += pending.length;
		pending.length = 0;
		recent.length = 0;
	};
}
export function flushPackageActivities(): void {
	if (!sink) return;
	while (pending.length > 0) {
		try {
			const activity = pending[0];
			const reported = dropped;
			if (!activity || !sink(reported > 0 ? { ...activity, captureDroppedBefore: reported } : activity)) return;
			pending.shift();
			dropped -= reported;
			if (reported > 0)
				writeDiagnostic(`Package activity capture dropped ${reported} earlier events; details are unavailable.`);
		} catch {
			// Observability has no authority over a committed host operation.
			return;
		}
	}
}
export function recordPackageActivity(input: ActivityInput): void {
	const activity: PackageActivity = {
		...input,
		type: input.type ?? EXTENSION_ACTIVITY,
		eventId: randomUUID(),
		at: input.at ?? new Date().toISOString(),
	};
	recent.push(activity);
	if (recent.length > LIMIT) recent.shift();
	pending.push(activity);
	if (pending.length > LIMIT) {
		pending.shift();
		dropped += 1;
	}
	flushPackageActivities();
}
export function recentPackageActivity(id: string): ReadonlyArray<PackageActivity> {
	return recent.filter((row) => row.owner.id === id).slice(-8);
}
export function packageActivityText(activity: PackageActivity): string {
	return `${activity.owner.id}@${activity.owner.version} ${activity.kind}${activity.outcome ? `: ${activity.outcome}` : ""} (${activity.owner.digest.slice(0, 12)})`;
}
