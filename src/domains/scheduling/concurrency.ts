/**
 * Concurrency gate. Combines a worker-count cap with a token-bucket limiter so
 * burst calls can't overrun downstream providers. v0.1 uses it as an
 * advisory surface; dispatch stays on the native worker pool.
 */

export interface ConcurrencyGate {
	readonly maxWorkers: number;
	activeWorkers(): number;
	tryAcquire(): boolean;
	release(): void;
	refillRatePerSec: number;
	tokensAvailable(): number;
	takeToken(now?: number): boolean;
}

export function createConcurrencyGate(maxWorkers: number, refillRatePerSec = 10): ConcurrencyGate {
	if (maxWorkers < 1) throw new Error(`concurrency: maxWorkers must be >= 1 (got ${maxWorkers})`);
	let active = 0;
	let tokens = maxWorkers;
	let lastRefillMs = Date.now();

	function refill(now: number): void {
		const elapsedSec = Math.max(0, (now - lastRefillMs) / 1000);
		const added = elapsedSec * refillRatePerSec;
		tokens = Math.min(maxWorkers, tokens + added);
		lastRefillMs = now;
	}

	return {
		maxWorkers,
		refillRatePerSec,
		activeWorkers: () => active,
		tryAcquire() {
			if (active >= maxWorkers) return false;
			active += 1;
			return true;
		},
		release() {
			if (active > 0) active -= 1;
		},
		tokensAvailable() {
			refill(Date.now());
			return tokens;
		},
		takeToken(now = Date.now()) {
			refill(now);
			if (tokens < 1) return false;
			tokens -= 1;
			return true;
		},
	};
}
