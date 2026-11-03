/**
 * What System One will do under these settings, in the words every surface
 * shows: off, configured but unmeasured, active for these measured actions,
 * recording, or unavailable. Pure, and it sends nothing.
 */

import type { ClioSettings } from "../../core/config.js";
import { findBuiltinRuntimeBootMetadata } from "../providers/runtimes/boot-manifest.js";
import { TYPESAFE_DEFAULT_MODEL } from "../providers/runtimes/typesafe-model.js";
import type { LocalCuts } from "./calibration.js";
import { measuredActions } from "./calibration.js";
import { describeBindings, type RuntimeLookup } from "./recorder/bindings.js";
import type { ChoiceResolution } from "./selection.js";
import { ACTIVE_PROFILE, effectiveSystemOne, RECORD_ONLY_SITES, resolveChoice } from "./selection.js";
import type { SiteId } from "./types.js";

export type SiteState = "off" | "unmeasured" | "active" | "recording" | "idle" | "unavailable";

export interface SiteStatus {
	readonly site: SiteId;
	readonly state: SiteState;
	readonly engine: string | null;
	readonly destination: string | null;
	/** The measured actions a site can take, or why it does not act. */
	readonly detail: string;
}

export interface SystemOneStatus {
	readonly use: string | null;
	readonly scope: string;
	readonly headline: string;
	readonly sites: ReadonlyArray<SiteStatus>;
}

export interface StatusInput {
	readonly settings: Readonly<ClioSettings>;
	/** The override in force and the scope it came from; absent reads `systemOne.use` from the settings layers. */
	readonly override?: { readonly use: string; readonly scope: "task" | "session" };
	readonly settingsOrigin?: string;
	readonly runtimes?: RuntimeLookup;
	/** Whether a runtime's key is available. Absent reads every key as present. */
	readonly hasCredential?: (runtimeId: string, envVar: string) => boolean;
	readonly recording?: boolean;
	readonly localCuts?: LocalCuts;
	readonly latencyMs?: (site: SiteId) => number | null;
}

export const IDENTITY_LIMIT =
	"A measurement belongs to the model name the server reports, plus its fingerprint where it gives one. It cannot detect a checkpoint swapped behind the same name and fingerprint.";

function calibrateHint(name: string): string {
	return `configured but unmeasured, so nothing is sent; run clio-coder systemone calibrate ${name}`;
}

function costNote(resolution: ChoiceResolution): string | null {
	if (resolution.kind !== "engine" || resolution.engine.kind !== "llm") return null;
	const where = `${resolution.engine.target}/${resolution.engine.model ?? "target default"}`;
	return `${resolution.name} adds separate completions on ${where}: tokens and money or subscription usage, and latency it must measure. Requests pass paid-request admission and count against the session's cost ceiling.`;
}

export function describeStatus(input: StatusInput): SystemOneStatus {
	const use = input.override?.use ?? input.settings.systemOne.use;
	const scope = input.override?.scope ?? input.settingsOrigin ?? "settings";
	const resolved = resolveChoice(input.settings, use);
	const applied = { ...input.settings, systemOne: { ...input.settings.systemOne, use } };
	const effective = effectiveSystemOne(applied);
	const recording = input.recording === true;
	const local = input.localCuts ?? {};
	const sites = describeBindings(applied, input.runtimes).map((binding): SiteStatus => {
		const { site, engine } = binding;
		if (engine === null) return { site, state: "off", engine: null, destination: null, detail: "asks nothing" };
		if (binding.problem !== undefined) {
			return { site, state: "unavailable", engine, destination: null, detail: `${binding.problem}; nothing is sent` };
		}
		const cfg = effective.systemOne.engines[engine];
		const target = effective.targets.find((entry) => entry.id === binding.target);
		const destination = `${binding.target}/${binding.model ?? target?.defaultModel ?? "target default"}`;
		// A key named on the target or by a gateway is the runtime's own affair; only a declared runtime key is checked.
		const runtimeId = target?.runtime ?? "";
		const required = findBuiltinRuntimeBootMetadata(runtimeId)?.credentialsEnvVar;
		if (required !== undefined && input.hasCredential?.(runtimeId, required) === false) {
			return { site, state: "unavailable", engine, destination, detail: `${required} is not set; nothing is sent` };
		}
		if (RECORD_ONLY_SITES.includes(site)) {
			return recording
				? { site, state: "recording", engine, destination, detail: "asked for the dataset; no reader acts on it" }
				: { site, state: "idle", engine, destination, detail: "record-only; asks nothing while the dataset is off" };
		}
		if (site === "consult") {
			return {
				site,
				state: "active",
				engine,
				destination,
				detail: "the agent may ask; readings are uncalibrated and no policy reads them; registered at startup",
			};
		}
		const build =
			cfg?.kind === "llm"
				? null
				: (binding.model ?? target?.defaultModel ?? (target?.runtime === "typesafe-jev" ? TYPESAFE_DEFAULT_MODEL : null));
		const actions = measuredActions(site, build, local);
		if (actions.length === 0) {
			return recording
				? { site, state: "recording", engine, destination, detail: "unmeasured; asked for the dataset only" }
				: { site, state: "unmeasured", engine, destination, detail: calibrateHint(engine) };
		}
		const latency = input.latencyMs?.(site) ?? null;
		return {
			site,
			state: "active",
			engine,
			destination,
			detail: `measured: ${actions.join(", ")}${latency === null ? "" : `; observed ${latency} ms`}`,
		};
	});
	const active = sites.filter((site) => site.state === "active" && site.site !== "consult");
	const headline = (() => {
		if (resolved.kind === "off") return "off: every site is masked";
		if (resolved.kind === "unavailable") return `unavailable: ${resolved.problem}; nothing is sent`;
		const bound = sites.filter((site) => site.engine !== null);
		if (bound.length === 0) return "off: no engine is chosen";
		const blocked = bound.find((site) => site.state === "unavailable" && ACTIVE_PROFILE.includes(site.site));
		if (blocked !== undefined) return `unavailable: ${blocked.detail}`;
		if (active.length === 0) {
			const name = resolved.kind === "engine" ? resolved.name : (bound[0]?.engine ?? "");
			return calibrateHint(name);
		}
		return `active for measured actions at ${active.map((site) => site.site).join(", ")}`;
	})();
	const cost = costNote(resolved);
	return { use, scope, headline: cost === null ? headline : `${headline}. ${cost}`, sites };
}

/** The lines `/systemone status` and `clio-coder systemone status` print. */
export function formatStatus(status: SystemOneStatus): string[] {
	const lines = [
		`system one (experimental): ${status.headline}`,
		`choice: ${status.use ?? "unset"} (${status.scope})`,
		...status.sites.map(
			(row) =>
				`  ${row.site}: ${row.state}${row.destination === null ? "" : ` via ${row.engine} → ${row.destination}`}; ${row.detail}`,
		),
		IDENTITY_LIMIT,
	];
	return lines;
}
