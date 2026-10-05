import type { ContextActivityKind } from "../core/bus-events.js";
import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { ContextClearCommandOptions, InitCommandOptions, RunIo } from "../session-control/slash-commands.js";

export interface ContextCommandHandlers {
	bus: SafeEventBus;
	onInit?: (options: InitCommandOptions, io?: RunIo) => Promise<unknown>;
	onContextClear?: (options: ContextClearCommandOptions, io?: RunIo) => Promise<unknown>;
	onContextRefresh?: (io?: RunIo) => Promise<unknown>;
	onRecoverHandoff?: (handoffId: string, action: "reduce" | "deliver") => Promise<unknown>;
}

/**
 * Runs a context command whose operation reports its own conclusion on the
 * bus. The result card carries what the command wrote and what failed, so the
 * run neither prints stdout nor repeats a failure the card already shows. A
 * failure before any operation began still reaches the caller.
 */
async function reportedByOperation(
	bus: SafeEventBus,
	kind: ContextActivityKind,
	run: () => Promise<unknown>,
): Promise<unknown> {
	let reported = false;
	const stop = bus.on(BusChannels.ContextActivity, (event) => {
		if (event.kind === kind && event.operation?.outcome !== undefined) reported = true;
	});
	try {
		return await run();
	} catch (err) {
		if (reported) return undefined;
		throw err;
	} finally {
		stop();
	}
}

/**
 * The interactive host hands `/context init`, `reset` and `refresh` no output
 * channel. Their operation facts and warnings reach the transcript as one
 * result card, and a second stream of stdout or stderr lines would repeat or
 * contradict it. A recover failure the operation already reported is likewise
 * not repeated as an error notice.
 */
export function presentContextCommands<D extends ContextCommandHandlers>(deps: D): D {
	const { bus, onInit, onContextClear, onContextRefresh, onRecoverHandoff } = deps;
	return {
		...deps,
		...(onInit
			? { onInit: (options: InitCommandOptions) => reportedByOperation(bus, "context-init", () => onInit(options)) }
			: {}),
		...(onContextClear
			? {
					onContextClear: (options: ContextClearCommandOptions) =>
						reportedByOperation(bus, "context-clear", () => onContextClear(options)),
				}
			: {}),
		...(onContextRefresh
			? { onContextRefresh: () => reportedByOperation(bus, "context-refresh", () => onContextRefresh()) }
			: {}),
		// A refusal before the operation begins ("wait for the turn to settle") never reports, so it still surfaces.
		...(onRecoverHandoff
			? {
					onRecoverHandoff: (handoffId: string, action: "reduce" | "deliver") =>
						reportedByOperation(bus, "context-recover", () => onRecoverHandoff(handoffId, action)),
				}
			: {}),
	};
}
