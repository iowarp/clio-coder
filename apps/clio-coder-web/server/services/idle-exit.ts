/** Holds cover HTTP response lifetimes, including SSE; busy covers work after disconnect. */
export class IdleExit {
	private holds = 0;
	private lastActivity = performance.now();
	private stopped = false;
	private readonly timer: ReturnType<typeof setInterval>;
	constructor(ms: number, busy: () => boolean, exit: () => void) {
		this.timer = setInterval(
			() => {
				if (this.holds || busy()) this.lastActivity = performance.now();
				else if (performance.now() - this.lastActivity >= ms) {
					this.stop();
					exit();
				}
			},
			Math.min(ms, 100),
		);
		this.timer.unref();
	}
	hold() {
		this.holds++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.holds--;
			this.lastActivity = performance.now();
		};
	}
	stop() {
		if (this.stopped) return;
		this.stopped = true;
		clearInterval(this.timer);
	}
}
