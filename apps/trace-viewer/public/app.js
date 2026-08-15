const app = typeof document === "undefined" ? null : document.querySelector("#app");
const state = {
	cursor: 0,
	events: [],
	poll: null,
	generation: 0,
	phaseId: null,
	processes: [],
	receipt: null,
	evidence: null,
};

/**
 * Every instant in the mirror was stamped by the orchestrator. A live span is
 * the one number the browser used to contribute, so a machine whose clock is
 * minutes off (a laptop back from sleep, a VM with no NTP) stretched or
 * inverted every running bar on the page.
 *
 * The offset between the two clocks is taken once, from the `Date` header the
 * server already sends on the first API response, and then held: re-reading it
 * every poll would let the header's one-second granularity jitter a live bar
 * back and forth. Until a response has supplied one the offset is zero, so the
 * first paint is no worse than the old behavior.
 */
let clockOffsetMs = 0;
let clockAdopted = false;

/** @internal Exported so a test can render live spans against a known skew. */
export function adoptServerClock(dateHeader, receivedAtMs = Date.now()) {
	const server = Date.parse(dateHeader ?? "");
	if (!Number.isFinite(server)) return clockOffsetMs;
	clockOffsetMs = server - receivedAtMs;
	clockAdopted = true;
	return clockOffsetMs;
}

/** Now, on the server's clock. */
export function serverNow() {
	return Date.now() + clockOffsetMs;
}

if (typeof window !== "undefined") {
	window.addEventListener("hashchange", route);
	route();
}

async function route() {
	if (!app) return;
	const generation = ++state.generation;
	clearTimeout(state.poll);
	state.cursor = 0;
	state.events = [];
	state.phaseId = null;
	state.processes = [];
	state.receipt = null;
	state.evidence = null;
	const match = location.hash.match(/^#\/run\/(.+)$/);
	try {
		if (!match) await renderRuns();
		else await renderRun(decodeURIComponent(match[1]), generation);
	} catch (error) {
		app.innerHTML = `<div class="empty">${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
	}
}

async function renderRuns() {
	if (!app) return;
	const { runs } = await api("/api/runs?limit=100");
	app.innerHTML = `<div class="eyebrow">Durable dispatch mirror</div><div class="title-row"><h1>Recent runs</h1><p>Live and historical activity share one SQLite cursor. Select a run to inspect its phases, tool spans, evidence, and spend.</p></div><section class="runs">${runs.map(runCard).join("") || '<div class="empty">No traced runs yet.</div>'}</section>`;
	if (runs.some((run) => run.status === "running" || run.status === "queued")) state.poll = setTimeout(route, 1000);
}

async function renderRun(runId, generation) {
	if (!app) return;
	const [{ run }, { phases }, { gates }] = await loadRun(runId);
	await drainEvents(runId);
	if (generation !== state.generation) return;
	renderRunPage(run, phases, gates);
	if (run.status === "running" || run.status === "queued") {
		scheduleRefresh(runId, generation);
	}
}

async function refreshRun(runId, generation) {
	if (!app) return;
	if (generation !== state.generation) return;
	const [{ run }, { phases }, { gates }] = await loadRun(runId);
	await drainEvents(runId);
	if (generation !== state.generation) return;
	renderRunPage(run, phases, gates);
	if (run.status === "running" || run.status === "queued") scheduleRefresh(runId, generation);
}

/**
 * The run, its phases, and its gates come from the trace mirror and must
 * succeed. Processes and the sealed receipt are sidecars a copied mirror may
 * simply not have, so a failure there parks an empty panel instead of taking
 * the page down.
 */
async function loadRun(runId) {
	const id = encodeURIComponent(runId);
	const [run, phases, gates, processes, sidecars] = await Promise.all([
		api(`/api/runs/${id}`),
		api(`/api/runs/${id}/phases`),
		api(`/api/runs/${id}/gates`),
		optional(`/api/runs/${id}/processes`, { processes: [] }),
		optional(`/api/runs/${id}/receipt`, { receipt: null, evidence: null }),
	]);
	state.processes = Array.isArray(processes.processes) ? processes.processes : [];
	state.receipt = sidecars.receipt ?? null;
	state.evidence = sidecars.evidence ?? null;
	return [run, phases, gates];
}

async function optional(path, fallback) {
	try {
		return await api(path);
	} catch {
		return fallback;
	}
}

function scheduleRefresh(runId, generation, delay = 500) {
	state.poll = setTimeout(() => {
		void refreshRun(runId, generation).catch((error) => {
			if (generation !== state.generation) return;
			const connection = document.querySelector("#connection");
			if (connection)
				connection.textContent = `mirror unavailable · ${error instanceof Error ? error.message : String(error)}`;
			scheduleRefresh(runId, generation, 1000);
		});
	}, delay);
}

function renderRunPage(run, phases, gates) {
	if (!app) return;
	const selected = phases.find((phase) => phase.phase_id === state.phaseId) ?? phases[0] ?? null;
	state.phaseId = selected?.phase_id ?? null;
	app.innerHTML = runPage(
		run,
		phases,
		state.events,
		gates,
		state.phaseId,
		state.processes,
		state.receipt,
		state.evidence,
	);
	for (const block of app.querySelectorAll("[data-phase-id]")) {
		block.addEventListener("click", () => {
			state.phaseId = block.getAttribute("data-phase-id");
			renderRunPage(run, phases, gates);
		});
	}
}

async function drainEvents(runId) {
	let more;
	do {
		const page = await api(`/api/runs/${encodeURIComponent(runId)}/events?after=${state.cursor}&limit=500`);
		state.events.push(...page.events);
		state.cursor = page.cursor;
		more = page.hasMore;
	} while (more);
}

function runCard(run) {
	const duration = runDuration(run);
	const request = typeof run.request === "string" && run.request.length > 0 ? run.request : null;
	return `<a class="run ${statusClass(run.status)}" href="#/run/${encodeURIComponent(run.run_id)}"><i class="status-mark"></i><div><div class="run-id">${escapeHtml(run.run_id)}</div>${request === null ? "" : `<div class="run-task" title="${escapeHtml(request)}">${escapeHtml(request)}</div>`}<div class="secondary">${escapeHtml(run.agent)} · ${escapeHtml(run.model)}</div></div><div><div class="status">${escapeHtml(run.status)}</div><div class="secondary">${formatTime(run.started_at)}</div><div class="secondary">${duration === null ? "" : formatDuration(duration)}</div></div><div><div class="metric">${formatTokens(run.total_tokens)}</div><div class="label">tokens</div></div><div><div class="metric">${formatCost(run.total_cost_usd)}</div><div class="label">cost</div></div><div><div class="metric">${escapeHtml(run.node ?? "local")}</div><div class="label">node</div></div></a>`;
}

export function runPage(
	run,
	phases,
	events,
	gates,
	selectedPhaseId = null,
	processes = [],
	receipt = null,
	evidence = null,
) {
	const span = timeline(phases, events, run.status === "running" || run.status === "queued");
	const selected = phases.find((phase) => phase.phase_id === selectedPhaseId) ?? phases[0] ?? null;
	return `<a class="back" href="#/">← All runs</a><header class="run-head"><div>${runHeadline(run)}</div></header><div class="layout"><section class="panel"><div class="panel-title">Run waterfall <small>${formatDuration(span.end - span.start)}</small></div>${waterfall(phases, events, span, selected?.phase_id ?? null)}</section>${costPanel(selected)}</div>${detailPanel(selected, events, gates, span.start)}${processPanel(processes)}${receiptPanel(receipt, evidence)}`;
}

function runHeadline(run) {
	const duration = runDuration(run);
	const request = typeof run.request === "string" && run.request.length > 0 ? run.request : null;
	const chips = [
		`<span class="chip">worker <b>${escapeHtml(run.agent)}</b></span>`,
		`<span class="chip">target <b>${escapeHtml(run.target)}</b></span>`,
		`<span class="chip">model <b>${escapeHtml(run.model)}</b></span>`,
		run.runtime ? `<span class="chip">runtime <b>${escapeHtml(run.runtime)}</b></span>` : "",
		`<span class="chip">node <b>${escapeHtml(run.node ?? "local")}</b></span>`,
		run.assignment_id && run.assignment_id !== run.run_id
			? `<span class="chip">assignment <b>${escapeHtml(run.assignment_id)}</b></span>`
			: "",
	];
	const timing = `${formatTime(run.started_at)}${run.ended_at ? ` → ${formatTime(run.ended_at)}` : " → live"}${duration === null ? "" : ` · ${formatDuration(duration)}`}`;
	return `<div class="eyebrow">${escapeHtml(run.status)} · ${escapeHtml(timing)}</div><h1>${escapeHtml(run.run_id)}</h1>${request === null ? "" : `<p class="task" title="${escapeHtml(request)}">${escapeHtml(request)}</p>`}<div class="chips">${chips.join("")}</div>`;
}

/** Wall clock for the run; a live run measures against now, as the waterfall does. */
function runDuration(run) {
	const start = Date.parse(run.started_at);
	if (!Number.isFinite(start)) return null;
	const end = run.ended_at ? Date.parse(run.ended_at) : serverNow();
	return Number.isFinite(end) ? Math.max(0, end - start) : null;
}

function waterfall(phases, events, span, selectedPhaseId) {
	const duration = Math.max(1, span.end - span.start);
	const lanes = new Map();
	for (const phase of phases) {
		const key = `${phase.kind}:${phase.owner}`;
		if (!lanes.has(key)) lanes.set(key, { kind: phase.kind, owner: phase.owner, phases: [] });
		lanes.get(key).phases.push(phase);
	}
	return `<div class="waterfall"><div class="axis"><span></span><div class="ticks"><span>0</span><span>${formatDuration(duration * 0.25)}</span><span>${formatDuration(duration * 0.5)}</span><span>${formatDuration(duration * 0.75)}</span><span>${formatDuration(duration)}</span></div></div>${[...lanes.values()].map((lane) => `<div class="lane"><div class="lane-label"><b>${escapeHtml(lane.owner)}</b><span>${escapeHtml(lane.kind)}</span></div><div class="track">${lane.phases.map((phase) => phaseBlock(phase, events, span, phase.phase_id === selectedPhaseId)).join("")}</div></div>`).join("") || '<div class="empty">No phases recorded.</div>'}</div>`;
}

function phaseBlock(phase, events, span, selected) {
	if (!phase.started_at)
		return `<button type="button" data-phase-id="${escapeHtml(phase.phase_id)}" class="phase queued ${selected ? "selected" : ""}"><span>${escapeHtml(phase.name)} · queued</span></button>`;
	const start = Date.parse(phase.started_at);
	const end = phase.ended_at ? Date.parse(phase.ended_at) : span.end;
	const total = Math.max(1, span.end - span.start);
	const left = Math.max(0, Math.min(99, ((start - span.start) / total) * 100));
	const width = Math.max(1, Math.min(100 - left, ((end - start) / total) * 100));
	const tools = events
		.filter((event) => event.phase_id === phase.phase_id && event.type === "tool_call")
		.map((event) => {
			const ok = parseJson(event.payload_json)?.ok;
			const verdict = ok === true ? "ok" : ok === false ? "failed" : "unknown";
			return `<i class="tool-tick ${verdict}" style="left:${Math.max(0, Math.min(100, ((Date.parse(event.started_at) - start) / Math.max(1, end - start)) * 100))}%"></i>`;
		})
		.join("");
	return `<button type="button" data-phase-id="${escapeHtml(phase.phase_id)}" class="phase ${statusClass(phase.status)} ${selected ? "selected" : ""}" style="left:${left}%;width:${width}%" title="${escapeHtml(phase.name)}"><span>${escapeHtml(phase.name)} · try ${Number(phase.attempt) + 1}</span>${tools}</button>`;
}

function costPanel(phase) {
	const p = phase ?? {};
	const rows = [
		["Input", p.input_tokens, p.input_cost_usd],
		["Output", p.output_tokens, p.output_cost_usd],
		["↳ reasoning", p.reasoning_tokens, null, "reason"],
		["Cache read", p.cache_read_tokens, p.cache_read_cost_usd],
		["Cache write", p.cache_write_tokens, p.cache_write_cost_usd],
	];
	const hasContext =
		Number.isFinite(p.context_tokens) &&
		p.context_tokens >= 0 &&
		Number.isFinite(p.context_window) &&
		p.context_window > 0;
	const context = !hasContext
		? ""
		: `<div class="context"><div class="cost-row"><span>Context occupancy</span><b>${formatTokens(p.context_tokens)}</b><span>${Math.round((p.context_tokens / p.context_window) * 100)}%</span></div><div class="context-bar"><i style="width:${Math.min(100, (p.context_tokens / p.context_window) * 100)}%"></i></div></div>`;
	return `<aside class="panel"><div class="panel-title">Spend <small>reasoning ⊂ output</small></div><div class="cost">${rows.map(([name, tokens, cost, klass]) => `<div class="cost-row ${klass ?? ""}"><span>${name}</span><b>${tokens == null ? '<em class="not-recorded">not recorded</em>' : formatTokens(tokens)}</b><span>${cost == null ? '<em class="not-recorded">not recorded</em>' : formatCost(cost)}</span></div>`).join("")}<div class="cost-row total"><span>Total</span><b>${formatTokens(p.total_tokens)}</b><span>${formatCost(p.total_cost_usd)}</span></div></div>${context}</aside>`;
}

function detailPanel(phase, events, gates, runStart) {
	const phaseId = phase?.phase_id ?? null;
	const phaseEvents = events.filter((event) => event.phase_id === phaseId);
	const tools = phaseEvents.filter((event) => event.type === "tool_call");
	const phaseGates = gates.filter((gate) => gate.phase_id === phaseId);
	return `<section class="panel detail"><div class="panel-title">Phase detail <small>${phaseEvents.length} events · ${tools.length} tool calls · ${phaseGates.length} gates</small></div>${phaseFacts(phase)}<div class="detail-grid"><div><div class="eyebrow">Event log</div>${
		phaseEvents.map((event) => eventRow(event, runStart)).join("") ||
		'<div class="empty">No events recorded for this phase.</div>'
	}</div><div><div class="eyebrow">Gate evidence</div>${
		phaseGates.map(gateBlock).join("") || '<div class="empty">No gates recorded.</div>'
	}</div></div></section>`;
}

/** Description, failure reason, and retry count: the phase facts the waterfall bar cannot carry. */
function phaseFacts(phase) {
	if (!phase) return "";
	const retries = Number(phase.retries);
	const rows = [
		phase.description ? `<div class="fact"><span>description</span><b>${escapeHtml(phase.description)}</b></div>` : "",
		Number.isFinite(retries) && retries > 0
			? `<div class="fact"><span>retries</span><b>${escapeHtml(retries)}</b></div>`
			: "",
		phase.error ? `<div class="fact error"><span>error</span><b>${escapeHtml(phase.error)}</b></div>` : "",
	].join("");
	return rows === "" ? "" : `<div class="facts">${rows}</div>`;
}

function eventRow(event, runStart) {
	const payload = parseJson(event.payload_json) || {};
	const started = Date.parse(event.started_at);
	const offset = Number.isFinite(started) && Number.isFinite(runStart) ? `+${formatDuration(started - runStart)}` : "";
	const duration = event.ended_at ? formatDuration(Date.parse(event.ended_at) - started) : "";
	const tokens = event.tokens == null ? "" : `${formatTokens(event.tokens)} tok`;
	const failed =
		event.type === "tool_call" ? payload.ok === false : event.type === "error" || event.type === "gate_fail";
	const meta = [duration, tokens].filter(Boolean).join(" · ");
	return `<article class="event ${failed ? "failed" : ""}"><div class="event-head"><span class="offset">${escapeHtml(offset)}</span><span class="badge ${escapeHtml(typeClass(event.type))}">${escapeHtml(event.type)}</span><b>${escapeHtml(event.name)}</b><span>${escapeHtml(meta)}</span></div>${eventSummary(event.type, payload)}<details><summary>payload</summary><pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre></details></article>`;
}

/**
 * One summary block per event type, keyed to the payloads the trace store and
 * the session turn writer actually persist. A payload the writer had to clip
 * says so rather than presenting its snippet as the whole record.
 */
function eventSummary(type, payload) {
	if (payload.truncated === true) {
		return facts([
			["truncated", "payload exceeded the trace limit; snippet only"],
			["snippet", payload.snippet],
		]);
	}
	if (type === "tool_call") {
		return facts([
			["tool", payload.tool],
			["agent", payload.agent],
			["ok", payload.ok],
			["outcome", payload.outcome],
			["blocked", payload.block_reason],
			["took", payload.duration_ms == null ? null : formatDuration(payload.duration_ms)],
			["args", payload.args],
			["result", payload.result_snippet ?? payload.result_summary],
		]);
	}
	if (type === "message") {
		return facts([
			["text", payload.text],
			["stop", payload.stopReason],
			["model", payload.model],
			["tool calls", payload.toolCalls],
		]);
	}
	if (type === "log") {
		return facts([
			["role", payload.role],
			["stop", payload.stopReason],
			["model", payload.model],
			["usage", payload.usage],
		]);
	}
	if (type === "handoff") {
		return facts([
			["attempt", payload.attempt],
			["status", payload.status],
			["reason", payload.reason],
			["previous run", payload.previousRunId],
			["level", payload.level],
			["due", payload.dueAt],
		]);
	}
	if (type === "error") {
		return facts([
			["reason", payload.reason],
			["detail", payload.detail],
			["agent", payload.agent],
		]);
	}
	if (type === "agent_start") {
		return facts([
			["target", payload.target],
			["model", payload.model],
			["runtime", payload.runtime],
		]);
	}
	if (type === "agent_end") {
		return facts([
			["outcome", payload.outcome],
			["detail", payload.outcomeDetail],
			["status", payload.status],
			["error", payload.error],
			["usage", payload.usage],
			["cost", payload.cost == null ? null : formatCost(payload.cost)],
			["context window", payload.contextWindow == null ? null : formatTokens(payload.contextWindow)],
		]);
	}
	if (type === "phase_end") return facts([["status", payload.status]]);
	if (type === "gate_pass" || type === "gate_fail") {
		return facts([
			["attempt", payload.attempt],
			["checks", payload.checks],
			["violations", payload.violations],
		]);
	}
	return facts(Object.keys(payload).map((key) => [key, payload[key]]));
}

function facts(rows) {
	const html = rows.map(([label, value]) => fact(label, value)).join("");
	return html === "" ? "" : `<div class="facts">${html}</div>`;
}

function fact(label, value) {
	const text = displayValue(value);
	if (text === null) return "";
	return `<div class="fact"><span>${escapeHtml(label)}</span><b>${escapeHtml(text)}</b></div>`;
}

/** Renders a payload value as one bounded line, or null when there is nothing to say. */
function displayValue(value, max = 400) {
	if (value === null || value === undefined) return null;
	if (typeof value === "string") return value.length === 0 ? null : truncate(value, max);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) {
		if (value.length === 0) return null;
		if (value.every((item) => item === null || typeof item !== "object")) return truncate(value.join(", "), max);
	}
	const json = JSON.stringify(value);
	return json === undefined ? null : truncate(json, max);
}

function truncate(value, max) {
	const text = String(value).replace(/\s+/g, " ").trim();
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function gateBlock(gate) {
	const passed = gate.passed == null ? null : Number(gate.passed) === 1;
	const violations = parseJson(gate.violations_json);
	const checks = parseJson(gate.checks_json);
	const verdict =
		passed === null
			? '<span class="verdict">no verdict</span>'
			: `<span class="verdict ${passed ? "ok" : "fail"}">${passed ? "passed" : "failed"}</span>`;
	const meta = [gate.attempt == null ? "" : `attempt ${escapeHtml(gate.attempt)}`, formatTime(gate.created_at)]
		.filter(Boolean)
		.join(" · ");
	const violationRows = Array.isArray(violations)
		? violations.map((item) => `<div class="check fail"><i>✗</i><div><b>${escapeHtml(item)}</b></div></div>`).join("")
		: "";
	const checkRows = Array.isArray(checks)
		? checks
				.map(
					(check) =>
						`<div class="check ${check.ok ? "ok" : "fail"}"><i>${check.ok ? "✓" : "✗"}</i><div><b>${escapeHtml(check.item)}</b><small>${escapeHtml(check.note)}</small></div></div>`,
				)
				.join("")
		: `<div class="empty">${escapeHtml(gate.gate)}: no evidence recorded</div>`;
	return `<div class="gate"><div class="gate-head"><b>${escapeHtml(gate.gate)}</b>${verdict}<span>${meta}</span></div>${violationRows}${checkRows}</div>`;
}

function processPanel(processes) {
	const rows = Array.isArray(processes) ? processes : [];
	const live = rows.filter((row) => !row.ended_at).length;
	return `<section class="panel detail"><div class="panel-title">Processes <small>${rows.length} recorded · ${live} live</small></div><div class="rows">${
		rows
			.map((row) => {
				const command = typeof row.command === "string" ? row.command : "";
				const span = `${formatTime(row.started_at)}${row.ended_at ? ` → ${formatTime(row.ended_at)}` : ""}`;
				return `<div class="process ${row.ended_at ? "ended" : "live"}"><div class="process-head"><b>${escapeHtml(row.kind ?? "process")}</b><span>${escapeHtml(row.name ?? "")}</span><span>pid ${escapeHtml(row.pid ?? "unknown")}</span><span class="verdict ${row.ended_at ? "" : "ok"}">${row.ended_at ? "ended" : "live"}</span><span>${escapeHtml(span)}</span></div>${command === "" ? "" : `<div class="command" title="${escapeHtml(command)}">${escapeHtml(truncate(command, 220))}</div>`}</div>`;
			})
			.join("") || '<div class="empty">No processes recorded.</div>'
	}</div></section>`;
}

/**
 * Provenance from the sealed receipt and the evidence sidecar. Every section
 * is omitted when its fields are absent: a receipt written by an older Clio,
 * or a run that never reached the stage that seals a field, must read as
 * silence rather than as "undefined".
 */
function receiptPanel(receipt, evidence) {
	if (receipt === null || typeof receipt !== "object") {
		return `<section class="panel detail"><div class="panel-title">Receipt</div><div class="empty">No sealed receipt was found for this run.</div>${
			evidence === null || evidence === undefined ? "" : `<div class="receipt">${findingsSection(null, evidence)}</div>`
		}</section>`;
	}
	const usage = [
		["input", receipt.inputTokenCount],
		["output", receipt.outputTokenCount],
		["cache read", receipt.cacheReadTokenCount],
		["cache write", receipt.cacheWriteTokenCount],
		["reasoning", receipt.reasoningTokenCount],
	].map(([label, value]) => [label, value == null ? null : formatTokens(value)]);
	const sections = [
		section(
			"Outcome",
			facts([
				["outcome", receipt.outcome],
				["code", receipt.outcomeCode],
				["detail", receipt.outcomeDetail],
				["exit code", receipt.exitCode],
				["failure", receipt.failureMessage],
			]),
		),
		section(
			"Verification",
			facts([
				["state", receipt.verification?.state],
				["basis", receipt.verification?.basis],
			]),
		),
		section(
			"Spend",
			facts([
				["cost", receipt.costUsd == null ? null : formatCost(receipt.costUsd)],
				["provenance", receipt.costProvenance],
				["tokens", receipt.tokenCount == null ? null : formatTokens(receipt.tokenCount)],
				...usage,
			]),
		),
		section("Tools", toolStatsTable(receipt)),
		section("Safety", facts(scalarEntries(receipt.safety))),
		findingsSection(receipt.findingsSummary ?? null, evidence),
		section("Provenance", provenanceFacts(receipt)),
	].join("");
	return `<section class="panel detail"><div class="panel-title">Receipt <small>${escapeHtml(receipt.integrity?.digest ? `${String(receipt.integrity.digest).slice(0, 12)}…` : "unsealed")}</small></div><div class="receipt">${sections}</div></section>`;
}

function section(title, html) {
	return html === "" ? "" : `<div class="receipt-section"><div class="eyebrow">${escapeHtml(title)}</div>${html}</div>`;
}

function toolStatsTable(receipt) {
	const stats = Array.isArray(receipt.toolStats) ? receipt.toolStats : [];
	const activity = facts(scalarEntries(receipt.toolActivity));
	if (stats.length === 0) return activity;
	const rows = stats
		.map(
			(stat) =>
				`<tr><td>${escapeHtml(stat.tool)}</td><td>${escapeHtml(stat.count)}</td><td class="ok">${escapeHtml(stat.ok)}</td><td class="fail">${escapeHtml(stat.errors)}</td><td>${escapeHtml(stat.blocked)}</td><td>${escapeHtml(formatDuration(stat.totalDurationMs))}</td></tr>`,
		)
		.join("");
	return `<table class="tools"><thead><tr><th>tool</th><th>calls</th><th>ok</th><th>errors</th><th>blocked</th><th>time</th></tr></thead><tbody>${rows}</tbody></table>${activity}`;
}

/**
 * The receipt's cheap summary and the evidence sidecar are computed from
 * different inputs and are allowed to disagree on first-pass success. Both are
 * shown when they do; picking one would hide the disagreement.
 */
function findingsSection(summary, evidence) {
	const row = evidence === null || evidence === undefined || typeof evidence !== "object" ? null : evidence;
	const disagrees =
		summary !== null && row !== null && summary.firstPassSuccess !== undefined && row.firstPassSuccess !== undefined
			? summary.firstPassSuccess !== row.firstPassSuccess
			: false;
	return section(
		"Findings",
		facts([
			["tags", summary?.tags],
			["findings", summary?.findingCount],
			[disagrees ? "first pass (receipt)" : "first pass", summary?.firstPassSuccess],
			["evidence id", row?.evidenceId],
			["evidence tags", row?.tags],
			["evidence findings", row?.findingCount],
			["first pass (evidence)", row?.firstPassSuccess],
		]),
	);
}

function provenanceFacts(receipt) {
	return facts([
		["clio", receipt.clioVersion],
		["platform", receipt.platform],
		["node", receipt.nodeVersion],
		["runtime kind", receipt.runtimeKind],
		["skills", Array.isArray(receipt.skillActivations) ? receipt.skillActivations.length : null],
		...scalarEntries(receipt.integrity),
		...scalarEntries(receipt.lineage, "lineage."),
		...scalarEntries(receipt.node, "node."),
		...scalarEntries(receipt.gate, "gate."),
		...scalarEntries(receipt.plan, "plan."),
		...scalarEntries(receipt.pipeline, "pipeline."),
		["reroutes", Array.isArray(receipt.reroutes) ? receipt.reroutes : null],
	]);
}

/**
 * Scalar leaves of an object, one level of nesting flattened into dotted keys.
 * Receipt sub-objects gain fields between versions, so the panel reads what is
 * there instead of asking for a fixed list.
 */
function scalarEntries(value, prefix = "") {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
	const rows = [];
	for (const [key, item] of Object.entries(value)) {
		if (item === null || item === undefined) continue;
		if (typeof item === "object") {
			if (!Array.isArray(item)) rows.push(...scalarEntries(item, `${prefix}${key}.`));
			continue;
		}
		rows.push([`${prefix}${key}`, item]);
	}
	return rows;
}

function typeClass(type) {
	if (type === "error" || type === "gate_fail") return "bad";
	if (type === "gate_pass") return "good";
	if (type === "tool_call") return "tool";
	return "neutral";
}

function timeline(phases, events, live) {
	const starts = [...phases.map((p) => p.started_at), ...events.map((e) => e.started_at)]
		.filter(Boolean)
		.map(Date.parse);
	const ends = [...phases.map((p) => p.ended_at), ...events.map((e) => e.ended_at)].filter(Boolean).map(Date.parse);
	const start = starts.length ? Math.min(...starts) : serverNow();
	return { start, end: live || ends.length === 0 ? Math.max(...ends, serverNow()) : Math.max(...ends) };
}
function parseJson(value) {
	try {
		return value ? JSON.parse(value) : null;
	} catch {
		return null;
	}
}
function statusClass(status) {
	return ["queued", "running", "success", "fail"].includes(status) ? status : "fail";
}
function formatTokens(value) {
	return value == null ? "not recorded" : Number(value).toLocaleString("en-US");
}
function formatCost(value) {
	return value == null ? "not recorded" : `$${Number(value).toFixed(Number(value) < 0.01 ? 4 : 2)}`;
}
// Pinned rather than defaulted: the CLI renders `YYYY-MM-DD` (en-CA) and
// `HH:MM:SS` (en-GB, h23) and an operator reads the two surfaces side by side.
// A bare toLocaleString() would render the same instant differently per browser.
const VIEWER_DATE = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" });
const VIEWER_CLOCK = new Intl.DateTimeFormat("en-GB", {
	hourCycle: "h23",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
});
function formatTime(value) {
	const date = new Date(value);
	return Number.isNaN(date.valueOf()) ? "unknown" : `${VIEWER_DATE.format(date)} ${VIEWER_CLOCK.format(date)}`;
}
function formatDuration(value) {
	const ms = Math.max(0, Number(value) || 0);
	return ms < 1000
		? `${Math.round(ms)}ms`
		: ms < 60000
			? `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`
			: `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}
export function escapeHtml(value) {
	return String(value ?? "").replace(
		/[&<>"']/g,
		(char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
	);
}
async function api(path) {
	const response = await fetch(path, { headers: { accept: "application/json" } });
	if (!clockAdopted) adoptServerClock(response.headers.get("date"));
	if (!response.ok) throw new Error((await response.json()).error ?? `request failed: ${response.status}`);
	return response.json();
}
