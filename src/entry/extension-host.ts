import type { TelemetryHub } from "../core/telemetry/hub.js";
import {
	createTurnObservations,
	observeChatTurns,
	subscribeExtensionObservations,
} from "../domains/extensions/bus-observations.js";
import { OperatorExtensions, type OperatorExtensionsOptions } from "../domains/extensions/operator-extensions.js";
import type { OperatorReloadResult } from "../domains/extensions/operator-runtime.js";
import { OBSERVATION_BACKLOG } from "../domains/extensions/operator-runtime-v2.js";
import type { ExtensionObservationV2 } from "../domains/extensions/public-api-v2.js";
import type { ExtensionRuntimeHookBridge } from "../domains/extensions/runtime-hook-bridge.js";
import type { ChatLoop } from "../session-control/chat-loop.js";
import type { AskUserHandler } from "../tools/ask-user.js";
import { cancelUnansweredInterview, runParkedInterview } from "../tools/extension-interview.js";

/**
 * Hosts api 2 extension runtimes for a session with no terminal: a headless
 * `clio-coder run` and an ACP session. Hooks, runtime tools, observations and
 * maintenance ticks work as they do in the terminal, and a tool's interview
 * goes to the ACP client's interview channel. With no channel the interview is
 * cancelled at once with reason `headless`, so the extension records that no
 * author was available instead of the call waiting. Workspaces, skins, docks,
 * mute and the dev scope stay terminal-only: nothing here draws what a
 * runtime publishes.
 */
export interface ExtensionHostOptions {
	mode: "headless" | "acp";
	/** The installed packages this host may start, as the extensions domain lists them. */
	list: NonNullable<OperatorExtensionsOptions["list"]>;
	runtimeHooks: ExtensionRuntimeHookBridge;
	bus: TelemetryHub;
	chat: Pick<ChatLoop, "isStreaming" | "turnPreparation" | "onEvent">;
	sessionId: () => string | null;
	targetId: () => string;
	frozenTools?: OperatorExtensionsOptions["frozenTools"];
	embed?: OperatorExtensionsOptions["embed"];
	sandboxUnixSockets?: OperatorExtensionsOptions["sandboxUnixSockets"];
	/** One line naming the extension and the reason. */
	notify: (message: string) => void;
	/** ACP's interview channel when the client answers interviews. */
	ask?: AskUserHandler;
}

export interface ExtensionHost {
	readonly operator: OperatorExtensions;
	/** Settles once the startup generation has started its runtimes; hooks and tools wait for it. */
	readonly ready: Promise<OperatorReloadResult>;
	/** Restart the runtimes after the hook generation was committed elsewhere (ACP's extensions reload). */
	restart(): Promise<OperatorReloadResult>;
	dispose(): Promise<void>;
}

export function startExtensionHost(options: ExtensionHostOptions): ExtensionHost {
	// Nothing runs yet while the startup reload stages, or after a session
	// change retired the last generation, so a turn that starts meanwhile has
	// nothing to swap out from under it; the next generation must not wait for
	// that turn to end, or every gate would fail closed until it is over.
	let starting = true;
	const isIdle = (): boolean =>
		starting ||
		operator.v2.awaitingGeneration ||
		(!options.chat.isStreaming() && options.chat.turnPreparation().phase === "idle");
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	const operator = new OperatorExtensions({
		context: () => ({ workspace: process.cwd(), sessionId: options.sessionId(), mode: options.mode }),
		isIdle,
		list: options.list,
		...(options.frozenTools ? { frozenTools: options.frozenTools } : {}),
		...(options.embed ? { embed: options.embed } : {}),
		...(options.sandboxUnixSockets ? { sandboxUnixSockets: options.sandboxUnixSockets } : {}),
		onChange: () => schedule(),
		onDiagnostic: (message) => options.notify(message),
		onReload: (result) => {
			if (result.status === "rejected" || result.degraded === undefined || result.degraded > 0)
				options.notify(result.message);
		},
	});
	// Nothing runs until the startup generation commits, so a headless run's
	// first turn_start would reach no runtime. Observations wait for it in order,
	// bounded like the runtime's own hold, each tagged with the session it came from.
	let held: { sessionId: string | null; observation: ExtensionObservationV2 }[] | undefined = [];
	const observeV2 = (observation: ExtensionObservationV2): void => {
		if (!held) {
			operator.observeV2(observation);
			return;
		}
		if (held.length >= OBSERVATION_BACKLOG) held.shift();
		held.push({ sessionId: options.sessionId(), observation });
	};
	const ready = operator.reload("startup").finally(() => {
		starting = false;
		const pending = held ?? [];
		held = undefined;
		// An ACP session/new during startup makes another session current; its
		// generation must not hear the old session's turn after its session_open.
		// A session-less event belongs to the session that adopts it.
		const current = options.sessionId();
		for (const { sessionId, observation } of pending)
			if (sessionId === null || sessionId === current) operator.observeV2(observation);
	});
	const turns = createTurnObservations(observeV2);
	// A hook registered with the generation answers only once its runtime runs;
	// until startup or a session change's reload settles it would read as not
	// running and fail closed.
	const settled = <T>(run: () => Promise<T>): Promise<T> => ready.then(() => operator.v2.whenLive()).then(run, run);
	options.runtimeHooks.bind({
		hook: (extensionId, event, timeoutMs, signal) => settled(() => operator.hook(extensionId, event, timeoutMs, signal)),
		notify: (message) => options.notify(message),
		observeTurnStart: (text) => turns.turnStart(text),
		tool: (extensionId, name, input, signal) => settled(() => operator.tool(extensionId, name, input, signal)),
		interview: (extensionId, interview, signal) => {
			const ask = options.ask;
			if (!ask) return cancelUnansweredInterview(interview, (answer) => operator.interview(extensionId, answer));
			return runParkedInterview(
				{ ask },
				interview,
				{ extensionId, title: extensionId },
				// The closing cancel still reaches the handler after an abort.
				(answer) => operator.interview(extensionId, answer, answer.nav === "cancel" ? undefined : signal),
				signal,
			);
		},
	});
	const unsubscribers = [
		...(
			["session.started", "session.ended", "session.parked", "session.reattached", "session.turn_switched"] as const
		).map((channel) =>
			options.bus.subscribe(channel, () => operator.invalidateContext(channel === "session.reattached")),
		),
		subscribeExtensionObservations(options.bus, observeV2),
		observeChatTurns((handler) => options.chat.onEvent(handler), turns, options.targetId),
		options.chat.onEvent((event) => {
			if (event.type !== "agent_end") return;
			operator.observe({ event: "turn_end", reason: "completed" });
			schedule();
		}),
	];
	function schedule(): void {
		if (disposed) return;
		clearTimeout(timer);
		const delay = operator.maintenanceDelayMs;
		if (delay === null) return;
		timer = setTimeout(() => {
			operator.maintenance();
			schedule();
		}, delay);
		timer.unref();
	}
	void ready.then(() => schedule());
	return {
		operator,
		ready,
		restart: () => operator.reload("reload"),
		async dispose() {
			if (disposed) return;
			disposed = true;
			clearTimeout(timer);
			for (const unsubscribe of unsubscribers) unsubscribe();
			options.runtimeHooks.bind(null);
			await operator.dispose();
		},
	};
}
