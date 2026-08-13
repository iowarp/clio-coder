/** Largest delay Node can schedule without overflowing to an approximately 1 ms timer. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Normalize optional/disable-capable timer inputs. Nonpositive and NaN values
 * disable the timer; oversized and infinite values cap at Node's real limit.
 */
export function clampTimerDelayMs(value: number): number {
	if (Number.isNaN(value) || value <= 0) return 0;
	return value >= MAX_TIMER_DELAY_MS ? MAX_TIMER_DELAY_MS : Math.floor(value);
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
