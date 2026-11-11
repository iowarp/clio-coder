/**
 * `/fleet run <playbook>` approval: the whole plan, before anything dispatches.
 *
 * The operator reads the compiled plan here and decides. Enter accepts and the
 * run starts; Esc cancels and nothing is dispatched, nothing is written, and no
 * ledger row exists. A contract that failed preflight opens the same overlay
 * with its diagnostics and no accept key, so the only way out of a broken plan
 * is to leave it.
 *
 * The body is a pure function of the projection so the layout is testable
 * without a TUI: the plan's identity, one table per wave, the budget as a
 * meter, and the two keys with what each one does, pinned under the window.
 */

import { renderUsdLimit } from "../../core/telemetry/render.js";
import type { FleetRunPreview, FleetRunPreviewStep } from "../../domains/dispatch/index.js";
import { budgetSpendText } from "../../domains/scheduling/budget.js";
import type { OverlayHandle, TUI } from "../../engine/tui.js";
import { isKeyRelease, matchesKey, visibleWidth } from "../../engine/tui.js";
import { buildResponsiveHint, createCachedBody, FocusBox, showClioOverlayFrame, windowRows } from "../overlay-frame.js";
import {
	type Choice,
	chipRows,
	choiceRows,
	clioTheme,
	errorState,
	factRows,
	formatTargetLabel,
	meter,
	positionRow,
	sectionRule,
	type TableSpec,
	tableColumnsFit,
	tableRows,
} from "../theme/index.js";
import { scrollJump } from "./confirm-once.js";

export const FLEET_RUN_APPROVAL_OVERLAY_TITLE = "Fleet run approval";

const FLEET_RUN_APPROVAL_MIN_WIDTH = 48;
const FLEET_RUN_APPROVAL_MAX_WIDTH = 110;
/** Rows of plan shown at once when the frame has not said how many it has. */
export const FLEET_RUN_APPROVAL_VISIBLE_ROWS = 22;
/** Below this width a wave's steps stack as fact blocks instead of table rows. */
const FLEET_RUN_TABLE_MIN_WIDTH = 100;
/** The budget meter never spans more than a reading line. */
const FLEET_RUN_METER_MAX_WIDTH = 72;

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

/** One step as its table cells: id, what runs it, where and how, its scope and boundary. */
function stepCells(step: FleetRunPreviewStep): string[] {
	// `repair repair 1` when the loop is named after its role; one word then.
	const loop =
		step.loop === undefined
			? ""
			: step.loop.loopId === step.loop.role
				? ` (${step.loop.role} ${step.loop.attempt})`
				: ` (${step.loop.loopId} ${step.loop.role} ${step.loop.attempt})`;
	const id = `${step.stepId}${loop}`;
	if (step.replayed === true) return [id, "replay", "prior sealed result, not dispatched", ""];
	const boundary = `${step.scope} · ${formatWriteBoundary(step.writes)}`;
	if (step.kind === "code") {
		const gate = step.gate === undefined ? "" : ` · gate path ${step.gate.path}`;
		const where = step.argv === undefined ? `command ${step.commandId ?? "?"}${gate}` : `${formatArgv(step.argv)}${gate}`;
		return [id, `command ${step.commandId ?? "?"}`, where, boundary];
	}
	const route =
		step.route === undefined
			? "route unresolved"
			: formatTargetLabel(step.route.targetId, step.route.wireModelId, { abbreviate: false });
	const node = step.route === undefined ? "" : ` · node ${step.route.nodeId}`;
	const declaredRoute =
		step.target !== undefined
			? ` · target ${step.target}`
			: step.profile !== undefined
				? ` · profile ${step.profile}`
				: "";
	const gate =
		step.gate !== undefined
			? ` · gate path ${step.gate.path} · run ${"commandId" in step.gate ? step.gate.commandId : "?"} · baseline ${"commandId" in step.gate ? step.gate.commandId : "?"}`
			: "";
	const dynamicPlan =
		step.plan === undefined
			? ""
			: ` · roster ${step.plan.roster.join(", ")} · maxTasks ${step.plan.maxTasks}${step.plan.proposals ? " · proposals" : ""}`;
	return [id, `agent ${step.agentId ?? "?"}`, `${route}${node}${declaredRoute}${gate}${dynamicPlan}`, boundary];
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

/**
 * The budget as a meter of the session ceiling, with the playbook's own
 * ceiling as a fact beneath it. Without a session ceiling there is nothing to
 * fill, so the sentence form stands in.
 */
function budgetRows(preview: FleetRunPreview, width: number): string[] {
	const theme = clioTheme();
	const { budget } = preview;
	const playbook = {
		label: "playbook",
		value: budget.playbookUsd === null ? "declares no ceiling" : `ceiling ${renderUsdLimit(budget.playbookUsd)}`,
	};
	if (budget.ceilingUsd <= 0)
		return factRows(theme, [{ label: "budget", value: formatBudgetLine(preview).slice(8) }, playbook], width);
	const amount = `${budgetSpendText(budget.currentUsd, budget.pricing)} of ${renderUsdLimit(budget.ceilingUsd)} session ceiling`;
	// The amount is the fact. A row too narrow for the label, the amount and a
	// four-cell bar carries the amount as a wrapping fact and no bar at all. A
	// meter wider than a reading line stops being a glance, so the bar caps.
	if (width < "budget ".length + visibleWidth(amount) + 5) {
		return factRows(theme, [{ label: "budget", value: amount }, playbook], width);
	}
	return [
		meter(theme, {
			value: budget.currentUsd,
			max: budget.ceilingUsd,
			width: Math.min(width, FLEET_RUN_METER_MAX_WIDTH),
			label: "budget",
			amount,
			tone:
				budget.currentUsd >= budget.ceilingUsd
					? "error"
					: budget.currentUsd >= budget.ceilingUsd * 0.8
						? "warning"
						: "meter",
		}),
		...factRows(theme, [playbook], width),
	];
}

/** The plan's rows, before windowing: identity, resume, waves and budget. */
function planRows(subject: FleetRunApprovalSubject, width: number): string[] {
	const theme = clioTheme();
	if (!subject.ok) {
		return [
			...errorState(theme, `${subject.name}: preflight failed; nothing will be dispatched`, width),
			...subject.diagnostics.flatMap((diagnostic) =>
				diagnostic.split("\n").flatMap((line) => factRows(theme, [{ label: " ", value: line }], width)),
			),
		];
	}
	const { preview } = subject;
	// The count is of the steps the waves below list, so the header and the rows under it agree.
	const steps = preview.waves.reduce((total, wave) => total + wave.steps.length, 0);
	const rows = [
		...chipRows(
			theme,
			[
				theme.style("heading", preview.name, { bold: true }),
				theme.fg("annotation", `${steps} ${steps === 1 ? "step" : "steps"}`),
			],
			width,
		),
		// The card leads with what approving does; the seal that makes it exact is a footnote under the budget.
		...factRows(
			theme,
			[
				{
					label: "approving",
					value: `dispatches the ${steps === 1 ? "step" : `${steps} steps`} below in ${preview.waves.length} ${preview.waves.length === 1 ? "wave" : "waves"}, exactly as listed; nothing runs until you press Enter`,
					tone: "info",
				},
			],
			width,
		),
	];
	if (preview.resume !== undefined) {
		const replayed = [...preview.resume.replayed.keys()];
		// The workspace is shown so the operator sees which checkout's prefix is replayed.
		const from = `${preview.resume.fromRunId} from ${preview.resume.record.cwd ?? "(unknown workspace)"}`;
		const value =
			replayed.length === 0
				? `${from}: no successful prefix to replay; every step runs`
				: `${from}: replays ${replayed.length} step${replayed.length === 1 ? "" : "s"} (${replayed.join(", ")}), runs the rest`;
		rows.push(...factRows(theme, [{ label: "resumes", value, tone: "info" }], width));
	}
	for (const wave of preview.waves) {
		rows.push(
			sectionRule(theme, width, `wave ${wave.index}`, {
				meta: `${wave.steps.length} step${wave.steps.length === 1 ? "" : "s"}`,
			}),
		);
		const cells = wave.steps.map(stepCells);
		// Nothing about a step may drop out at any width: who runs it, where, and
		// what it may write are the approval. The table is used only when every
		// column fits whole; otherwise each step is a block of facts under its id.
		const table = {
			columns: [
				{ label: "step", priority: 3, tone: "neutral" },
				{ label: "runs", priority: 2, tone: "accent" },
				{ label: "where", priority: 1, wrap: true, min: 16, tone: "muted" },
				{ label: "scope", priority: 0, tone: "muted" },
			],
			rows: cells,
		} satisfies TableSpec;
		if (width >= FLEET_RUN_TABLE_MIN_WIDTH && tableColumnsFit(table, width)) {
			rows.push(...tableRows(theme, table, width));
		} else {
			rows.push(
				...factRows(
					theme,
					cells.map(([id, runs, where, scope]) => ({
						label: id ?? "",
						value: [
							theme.fg("guidance", runs ?? ""),
							theme.fg("annotation", [where, scope].filter(Boolean).join(" · ")),
						].join("\n"),
					})),
					width,
				),
			);
		}
	}
	rows.push(...budgetRows(preview, width));
	rows.push(
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
	return rows;
}

/** What each key does, for the rows under the plan. A failed preflight has one way out. */
function planChoices(subject: FleetRunApprovalSubject): Choice[] {
	if (!subject.ok) return [{ key: "Esc", verb: "leave", consequence: "nothing was dispatched or written" }];
	return [
		{ key: "Enter", verb: "dispatch", consequence: "starts this exact plan now", tone: "action" },
		{ key: "Esc", verb: "cancel", consequence: "dispatches nothing and writes nothing" },
	];
}

/**
 * Render the body: the plan rows windowed to `rows` with the choices pinned
 * beneath them, so the keys and their consequences never scroll away. Zero
 * rows means the frame has not said how many it has.
 */
export function formatFleetRunApprovalBody(
	subject: FleetRunApprovalSubject,
	width: number,
	scroll: number,
	rows = 0,
): string[] {
	const theme = clioTheme();
	const contentWidth = Math.max(1, Math.floor(width));
	const plan = planRows(subject, contentWidth);
	const choices = choiceRows(theme, planChoices(subject), contentWidth);
	const budget = rows > 0 ? Math.max(4, rows - choices.length - 1) : FLEET_RUN_APPROVAL_VISIBLE_ROWS;
	if (plan.length <= budget) return [...plan, ...choices];
	const pane = windowRows(plan, scroll, budget - 1);
	return [
		...pane.window,
		...(pane.position === null ? [] : [positionRow(theme, { ...pane.position, unit: "lines" }, contentWidth)]),
		...choices,
	];
}

export function openFleetRunApprovalOverlay(tui: TUI, options: OpenFleetRunApprovalOverlayOptions): OverlayHandle {
	const acceptable = options.subject.ok;
	let scroll = 0;
	let settled = false;
	const body = createCachedBody((width, rows) => formatFleetRunApprovalBody(options.subject, width, scroll, rows));

	const accept = (): void => {
		if (settled || !acceptable) return;
		settled = true;
		options.onAccept();
	};
	const cancel = (): void => {
		if (settled) return;
		settled = true;
		options.onCancel();
	};
	const scrollBy = (delta: number): void => {
		scroll = Math.max(0, scroll + delta);
		body.touch();
		tui.requestRender();
	};

	const focus = new FocusBox(body, {
		// Keys are matched by name, never by raw bytes: under the kitty keyboard
		// protocol Esc arrives as CSI 27 u, and a byte comparison against "\x1b"
		// left the overlay unanswerable. Everything unmatched is swallowed.
		onInput: (data: string): void => {
			if (settled || isKeyRelease(data)) return;
			const jump = scrollJump(data, scroll);
			if (jump !== null) {
				scrollBy(jump - scroll);
				return;
			}
			if (matchesKey(data, "up")) {
				scrollBy(-1);
				return;
			}
			if (matchesKey(data, "down")) {
				scrollBy(1);
				return;
			}
			if (matchesKey(data, "enter")) {
				accept();
				return;
			}
			if (matchesKey(data, "escape")) cancel();
		},
	});

	const handle = showClioOverlayFrame(tui, focus, {
		anchor: "center",
		width: fleetRunApprovalOverlayWidth(options.columns),
		markerId: "fleet-run-approval",
		title: FLEET_RUN_APPROVAL_OVERLAY_TITLE,
		// A plan that can dispatch is a decision, so the rails carry the approval
		// tone. A failed preflight has nothing to approve and stays informational.
		...(acceptable ? { approval: true, awaitingInput: true, tone: "decisionCue" as const } : {}),
		// The body's own rows name Enter and Esc with what they do. The rail names
		// the way out as well, because a frame short enough to cut those rows
		// would otherwise leave Esc on no surface at all.
		footerHint: buildResponsiveHint([{ key: "↑↓", verb: "scroll" }], {
			key: "Esc",
			verb: acceptable ? "cancel, nothing dispatched" : "leave",
			short: acceptable ? "cancel" : "leave",
		}),
	});

	return {
		...handle,
		hide(): void {
			cancel();
			handle.hide();
		},
	};
}
