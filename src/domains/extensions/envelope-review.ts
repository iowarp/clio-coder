/**
 * What an extension may do, in words, before anything is installed or loaded.
 * One renderer feeds the dev consent card, the Library review, the CLI plan
 * output and `extensions install`, so the four never describe the same
 * envelope differently.
 */
import { loadManifestFromRoot } from "./discovery.js";
import type { ExtensionCapabilityEnvelope } from "./manifest-v2.js";
import { capabilityEnvelope, envelopeDigest, envelopeGrowth } from "./runtime-schema-v2.js";

/** The honest limit of the process permission flags, said wherever consent is asked. */
export const ENVELOPE_SEAT_BELT =
	"Node's permission flags are a seat belt against mistakes, not a boundary against hostile code.";

/** One line per capability class, written for an operator and never abbreviated into a code. */
export function envelopeLines(envelope: ExtensionCapabilityEnvelope): string[] {
	const list = (items: readonly string[]): string => (items.length > 0 ? items.join(", ") : "none");
	const hooks = envelope.hooks.map((hook) => {
		const tools = hook.tools ? ` on ${hook.tools.join(", ")}` : "";
		const gate = hook.onTimeout === "block" || hook.onError === "block" ? ", can refuse" : "";
		const failure = `on timeout ${hook.onTimeout}, on error ${hook.onError}`;
		return `${hook.on}${tools} (${hook.timeoutMs} ms${gate}; ${failure})`;
	});
	const lines = [
		`Commands: ${list(envelope.commands)}`,
		...(envelope.takesOver ? [`Takes over prompts: ${list(envelope.takesOver.map((name) => `/${name}`))}`] : []),
		`Events: ${list([...envelope.events, ...(envelope.tickMs !== undefined ? [`tick ${envelope.tickMs / 1000}s`] : [])])}`,
		`Hooks: ${list(hooks)}`,
		`Tools: ${list(envelope.tools.map((tool) => `${tool.name} (${tool.actionClass})`))}`,
		`Interface: ${list(envelope.ui)}`,
	];
	if (envelope.workspaces.length > 0)
		lines.push(
			`Workspaces: ${envelope.workspaces
				.map((workspace) => {
					const keys = workspace.keys?.map((binding) => binding.key).join(" ");
					const board = workspace.board ? `; board ${workspace.board}` : "";
					return `${workspace.id} (${workspace.regions.join(", ")}${board}${keys ? `; keys ${keys}` : ""})`;
				})
				.join("; ")}`,
		);
	if (envelope.watch.length > 0) lines.push(`Watches: ${envelope.watch.join(", ")}`);
	lines.push(
		`Content it may read: ${list(envelope.access)}`,
		`Files: read ${list(envelope.permissions.fs.read)}; write ${list(envelope.permissions.fs.write)}`,
		`Programs: ${envelope.permissions.exec ? "may run programs" : "none"}; network: ${envelope.permissions.net ? "may use the network" : "none"}`,
	);
	return lines;
}

export interface ExtensionEnvelopeReview {
	id: string;
	version: string;
	/** The plugin this extension serves, when it names one. */
	plugin?: string;
	envelope: ExtensionCapabilityEnvelope;
	digest: string;
	/** What reaches further than the installed copy; absent unless an installed copy was compared. */
	growth?: string[];
}

/**
 * The envelope a package root declares, read from the manifest alone: no entry
 * point is loaded and nothing runs. `null` for a root with no readable api 2
 * runtime, which has no envelope to approve. With `installedRoot`, `growth`
 * names what the candidate adds beyond the copy the operator already accepted.
 */
export function reviewExtensionEnvelope(root: string, installedRoot?: string): ExtensionEnvelopeReview | null {
	const candidate = loadManifestFromRoot(root).manifest;
	if (!candidate?.runtimeV2) return null;
	const envelope = capabilityEnvelope(candidate.runtimeV2, candidate.plugin);
	const installed = installedRoot ? loadManifestFromRoot(installedRoot).manifest : undefined;
	return {
		id: candidate.id,
		version: candidate.version,
		...(candidate.plugin ? { plugin: candidate.plugin } : {}),
		envelope,
		digest: envelopeDigest(envelope),
		...(installed?.runtimeV2
			? { growth: envelopeGrowth(capabilityEnvelope(installed.runtimeV2, installed.plugin), envelope) }
			: {}),
	};
}

/** The review as plain text lines, one per fact, ready for a terminal or a card. */
export function envelopeReviewLines(review: ExtensionEnvelopeReview): string[] {
	const lines: string[] = [];
	if (review.growth !== undefined)
		lines.push(
			review.growth.length === 0
				? "Reaches no further than the installed copy."
				: "Reaches further than the installed copy:",
			...review.growth.map((line) => `  ${line}`),
		);
	lines.push(...envelopeLines(review.envelope), ENVELOPE_SEAT_BELT, `Envelope sha256 ${review.digest}`);
	return lines;
}
