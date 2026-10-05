import { AsyncLocalStorage } from "node:async_hooks";

interface Clock {
	now: number;
}
const clocks = new AsyncLocalStorage<Clock>();
let users = 0;
let originalDate: DateConstructor;
let scopedDate: DateConstructor;

/** Date sees the requesting host's clock; concurrent hosts and unrelated code retain their own time. */
export function createTestClock() {
	const clock = { now: 0 };
	if (users++ === 0) {
		originalDate = globalThis.Date;
		scopedDate = new Proxy(originalDate, {
			construct(target, args, newTarget) {
				const active = clocks.getStore();
				return Reflect.construct(target, args.length === 0 && active ? [active.now] : args, newTarget);
			},
			apply(target, thisArg, args) {
				const active = clocks.getStore();
				return active ? new originalDate(active.now).toString() : Reflect.apply(target, thisArg, args);
			},
			get(target, key, receiver) {
				return key === "now" ? () => clocks.getStore()?.now ?? originalDate.now() : Reflect.get(target, key, receiver);
			},
		});
		globalThis.Date = scopedDate;
	}
	let disposed = false;
	return {
		get now(): number {
			return clock.now;
		},
		set now(value: number) {
			clock.now = value;
		},
		run<T>(task: () => T): T {
			return clocks.run(clock, task);
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			if (--users === 0 && globalThis.Date === scopedDate) globalThis.Date = originalDate;
		},
	};
}
