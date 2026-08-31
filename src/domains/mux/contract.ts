/**
 * The pane layer's cross-domain surface, per spec 4.4.
 *
 * Every method is best-effort. A mux failure never fails a dispatch, never
 * throws at a caller, and never blocks the event loop on a dead socket: it logs
 * and degrades to `available() === false`, which the consumers read as "use the
 * native fleet surfaces instead". That is why every method here returns a
 * fallback value rather than rejecting.
 *
 * Two ownership rules run through the whole file. Clio acts only on panes it
 * created, tracked in `pane-registry.ts` and tagged with the `clio_owner`
 * metadata token so `clio doctor` can find orphans. The one documented
 * exception is Clio's own hosting pane in guest mode, which `reportSelf`
 * writes to under SA-3 of the v0.4.0 cycle plan.
 */

import type { DomainContract } from "../../core/domain-loader.js";
import type { MuxDetection } from "./detect.js";
import { createPaneRegistry, type MuxPaneRegistry, paneRecord } from "./pane-registry.js";
import { muxSupportsMethod } from "./protocol.js";
import type { MuxClient, MuxSubscription } from "./socket-client.js";
import {
	MuxError,
	type MuxEvent,
	type MuxLog,
	type MuxMode,
	type MuxNotificationSound,
	type MuxPaneRecord,
	type MuxPaneRef,
	type MuxReportableAgentState,
	type MuxRunDisplayState,
	type MuxSelfReport,
} from "./types.js";

/** Metadata source for everything Clio's pane layer writes. */
const METADATA_SOURCE = "clio:mux";
/** Agent-authority source for viewer panes, per spec 4.7. */
const RUN_AGENT_SOURCE = "clio:dispatch";
/** Agent-authority source for Clio's own hosting pane, per SA-3. */
const SELF_AGENT_SOURCE = "clio:coder";
/** Token every Clio-created pane carries so orphans are findable. */
const OWNER_TOKEN_KEY = "clio_owner";
const OWNER_TOKEN_VALUE = "clio:mux";
/** herdr caps a metadata token value at 80 characters. */
const TOKEN_VALUE_MAX = 80;
/** How long `available()` stays false after a transport failure before probing again. */
const DEGRADE_COOLDOWN_MS = 5_000;
const DEFAULT_FLEET_TAB_LABEL = "Fleet";

export interface MuxOpenRunPaneRequest {
	runId: string;
	agentId: string;
	label: string;
}

export interface MuxOpenUtilityPaneRequest {
	argv: ReadonlyArray<string>;
	cwd: string;
	label: string;
	direction?: "right" | "down";
	env?: Readonly<Record<string, string>>;
}

export interface MuxNotifyRequest {
	title: string;
	body?: string;
	sound?: MuxNotificationSound;
}

/** One still-running run a resumed session wants its viewer pane back for. */
export interface MuxAdoptableRun {
	runId: string;
	agentId: string;
	label: string;
}

export interface MuxContract extends DomainContract {
	readonly mode: MuxMode;
	/** `mode !== "none"` and the socket is currently healthy. */
	available(): boolean;
	/**
	 * The rung detection resolved to, with the socket it answered on and the
	 * protocol recorded from the handshake. `/panes` and `clio-coder doctor`
	 * print it; the focus and notify ladders gate on its protocol.
	 */
	detection(): Readonly<MuxDetection>;
	openRunPane(request: MuxOpenRunPaneRequest): Promise<MuxPaneRef | null>;
	focusRunPane(runId: string): Promise<boolean>;
	closeRunPane(runId: string, options?: { keepOnFailure?: boolean }): Promise<void>;
	openUtilityPane(request: MuxOpenUtilityPaneRequest): Promise<MuxPaneRef | null>;
	/** Close one Clio-created pane by pane id. Refuses a pane Clio did not create. */
	closePane(paneId: string): Promise<boolean>;
	reportRunState(runId: string, state: MuxRunDisplayState): Promise<void>;
	notify(request: MuxNotifyRequest): Promise<void>;
	/**
	 * Re-adopt viewer panes that outlived the process that made them.
	 *
	 * A resumed session takes a fresh `session.snapshot` and claims back every
	 * pane carrying Clio's owner token whose `run` token names a run the caller
	 * says is still going. That is what stops a restart from opening a second
	 * pane beside the one already on screen. Returns the runs it adopted.
	 */
	adoptRunPanes(runs: ReadonlyArray<MuxAdoptableRun>): Promise<ReadonlyArray<string>>;
	/**
	 * Called when a pane Clio owns leaves, whether the user closed it or the
	 * program in it exited. The bridge records the run id and does not reopen:
	 * a closed viewer pane is a decision, not a fault.
	 */
	onPaneGone(handler: (record: MuxPaneRecord) => void): () => void;
	/** Panes Clio created, with their purpose and run id. */
	list(): ReadonlyArray<MuxPaneRecord>;
	/**
	 * Report Clio's own state on its hosting pane (SA-3). Returns false when
	 * there is no pane to report on, which is every mode but guest. Phase 3
	 * drives this from turn events; Phase 1 only lands the capability.
	 */
	reportSelf(report: MuxSelfReport): Promise<boolean>;
	shutdown(): Promise<void>;
}

export interface MuxRuntimeOptions {
	detection: MuxDetection;
	client: MuxClient | null;
	log?: MuxLog;
	now?: () => number;
	fleetTabLabel?: string;
	/** Working directory new panes inherit when the caller does not name one. */
	cwd?: string;
	/**
	 * Command a run viewer pane runs. Phase 2 supplies `clio run view <runId>`;
	 * until then a viewer pane is a plain shell in the Fleet tab.
	 */
	viewerCommand?: (request: MuxOpenRunPaneRequest) => ReadonlyArray<string> | null;
}

/** The contract plus the lifecycle handles the domain extension drives. */
export interface MuxRuntime {
	contract: MuxContract;
	start(): Promise<void>;
	stop(): Promise<void>;
	/** Test seam: the registry the contract reconciles against. */
	registry: MuxPaneRegistry;
}

/** POSIX single-quoting, so an argv element with spaces or quotes survives the shell. */
function shellQuote(argv: ReadonlyArray<string>): string {
	return argv.map((arg) => `'${arg.replaceAll("'", `'\\''`)}'`).join(" ");
}

function token(value: string | undefined | null): string | null {
	if (typeof value !== "string" || value.length === 0) return null;
	return value.length > TOKEN_VALUE_MAX ? value.slice(0, TOKEN_VALUE_MAX) : value;
}

interface FleetTab {
	tabId: string;
	/** The tab's root pane; the anchor every viewer pane splits from. */
	seedPaneId: string;
	/** Whether the root pane itself was handed to a run rather than left as a shell. */
	rootAdopted: boolean;
}

export function createMuxRuntime(options: MuxRuntimeOptions): MuxRuntime {
	const { detection, client } = options;
	const log = options.log ?? ((): void => undefined);
	const now = options.now ?? Date.now;
	const fleetTabLabel = options.fleetTabLabel ?? DEFAULT_FLEET_TAB_LABEL;
	const registry = createPaneRegistry();

	let healthy = client !== null;
	let probeHealthAt = 0;
	let stopped = false;
	let subscription: MuxSubscription | null = null;
	let fleetTab: FleetTab | null = null;
	const paneGoneHandlers = new Set<(record: MuxPaneRecord) => void>();

	const degrade = (what: string, error: unknown): void => {
		const message = error instanceof Error ? error.message : String(error);
		const transport = error instanceof MuxError && (error.kind === "transport" || error.kind === "timeout");
		if (transport) {
			healthy = false;
			probeHealthAt = now() + DEGRADE_COOLDOWN_MS;
		}
		log(transport ? "warning" : "debug", `mux ${what} failed: ${message}`);
	};

	const usable = (): boolean => {
		if (stopped || client === null || detection.mode === "none") return false;
		return healthy || now() >= probeHealthAt;
	};

	/**
	 * Runs one mux interaction and swallows everything it can throw. The fallback
	 * is what the caller sees when the pane layer is not there, which is the same
	 * value it sees in `none` mode.
	 */
	const attempt = async <T>(what: string, run: (live: MuxClient) => Promise<T>, fallback: T): Promise<T> => {
		if (!usable() || client === null) return fallback;
		try {
			const value = await run(client);
			healthy = true;
			return value;
		} catch (error) {
			degrade(what, error);
			return fallback;
		}
	};

	const tagOwner = async (
		live: MuxClient,
		paneId: string,
		tokens: Readonly<Record<string, string | null>>,
	): Promise<void> => {
		await live.paneReportMetadata({
			paneId,
			source: METADATA_SOURCE,
			tokens: { [OWNER_TOKEN_KEY]: OWNER_TOKEN_VALUE, ...tokens },
		});
	};

	/**
	 * Resolve the Fleet tab, creating it on first use. The tab id is cached and
	 * re-verified through `tab.list` because the user may have closed it since.
	 */
	const ensureFleetTab = async (live: MuxClient): Promise<FleetTab> => {
		if (fleetTab) {
			const tabs = await live.tabList(detection.self.workspaceId ?? undefined);
			if (tabs.some((tab) => tab.tabId === fleetTab?.tabId)) return fleetTab;
			fleetTab = null;
		}
		const created = await live.tabCreate({
			...(detection.self.workspaceId ? { workspaceId: detection.self.workspaceId } : {}),
			label: fleetTabLabel,
			focus: false,
		});
		fleetTab = { tabId: created.tab.tabId, seedPaneId: created.rootPane.paneId, rootAdopted: false };
		return fleetTab;
	};

	/** Newest Clio-owned pane in the Fleet tab, or the tab root when there is none. */
	const fleetAnchor = (tab: FleetTab): string => {
		let anchor = tab.seedPaneId;
		for (const entry of registry.list()) {
			if (entry.ref.tabId === tab.tabId) anchor = entry.ref.paneId;
		}
		return anchor;
	};

	const reportAgent = async (
		live: MuxClient,
		paneId: string,
		agent: string,
		state: MuxReportableAgentState,
		source: string,
		message?: string,
	): Promise<void> => {
		await live.paneReportAgent({
			paneId,
			source,
			agent,
			state,
			...(message ? { message } : {}),
		});
	};

	const onEvent = (event: MuxEvent): void => {
		if (fleetTab && event.paneId === fleetTab.seedPaneId) {
			// The tab's anchor is gone; the next openRunPane rebuilds the tab.
			fleetTab = null;
		}
		const dropped = registry.forget(event.paneId);
		if (dropped) {
			log("debug", `mux pane ${event.paneId} left on ${event.kind}; dropped from the registry`);
			for (const handler of paneGoneHandlers) {
				try {
					handler(dropped);
				} catch (error) {
					log("debug", `mux pane-gone handler threw: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
	};

	const contract: MuxContract = {
		mode: detection.mode,

		available(): boolean {
			return usable();
		},

		detection(): Readonly<MuxDetection> {
			return detection;
		},

		async openRunPane(request: MuxOpenRunPaneRequest): Promise<MuxPaneRef | null> {
			const existing = registry.byRunId(request.runId);
			if (existing) return existing.ref;
			return await attempt(
				"openRunPane",
				async (live) => {
					// Re-check under the await: two starts for one run can race here.
					const raced = registry.byRunId(request.runId);
					if (raced) return raced.ref;
					const tab = await ensureFleetTab(live);
					const pane = tab.rootAdopted
						? await live.paneSplit({
								direction: "down",
								targetPaneId: fleetAnchor(tab),
								focus: false,
								...(options.cwd ? { cwd: options.cwd } : {}),
							})
						: await live.paneGet(tab.seedPaneId);
					tab.rootAdopted = true;
					const ref: MuxPaneRef = { paneId: pane.paneId, tabId: pane.tabId, workspaceId: pane.workspaceId };
					registry.record(
						paneRecord(ref, {
							purpose: "run",
							label: request.label,
							openedAt: now(),
							runId: request.runId,
							agentId: request.agentId,
						}),
					);
					await tagOwner(live, pane.paneId, {
						role: token(request.agentId),
						run: token(request.runId),
					});
					await reportAgent(live, pane.paneId, request.agentId, "working", RUN_AGENT_SOURCE, request.label);
					const argv = options.viewerCommand?.(request);
					if (argv && argv.length > 0) {
						await live.paneSendText(pane.paneId, `exec ${shellQuote(argv)}\n`);
					}
					return ref;
				},
				null,
			);
		},

		async focusRunPane(runId: string): Promise<boolean> {
			const entry = registry.byRunId(runId);
			if (!entry) return false;
			return await attempt(
				"focusRunPane",
				async (live) => {
					// herdr has no pane.focus method, so this is a two-rung ladder.
					// agent.focus is preferred because it additionally marks the pane
					// seen, clearing herdr's attention state; it resolves for a viewer
					// pane exactly because pane.report_agent gave that pane agent
					// authority. A pane that never got authority, or a server too old
					// for the method, falls back to focusing the pane's tab, which is
					// what phase 1 did for every pane.
					if (muxSupportsMethod(detection.server, "agent.focus")) {
						try {
							await live.agentFocus(entry.ref.paneId);
							return true;
						} catch (error) {
							// A transport failure has to reach `attempt` so the contract
							// degrades; anything the server refused is a reason to fall back.
							if (error instanceof MuxError && (error.kind === "transport" || error.kind === "timeout")) throw error;
							log("debug", `mux agent.focus on ${entry.ref.paneId} refused; falling back to tab.focus`);
						}
					}
					await live.tabFocus(entry.ref.tabId);
					return true;
				},
				false,
			);
		},

		async closeRunPane(runId: string, closeOptions: { keepOnFailure?: boolean } = {}): Promise<void> {
			const entry = registry.byRunId(runId);
			if (!entry) return;
			const failed = entry.outcome === "failed" || entry.outcome === "timed_out";
			if (closeOptions.keepOnFailure === true && failed) {
				log("debug", `mux keeping pane ${entry.ref.paneId} open for post-mortem of ${runId}`);
				return;
			}
			await attempt(
				"closeRunPane",
				async (live) => {
					await live.paneClose(entry.ref.paneId);
					registry.forget(entry.ref.paneId);
					return undefined;
				},
				undefined,
			);
		},

		async closePane(paneId: string): Promise<boolean> {
			// Spec 4.4's ownership rule, restated for the operator-facing path:
			// `/panes close` addresses panes by id and must refuse anything the
			// registry does not hold.
			if (!registry.owns(paneId)) return false;
			return await attempt(
				"closePane",
				async (live) => {
					await live.paneClose(paneId);
					registry.forget(paneId);
					return true;
				},
				false,
			);
		},

		async openUtilityPane(request: MuxOpenUtilityPaneRequest): Promise<MuxPaneRef | null> {
			return await attempt(
				"openUtilityPane",
				async (live) => {
					const anchor = detection.self.paneId ?? (await live.paneCurrent()).paneId;
					const pane = await live.paneSplit({
						direction: request.direction ?? "right",
						targetPaneId: anchor,
						cwd: request.cwd,
						focus: false,
						...(request.env ? { env: request.env } : {}),
					});
					const ref: MuxPaneRef = { paneId: pane.paneId, tabId: pane.tabId, workspaceId: pane.workspaceId };
					registry.record(paneRecord(ref, { purpose: "utility", label: request.label, openedAt: now() }));
					await tagOwner(live, pane.paneId, { role: token(request.label) });
					if (request.argv.length > 0) {
						// herdr has no argv parameter on pane.split, so the command goes in
						// through the pane's shell. `exec` replaces the shell so the pane
						// exits with the program and emits pane.exited for reconciliation.
						await live.paneSendText(pane.paneId, `exec ${shellQuote(request.argv)}\n`);
					}
					return ref;
				},
				null,
			);
		},

		async reportRunState(runId: string, state: MuxRunDisplayState): Promise<void> {
			const entry = registry.byRunId(runId);
			// Not ours: spec 4.4 forbids reporting state on a pane Clio did not create.
			if (!entry) return;
			registry.update(entry.ref.paneId, { outcome: state.outcome ?? null });
			await attempt(
				"reportRunState",
				async (live) => {
					await reportAgent(live, entry.ref.paneId, entry.agentId ?? entry.label, state.agentState, RUN_AGENT_SOURCE);
					await live.paneReportMetadata({
						paneId: entry.ref.paneId,
						source: METADATA_SOURCE,
						tokens: {
							[OWNER_TOKEN_KEY]: OWNER_TOKEN_VALUE,
							role: token(entry.agentId),
							run: token(entry.runId),
							phase: token(state.phase),
							model: token(state.model),
							outcome: token(state.outcome),
						},
						// A finished run reported as `idle` reads in herdr's sidebar
						// exactly like an untouched shell. The override is what makes a
						// terminal pane say what it is holding.
						...(state.stateLabels ? { stateLabels: state.stateLabels } : {}),
					});
					return undefined;
				},
				undefined,
			);
		},

		async notify(request: MuxNotifyRequest): Promise<void> {
			if (!muxSupportsMethod(detection.server, "notification.show")) {
				log("debug", `mux notify skipped, server protocol is below the notification.show floor: ${request.title}`);
				return;
			}
			await attempt(
				"notify",
				async (live) => {
					const result = await live.notificationShow({
						title: request.title,
						...(request.body ? { body: request.body } : {}),
						...(request.sound ? { sound: request.sound } : {}),
					});
					// A suppressed toast is the operator's own herdr config talking
					// (disabled, rate limited, no foreground client). Reporting it as a
					// warning would turn their setting into Clio's error.
					if (!result.shown) log("debug", `mux notify not shown (${result.reason}): ${request.title}`);
					return undefined;
				},
				undefined,
			);
		},

		async adoptRunPanes(runs: ReadonlyArray<MuxAdoptableRun>): Promise<ReadonlyArray<string>> {
			if (runs.length === 0) return [];
			const wanted = new Map(runs.map((run) => [run.runId, run]));
			return await attempt(
				"adoptRunPanes",
				async (live) => {
					const snapshot = await live.snapshot();
					const adopted: string[] = [];
					for (const pane of snapshot.panes) {
						if (pane.tokens[OWNER_TOKEN_KEY] !== OWNER_TOKEN_VALUE) continue;
						const runId = pane.tokens.run;
						if (runId === undefined) continue;
						const run = wanted.get(runId);
						// A run that already has a pane in this process wins: the record
						// here is live and the snapshot is a moment old.
						if (!run || registry.byRunId(runId) || registry.owns(pane.paneId)) continue;
						registry.record(
							paneRecord(
								{ paneId: pane.paneId, tabId: pane.tabId, workspaceId: pane.workspaceId },
								{
									purpose: "run",
									label: run.label,
									openedAt: now(),
									runId,
									agentId: run.agentId,
									adopted: true,
								},
							),
						);
						adopted.push(runId);
					}
					if (adopted.length > 0) {
						log("info", `mux adopted ${adopted.length} viewer pane(s) left open by a previous session`);
					}
					return adopted;
				},
				[],
			);
		},

		onPaneGone(handler: (record: MuxPaneRecord) => void): () => void {
			paneGoneHandlers.add(handler);
			return () => {
				paneGoneHandlers.delete(handler);
			};
		},

		list(): ReadonlyArray<MuxPaneRecord> {
			return registry.list();
		},

		async reportSelf(report: MuxSelfReport): Promise<boolean> {
			const paneId = detection.self.paneId;
			if (detection.mode !== "guest" || !paneId) return false;
			return await attempt(
				"reportSelf",
				async (live) => {
					await reportAgent(live, paneId, "clio-coder", report.state, SELF_AGENT_SOURCE, report.message);
					if (report.tokens || report.stateLabels || report.ttlMs !== undefined) {
						await live.paneReportMetadata({
							paneId,
							source: METADATA_SOURCE,
							...(report.tokens ? { tokens: report.tokens } : {}),
							...(report.stateLabels ? { stateLabels: report.stateLabels } : {}),
							...(report.ttlMs !== undefined ? { ttlMs: report.ttlMs } : {}),
						});
					}
					return true;
				},
				false,
			);
		},

		async shutdown(): Promise<void> {
			if (stopped) return;
			stopped = true;
			subscription?.close();
			subscription = null;
			fleetTab = null;
			paneGoneHandlers.clear();
			registry.clear();
			if (client) await client.close().catch(() => undefined);
		},
	};

	const start = async (): Promise<void> => {
		if (detection.mode === "none" || client === null) return;
		try {
			subscription = await client.subscribe(["pane.closed", "pane.exited"], onEvent, {
				onResync: (snapshot) => {
					// A reconnect means events were missed. The snapshot is the authority
					// on which panes still exist, so anything Clio thinks it owns that is
					// absent from it is gone.
					const dropped = registry.reconcile(snapshot.panes.map((pane) => pane.paneId));
					if (fleetTab && !snapshot.tabs.some((tab) => tab.tabId === fleetTab?.tabId)) fleetTab = null;
					if (dropped.length > 0) {
						log("info", `mux reconciled ${dropped.length} pane(s) closed while the socket was down`);
					}
				},
			});
		} catch (error) {
			degrade("event subscription", error);
		}
	};

	return { contract, start, stop: contract.shutdown, registry };
}
