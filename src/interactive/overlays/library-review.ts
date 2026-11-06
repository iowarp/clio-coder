/**
 * The Library's review and outcome surface.
 *
 * One overlay covers both halves of a managed change, because they are the same
 * question asked twice: what would this do, and then what did it actually do.
 * Nothing is written before the operator accepts the reviewed plan, and the
 * outcome separates the three facts that a single "done" would have blurred:
 * what the writer committed, what the resources now admit, and whether the
 * session refreshed.
 *
 * The bodies are pure functions of the plan and the result, so the wording is
 * testable without a terminal. Each one leads with its verdict and the keys
 * that answer it, then lays every step out as a fact table under its own rule.
 */

import { homedir } from "node:os";
import { ENVELOPE_SEAT_BELT, envelopeLines } from "../../domains/extensions/envelope-review.js";
import type { LibraryImportApplyResult, LibraryImportPlan } from "../../domains/interop/index.js";
import {
	describeLibraryPair,
	type LibraryApplyResult,
	type LibraryLifecyclePlan,
	type LibraryPlanStep,
	type LibraryRefreshResult,
	type LibraryStepOutcome,
	type LibraryStepReview,
	type LibraryStepVerification,
} from "../../domains/resources/index.js";
import {
	type Component,
	isKeyRelease,
	matchesKey,
	type OverlayHandle,
	type TUI,
	wrapTextWithAnsi,
} from "../../engine/tui.js";
import { displaySafe } from "../display-safe.js";
import { backOutOneLayer, type EscapeLayers, escapeHintEntry } from "../escape-layers.js";
import {
	buildResponsiveHint,
	createCachedBody,
	FocusBox,
	type RowBudgetedBody,
	showClioOverlayFrame,
	windowRows,
} from "../overlay-frame.js";
import {
	type Choice,
	chip,
	chipRows,
	choiceRows,
	clioTheme,
	type Fact,
	factRows,
	positionRow,
	sectionRule,
	statusChip,
} from "../theme/index.js";
import { refWords } from "./library-words.js";

const MIN_WIDTH = 48;
const MAX_WIDTH = 110;
/** Rows the body shows while the frame has not said how many it has. */
const REVIEW_DEFAULT_ROWS = 20;

const FACT_OPTIONS = { labelRole: "fieldName" as const, stack: "never" as const };

function libraryReviewWidth(columns: number): number {
	return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, columns - 4));
}

function stepHeadline(step: LibraryPlanStep): string {
	return `${step.operation} the ${refWords(step.identity.ref)} in ${step.identity.scope} scope`;
}

/** The verdict line, bold and wrapped: a long package name folds, it never loses its scope. */
function headline(token: Parameters<ClioThemeStyle>[0], text: string, width: number): string[] {
	return wrapTextWithAnsi(clioTheme().style(token, text, { bold: true }), Math.max(1, Math.floor(width)));
}
type ClioThemeStyle = ReturnType<typeof clioTheme>["style"];

/**
 * One step's rule names the operation and the scope, which always fit; the
 * package ref, which can be longer than the rule, is the step's first fact.
 */
function stepRule(step: LibraryPlanStep, index: number, total: number, width: number): string {
	return sectionRule(clioTheme(), width, `${step.operation} in ${step.identity.scope} scope`, {
		...(total > 1 ? { meta: `${index + 1}/${total}` } : {}),
		...(step.refusal ? { token: "error" as const } : {}),
	});
}

/**
 * What an extension step would be allowed to do, then the other half of its
 * plugin pairing. The envelope comes from the staged manifest, so it is shown
 * before anything is written; on an update, what grew leads, because the
 * operator already accepted the rest.
 */
function reviewFacts(step: LibraryPlanStep, review: LibraryStepReview | undefined): Fact[] {
	if (!review) return [];
	const theme = clioTheme();
	const facts: Fact[] = [];
	if (review.envelope) {
		facts.push({
			label: "Allowed to",
			value: [
				...(review.growth !== undefined
					? [
							review.growth.length === 0
								? statusChip(theme, "ok", "reaches no further than the installed copy")
								: statusChip(theme, "warning", `reaches further than the installed copy: ${review.growth.join("; ")}`),
						]
					: []),
				...envelopeLines(review.envelope, step.identity.kind === "extension" ? step.identity.name : undefined).map((line) =>
					theme.fg("body", line),
				),
				theme.fg("annotation", ENVELOPE_SEAT_BELT),
			].join("\n"),
		});
		if (review.envelopeDigest) facts.push({ label: "Envelope", value: `sha256 ${review.envelopeDigest}`, tone: "muted" });
	}
	for (const pair of review.pairs)
		facts.push({
			label: pair.role === "plugin" ? "Plugin" : "Extension",
			value: describeLibraryPair({ kind: step.identity.kind, name: step.identity.name }, pair),
			tone: "info",
		});
	return facts;
}

/** One step's facts, in the order the questions matter. */
/** Why a copy that takes effect still does not load, in the operator's words. */
const COPY_NOT_LOADED: Record<NonNullable<LibraryPlanStep["effectiveAfter"]>["state"], string> = {
	loadable: "Clio cannot load it",
	disabled: "it is disabled, so Clio skips it",
	shadowed: "another copy shadows it",
	invalid: "its package is invalid, so Clio cannot load it",
	incompatible: "it does not support this Clio version",
	damaged: "its files changed since install, so Clio cannot load it",
	untrusted: "it waits for workspace trust before Clio loads it",
};

/** Which copy is in effect after the step, and whether Clio loads it. */
function afterwardsText(after: NonNullable<LibraryPlanStep["effectiveAfter"]>): string {
	const copy = `the ${after.scope} copy is in effect`;
	if (after.loadable && after.state === "loadable") return `${copy} and Clio loads it`;
	return `${copy}, but ${COPY_NOT_LOADED[after.state]}`;
}

function stepFacts(step: LibraryPlanStep, review: LibraryStepReview | undefined, detail: boolean): Fact[] {
	const theme = clioTheme();
	const facts: Fact[] = [{ label: "Package", value: refWords(step.identity.ref) }];
	const versions = step.versions;
	if (versions?.from && versions.to && versions.from !== versions.to)
		facts.push({ label: "Version", value: `${versions.from} installed → ${versions.to}` });
	else if (versions?.to && !versions.from) facts.push({ label: "Version", value: versions.to });
	else if (versions?.from && step.operation === "update")
		facts.push({ label: "Version", value: `${versions.from}, same version with changed content` });
	if (step.refusal) facts.push({ label: "Refused", value: statusChip(theme, "error", step.refusal) });
	if (step.content && !step.content.valid)
		facts.push({
			label: "Content",
			value: statusChip(theme, "warning", `invalid: ${step.content.diagnostics.join("; ")}`),
		});
	if (step.content?.resources.length)
		facts.push({
			label: "Adds",
			value: resourceSummary(
				step.content.resources.map((item) => ({ kind: item.kind, name: `${item.name}${item.valid ? "" : " (invalid)"}` })),
				detail,
			),
		});
	if (step.dependencies.missing.length)
		facts.push({
			label: "Missing",
			value: `requires ${step.dependencies.missing.map(refWords).join(", ")}`,
			tone: "warning",
		});
	if (step.dependencies.inactive.length)
		facts.push({
			label: "Inactive",
			value: `requires ${step.dependencies.inactive.map(refWords).join(", ")}`,
			tone: "warning",
		});
	for (const dependent of step.dependents.newlyBroken)
		facts.push({
			label: "Dependents",
			value: statusChip(
				theme,
				"error",
				`would break the ${refWords(dependent.ref)} (${dependent.scope}): needs ${dependent.missing.map(refWords).join(", ")}`,
			),
		});
	for (const dependent of step.dependents.preexisting)
		facts.push({
			label: "Dependents",
			value: `already broken: the ${refWords(dependent.ref)} (${dependent.scope}) needs ${dependent.missing.map(refWords).join(", ")}`,
			tone: "muted",
		});
	if (step.effectiveAfter)
		facts.push({
			label: "Afterwards",
			value: afterwardsText(step.effectiveAfter),
			tone: "info",
		});
	facts.push({ label: "Fallback", value: step.fallbackNote, tone: "muted" });
	facts.push({ label: "Recovery", value: step.recovery, tone: "muted" });
	facts.push(...reviewFacts(step, review));
	if (detail) {
		facts.push({ label: "Destination", value: shortenHomePath(step.destination), tone: "muted" });
		if (step.source) {
			facts.push({ label: "Source", value: shortenHomePath(step.source.sourceUrl), tone: "muted" });
			facts.push({ label: "sha256", value: step.source.sha256, tone: "muted" });
		}
	}
	return facts;
}

/** What Enter does on each operation's review, in the words of the change itself. */
const APPLY_CONSEQUENCE: Record<LibraryLifecyclePlan["request"]["operation"], string> = {
	install: "makes exactly this change",
	update: "replaces the installed copy with this one",
	enable: "turns this copy back on",
	disable: "keeps the files and turns this copy off",
	remove: "deletes this copy",
};

/** The keys every review answers to, with what each one does. */
function reviewChoices(applicable: boolean, verb: string, consequence: string, detail: boolean): Choice[] {
	return [
		...(applicable ? [{ key: "Enter", verb, consequence, tone: "action" as const }] : []),
		// The rows say what Esc does now: with the paths open it hides them, the way the rail says.
		detail
			? { key: "Esc", verb: "back to review", consequence: "closes the paths; nothing changes" }
			: { key: "Esc", verb: "cancel", consequence: "changes nothing and returns to the Library" },
		{
			key: "d",
			verb: detail ? "hide paths" : "paths",
			consequence: detail ? "back to the review" : "shows paths and digests",
		},
	];
}

/**
 * The reviewed plan, in the order the questions matter: the verdict and the
 * keys, then per step what changes, what it depends on, what depends on it,
 * what becomes effective afterwards, and how a changed tree is recovered.
 *
 * `detail` adds the destination path and the source digest. They are the facts
 * an operator verifies against `library install --dry-run`, and they are also
 * the two longest lines on the screen, so they expand rather than crowd out the
 * dependency story.
 */
export function formatLibraryPlanReview(
	rawPlan: LibraryLifecyclePlan,
	width: number,
	options: { detail?: boolean } = {},
): string[] {
	const theme = clioTheme();
	// Refs, notes, diagnostics and recovery text come from manifests and the
	// tree; one pass here neutralizes every string a row below prints.
	const plan = displaySafe(rawPlan);
	const detail = options.detail === true;
	const target = plan.steps.at(-1);
	const rows: string[] = [
		...headline(
			"decisionQuestion",
			target ? stepHeadline(target) : `${plan.request.operation} ${refWords(plan.request.ref)}`,
			width,
		),
		...chipRows(
			theme,
			[
				plan.applicable
					? statusChip(theme, "pending", "ready to apply")
					: statusChip(theme, "error", "cannot be applied as reviewed"),
				plan.steps.length > 1 ? chip(theme, `${plan.steps.length} steps, requirements first`, "muted") : null,
			],
			width,
		),
		...choiceRows(
			theme,
			reviewChoices(
				plan.applicable,
				plan.request.operation,
				`${APPLY_CONSEQUENCE[plan.request.operation]}, then shows what Clio loads afterwards`,
				detail,
			),
			width,
		),
	];
	plan.steps.forEach((step, index) => {
		rows.push(stepRule(step, index, plan.steps.length, width));
		rows.push(
			...factRows(
				theme,
				stepFacts(
					step,
					plan.reviews?.find((item) => item.ref === step.identity.ref && item.scope === step.identity.scope),
					detail,
				),
				width,
				FACT_OPTIONS,
			),
		);
	});
	if (plan.diagnostics.length > 0) {
		rows.push(sectionRule(theme, width, "Diagnostics", { meta: String(plan.diagnostics.length) }));
		for (const diagnostic of plan.diagnostics)
			rows.push(...chipRows(theme, [statusChip(theme, "warning", diagnostic)], width));
	}
	return rows;
}

/** What the extension reload did, in the words of what the operator will see next. */
const EXTENSION_REFRESH_TEXT = {
	reloading: "Extensions are restarting now; a notice says when they are ready.",
	queued:
		"Extensions restart once you close the Library and Clio is idle; until then the ones already running stay as they are.",
	unavailable: "This session has no extension host, so extensions were not restarted; restart Clio to load them.",
} as const;

/** The refresh as one sentence for a notice, in what the operator will see next. */
export function libraryRefreshSummary(refresh: LibraryRefreshResult): string {
	if (refresh.status === "failed")
		return `The session refresh failed (${refresh.error}); reopen the Library and press R.`;
	if (refresh.status === "not-applicable") return "";
	if (refresh.extensions) return EXTENSION_REFRESH_TEXT[refresh.extensions];
	return "This session already sees the change.";
}

const PAST_TENSE: Record<LibraryStepOutcome["operation"], string> = {
	install: "Installed",
	update: "Updated",
	enable: "Enabled",
	disable: "Disabled",
	remove: "Removed",
};

/**
 * The outcome as one sentence: what changed, where. A batch, or one that did
 * not fully land, adds its counts, because two of three writes committing is
 * a different situation from all of them, and the sentence must not hide it.
 */
export function libraryOutcomeHeadline(
	result: Pick<LibraryApplyResult, "outcomes" | "committed" | "failed" | "unattempted">,
): string {
	const only = result.outcomes.length === 1 ? result.outcomes[0] : undefined;
	if (only) {
		const place = `${only.operation === "remove" ? "from" : "in"} ${only.identity.scope} scope`;
		if (only.status === "committed")
			return `${only.imported ? "Imported" : PAST_TENSE[only.operation]} the ${refWords(only.identity.ref)} ${place}`;
		if (only.status === "failed") return `Could not ${only.operation} the ${refWords(only.identity.ref)} ${place}`;
		return `Did not start the ${only.operation} of the ${refWords(only.identity.ref)}`;
	}
	return `${result.committed} committed · ${result.failed} failed · ${result.unattempted} unattempted`;
}

function refreshChip(refresh: LibraryRefreshResult): string {
	const theme = clioTheme();
	if (refresh.status === "refreshed")
		return statusChip(theme, refresh.extensions === "unavailable" ? "warning" : "ok", libraryRefreshSummary(refresh));
	if (refresh.status === "failed")
		return statusChip(theme, "error", `session refresh failed: ${refresh.error}; press R to retry`);
	return chip(theme, `no session refresh needed: ${refresh.reason}`, "muted");
}

/**
 * When the resource evidence was read, said explicitly.
 *
 * Verification reads the copy back from disk as soon as the writer returns,
 * which is before the session refreshes. Those are different moments and an
 * unlabelled list of resources blurred them: after a failed refresh the disk
 * can be correct while this session still serves the previous generation, and
 * an operator reading "available" deserves to know which of the two it means.
 */
function evidenceLabel(evidence: "pre-refresh" | "post-refresh", refresh: LibraryRefreshResult): string {
	if (evidence === "post-refresh") return "";
	if (refresh.status === "refreshed")
		return "read before this session reloaded; reopen the Library to see what loads now";
	if (refresh.status === "failed") return "read before the reload, which failed, so what loads now is unverified";
	return "read from disk; no reload was needed";
}

/** Resources grouped by kind with a count each: "6 skills: a, b; 20 prompts: c, d" reads faster than 26 kind:name refs. */
/** How many names a kind lists before it counts the rest; the full list is behind the paths key. */
const SUMMARY_NAMES = 3;

function resourceSummary(items: ReadonlyArray<{ kind: string; name: string }>, detail = false): string {
	const groups = new Map<string, string[]>();
	// A name carries its package as `pkg:name`; the review already names the package, so the row keeps the name.
	for (const item of items)
		groups.set(item.kind, [...(groups.get(item.kind) ?? []), item.name.replace(/^[^:\s]+:/u, "")]);
	return [...groups]
		.map(([kind, names]) => {
			const shown = detail || names.length <= SUMMARY_NAMES + 1 ? names : names.slice(0, SUMMARY_NAMES);
			const more = names.length - shown.length;
			return `${names.length} ${names.length === 1 ? kind : `${kind}s`}: ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
		})
		.join("; ");
}

/** A path under the home folder as ~/…, the way the footer and the setup screens print it. */
function shortenHomePath(target: string): string {
	const home = homedir();
	return target === home || target.startsWith(`${home}/`) ? `~${target.slice(home.length)}` : target;
}

/** Disk state in words; the common pairs read as one fact, anything else names both parts. */
function diskText(verification: LibraryStepVerification): string {
	if (verification.tree === "present" && verification.record === "recorded") return "files and install record written";
	if (verification.tree === "absent" && verification.record === "absent") return "files and install record removed";
	const tree = { present: "files present", absent: "files absent", changed: "files changed after the write" }[
		verification.tree
	];
	const record = {
		recorded: "install record written",
		absent: "no install record",
		unreadable: "install record unreadable",
	}[verification.record];
	return `${tree}, ${record}`;
}

function outcomeFacts(outcome: LibraryStepOutcome, refresh: LibraryRefreshResult): Fact[] {
	const theme = clioTheme();
	const facts: Fact[] = [{ label: "Package", value: refWords(outcome.identity.ref) }];
	if (outcome.error) {
		facts.push({ label: "Error", value: statusChip(theme, "error", `${outcome.error.code}: ${outcome.error.message}`) });
		if (outcome.error.changed)
			facts.push({
				label: "Changed fact",
				value: `${outcome.error.changed.fact}: reviewed ${JSON.stringify(outcome.error.changed.expected)}, observed ${JSON.stringify(outcome.error.changed.observed)}`,
				tone: "muted",
			});
		facts.push({ label: "Next", value: outcome.error.next, tone: "info" });
	}
	const verification = outcome.verification;
	if (verification) {
		facts.push({
			label: "On disk",
			value: outcome.destination
				? `${diskText(verification)} · ${shortenHomePath(outcome.destination)}`
				: diskText(verification),
			tone: "muted",
		});
		const label = evidenceLabel(verification.evidence, refresh);
		const loaded =
			verification.resources.length === 0
				? outcome.identity.kind === "extension"
					? "no skills, agents, prompts or playbooks; an extension adds its commands and status instead"
					: "nothing Clio can load from it"
				: [
						resourceSummary(verification.resources.filter((item) => item.available)),
						...verification.resources
							.filter((item) => !item.available)
							.map((item) => `not available: ${item.kind}:${item.name} (${item.reason ?? "no reason recorded"})`),
					]
						.filter(Boolean)
						.join("; ");
		// Nothing loads from a package that is gone; the fact would only restate it.
		if (verification.effective || verification.resources.length > 0)
			facts.push({ label: "Loads", value: label ? `${loaded} (${label})` : loaded, tone: "muted" });
		facts.push({
			label: "In effect",
			value: verification.effective
				? verification.effective.loadable
					? `the ${verification.effective.scope} copy, which Clio loads`
					: `the ${verification.effective.scope} copy, which Clio cannot load`
				: "no copy remains",
			tone: "muted",
		});
	}
	if (outcome.recovery?.packageBackup)
		facts.push({ label: "Recovered content", value: outcome.recovery.packageBackup, tone: "info" });
	if (outcome.recovery?.stateBackup)
		facts.push({ label: "State backup", value: outcome.recovery.stateBackup, tone: "muted" });
	for (const diagnostic of outcome.diagnostics) facts.push({ label: "Diagnostic", value: diagnostic, tone: "muted" });
	return facts;
}

/**
 * What actually happened.
 *
 * The three counts lead, because a batch that committed two of three writes is
 * a different situation from one that committed none, and the older single
 * "installed" line could describe both. Disk state, resource admission and
 * session refresh are then separate facts: a package can be on disk with one
 * resource still unavailable, and that is not a failed write.
 */
export function formatLibraryOutcome(rawResult: LibraryApplyResult, width: number): string[] {
	const theme = clioTheme();
	const result = displaySafe(rawResult);
	const rows: string[] = [
		...headline(result.failed > 0 ? "error" : "success", libraryOutcomeHeadline(result), width),
		...chipRows(theme, [refreshChip(result.refresh)], width),
		...choiceRows(
			theme,
			[
				// Retry is offered where there is something to retry; R still answers after a success.
				...(result.refresh.status === "failed"
					? [
							{
								key: "R",
								verb: "retry refresh",
								consequence: "retries the session refresh only; it never repeats a write",
								tone: "action" as const,
							},
						]
					: []),
				{
					key: "Esc",
					verb: "close",
					consequence: result.committed > 0 ? "returns to the Library; the change stands" : "returns to the Library",
				},
			],
			width,
		),
	];
	for (const outcome of result.outcomes) {
		const status = outcome.status === "committed" ? "ok" : outcome.status === "failed" ? "error" : "queued";
		rows.push(
			sectionRule(theme, width, `${outcome.operation} in ${outcome.identity.scope} scope`, {
				meta: outcome.status,
				...(outcome.status === "failed" ? { token: "error" as const } : {}),
			}),
		);
		// One committed step is already the headline; a chip repeating it is noise.
		if (outcome.status !== "committed" || result.outcomes.length > 1)
			rows.push(...chipRows(theme, [statusChip(theme, status, outcome.status)], width));
		rows.push(...factRows(theme, outcomeFacts(outcome, result.refresh), width, FACT_OPTIONS));
	}
	if (result.unattempted > 0)
		rows.push(
			...chipRows(
				theme,
				[
					chip(
						theme,
						"Unattempted steps were never started; the committed ones stand. Review a fresh plan for the rest.",
						"muted",
					),
				],
				width,
			),
		);
	return rows;
}

/**
 * The reviewed foreign import, before anything is written.
 *
 * An import is the one operation whose losses matter as much as its writes, so
 * the projected resources, the unsupported host features and the omitted files
 * are all on this screen. A plan that would install something while silently
 * dropping a companion the instructions need is the failure this wording
 * exists to prevent.
 */
/** What an import source is, in plain words; the format id itself stays in the paths view. */
const IMPORT_FORMAT_WORDS: Record<string, string> = {
	"agent-skill": "a skill folder (SKILL.md)",
	"claude-code": "a Claude Code plugin",
	codex: "a Codex plugin",
	portable: "a portable package",
};

function importFormatWords(format: string): string {
	return IMPORT_FORMAT_WORDS[format] ?? format;
}

function formatLibraryImportReview(
	rawPlan: LibraryImportPlan,
	width: number,
	options: { detail?: boolean } = {},
): string[] {
	const theme = clioTheme();
	const plan = displaySafe(rawPlan);
	const detail = options.detail === true;
	const install = plan.action === "install";
	const facts: Fact[] = [
		{
			label: "Source",
			value: `${shortenHomePath(plan.source.input)}${plan.source.transport === "local" ? "" : ` (${plan.source.transport})`}`,
		},
		...(plan.format ? [{ label: "Format", value: importFormatWords(plan.format) }] : []),
		// A bare skill folder carries no version of its own; the 0.0.0 the packager gives it says nothing.
		...(plan.version && plan.version !== "0.0.0" ? [{ label: "Version", value: plan.version }] : []),
		...(plan.destination ? [{ label: "Destination", value: shortenHomePath(plan.destination) }] : []),
		{
			label: "Adds",
			value:
				plan.outcomes.length === 0
					? "no resources"
					: resourceSummary(
							plan.outcomes.map((outcome) => ({ kind: outcome.kind, name: `${outcome.name} (${outcome.status})` })),
						),
			tone: "info",
		},
		...plan.unsupported.map(
			(item): Fact => ({ label: "Not imported", value: `unsupported host feature: ${item}`, tone: "warning" }),
		),
		...plan.omitted.map((item): Fact => ({ label: "Omitted file", value: item, tone: "warning" })),
		...(plan.requirements.length
			? [{ label: "Requires", value: `installed packages ${plan.requirements.join(", ")}`, tone: "warning" as const }]
			: []),
		...plan.reasons.map((reason): Fact => {
			const blocks = !install && reason !== plan.note;
			return { label: blocks ? "Blocked" : "Note", value: reason, tone: blocks ? "error" : "muted" };
		}),
		{
			label: "Provenance",
			value:
				"Imported content keeps its original source, and the model uses it only once this project trusts imported resources. The folder it came from is never modified.",
			tone: "muted",
		},
		...(detail
			? [
					{ label: "Fingerprint", value: `review ${plan.reviewFingerprint}`, tone: "muted" as const },
					...(plan.digest ? [{ label: "Digest", value: `projected ${plan.digest}`, tone: "muted" as const }] : []),
					{ label: "Source root", value: plan.source.root, tone: "muted" as const },
				]
			: []),
	];
	return [
		...headline(
			install ? "decisionQuestion" : "error",
			`${install ? "import" : "Cannot import"} ${plan.id ?? plan.source.input} into ${plan.scope} scope`,
			width,
		),
		...chipRows(
			theme,
			[
				install
					? statusChip(theme, "pending", "ready to import")
					: statusChip(theme, "error", "cannot be imported as reviewed"),
				plan.format ? chip(theme, importFormatWords(plan.format), "muted") : null,
			],
			width,
		),
		...choiceRows(theme, reviewChoices(install, "import", "writes exactly what is listed below", detail), width),
		sectionRule(theme, width, "What import writes"),
		...factRows(theme, facts, width, FACT_OPTIONS),
	];
}

/**
 * One scrollable body that shows a reviewed plan, then the outcome that
 * replaced it. The rows are cached on width, the detail toggle and the outcome
 * revision, and windowed to the rows the frame grants with one row kept for
 * the position, so the keys that apply the plan are never cut off the bottom.
 */
class LibraryReviewBody implements Component, RowBudgetedBody {
	private scroll = 0;
	private detailShown = false;
	private outcomeRows: ((width: number) => string[]) | null = null;
	private readonly rows = createCachedBody((width) =>
		this.outcomeRows ? this.outcomeRows(width) : this.review(width, this.detailShown),
	);
	private bodyRows = 0;
	private page = 1;
	/** The last window, kept while nothing moved, so the dock's own cache sees the same lines again. */
	private memo: { all: string[]; width: number; start: number; height: number; lines: string[] } | null = null;

	constructor(private readonly review: (width: number, detail: boolean) => string[]) {}

	get detail(): boolean {
		return this.detailShown;
	}

	set detail(next: boolean) {
		this.detailShown = next;
		this.touch();
	}

	get outcome(): ((width: number) => string[]) | null {
		return this.outcomeRows;
	}

	/** The outcome replaces the review; it is laid out at the body's own width on every render. */
	set outcome(next: ((width: number) => string[]) | null) {
		this.outcomeRows = next;
		this.touch();
	}

	private touch(): void {
		this.rows.touch();
	}

	scrollBy(rows: number): void {
		this.scroll = Math.max(0, this.scroll + rows);
	}

	pageBy(pages: number): void {
		this.scrollBy(pages * this.page);
	}

	reset(): void {
		this.scroll = 0;
	}

	setBodyRows(rows: number): void {
		this.bodyRows = Math.max(0, Math.floor(rows));
		this.rows.setBodyRows(rows);
	}

	render(width: number): string[] {
		const all = this.rows.render(width);
		const budget = this.bodyRows > 0 ? this.bodyRows : REVIEW_DEFAULT_ROWS;
		const height = all.length > budget ? Math.max(1, budget - 1) : budget;
		this.page = height;
		const { window, start, position } = windowRows(all, this.scroll, height);
		this.scroll = start;
		const memo = this.memo;
		if (memo && memo.all === all && memo.width === width && memo.start === start && memo.height === height)
			return memo.lines;
		const lines =
			position === null
				? window
				: [...window, positionRow(clioTheme(), { ...position, keys: ["↑↓ scroll", "PgUp/PgDn page"] }, width)];
		this.memo = { all, width, start, height, lines };
		return lines;
	}

	invalidate(): void {
		this.rows.invalidate();
	}
}

/** The frame budgets rows through its direct child, which here is the input-routing box around the body. */
class ReviewFocusBox extends FocusBox implements RowBudgetedBody {
	constructor(
		private readonly windowed: LibraryReviewBody,
		options: ConstructorParameters<typeof FocusBox>[1],
	) {
		super(windowed, options);
	}

	override setBodyRows(rows: number): void {
		this.windowed.setBodyRows(rows);
	}
}

interface ReviewOverlaySpec {
	title: string;
	verb: string;
	columns: number;
	applicable: boolean;
	review: (width: number, detail: boolean) => string[];
	/** Apply, and return the body the outcome half renders. Called only after Enter. */
	commit: () => (width: number) => string[];
	/** Refresh only; returns the replacement outcome body. Never repeats a write. */
	retryRefresh: () => (width: number) => string[];
	/** Whether the outcome's refresh failed, which is when the footer offers R. */
	refreshFailed: () => boolean;
	onCancel: () => void;
	onDone: () => void;
}

function openReviewOverlay(tui: TUI, spec: ReviewOverlaySpec): OverlayHandle {
	let settled = false;
	const body = new LibraryReviewBody(spec.review);

	const cancel = (): void => {
		if (settled) return;
		settled = true;
		spec.onCancel();
	};

	// Esc backs out one layer: the path list first, then the review, which cancels without writing anything.
	const reviewLayers = (): EscapeLayers => [
		// `d` already says `hide paths`; Esc names where it lands, so two keys never share one label.
		body.detail && {
			verb: "back to review",
			short: "back",
			back: () => {
				body.detail = false;
				tui.requestRender();
			},
		},
		{ verb: "cancel", back: cancel },
	];
	const focus = new ReviewFocusBox(body, {
		// Keys are matched by name rather than by raw bytes: under the kitty
		// keyboard protocol Esc arrives as CSI 27 u, and a byte comparison left
		// this overlay unanswerable.
		onInput: (data: string): void => {
			if (isKeyRelease(data)) return;
			if (body.outcome) {
				if (data === "R") {
					// Refresh only. The writes already committed and are never repeated.
					body.outcome = spec.retryRefresh();
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
					settled = true;
					spec.onDone();
					return;
				}
			} else {
				if (matchesKey(data, "enter")) {
					if (!spec.applicable) return;
					settled = true;
					body.outcome = spec.commit();
					body.reset();
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "escape")) {
					backOutOneLayer(reviewLayers());
					return;
				}
				if (data === "d") {
					body.detail = !body.detail;
					tui.requestRender();
					return;
				}
			}
			if (matchesKey(data, "down")) body.scrollBy(1);
			else if (matchesKey(data, "up")) body.scrollBy(-1);
			else if (matchesKey(data, "pageDown")) body.pageBy(1);
			else if (matchesKey(data, "pageUp")) body.pageBy(-1);
			else return;
			tui.requestRender();
		},
	});

	const handle = showClioOverlayFrame(tui, focus, {
		anchor: "center",
		width: libraryReviewWidth(spec.columns),
		markerId: "library-review",
		title: () => (body.outcome ? "Library outcome" : spec.title),
		footerHint: (innerWidth: number) =>
			body.outcome
				? buildResponsiveHint(spec.refreshFailed() ? [{ key: "R", verb: "retry refresh" }] : [], {
						key: "Esc",
						verb: "close",
					})(innerWidth)
				: buildResponsiveHint(
						[
							...(spec.applicable ? [{ key: "Enter", verb: spec.verb }] : []),
							{ key: "d", verb: body.detail ? "hide paths" : "paths" },
						],
						escapeHintEntry(reviewLayers()) ?? { key: "Esc", verb: "cancel" },
					)(innerWidth),
	});

	return {
		...handle,
		hide(): void {
			cancel();
			handle.hide();
		},
	};
}

export interface OpenLibraryReviewOptions {
	plan: LibraryLifecyclePlan;
	columns: number;
	/** Apply the reviewed plan. Called only after the operator accepts. */
	commit: (plan: LibraryLifecyclePlan) => LibraryApplyResult;
	/** Refresh only, for a failed or skipped session refresh. */
	retryRefresh: () => LibraryRefreshResult;
	/** Cancel before commit: nothing was written; the caller releases the staged source. */
	onCancel: () => void;
	/** Closed after an outcome was shown; carries what happened so the list can redraw. */
	onDone: (result: LibraryApplyResult) => void;
}

export function openLibraryReviewOverlay(tui: TUI, options: OpenLibraryReviewOptions): OverlayHandle {
	let applied: LibraryApplyResult | null = null;
	return openReviewOverlay(tui, {
		title: `Library ${options.plan.request.operation}`,
		verb: options.plan.request.operation,
		columns: options.columns,
		applicable: options.plan.applicable,
		review: (width, detail) => formatLibraryPlanReview(options.plan, width, { detail }),
		commit: () => {
			applied = options.commit(options.plan);
			return (width) => formatLibraryOutcome(applied as LibraryApplyResult, width);
		},
		retryRefresh: () => {
			const refresh = options.retryRefresh();
			applied = applied ? { ...applied, refresh } : applied;
			return (width) => formatLibraryOutcome(applied as LibraryApplyResult, width);
		},
		refreshFailed: () => applied?.refresh.status === "failed",
		onCancel: options.onCancel,
		onDone: () => {
			if (applied) options.onDone(applied);
		},
	});
}

export interface OpenLibraryImportOptions {
	plan: LibraryImportPlan;
	columns: number;
	/** Apply the reviewed import. Called only after the operator accepts. */
	commit: (plan: LibraryImportPlan) => LibraryImportApplyResult;
	/** Project the applied import into the shared outcome shape. */
	outcome: (plan: LibraryImportPlan, result: LibraryImportApplyResult) => LibraryApplyResult;
	retryRefresh: () => LibraryRefreshResult;
	onCancel: () => void;
	onDone: (result: LibraryApplyResult) => void;
}

/**
 * Review one explicit import, then show it in the same outcome widget.
 *
 * `/library import <path-or-url>` names a source, and that exact source is what
 * gets planned and reported. The local-agent discovery surface is a separate
 * way in, not a substitute for the one the operator typed.
 */
export function openLibraryImportOverlay(tui: TUI, options: OpenLibraryImportOptions): OverlayHandle {
	let applied: LibraryApplyResult | null = null;
	return openReviewOverlay(tui, {
		title: "Library import",
		verb: "import",
		columns: options.columns,
		applicable: options.plan.action === "install",
		review: (width, detail) => formatLibraryImportReview(options.plan, width, { detail }),
		commit: () => {
			applied = options.outcome(options.plan, options.commit(options.plan));
			return (width) => formatLibraryOutcome(applied as LibraryApplyResult, width);
		},
		retryRefresh: () => {
			const refresh = options.retryRefresh();
			applied = applied ? { ...applied, refresh } : applied;
			return (width) => formatLibraryOutcome(applied as LibraryApplyResult, width);
		},
		refreshFailed: () => applied?.refresh.status === "failed",
		onCancel: options.onCancel,
		onDone: () => {
			if (applied) options.onDone(applied);
		},
	});
}
