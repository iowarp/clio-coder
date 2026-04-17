/**
 * Minimal concurrency primitives used throughout Clio: a semaphore for max-in-flight
 * control and a token bucket for per-provider rate limiting.
 *
 * Phase 1 seeds both primitives so later domains (dispatch, scheduling, providers) can
 * depend on them without circular imports.
 */

export class Semaphore {
	private permits: number;
	private readonly waiters: Array<() => void> = [];

	constructor(permits: number) {
		if (permits < 1) throw new Error("Semaphore permits must be >= 1");
		this.permits = permits;
	}

	async acquire(): Promise<() => void> {
		if (this.permits > 0) {
			this.permits -= 1;
			return () => this.release();
		}
		await new Promise<void>((resolve) => this.waiters.push(resolve));
		this.permits -= 1;
		return () => this.release();
	}

	private release(): void {
		this.permits += 1;
		const waiter = this.waiters.shift();
		if (waiter) waiter();
	}

	available(): number {
		return this.permits;
	}
}

export class TokenBucket {
	private tokens: number;
	private lastRefillMs: number;

	constructor(
		private readonly capacity: number,
		private readonly refillPerSec: number,
	) {
		if (capacity < 1) throw new Error("TokenBucket capacity must be >= 1");
		this.tokens = capacity;
		this.lastRefillMs = Date.now();
	}

	tryTake(n = 1): boolean {
		this.refill();
		if (this.tokens < n) return false;
		this.tokens -= n;
		return true;
	}

	private refill(): void {
		const now = Date.now();
		const elapsedSec = (now - this.lastRefillMs) / 1000;
		if (elapsedSec <= 0) return;
		this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
		this.lastRefillMs = now;
	}
}
