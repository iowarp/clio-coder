import { BusChannels } from "../../core/bus-events.js";
import { type ClioSettings, readSettings, writeSettings } from "../../core/config.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import type { ModesContract, SuperModeConfirmation } from "./contract.js";
import { MODE_MATRIX, type ModeName, isActionAllowed, isToolVisible } from "./matrix.js";
import { createModeState, parseModeName } from "./state.js";

type SettingsWithState = ClioSettings & { state?: { lastMode?: string } };

export function createModesBundle(context: DomainContext): DomainBundle<ModesContract> {
	let pending: null | "super" = null;

	const initial: ModeName = readInitialMode();

	const onChange = (next: ModeName, previous: ModeName, reason?: string): void => {
		context.bus.emit(BusChannels.ModeChanged, {
			from: previous,
			to: next,
			reason: reason ?? null,
			at: Date.now(),
		});
		persistLastMode(next);
	};

	const state = createModeState(initial, onChange);

	const extension: DomainExtension = {
		async start() {
			// Announce initial mode on boot so downstream domains can prime
			// tool registries, footers, etc.
			context.bus.emit(BusChannels.ModeChanged, {
				from: null,
				to: initial,
				reason: "boot",
				at: Date.now(),
			});
		},
		async stop() {},
	};

	const contract: ModesContract = {
		current: () => state.get(),
		setMode: (next, reason) => {
			if (next === "super") {
				// direct setMode into super still requires a prior confirmation; API
				// callers may bypass by providing reason "confirmed" / "api-confirmed"
				if (reason !== "confirmed" && reason !== "api-confirmed") {
					contract.requestSuper(reason ?? "api");
					return state.get();
				}
			}
			return state.set(next, reason);
		},
		cycleNormal: () => state.cycleNormal(),
		visibleTools: () => MODE_MATRIX[state.get()].tools,
		isToolVisible: (tool) => isToolVisible(state.get(), tool),
		isActionAllowed: (action) => isActionAllowed(state.get(), action),
		requestSuper: (requestedBy) => {
			pending = "super";
			context.bus.emit(BusChannels.ModeChanged, {
				from: state.get(),
				to: "super",
				reason: "request",
				requestedBy,
				requiresConfirmation: true,
				at: Date.now(),
			});
		},
		confirmSuper: (_conf: SuperModeConfirmation) => {
			if (pending !== "super") return state.get();
			pending = null;
			return state.set("super", "confirmed");
		},
	};

	return { extension, contract };
}

function readInitialMode(): ModeName {
	try {
		const settings = readSettings() as SettingsWithState;
		const raw = settings.state?.lastMode ?? settings.defaultMode ?? "default";
		return parseModeName(String(raw));
	} catch {
		return "default";
	}
}

function persistLastMode(mode: ModeName): void {
	try {
		const s = readSettings() as SettingsWithState;
		const next = { ...s, state: { ...(s.state ?? {}), lastMode: mode } };
		writeSettings(next as ClioSettings);
	} catch (err) {
		process.stderr.write(`[clio:modes] persist lastMode failed: ${err instanceof Error ? err.message : String(err)}\n`);
	}
}
