import type { ProvidersContract } from "../domains/providers/contract.js";
import type { OverlayHandle, OverlayOptions, TUI } from "../engine/tui.js";
import { openProvidersOverlay } from "./providers-overlay.js";

const failures: string[] = [];

function check(label: string, condition: boolean, detail?: string): void {
	if (condition) return;
	failures.push(`${label}${detail ? ` - ${detail}` : ""}`);
}

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function createDeferred(): Deferred {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function createFakeTui(): TUI {
	const visible = { current: true };
	const handle: OverlayHandle = {
		hide: () => {
			visible.current = false;
		},
		setHidden: () => {},
		isHidden: () => !visible.current,
		focus: () => {},
		unfocus: () => {},
		isFocused: () => visible.current,
	};
	return {
		requestRender: () => {},
		showOverlay: (_component: unknown, _options?: OverlayOptions) => handle,
	} as unknown as TUI;
}

async function main(): Promise<void> {
	const realSetInterval = globalThis.setInterval;
	const realClearInterval = globalThis.clearInterval;
	let nextId = 0;
	const timers = new Set<number>();
	globalThis.setInterval = ((_: () => void, _ms?: number) => {
		const id = ++nextId;
		timers.add(id);
		return id as unknown as ReturnType<typeof setInterval>;
	}) as typeof setInterval;
	globalThis.clearInterval = ((id: ReturnType<typeof setInterval>) => {
		timers.delete(id as unknown as number);
	}) as typeof clearInterval;

	try {
		const live = createDeferred();
		const endpoints = createDeferred();
		let completeCalls = 0;
		const providers: ProvidersContract = {
			list: () => [],
			getAdapter: () => null,
			probeAll: async () => {},
			probeEndpoints: async () => {
				await endpoints.promise;
			},
			probeAllLive: async () => {
				await live.promise;
			},
			probeEndpointsLive: async () => {},
			credentials: {
				hasKey: () => false,
				set: () => {},
				remove: () => {},
			},
		};

		const handle = openProvidersOverlay(createFakeTui(), providers, {
			onComplete: () => {
				completeCalls += 1;
			},
		});

		check("providers-overlay:loader-single-interval-while-open", timers.size === 1, String(timers.size));
		handle.hide();
		check("providers-overlay:loader-stops-on-hide", timers.size === 0, String(timers.size));

		live.resolve();
		await live.promise;
		endpoints.resolve();
		await endpoints.promise;
		await Promise.resolve();

		check("providers-overlay:hide-aborts-completion", completeCalls === 0, String(completeCalls));
	} finally {
		globalThis.setInterval = realSetInterval;
		globalThis.clearInterval = realClearInterval;
	}

	if (failures.length > 0) {
		for (const failure of failures) {
			process.stderr.write(`[providers-overlay.diag] FAIL ${failure}\n`);
		}
		process.exit(1);
	}

	process.stdout.write("[providers-overlay.diag] PASS\n");
}

main().catch((err: unknown) => {
	process.stderr.write(`[providers-overlay.diag] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
