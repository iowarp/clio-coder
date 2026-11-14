import { useSyncExternalStore } from "react";
import { clock } from "./clock.js";

// One interval for the whole page. Every countdown that reads it reads the same second in the same commit,
// so a banner and the card it points at can never disagree by one.

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let current = clock.now();

function tick() {
	current = clock.now();
	for (const listener of listeners) listener();
}

/** Starts the interval on the first subscriber and stops it on the last. */
export function subscribeSecond(listener: () => void): () => void {
	listeners.add(listener);
	if (timer === null) {
		current = clock.now();
		timer = setInterval(tick, 1000);
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0 && timer !== null) {
			clearInterval(timer);
			timer = null;
		}
	};
}

/** The cached second; it only changes on a tick, so repeated reads in one commit agree. */
export const currentSecond = (): number => current;

const idle = () => () => {};

/** The shared skew-corrected second while `active`; an inactive caller holds the last value and costs nothing. */
export function useSharedSecond(active: boolean): number {
	return useSyncExternalStore(active ? subscribeSecond : idle, currentSecond, currentSecond);
}
