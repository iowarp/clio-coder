const STOP_SIGNALS = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
export type StopSignal = keyof typeof STOP_SIGNALS;

export interface StopSignals {
	received: () => StopSignal | null;
	/** 130, 143 or 129 for the first signal received; 130 when none arrived. */
	exitCode: () => number;
	dispose: () => void;
}

/**
 * Stop a long-running command on SIGINT, SIGTERM or SIGHUP the same way: abort the controller so the command stops
 * its children, waits for them and cleans up, and remember the first signal for the exit code. A closed terminal
 * sends SIGHUP, and children that lead their own process groups never see it, so the abort is their only stop.
 */
export function installStopSignals(controller: AbortController, onFirst?: (signal: StopSignal) => void): StopSignals {
	let received: StopSignal | null = null;
	const handlers = (Object.keys(STOP_SIGNALS) as StopSignal[]).map((name) => {
		const handler = (): void => {
			if (received === null) {
				received = name;
				onFirst?.(name);
			}
			controller.abort();
		};
		process.on(name, handler);
		return [name, handler] as const;
	});
	return {
		received: () => received,
		exitCode: () => STOP_SIGNALS[received ?? "SIGINT"],
		dispose: () => {
			for (const [name, handler] of handlers) process.off(name, handler);
		},
	};
}
