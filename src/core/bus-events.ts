/**
 * Canonical channel names for the Clio event bus.
 *
 * Add new channels here. Downstream code imports from this file rather than
 * hard-coding string literals so renames are a single edit and typos fail fast.
 */

export const BusChannels = {
	SessionStart: "session.start",
	SessionEnd: "session.end",
	DomainLoaded: "domain.loaded",
	DomainFailed: "domain.failed",
	ConfigHotReload: "config.hotReload",
	ConfigNextTurn: "config.nextTurn",
	ConfigRestartRequired: "config.restartRequired",
	ModeChanged: "mode.changed",
	SafetyClassified: "safety.classified",
	SafetyBlocked: "safety.blocked",
	SafetyAllowed: "safety.allowed",
	ProviderHealth: "provider.health",
	DispatchEnqueued: "dispatch.enqueued",
	DispatchStarted: "dispatch.started",
	DispatchProgress: "dispatch.progress",
	DispatchCompleted: "dispatch.completed",
	DispatchFailed: "dispatch.failed",
	BudgetAlert: "budget.alert",
	ShutdownRequested: "shutdown.requested",
	ShutdownDrained: "shutdown.drained",
	ShutdownTerminated: "shutdown.terminated",
	ShutdownPersisted: "shutdown.persisted",
	HarnessWatcherStarted: "harness.watcher.started",
	HarnessFileChanged: "harness.file.changed",
	HarnessHotreloadSucceeded: "harness.hotreload.succeeded",
	HarnessHotreloadFailed: "harness.hotreload.failed",
	HarnessRestartRequired: "harness.restart.required",
	HarnessRestartTriggered: "harness.restart.triggered",
} as const;

export type BusChannel = (typeof BusChannels)[keyof typeof BusChannels];
