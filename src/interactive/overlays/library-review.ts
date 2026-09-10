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
 * testable without a terminal.
 */

import type { LibraryImportApplyResult, LibraryImportPlan } from "../../domains/interop/index.js";
import type {
	LibraryApplyResult,
	LibraryLifecyclePlan,
	LibraryPlanStep,
	LibraryRefreshResult,
	LibraryStepOutcome,
} from "../../domains/resources/index.js";
import {
	type Component,
	isKeyRelease,
	matchesKey,
	type OverlayHandle,
	type TUI,
	wrapTextWithAnsi,
} from "../../engine/tui.js";
import { buildResponsiveHint, FocusBox, showClioOverlayFrame } from "../overlay-frame.js";
import { clioTheme, rule } from "../theme/index.js";

const MIN_WIDTH = 48;
const MAX_WIDTH = 110;

function libraryReviewWidth(columns: number): number {
	return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, columns - 4));
}

function wrap(text: string, width: number): string[] {
	return wrapTextWithAnsi(text, Math.max(1, Math.floor(width)));
}

function stepHeadline(step: LibraryPlanStep): string {
	return `${step.operation} ${step.identity.ref} in ${step.identity.scope} scope`;
}

/**
 * The reviewed plan, in the order the questions matter: what changes, what it
 * depends on, what depends on it, what becomes effective afterwards, and how a
 * changed tree is recovered.
 *
 * `detail` adds the destination path and the source digest. They are the facts
 * an operator verifies against `library install --dry-run`, and they are also
 * the two longest lines on the screen, so they expand rather than crowd out the
 * dependency story.
 */
export function formatLibraryPlanReview(
	plan: LibraryLifecyclePlan,
	width: number,
	options: { detail?: boolean } = {},
): string[] {
	const theme = clioTheme();
	const rows: string[] = [];
	const target = plan.steps.at(-1);
	rows.push(
		...wrap(theme.fg("accent", target ? stepHeadline(target) : `${plan.request.operation} ${plan.request.ref}`), width),
	);
	if (plan.steps.length > 1)
		rows.push(...wrap(theme.fg("dim", `${plan.steps.length} steps, requirements first`), width));
	rows.push(rule(theme, width));

	for (const step of plan.steps) {
		rows.push(...wrap(theme.fg("muted", stepHeadline(step)), width));
		if (step.refusal) rows.push(...wrap(theme.fg("error", `refused: ${step.refusal}`), width));
		if (step.content && !step.content.valid)
			rows.push(...wrap(theme.fg("warning", `content invalid: ${step.content.diagnostics.join("; ")}`), width));
		if (step.content?.resources.length)
			rows.push(
				...wrap(
					theme.fg(
						"dim",
						`projects ${step.content.resources.map((item) => `${item.kind}:${item.name}${item.valid ? "" : " (invalid)"}`).join(", ")}`,
					),
					width,
				),
			);
		if (step.dependencies.missing.length)
			rows.push(...wrap(theme.fg("warning", `missing requirements: ${step.dependencies.missing.join(", ")}`), width));
		if (step.dependencies.inactive.length)
			rows.push(...wrap(theme.fg("warning", `inactive requirements: ${step.dependencies.inactive.join(", ")}`), width));
		for (const dependent of step.dependents.newlyBroken)
			rows.push(
				...wrap(
					theme.fg("error", `would break ${dependent.ref} (${dependent.scope}): needs ${dependent.missing.join(", ")}`),
					width,
				),
			);
		for (const dependent of step.dependents.preexisting)
			rows.push(
				...wrap(
					theme.fg("dim", `already broken ${dependent.ref} (${dependent.scope}): needs ${dependent.missing.join(", ")}`),
					width,
				),
			);
		if (step.effectiveAfter)
			rows.push(
				...wrap(
					theme.fg(
						"info",
						`effective afterwards: ${step.effectiveAfter.scope} copy, ${step.effectiveAfter.loadable ? "loadable" : "not loadable"} (${step.effectiveAfter.state})`,
					),
					width,
				),
			);
		rows.push(...wrap(theme.fg("dim", step.fallbackNote), width));
		rows.push(...wrap(theme.fg("dim", step.recovery), width));
		if (options.detail) {
			rows.push(...wrap(theme.fg("dim", `destination ${step.destination}`), width));
			if (step.source)
				rows.push(
					...wrap(theme.fg("dim", `source ${step.source.sourceUrl}`), width),
					...wrap(theme.fg("dim", `    sha256 ${step.source.sha256}`), width),
				);
		}
	}

	rows.push(rule(theme, width));
	for (const diagnostic of plan.diagnostics) rows.push(...wrap(theme.fg("warning", diagnostic), width));
	rows.push(
		...wrap(
			theme.fg(
				"dim",
				plan.applicable
					? "Verification after the change reads the copy back from disk and reports which resources the loaders actually admit. Enter applies it; Esc writes nothing and releases the staged source."
					: "This plan cannot be applied as reviewed. Esc writes nothing and releases the staged source.",
			),
			width,
		),
	);
	rows.push(...wrap(theme.fg("dim", options.detail ? "d hides paths and digests" : "d shows paths and digests"), width));
	return rows;
}

function refreshLine(refresh: LibraryRefreshResult): string {
	const theme = clioTheme();
	if (refresh.status === "refreshed")
		return theme.fg(
			"success",
			`session resources refreshed (generation ${refresh.generation}${refresh.changed ? ", changed" : ", unchanged"})`,
		);
	if (refresh.status === "failed")
		return theme.fg("error", `session refresh failed: ${refresh.error}; press R to retry`);
	return theme.fg("dim", `session refresh not applicable: ${refresh.reason}`);
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

function outcomeLines(outcome: LibraryStepOutcome, width: number, refresh: LibraryRefreshResult): string[] {
	const theme = clioTheme();
	const token = outcome.status === "committed" ? "success" : outcome.status === "failed" ? "error" : ("dim" as const);
	const rows = wrap(
		theme.fg(token, `${outcome.status}: ${outcome.operation} ${outcome.identity.ref} (${outcome.identity.scope})`),
		width,
	);
	if (outcome.error) {
		rows.push(...wrap(theme.fg("error", `${outcome.error.code}: ${outcome.error.message}`), width));
		if (outcome.error.changed)
			rows.push(
				...wrap(
					theme.fg(
						"dim",
						`changed fact ${outcome.error.changed.fact}: reviewed ${JSON.stringify(outcome.error.changed.expected)}, observed ${JSON.stringify(outcome.error.changed.observed)}`,
					),
					width,
				),
			);
		rows.push(...wrap(theme.fg("info", outcome.error.next), width));
	}
	const verification = outcome.verification;
	if (verification) {
		rows.push(...wrap(theme.fg("dim", `disk: tree ${verification.tree}, record ${verification.record}`), width));
		rows.push(
			...wrap(
				theme.fg(
					"dim",
					`${evidenceLabel(verification.evidence, refresh)}: ${
						verification.resources.length === 0
							? "none admitted"
							: verification.resources
									.map(
										(item) =>
											`${item.kind}:${item.name} ${item.available ? "available" : `unavailable (${item.reason ?? "no reason recorded"})`}`,
									)
									.join(", ")
					}`,
				),
				width,
			),
		);
		rows.push(
			...wrap(
				theme.fg(
					"dim",
					verification.effective
						? `effective copy: ${verification.effective.scope}, ${verification.effective.loadable ? "loadable" : "not loadable"}`
						: "effective copy: none remains",
				),
				width,
			),
		);
	}
	if (outcome.recovery?.packageBackup)
		rows.push(...wrap(theme.fg("info", `recovered content: ${outcome.recovery.packageBackup}`), width));
	if (outcome.recovery?.stateBackup)
		rows.push(...wrap(theme.fg("dim", `state backup: ${outcome.recovery.stateBackup}`), width));
	for (const diagnostic of outcome.diagnostics) rows.push(...wrap(theme.fg("dim", diagnostic), width));
	return rows;
}

/**
 * What actually happened.
 *
 * The three counts lead, because a batch that committed two of three writes is
 * a different situation from one that committed none, and the older single
 * "installed" line could describe both. Disk state, resource admission and
 * session refresh are then separate lines: a package can be on disk with one
 * resource still unavailable, and that is not a failed write.
 */
export function formatLibraryOutcome(result: LibraryApplyResult, width: number): string[] {
	const theme = clioTheme();
	const rows = wrap(
		theme.fg(
			result.failed > 0 ? "error" : "success",
			`${result.committed} committed · ${result.failed} failed · ${result.unattempted} unattempted`,
		),
		width,
	);
	rows.push(rule(theme, width));
	for (const outcome of result.outcomes) rows.push(...outcomeLines(outcome, width, result.refresh));
	rows.push(rule(theme, width));
	rows.push(...wrap(refreshLine(result.refresh), width));
	if (result.unattempted > 0)
		rows.push(
			...wrap(
				theme.fg(
					"dim",
					"Unattempted steps were never started; the committed ones stand. Review a fresh plan for the rest.",
				),
				width,
			),
		);
	rows.push(
		...wrap(theme.fg("dim", "R retries the session refresh only; it never repeats a write. Esc closes."), width),
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
	plan: LibraryImportPlan,
	width: number,
	options: { detail?: boolean } = {},
): string[] {
	const theme = clioTheme();
	const rows = wrap(
		theme.fg(
			plan.action === "install" ? "accent" : "error",
			`${plan.action === "install" ? "import" : "blocked"} ${plan.id ?? plan.source.input} into ${plan.scope} scope`,
		),
		width,
	);
	rows.push(rule(theme, width));
	rows.push(...wrap(theme.fg("muted", `source: ${plan.source.input} (${plan.source.transport})`), width));
	if (plan.format) rows.push(...wrap(theme.fg("dim", `format: ${plan.format}`), width));
	if (plan.version) rows.push(...wrap(theme.fg("dim", `version: ${plan.version}`), width));
	if (plan.destination) rows.push(...wrap(theme.fg("dim", `destination: ${plan.destination}`), width));
	rows.push(
		...wrap(
			theme.fg(
				"info",
				`projects ${plan.outcomes.length} resource${plan.outcomes.length === 1 ? "" : "s"}${
					plan.outcomes.length > 0
						? `: ${plan.outcomes.map((outcome) => `${outcome.kind}:${outcome.name} (${outcome.status})`).join(", ")}`
						: ""
				}`,
			),
			width,
		),
	);
	for (const item of plan.unsupported)
		rows.push(...wrap(theme.fg("warning", `unsupported host feature, not imported: ${item}`), width));
	for (const item of plan.omitted) rows.push(...wrap(theme.fg("warning", `omitted file: ${item}`), width));
	if (plan.requirements.length)
		rows.push(...wrap(theme.fg("warning", `requires installed packages: ${plan.requirements.join(", ")}`), width));
	for (const reason of plan.reasons)
		rows.push(...wrap(theme.fg(plan.action === "install" ? "dim" : "error", reason), width));
	rows.push(rule(theme, width));
	rows.push(
		...wrap(
			theme.fg(
				"dim",
				"Imported content stays foreign: it keeps its original provenance and needs the project-import trust gate before the model may use it. The vendor's own directory is never modified.",
			),
			width,
		),
	);
	if (options.detail) {
		rows.push(...wrap(theme.fg("dim", `review fingerprint ${plan.reviewFingerprint}`), width));
		if (plan.digest) rows.push(...wrap(theme.fg("dim", `projected digest ${plan.digest}`), width));
		rows.push(...wrap(theme.fg("dim", `source root ${plan.source.root}`), width));
	}
	rows.push(
		...wrap(
			theme.fg(
				"dim",
				plan.action === "install"
					? "Enter imports exactly this projection; Esc writes nothing."
					: "This source cannot be imported as reviewed. Esc writes nothing.",
			),
			width,
		),
	);
	rows.push(...wrap(theme.fg("dim", options.detail ? "d hides paths and digests" : "d shows paths and digests"), width));
	return rows;
}

/** One scrollable body that shows a reviewed plan, then the outcome that replaced it. */
class LibraryReviewBody implements Component {
	private scroll = 0;
	private maxScroll = 0;
	private rows = 12;
	detail = false;
	outcome: (() => string[]) | null = null;

	constructor(private readonly review: (width: number, detail: boolean) => string[]) {}

	scrollBy(delta: number): void {
		this.scroll = Math.max(0, Math.min(this.maxScroll, this.scroll + delta * this.rows));
	}

	reset(): void {
		this.scroll = 0;
	}

	render(width: number): string[] {
		const body = this.outcome ? this.outcome() : this.review(width, this.detail);
		this.rows = Math.max(4, (process.stdout.rows || 30) - 10);
		this.maxScroll = Math.max(0, body.length - this.rows);
		this.scroll = Math.min(this.scroll, this.maxScroll);
		const shown = body.slice(this.scroll, this.scroll + this.rows);
		if (this.maxScroll) shown.push(`(${this.scroll + 1}-${this.scroll + shown.length}/${body.length}) PgUp/PgDn`);
		return shown;
	}

	invalidate(): void {}
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
	let width = libraryReviewWidth(spec.columns);
	const body = new LibraryReviewBody(spec.review);

	const cancel = (): void => {
		if (settled) return;
		settled = true;
		spec.onCancel();
	};

	const focus = new FocusBox(body, {
		// Keys are matched by name rather than by raw bytes: under the kitty
		// keyboard protocol Esc arrives as CSI 27 u, and a byte comparison left
		// this overlay unanswerable.
		onInput: (data: string): void => {
			if (isKeyRelease(data)) return;
			if (body.outcome) {
				if (data === "R") {
					// Refresh only. The writes already committed and are never repeated.
					const next = spec.retryRefresh();
					body.outcome = () => next(width);
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
					const outcome = spec.commit();
					body.outcome = () => outcome(width);
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
			if (matchesKey(data, "pageDown") || matchesKey(data, "down")) body.scrollBy(1);
			else if (matchesKey(data, "pageUp") || matchesKey(data, "up")) body.scrollBy(-1);
			tui.requestRender();
		},
	});

	const handle = showClioOverlayFrame(tui, focus, {
		anchor: "center",
		width,
		markerId: "library-review",
		title: () => (body.outcome ? "Library outcome" : spec.title),
		footerHint: (innerWidth: number) => {
			width = innerWidth;
			return body.outcome
				? buildResponsiveHint([{ key: "R", verb: "retry refresh" }], { key: "Esc", verb: "close" })(innerWidth)
				: buildResponsiveHint(
						[...(spec.applicable ? [{ key: "Enter", verb: spec.verb }] : []), { key: "d", verb: "paths" }],
						{ key: "Esc", verb: "cancel" },
					)(innerWidth);
		},
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
