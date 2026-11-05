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

const MIN_WIDTH = 48;
const MAX_WIDTH = 110;
/** Rows the body shows while the frame has not said how many it has. */
const REVIEW_DEFAULT_ROWS = 20;

const FACT_OPTIONS = { labelRole: "fieldName" as const, stack: "never" as const };

function libraryReviewWidth(columns: number): number {
	return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, columns - 4));
}

function stepHeadline(step: LibraryPlanStep): string {
	return `${step.operation} ${step.identity.ref} in ${step.identity.scope} scope`;
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
function stepFacts(step: LibraryPlanStep, review: LibraryStepReview | undefined, detail: boolean): Fact[] {
	const theme = clioTheme();
	const facts: Fact[] = [{ label: "Package", value: step.identity.ref }];
	if (step.refusal) facts.push({ label: "Refused", value: statusChip(theme, "error", step.refusal) });
	if (step.content && !step.content.valid)
		facts.push({
			label: "Content",
			value: statusChip(theme, "warning", `invalid: ${step.content.diagnostics.join("; ")}`),
		});
	if (step.content?.resources.length)
		facts.push({
			label: "Projects",
			value: step.content.resources.map((item) => `${item.kind}:${item.name}${item.valid ? "" : " (invalid)"}`).join(", "),
		});
	if (step.dependencies.missing.length)
		facts.push({ label: "Missing", value: `requires ${step.dependencies.missing.join(", ")}`, tone: "warning" });
	if (step.dependencies.inactive.length)
		facts.push({ label: "Inactive", value: `requires ${step.dependencies.inactive.join(", ")}`, tone: "warning" });
	for (const dependent of step.dependents.newlyBroken)
		facts.push({
			label: "Dependents",
			value: statusChip(
				theme,
				"error",
				`would break ${dependent.ref} (${dependent.scope}): needs ${dependent.missing.join(", ")}`,
			),
		});
	for (const dependent of step.dependents.preexisting)
		facts.push({
			label: "Dependents",
			value: `already broken ${dependent.ref} (${dependent.scope}): needs ${dependent.missing.join(", ")}`,
			tone: "muted",
		});
	if (step.effectiveAfter)
		facts.push({
			label: "Afterwards",
			value: `${step.effectiveAfter.scope} copy, ${step.effectiveAfter.loadable ? "loadable" : "not loadable"} (${step.effectiveAfter.state})`,
			tone: "info",
		});
	facts.push({ label: "Fallback", value: step.fallbackNote, tone: "muted" });
	facts.push({ label: "Recovery", value: step.recovery, tone: "muted" });
	facts.push(...reviewFacts(step, review));
	if (detail) {
		facts.push({ label: "Destination", value: step.destination, tone: "muted" });
		if (step.source) {
			facts.push({ label: "Source", value: step.source.sourceUrl, tone: "muted" });
			facts.push({ label: "sha256", value: step.source.sha256, tone: "muted" });
		}
	}
	return facts;
}

/** The keys every review answers to, with what each one does. */
function reviewChoices(applicable: boolean, verb: string, consequence: string, detail: boolean): Choice[] {
	return [
		...(applicable ? [{ key: "Enter", verb, consequence, tone: "action" as const }] : []),
		{ key: "Esc", verb: "cancel", consequence: "writes nothing and releases the staged source" },
		{ key: "d", verb: "paths", consequence: detail ? "hides paths and digests" : "shows paths and digests" },
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
			target ? stepHeadline(target) : `${plan.request.operation} ${plan.request.ref}`,
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
				"applies the reviewed plan; verification then reads the copy back from disk and reports which resources the loaders actually admit",
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
	reloading: "extension runtimes and hooks are reloading; the result follows as a notice",
	queued:
		"extension runtimes and hooks reload once this Library closes and the session is idle; the result follows as a notice, and until then extensions stay as they were loaded",
	unavailable:
		"extension runtimes and hooks were not reloaded because this session has no extension host; restart to load them",
} as const;

/** The refresh as one clause for a notice: the status, plus what happened to extensions when one changed. */
export function libraryRefreshSummary(refresh: LibraryRefreshResult): string {
	if (refresh.status !== "refreshed" || !refresh.extensions) return refresh.status;
	return `refreshed, extensions ${refresh.extensions === "unavailable" ? "not reloaded" : refresh.extensions}`;
}

function refreshChip(refresh: LibraryRefreshResult): string {
	const theme = clioTheme();
	if (refresh.status === "refreshed") {
		const resources = `session resources refreshed (generation ${refresh.generation}${refresh.changed ? ", changed" : ", unchanged"})`;
		if (!refresh.extensions) return statusChip(theme, "ok", resources);
		return statusChip(
			theme,
			refresh.extensions === "unavailable" ? "warning" : "ok",
			`${resources}; ${EXTENSION_REFRESH_TEXT[refresh.extensions]}`,
		);
	}
	if (refresh.status === "failed")
		return statusChip(theme, "error", `session refresh failed: ${refresh.error}; press R to retry`);
	return chip(theme, `session refresh not applicable: ${refresh.reason}`, "muted");
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
	if (evidence === "post-refresh") return "resources verified after the session refresh";
	if (refresh.status === "refreshed")
		return "resource evidence from before refresh; session refreshed, reopen the Library for current admission";
	if (refresh.status === "failed")
		return "resource evidence from before refresh; current session admission is unverified because refresh failed";
	return "resource evidence from before refresh; no session refresh applied";
}

function outcomeFacts(outcome: LibraryStepOutcome, refresh: LibraryRefreshResult): Fact[] {
	const theme = clioTheme();
	const facts: Fact[] = [{ label: "Package", value: outcome.identity.ref }];
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
		facts.push({ label: "Disk", value: `tree ${verification.tree}, record ${verification.record}`, tone: "muted" });
		facts.push({
			label: "Resources",
			value: `${evidenceLabel(verification.evidence, refresh)}: ${
				verification.resources.length === 0
					? "none admitted"
					: verification.resources
							.map(
								(item) =>
									`${item.kind}:${item.name} ${item.available ? "available" : `unavailable (${item.reason ?? "no reason recorded"})`}`,
							)
							.join(", ")
			}`,
			tone: "muted",
		});
		facts.push({
			label: "Effective",
			value: verification.effective
				? `${verification.effective.scope} copy, ${verification.effective.loadable ? "loadable" : "not loadable"}`
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
		...headline(
			result.failed > 0 ? "error" : "success",
			`${result.committed} committed · ${result.failed} failed · ${result.unattempted} unattempted`,
			width,
		),
		...chipRows(theme, [refreshChip(result.refresh)], width),
		...choiceRows(
			theme,
			[
				{
					key: "R",
					verb: "retry refresh",
					consequence: "retries the session refresh only; it never repeats a write",
					...(result.refresh.status === "failed" ? { tone: "action" as const } : {}),
				},
				{ key: "Esc", verb: "close", consequence: "closes; the committed writes stand" },
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
		{ label: "Source", value: `${plan.source.input} (${plan.source.transport})` },
		...(plan.format ? [{ label: "Format", value: plan.format }] : []),
		...(plan.version ? [{ label: "Version", value: plan.version }] : []),
		...(plan.destination ? [{ label: "Destination", value: plan.destination }] : []),
		{
			label: "Projects",
			value:
				plan.outcomes.length === 0
					? "no resources"
					: `${plan.outcomes.length} resource${plan.outcomes.length === 1 ? "" : "s"}: ${plan.outcomes
							.map((outcome) => `${outcome.kind}:${outcome.name} (${outcome.status})`)
							.join(", ")}`,
			tone: "info",
		},
		...plan.unsupported.map(
			(item): Fact => ({ label: "Not imported", value: `unsupported host feature: ${item}`, tone: "warning" }),
		),
		...plan.omitted.map((item): Fact => ({ label: "Omitted file", value: item, tone: "warning" })),
		...(plan.requirements.length
			? [{ label: "Requires", value: `installed packages ${plan.requirements.join(", ")}`, tone: "warning" as const }]
			: []),
		...plan.reasons.map(
			(reason): Fact => ({ label: install ? "Note" : "Blocked", value: reason, tone: install ? "muted" : "error" }),
		),
		{
			label: "Provenance",
			value:
				"Imported content stays foreign: it keeps its original provenance and needs the project-import trust gate before the model may use it. The vendor's own directory is never modified.",
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
			`${install ? "import" : "blocked"} ${plan.id ?? plan.source.input} into ${plan.scope} scope`,
			width,
		),
		...chipRows(
			theme,
			[
				install
					? statusChip(theme, "pending", "ready to import")
					: statusChip(theme, "error", "cannot be imported as reviewed"),
				plan.format ? chip(theme, plan.format, "muted") : null,
			],
			width,
		),
		...choiceRows(theme, reviewChoices(install, "import", "imports exactly this projection", detail), width),
		sectionRule(theme, width, "Projection"),
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
					cancel();
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
				? buildResponsiveHint([{ key: "R", verb: "retry refresh" }], { key: "Esc", verb: "close" })(innerWidth)
				: buildResponsiveHint(
						[...(spec.applicable ? [{ key: "Enter", verb: spec.verb }] : []), { key: "d", verb: "paths" }],
						{ key: "Esc", verb: "cancel" },
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
		onCancel: options.onCancel,
		onDone: () => {
			if (applied) options.onDone(applied);
		},
	});
}
