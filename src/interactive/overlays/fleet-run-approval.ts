/**
 * `/fleet run <playbook>` approval: the whole plan, before anything dispatches.
 *
 * The operator reads the compiled plan here and decides. Enter accepts and the
 * run starts; Esc cancels and nothing is dispatched, nothing is written, and no
 * ledger row exists. A contract that failed preflight opens the same overlay
 * refused, with its diagnostics and no accept key, so the only way out of a
 * broken plan is to close it.
 *
 * The body is a pure function of the projection and the presentation tier, so
 * the layout is testable without a TUI. It takes the approval card's height
 * rules: the verdict, isolation, budget and choices are pinned, the step rows
 * scroll between them in a window the tier bounds (`decisionPreviewRows`), and
 * a frame too short for the pinned rows becomes one window that Enter cannot
 * answer until every choice is on screen.
 */

import { onPresentationTierChange, type TierPolicy, tierPolicy } from "../../core/presentation-tier.js";
import { renderUsdLimit } from "../../core/telemetry/render.js";
import type { ExecutionPlan, ExecutionPlanStep } from "../../domains/dispatch/execution-plan.js";
import { executionPlanIsolationText, executionPlanStepScope } from "../../domains/dispatch/execution-plan.js";
import type { FleetRunPreview, FleetRunPreviewStep } from "../../domains/dispatch/index.js";
import { budgetSpendText } from "../../domains/scheduling/budget.js";
import type { OverlayHandle, TUI } from "../../engine/tui.js";
import { isKeyRelease, matchesKey, truncateToWidth, visibleWidth } from "../../engine/tui.js";
import {
	buildResponsiveHint,
	createCachedBody,
	FocusBox,
	type HintEntry,
	showClioOverlayFrame,
	windowRows,
} from "../overlay-frame.js";
import {
	type Choice,
	chipRows,
	choiceRows,
	clioTheme,
	errorState,
	type Fact,
	factRows,
	formatTargetLabel,
	GLYPH,
	padAnsi,
	positionRow,
	type Tone,
	toneRole,
} from "../theme/index.js";
import { scrollJump } from "./confirm-once.js";

export const FLEET_RUN_APPROVAL_OVERLAY_TITLE = "Fleet run approval";

const FLEET_RUN_APPROVAL_MIN_WIDTH = 48;
const FLEET_RUN_APPROVAL_MAX_WIDTH = 110;
/** Rows of plan shown at once when the frame has not said how many it has. */
export const FLEET_RUN_APPROVAL_VISIBLE_ROWS = 22;
/**
 * A preview budget under this many rows cannot hold a step and the position row that says how many more there are,
 * so the verdict's step count stands for the list (compact's budget is 2).
 */
const STEP_LIST_MIN_PREVIEW_ROWS = 3;

function fleetRunApprovalOverlayWidth(columns: number): number {
	return Math.max(FLEET_RUN_APPROVAL_MIN_WIDTH, Math.min(FLEET_RUN_APPROVAL_MAX_WIDTH, columns - 4));
}

/** What the overlay renders: an accepted-shaped plan or the reasons there is none. */
export type FleetRunApprovalSubject =
	| { ok: true; preview: FleetRunPreview }
	| { ok: false; name: string; diagnostics: ReadonlyArray<string> };

export interface OpenFleetRunApprovalOverlayOptions {
	subject: FleetRunApprovalSubject;
	/** Live terminal width, so the box tracks the window it opened in. */
	columns: number;
	/** Enter: dispatch this exact plan. Never called for a failed preflight. */
	onAccept: () => void;
	/** Esc: nothing is dispatched and nothing is written. */
	onCancel: () => void;
}

const sep = (): string => ` ${GLYPH.sep} `;

/** The declared boundary as one phrase: an empty allowlist is a claim, not an absence. */
function formatWriteBoundary(writes: ReadonlyArray<string> | undefined): string {
	if (writes === undefined) return "writes unenforced";
	if (writes.length === 0) return "writes nothing";
	return `writes ${writes.join(", ")}`;
}

/** An argv as a shell would show it: bare words bare, anything else quoted exactly. */
function formatArgv(argv: ReadonlyArray<string>): string {
	return argv.map((arg) => (/^[\w./:=@%+-]+$/u.test(arg) ? arg : JSON.stringify(arg))).join(" ");
}

/** A step's id with its loop position: `repair 1` when the loop is named after its role. */
function stepLabel(step: FleetRunPreviewStep): string {
	if (step.loop === undefined) return step.stepId;
	return step.loop.loopId === step.loop.role
		? `${step.stepId} (${step.loop.role} ${step.loop.attempt})`
		: `${step.stepId} (${step.loop.loopId} ${step.loop.role} ${step.loop.attempt})`;
}

/** Who runs a step, as one word: the agent, the command, or the prior result a resume replays. */
function stepRunner(step: FleetRunPreviewStep): string {
	if (step.replayed === true) return "replay";
	if (step.kind === "code") return step.commandId ?? "?";
	return step.agentId ?? "?";
}

/** A step's task as one line: the agent's compiled task, the command's argv, or the replay. */
function stepTask(step: FleetRunPreviewStep, planSteps: ReadonlyMap<string, ExecutionPlanStep>): string {
	if (step.replayed === true) return "prior sealed result, not dispatched";
	if (step.kind === "code") return step.argv === undefined ? `command ${step.commandId ?? "?"}` : formatArgv(step.argv);
	const planned = planSteps.get(step.stepId);
	const task = planned?.kind === "agent" ? planned.task : "";
	return task.replace(/\s+/gu, " ").trim();
}

/** Where a step runs and what it may write, the facts detailed adds under its row. */
function stepFacts(step: FleetRunPreviewStep, plan: Pick<ExecutionPlan, "isolation">): Fact[] {
	if (step.replayed === true) return [];
	const scope: Fact = {
		label: "scope",
		value: `${executionPlanStepScope(plan, step.scope)}${sep()}${formatWriteBoundary(step.writes)}`,
		tone: "muted",
	};
	if (step.kind === "code") {
		const gate = step.gate === undefined ? "" : `${sep()}gate path ${step.gate.path}`;
		const where = step.argv === undefined ? `command ${step.commandId ?? "?"}` : formatArgv(step.argv);
		return [{ label: "runs", value: `${where}${gate}`, tone: "muted" }, scope];
	}
	const route =
		step.route === undefined
			? "route unresolved"
			: formatTargetLabel(step.route.targetId, step.route.wireModelId, { abbreviate: false });
	const node = step.route === undefined ? "" : `${sep()}node ${step.route.nodeId}`;
	const declaredRoute =
		step.target !== undefined
			? `${sep()}target ${step.target}`
			: step.profile !== undefined
				? `${sep()}profile ${step.profile}`
				: "";
	const gate =
		step.gate !== undefined
			? `${sep()}gate path ${step.gate.path}${sep()}run ${"commandId" in step.gate ? step.gate.commandId : "?"}${sep()}baseline ${"commandId" in step.gate ? step.gate.commandId : "?"}`
			: "";
	const dynamicPlan =
		step.plan === undefined
			? ""
			: `${sep()}roster ${step.plan.roster.join(", ")}${sep()}maxTasks ${step.plan.maxTasks}${step.plan.proposals ? `${sep()}proposals` : ""}`;
	return [{ label: "route", value: `${route}${node}${declaredRoute}${gate}${dynamicPlan}`, tone: "muted" }, scope];
}

export function formatBudgetLine(preview: FleetRunPreview): string {
	const playbook =
		preview.budget.playbookUsd === null
			? "playbook declares no ceiling"
			: `playbook ceiling ${renderUsdLimit(preview.budget.playbookUsd)}`;
	const ceiling =
		preview.budget.ceilingUsd === 0
			? "no session ceiling"
			: `${renderUsdLimit(preview.budget.ceilingUsd)} session ceiling`;
	return `budget: admitted under ${ceiling}, ${budgetSpendText(preview.budget.currentUsd, preview.budget.pricing)} spent, ${playbook}`;
}

/** The budget row in `formatBudgetLine`'s words, toned by how near the spend is to the session ceiling. */
function budgetRows(preview: FleetRunPreview, width: number): string[] {
	const { ceilingUsd, currentUsd } = preview.budget;
	const tone: Tone =
		ceilingUsd <= 0
			? "neutral"
			: currentUsd >= ceilingUsd
				? "error"
				: currentUsd >= ceilingUsd * 0.8
					? "warning"
					: "neutral";
	const value = formatBudgetLine(preview).slice("budget: ".length);
	return factRows(clioTheme(), [{ label: "budget", value, tone }], width);
}

/** The worktree a resumed run continues in: the prior record's, else the prior run's own id. */
function resumedWorktree(preview: FleetRunPreview): string | null {
	if (preview.resume === undefined || preview.plan.isolation !== "worktree") return null;
	return preview.resume.record.worktree ?? preview.resume.record.id;
}

/** Where the run writes, the isolation fact every tier pins. */
function isolationText(preview: FleetRunPreview): string {
	if (preview.plan.isolation !== "worktree") return "every step runs in this checkout";
	if (resumedWorktree(preview) !== null)
		return "every step runs in the task worktree the resumed run kept; this checkout does not change until it lands";
	return executionPlanIsolationText();
}

/** One row per step, `w1  build  coder  Implement this change…`, cut with an ellipsis and never wider than `width`. */
function stepRows(preview: FleetRunPreview, width: number, policy: TierPolicy): string[] {
	const theme = clioTheme();
	const planSteps = new Map((preview.plan.steps ?? []).map((step) => [step.id, step]));
	const entries = preview.waves.flatMap((wave) => wave.steps.map((step) => ({ wave: `w${wave.index + 1}`, step })));
	const widest = (values: ReadonlyArray<string>): number => values.reduce((max, v) => Math.max(max, visibleWidth(v)), 0);
	const waveWidth = widest(entries.map((entry) => entry.wave));
	const idWidth = Math.min(widest(entries.map((entry) => stepLabel(entry.step))), Math.max(6, Math.floor(width / 5)));
	const runnerWidth = Math.min(
		widest(entries.map((entry) => stepRunner(entry.step))),
		Math.max(5, Math.floor(width / 6)),
	);
	const taskWidth = width - waveWidth - idWidth - runnerWidth - 6;
	const rows: string[] = [];
	for (const { wave, step } of entries) {
		const cells = [
			padAnsi(theme.fg("annotation", wave), waveWidth, GLYPH.ellipsis),
			padAnsi(theme.fg(toneRole("neutral"), stepLabel(step)), idWidth, GLYPH.ellipsis),
			padAnsi(theme.fg(toneRole("accent"), stepRunner(step)), runnerWidth, GLYPH.ellipsis),
		];
		const task = stepTask(step, planSteps);
		const row =
			taskWidth >= 4 && task.length > 0
				? `${cells.join("  ")}  ${truncateToWidth(theme.fg(toneRole("muted"), task), taskWidth, GLYPH.ellipsis)}`
				: cells.join("  ").trimEnd();
		rows.push(truncateToWidth(row, width, GLYPH.ellipsis));
		if (policy.runSubRows > 0) {
			rows.push(...factRows(theme, stepFacts(step, preview.plan), Math.max(1, width - 4)).map((line) => `    ${line}`));
		}
	}
	return rows;
}

/** The card as its parts: pinned head, the window the tier bounds, pinned budget and choices. */
interface CardParts {
	head: string[];
	window: string[];
	/** Most window rows shown at once before scrolling; a refusal's reasons are never capped. */
	windowCap: number;
	/** The noun the position row counts the window in. */
	unit: string;
	budget: string[];
	choices: string[];
}

function cardParts(subject: FleetRunApprovalSubject, width: number, policy: TierPolicy): CardParts {
	const theme = clioTheme();
	if (!subject.ok) {
		return {
			head: [
				...chipRows(
					theme,
					[theme.style("heading", subject.name, { bold: true }), theme.fg(toneRole("error"), "refused")],
					width,
				),
				...errorState(theme, "preflight failed; nothing will be dispatched", width),
			],
			window: subject.diagnostics.flatMap((diagnostic) =>
				diagnostic.split("\n").flatMap((line) => factRows(theme, [{ label: " ", value: line }], width)),
			),
			windowCap: Number.POSITIVE_INFINITY,
			unit: "rows",
			budget: [],
			choices: choiceRows(theme, planChoices(subject), width),
		};
	}
	const { preview } = subject;
	// The count is of the steps the waves list, so the verdict and the rows under it agree.
	const steps = preview.waves.reduce((total, wave) => total + wave.steps.length, 0);
	const waves = preview.waves.length;
	const head = [
		...chipRows(
			theme,
			[
				theme.style("heading", preview.name, { bold: true }),
				theme.fg(toneRole("success"), "admitted"),
				theme.fg("annotation", `${steps} ${steps === 1 ? "step" : "steps"} in ${waves} ${waves === 1 ? "wave" : "waves"}`),
				preview.resume === undefined ? null : theme.fg(toneRole("info"), "resumed"),
			],
			width,
		),
		...factRows(theme, [{ label: "isolation", value: isolationText(preview), tone: "info" }], width),
	];
	const window: string[] = [];
	// Lineage, the resumed worktree, each step's route and boundary and the seal are provenance, read where runs carry
	// their telemetry row (detailed); the other tiers keep the word `resumed` and one row per step.
	const detailed = policy.runSubRows > 0;
	if (detailed && preview.resume !== undefined) {
		const replayed = [...preview.resume.replayed.keys()];
		const from = `${preview.resume.fromRunId} from ${preview.resume.record.cwd ?? "(unknown workspace)"}`;
		const value =
			replayed.length === 0
				? `${from}: no successful prefix to replay; every step runs`
				: `${from}: replays ${replayed.length} step${replayed.length === 1 ? "" : "s"} (${replayed.join(", ")}), runs the rest`;
		const facts: Fact[] = [{ label: "resumes", value, tone: "info" }];
		const worktree = resumedWorktree(preview);
		if (worktree !== null) {
			facts.push({
				label: "worktree",
				value: `continues in task worktree ${worktree}, kept from run ${preview.resume.fromRunId}`,
				tone: "info",
			});
		}
		window.push(...factRows(theme, facts, width));
	}
	// Compact states the count in the verdict; standard and detailed list every step.
	if (policy.decisionPreviewRows >= STEP_LIST_MIN_PREVIEW_ROWS) window.push(...stepRows(preview, width, policy));
	if (detailed) {
		window.push(
			...factRows(
				theme,
				[
					{
						label: "sealed",
						value: `plan ${preview.plan.hash.slice(0, 12)}, approval ${preview.planHash.slice(0, 12)}: recipes, routes, commands, budget and replay cannot change after you approve`,
						tone: "muted",
					},
				],
				width,
			),
		);
	}
	return {
		head,
		window,
		windowCap: policy.decisionPreviewRows,
		unit: detailed ? "rows" : "steps",
		budget: budgetRows(preview, width),
		choices: choiceRows(theme, planChoices(subject), width),
	};
}

/** What each key does, for the rows under the plan. A refused plan has one way out. */
function planChoices(subject: FleetRunApprovalSubject): Choice[] {
	if (!subject.ok) return [{ key: "Esc", verb: "close", consequence: "nothing was dispatched or written" }];
	return [
		{ key: "Enter", verb: "dispatch", consequence: "starts this exact plan now", tone: "action" },
		{ key: "Esc", verb: "cancel", consequence: "dispatches nothing and writes nothing" },
	];
}

/** The rendered card and what the keys may do in it. */
interface FleetRunApprovalLayout {
	lines: string[];
	/** Every choice row with its consequence is on screen; Enter answers only then. */
	choicesShown: boolean;
	/** The scroll offset the window settled on, clamped to what exists. */
	scroll: number;
	maxScroll: number;
}

function layoutFleetRunApproval(
	subject: FleetRunApprovalSubject,
	width: number,
	scroll: number,
	rows: number,
): FleetRunApprovalLayout {
	const theme = clioTheme();
	const contentWidth = Math.max(1, Math.floor(width));
	const parts = cardParts(subject, contentWidth, tierPolicy());
	const budget = rows > 0 ? rows : FLEET_RUN_APPROVAL_VISIBLE_ROWS;
	const pinned = parts.head.length + parts.budget.length + parts.choices.length;
	const position = (
		pane: { position: { start: number; end: number; total: number } | null },
		keys: string[],
		unit = parts.unit,
	) => (pane.position === null ? [] : [positionRow(theme, { ...pane.position, unit, keys }, contentWidth)]);
	if (pinned <= budget) {
		const room = budget - pinned;
		if (parts.window.length <= Math.min(parts.windowCap, room)) {
			return {
				lines: [...parts.head, ...parts.window, ...parts.budget, ...parts.choices],
				choicesShown: true,
				scroll: 0,
				maxScroll: 0,
			};
		}
		const height = Math.min(parts.windowCap, room - 1);
		// No row left for even one window row and its position: the count in the verdict stands for the list.
		if (height < 1) {
			return { lines: [...parts.head, ...parts.budget, ...parts.choices], choicesShown: true, scroll: 0, maxScroll: 0 };
		}
		const pane = windowRows(parts.window, scroll, height);
		return {
			lines: [
				...parts.head,
				...pane.window,
				...position(pane, [`[${GLYPH.up}${GLYPH.down}] scroll`]),
				...parts.budget,
				...parts.choices,
			],
			choicesShown: true,
			scroll: pane.start,
			maxScroll: pane.maxScroll,
		};
	}
	// Reading form: the first verdict row stays, and everything else, choices included, is one window.
	const [lead = "", ...rest] = parts.head;
	const flow = [...rest, ...parts.window, ...parts.budget, ...parts.choices];
	const pane = windowRows(flow, scroll, Math.max(1, budget - 2));
	const end = pane.start + pane.window.length;
	const choicesShown = end === flow.length && pane.start <= flow.length - parts.choices.length;
	return {
		lines: [
			lead,
			...pane.window,
			...position(pane, [choicesShown ? `[${GLYPH.up}${GLYPH.down}] scroll` : `[${GLYPH.down}] read choices`], "rows"),
		],
		choicesShown,
		scroll: pane.start,
		maxScroll: pane.maxScroll,
	};
}

/**
 * Render the body at the current tier: the verdict, isolation, budget and
 * choices pinned, the steps windowed between them. Zero rows means the frame
 * has not said how many it has.
 */
export function formatFleetRunApprovalBody(
	subject: FleetRunApprovalSubject,
	width: number,
	scroll: number,
	rows = 0,
): string[] {
	return layoutFleetRunApproval(subject, width, scroll, rows).lines;
}

export function openFleetRunApprovalOverlay(tui: TUI, options: OpenFleetRunApprovalOverlayOptions): OverlayHandle {
	const acceptable = options.subject.ok;
	let scroll = 0;
	let maxScroll = 0;
	let choicesShown = true;
	let settled = false;
	const body = createCachedBody((width, rows) => {
		const layout = layoutFleetRunApproval(options.subject, width, scroll, rows);
		scroll = layout.scroll;
		maxScroll = layout.maxScroll;
		choicesShown = layout.choicesShown;
		return layout.lines;
	});
	// The body memoizes on its own revision, so a tier change touches it and the held card redraws on the next frame.
	const unsubscribe = onPresentationTierChange(() => {
		body.touch();
		tui.requestRender();
	});

	const accept = (): void => {
		// Enter answers only while every choice and its consequence is on screen.
		if (settled || !acceptable || !choicesShown) return;
		settled = true;
		unsubscribe();
		options.onAccept();
	};
	const cancel = (): void => {
		if (settled) return;
		settled = true;
		unsubscribe();
		options.onCancel();
	};
	const scrollTo = (next: number): void => {
		const clamped = Math.max(0, Math.min(maxScroll, next));
		if (clamped === scroll) return;
		scroll = clamped;
		body.touch();
		tui.requestRender();
	};

	const focus = new FocusBox(body, {
		// Keys are matched by name, never by raw bytes: under the kitty keyboard
		// protocol Esc arrives as CSI 27 u, and a byte comparison against "\x1b"
		// left the overlay unanswerable. Everything unmatched is swallowed.
		onInput: (data: string): void => {
			if (settled || isKeyRelease(data)) return;
			const jump = scrollJump(data, scroll, maxScroll);
			if (jump !== null) {
				scrollTo(jump);
				return;
			}
			if (matchesKey(data, "up")) {
				scrollTo(scroll - 1);
				return;
			}
			if (matchesKey(data, "down")) {
				scrollTo(scroll + 1);
				return;
			}
			if (matchesKey(data, "enter")) {
				accept();
				return;
			}
			if (matchesKey(data, "escape")) cancel();
		},
	});

	const escEntry: HintEntry = acceptable
		? { key: "Esc", verb: "cancel, nothing dispatched", short: "cancel" }
		: { key: "Esc", verb: "close" };
	const handle = showClioOverlayFrame(tui, focus, {
		anchor: "center",
		width: fleetRunApprovalOverlayWidth(options.columns),
		markerId: "fleet-run-approval",
		title: FLEET_RUN_APPROVAL_OVERLAY_TITLE,
		// A plan that can dispatch is a decision, so the rails carry the approval
		// tone. A refused plan has nothing to approve and stays informational.
		...(acceptable ? { approval: true, awaitingInput: true, tone: "decisionCue" as const } : {}),
		// The rail is read after the body renders, so it names Enter only while the
		// choices are on screen and points down to them otherwise. It names the way
		// out as well, because a frame short enough to cut the choice rows would
		// otherwise leave Esc on no surface at all.
		footerHint: (innerWidth: number): string => {
			const entries: HintEntry[] = [];
			if (acceptable && !choicesShown) entries.push({ key: GLYPH.down, verb: "read choices" });
			else {
				if (maxScroll > 0) entries.push({ key: `${GLYPH.up}${GLYPH.down}`, verb: "scroll" });
				if (acceptable) entries.push({ key: "Enter", verb: "dispatch" });
			}
			return buildResponsiveHint(entries, escEntry)(innerWidth);
		},
	});

	return {
		...handle,
		hide(): void {
			cancel();
			unsubscribe();
			handle.hide();
		},
	};
}
