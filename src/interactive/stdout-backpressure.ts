/**
 * Process-wide stdout admission gate for interactive frame production.
 *
 * A terminal frame whose write returns false was accepted by Node, but the
 * writable is now saturated. The current frame may finish its cursor/IME
 * writes; later frames wait for drain and then render the newest model state.
 */

export interface StdoutBackpressureGate {
	readonly blocked: boolean;
	readonly observed: boolean;
	onWritable(listener: () => void): () => void;
	/** Resolve false when a finite wait expires; no listener survives the bound. */
	whenWritable(timeoutMs?: number): Promise<boolean>;
	restore(): void;
}

interface WritableStdoutBoundary {
	write: typeof process.stdout.write;
	once(event: "drain", listener: () => void): unknown;
	off(event: "drain", listener: () => void): unknown;
}

export function installStdoutBackpressureGate(stdout: WritableStdoutBoundary = process.stdout): StdoutBackpressureGate {
	const original = stdout.write;
	const listeners = new Set<() => void>();
	let blocked = false;
	let observed = false;
	let restored = false;
	let drainListening = false;

	const notifyWritable = (): void => {
		drainListening = false;
		if (!blocked) return;
		blocked = false;
		for (const listener of [...listeners]) listener();
	};
	const listenForDrain = (): void => {
		if (drainListening || restored) return;
		drainListening = true;
		stdout.once("drain", notifyWritable);
	};
	const wrapped = function (this: typeof stdout, ...args: unknown[]): boolean {
		const returned = Reflect.apply(original, this, args) as boolean;
		if (!returned) {
			observed = true;
			blocked = true;
			listenForDrain();
		}
		return returned;
	} as typeof stdout.write;
	stdout.write = wrapped;

	return {
		get blocked() {
			return blocked;
		},
		get observed() {
			return observed;
		},
		onWritable(listener) {
			if (restored || !blocked) {
				queueMicrotask(listener);
				return () => {};
			}
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		whenWritable(timeoutMs?: number) {
			if (restored || !blocked) return Promise.resolve(true);
			return new Promise<boolean>((resolve) => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				const release = this.onWritable(() => {
					if (timer) clearTimeout(timer);
					release();
					resolve(true);
				});
				if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs >= 0) {
					timer = setTimeout(() => {
						release();
						resolve(false);
					}, timeoutMs);
				}
			});
		},
		restore() {
			if (restored) return;
			restored = true;
			blocked = false;
			if (drainListening) {
				stdout.off("drain", notifyWritable);
				drainListening = false;
			}
			if (stdout.write === wrapped) stdout.write = original;
			for (const listener of [...listeners]) listener();
			listeners.clear();
		},
	};
}
