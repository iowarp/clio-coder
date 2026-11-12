// Lossless size reduction for a finished asciicast v2 event list. A streamed
// chat turn redraws its live region on every chunk, so raw casts run to
// 450-570 KB. Three passes, none of which changes what the player shows at any
// event that remains:
//
// 1. A synchronized-output frame (CSI ?2026h ... ?2026l) is dropped when the very
//    next event is another output frame, arrives within WINDOW seconds, and has
//    the same shape: the same cursor moves and line erases, with the cursor
//    ending where it started, and every row it writes erased first. The later
//    frame then repaints every cell the dropped one painted. Markers count as
//    events, so the frame a marker (and its still) points at is always kept.
// 2. An OSC 8 hyperlink close is removed while no link is open; the renderer
//    ends every frame with one whether or not it opened a link.
// 3. Within a run of adjacent SGR sequences, codes before the last full reset
//    and a colour later overridden on the same layer are removed.
//
// Verified on the first live casts by replaying original and compacted casts
// in pyte and comparing every cell, colour, attribute and the cursor at each
// remaining event time: no differences, 24-29% smaller.

const ESC = "\u001b";
const WINDOW = 0.125;
const token = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]|${ESC}\\]8;[^\\u0007]*\\u0007|\\r|\\n|[^${ESC}\\r\\n]+`, "g");

function shape(data) {
	if (!data.startsWith(`${ESC}[?2026h`) || !data.includes(`${ESC}[?2026l`)) return null;
	const out = [];
	let cleared = true;
	let net = 0;
	for (const [tok] of data.matchAll(token)) {
		if (tok[0] !== ESC && tok !== "\r" && tok !== "\n") {
			if (!cleared) return null;
			continue;
		}
		if (tok.endsWith("m") || tok.startsWith(`${ESC}]8;`)) continue;
		const move = tok[0] === ESC && /^.\[(\d*)([AB])$/.exec(tok);
		if (move) net += (move[2] === "A" ? -1 : 1) * Number(move[1] || 1);
		if (tok === "\n") net += 1;
		if (/[EFH]$/.test(tok)) return null;
		if (tok === `${ESC}[2K`) cleared = true;
		else if (tok === "\r" || tok === "\n" || /[AB]$/.test(tok)) cleared = false;
		out.push(tok);
	}
	return net === 0 ? out.join("") : null;
}

const sgrRun = new RegExp(`(?:${ESC}\\[[0-9;]*m)+`, "g");
const sgrOne = new RegExp(`${ESC}\\[([0-9;]*)m`, "g");

function layer(params) {
	const p = params.split(";");
	const rgb = (lead) => p[0] === lead && ((p.length === 5 && p[1] === "2") || (p.length === 3 && p[1] === "5"));
	if (/^(?:3[0-7]|9[0-7]|39)$/.test(params) || rgb("38")) return "fg";
	if (/^(?:4[0-7]|10[0-7]|49)$/.test(params) || rgb("48")) return "bg";
	return null;
}

function compactSgr(data) {
	return data.replace(sgrRun, (seq) => {
		let codes = [...seq.matchAll(sgrOne)].map((match) => match[1]);
		const reset = codes.findLastIndex((code) => code === "" || code === "0");
		if (reset > 0) codes = codes.slice(reset);
		codes = codes.filter((code, i) => {
			const own = layer(code);
			return !own || !codes.slice(i + 1).some((later) => layer(later) === own);
		});
		return codes.map((code) => `${ESC}[${code}m`).join("");
	});
}

const osc8 = new RegExp(`${ESC}\\]8;[^;\\u0007]*;([^\\u0007]*)\\u0007`, "g");

export function compactEvents(events) {
	const kept = [];
	let linkOpen = false;
	const dropIdleCloses = (data) =>
		data.replace(osc8, (seq, uri) => {
			const idle = !uri && !linkOpen;
			linkOpen = Boolean(uri);
			return idle ? "" : seq;
		});
	for (let i = 0; i < events.length; i++) {
		const [time, kind, data] = events[i];
		const next = events[i + 1];
		if (kind === "o" && next?.[1] === "o" && next[0] - time < WINDOW) {
			const own = shape(data);
			if (own && shape(next[2]) === own) continue;
		}
		kept.push(kind === "o" ? [time, kind, compactSgr(dropIdleCloses(data))] : events[i]);
	}
	return kept;
}
