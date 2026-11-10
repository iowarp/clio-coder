import type { DispatchPrefixGroup } from "./contract.js";

/** The longest a batch holds the rest of a shared-prefix group for its leader's first token (C-04). */
export const PREFIX_HOLD_CAP_MS = 15_000;

export type PrefixHold =
	| { role: "leader"; group: DispatchPrefixGroup }
	| { role: "follower"; leaderRunId: string; heldMs: number }
	| null;

/**
 * C-04: within one batch, the first native run of a prefix key leads and starts at once; a later run of the same key
 * waits until the leader streams its first token, settles, or the group's cap from the leader's start runs out, so it
 * reads the prefix the leader wrote instead of prefilling it again. Abort ends the wait; the caller rechecks the signal.
 */
export async function holdForSharedPrefix(
	groups: Map<string, DispatchPrefixGroup> | undefined,
	key: string | null,
	runId: string,
	options: { signal?: AbortSignal; now?: () => number } = {},
): Promise<PrefixHold> {
	if (groups === undefined || key === null) return null;
	const existing = groups.get(key);
	if (existing === undefined) {
		let release!: () => void;
		let isReleased = false;
		const released = new Promise<void>((resolve) => {
			release = () => {
				isReleased = true;
				clearTimeout(timer);
				resolve();
			};
		});
		const timer = setTimeout(release, PREFIX_HOLD_CAP_MS);
		timer.unref?.();
		const group: DispatchPrefixGroup = { leaderRunId: runId, released, release, isReleased: () => isReleased };
		groups.set(key, group);
		return { role: "leader", group };
	}
	if (existing.isReleased()) return null;
	const now = options.now ?? Date.now;
	const startedAt = now();
	const signal = options.signal;
	if (signal?.aborted) return null;
	let onAbort: (() => void) | undefined;
	await Promise.race([
		existing.released,
		new Promise<void>((resolve) => {
			onAbort = resolve;
			signal?.addEventListener("abort", onAbort, { once: true });
		}),
	]);
	if (onAbort) signal?.removeEventListener("abort", onAbort);
	return { role: "follower", leaderRunId: existing.leaderRunId, heldMs: Math.max(0, now() - startedAt) };
}
