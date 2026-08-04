const app = typeof document === "undefined" ? null : document.querySelector("#app");
const state = { cursor: 0, events: [], poll: null, generation: 0, phaseId: null };

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
	const [{ run }, { phases }, { gates }] = await Promise.all([
		api(`/api/runs/${encodeURIComponent(runId)}`),
		api(`/api/runs/${encodeURIComponent(runId)}/phases`),
		api(`/api/runs/${encodeURIComponent(runId)}/gates`),
	]);
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
	const [{ run }, { phases }, { gates }] = await Promise.all([
		api(`/api/runs/${encodeURIComponent(runId)}`),
		api(`/api/runs/${encodeURIComponent(runId)}/phases`),
		api(`/api/runs/${encodeURIComponent(runId)}/gates`),
	]);
	await drainEvents(runId);
	if (generation !== state.generation) return;
	renderRunPage(run, phases, gates);
	if (run.status === "running" || run.status === "queued") scheduleRefresh(runId, generation);
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
	app.innerHTML = runPage(run, phases, state.events, gates, state.phaseId);
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
	return `<a class="run ${statusClass(run.status)}" href="#/run/${encodeURIComponent(run.run_id)}"><i class="status-mark"></i><div><div class="run-id">${escapeHtml(run.run_id)}</div><div class="secondary">${escapeHtml(run.agent)} · ${escapeHtml(run.model)}</div></div><div><div class="status">${escapeHtml(run.status)}</div><div class="secondary">${formatTime(run.started_at)}</div></div><div><div class="metric">${formatTokens(run.total_tokens)}</div><div class="label">tokens</div></div><div><div class="metric">${formatCost(run.total_cost_usd)}</div><div class="label">cost</div></div><div><div class="metric">${escapeHtml(run.node ?? "local")}</div><div class="label">node</div></div></a>`;
}

export function runPage(run, phases, events, gates, selectedPhaseId = null) {
	const span = timeline(phases, events, run.status === "running" || run.status === "queued");
	const selected = phases.find((phase) => phase.phase_id === selectedPhaseId) ?? phases[0] ?? null;
	return `<a class="back" href="#/">← All runs</a><header class="run-head"><div><div class="eyebrow">${escapeHtml(run.status)} · ${formatTime(run.started_at)}</div><h1>${escapeHtml(run.run_id)}</h1><div class="chips"><span class="chip">worker <b>${escapeHtml(run.agent)}</b></span><span class="chip">target <b>${escapeHtml(run.target)}</b></span><span class="chip">model <b>${escapeHtml(run.model)}</b></span><span class="chip">node <b>${escapeHtml(run.node ?? "local")}</b></span></div></div></header><div class="layout"><section class="panel"><div class="panel-title">Run waterfall <small>${formatDuration(span.end - span.start)}</small></div>${waterfall(phases, events, span, selected?.phase_id ?? null)}</section>${costPanel(selected)}</div>${detailPanel(selected, events, gates)}`;
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
		.map(
			(event) =>
				`<i class="tool-tick" style="left:${Math.max(0, Math.min(100, ((Date.parse(event.started_at) - start) / Math.max(1, end - start)) * 100))}%"></i>`,
		)
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

function detailPanel(phase, events, gates) {
	const phaseId = phase?.phase_id ?? null;
	const tools = events.filter((event) => event.type === "tool_call" && event.phase_id === phaseId);
	const phaseGates = gates.filter((gate) => gate.phase_id === phaseId);
	return `<section class="panel detail"><div class="panel-title">Phase detail <small>${tools.length} tool calls · ${phaseGates.length} gates</small></div><div class="detail-grid"><div><div class="eyebrow">Tool spans & attempts</div>${
		tools
			.map((tool) => {
				const payload = parseJson(tool.payload_json) || {};
				return `<article class="event"><div class="event-head"><b>${escapeHtml(tool.name)}</b><span>${formatDuration(Date.parse(tool.ended_at) - Date.parse(tool.started_at))}</span></div><pre>${escapeHtml(JSON.stringify({ args: payload.args, result: payload.result_snippet, ok: payload.ok }, null, 2))}</pre></article>`;
			})
			.join("") || '<div class="empty">No tool calls recorded.</div>'
	}</div><div><div class="eyebrow">Gate evidence</div>${
		phaseGates
			.flatMap((gate) => {
				const checks = parseJson(gate.checks_json);
				return Array.isArray(checks)
					? checks.map(
							(check) =>
								`<div class="check ${check.ok ? "ok" : "fail"}"><i>${check.ok ? "✓" : "✗"}</i><div><b>${escapeHtml(check.item)}</b><small>${escapeHtml(check.note)}</small></div></div>`,
						)
					: [`<div class="empty">${escapeHtml(gate.gate)}: no evidence recorded</div>`];
			})
			.join("") || '<div class="empty">No gates recorded.</div>'
	}</div></div></section>`;
}

function timeline(phases, events, live) {
	const starts = [...phases.map((p) => p.started_at), ...events.map((e) => e.started_at)]
		.filter(Boolean)
		.map(Date.parse);
	const ends = [...phases.map((p) => p.ended_at), ...events.map((e) => e.ended_at)].filter(Boolean).map(Date.parse);
	const start = starts.length ? Math.min(...starts) : Date.now();
	return { start, end: live || ends.length === 0 ? Math.max(...ends, Date.now()) : Math.max(...ends) };
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
function formatTime(value) {
	const date = new Date(value);
	return Number.isNaN(date.valueOf()) ? "unknown" : date.toLocaleString();
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
	if (!response.ok) throw new Error((await response.json()).error ?? `request failed: ${response.status}`);
	return response.json();
}
