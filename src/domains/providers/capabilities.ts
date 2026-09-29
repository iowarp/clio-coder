import type { CapabilityFlags } from "./types/capability-flags.js";
import type { KnowledgeBaseEntry } from "./types/knowledge-base.js";

/**
 * The model-facts layer of `mergeCapabilities`. A catalog file's window and output
 * numbers describe the model, so neither `contextWindow` nor `maxTokens` passes through:
 * only the profile's declared `modelMaxOutput` does, as the labeled cap that ranks below
 * every server report and operator limit.
 */
export function hintCapabilities(
	entry: Pick<KnowledgeBaseEntry, "capabilities" | "modelMaxOutput"> | null | undefined,
): Partial<CapabilityFlags> | null {
	if (!entry) return null;
	const hint: Partial<CapabilityFlags> = { ...entry.capabilities };
	delete hint.contextWindow;
	delete hint.maxTokens;
	if (typeof entry.modelMaxOutput === "number" && entry.modelMaxOutput > 0) hint.maxTokens = entry.modelMaxOutput;
	return hint;
}

/** Flags a server can answer per model. A live yes or no decides them. */
const REPORTED_FLAGS = ["tools", "vision", "reasoning"] as const;

/** Reported flags where the operator claims true and the server reported false, so the claim is ignored. */
export function ignoredCapabilityRaises(
	probe: Partial<CapabilityFlags> | null | undefined,
	userOverride: Partial<CapabilityFlags> | null | undefined,
): Array<(typeof REPORTED_FLAGS)[number]> {
	return REPORTED_FLAGS.filter((key) => probe?.[key] === false && userOverride?.[key] === true);
}

/**
 * Layer capability sources onto a runtime's defaults, weakest first.
 *
 * The server is the truth for what it serves. Three rules follow from that:
 *
 * - `tools`, `vision` and `reasoning`: a live yes or no wins. An operator `false` may lower
 *   a reported true, the way an operator limit lowers a served window, but an operator
 *   `true` never raises a reported false. An operator value stands alone only where the
 *   server is silent, and the profile hint only where both are. A reported false is a
 *   report, not something an operator or a profile repairs.
 * - `contextWindow` and `maxTokens`: a live limit is the ceiling. An operator limit may
 *   only lower it, or stands alone when the server reports none. The profile contributes
 *   no window, and its output cap ranks below both.
 * - Every other flag is descriptive (tool-call format, structured outputs, thinking
 *   format): the profile describes the model better than a server's flag list, and an
 *   operator value outranks it. Audio input is the exception a live "no" wins, because
 *   a projector is a deployment fact.
 */
export function mergeCapabilities(
	base: CapabilityFlags,
	hint: Partial<CapabilityFlags> | null,
	probe: Partial<CapabilityFlags> | null,
	userOverride: Partial<CapabilityFlags> | null,
): CapabilityFlags {
	const merged: Record<string, unknown> = { ...base };
	applyLayer(merged, probe);
	applyLayer(merged, hint);
	if (probe?.audio === false) merged.audio = false;
	applyLayer(merged, userOverride);
	for (const key of REPORTED_FLAGS) {
		const live = probe?.[key];
		const user = userOverride?.[key];
		const value = live === undefined ? (user ?? hint?.[key]) : live && user === false ? false : live;
		if (value !== undefined) merged[key] = value;
	}
	applyLimit(merged, "contextWindow", probe?.contextWindow, userOverride?.contextWindow);
	applyLimit(merged, "maxTokens", probe?.maxTokens, userOverride?.maxTokens);
	return merged as unknown as CapabilityFlags;
}

function applyLimit(
	target: Record<string, unknown>,
	key: "contextWindow" | "maxTokens",
	live: number | undefined,
	user: number | undefined,
): void {
	// A live zero means the server reported nothing usable, which still beats a placeholder.
	if (live !== undefined) target[key] = live;
	if (typeof user !== "number" || !Number.isFinite(user) || user <= 0) return;
	target[key] = typeof live === "number" && live > 0 ? Math.min(user, live) : user;
}

/**
 * Whether a model may drive an agent role (orchestrator, dispatched worker).
 *
 * Clio's whole surface is typed tools. A chat model that reports no tool support
 * cannot read a file or run a command, so pointing an agent role at one produces
 * a run that burns budget and returns nothing usable. Roles that only need text
 * back, such as the background memory policy, do not consult this.
 *
 * The flag is metadata, not a measurement, and servers do get it wrong. A live
 * report decides it; an operator value or a profile fills it only where the
 * server is silent.
 */
export function supportsAgentRoleTools(capabilities: Pick<CapabilityFlags, "tools">): boolean {
	return capabilities.tools === true;
}

export const AGENT_ROLE_TOOLS_REQUIRED_REASON =
	"reports no tool support; Clio drives every agent role through typed tools";

function applyLayer(target: Record<string, unknown>, layer: Partial<CapabilityFlags> | null): void {
	if (!layer) return;
	for (const key of Object.keys(layer) as Array<keyof CapabilityFlags>) {
		const value = layer[key];
		if (value !== undefined) target[key] = value;
	}
}
