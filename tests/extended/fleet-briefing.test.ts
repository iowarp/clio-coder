import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	BRIEFING_MIN_EXCERPT_BYTES,
	BRIEFING_SEPARATOR,
	type BriefingPart,
	buildBriefing,
} from "../../src/domains/context/index.js";

const notice = (omitted: number, total: number): string => `\n[clio: ${omitted} of ${total} bytes omitted]\n`;
const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
const framing: BriefingPart = { kind: "framing", lead: `[council] ${"f".repeat(90)}` };
const task = (body: string): BriefingPart => ({ kind: "task", lead: "[original briefing] ", body });
const seat = (label: string, body: string): BriefingPart => ({ kind: "evidence", lead: `[${label}] `, body });
const failed = (label: string): BriefingPart => ({ kind: "evidence", lead: `[${label}] failed; no answer.` });
const whole = (parts: ReadonlyArray<BriefingPart>): string =>
	parts.map((part) => `${part.lead}${part.body ?? ""}`).join(BRIEFING_SEPARATOR);
/** Each part's rendered text, split back out of the briefing by the leads the caller gave it. */
function rendered(text: string, parts: ReadonlyArray<BriefingPart>): string[] {
	return parts.map((part, index) => {
		const start = text.indexOf(part.lead);
		const next = parts[index + 1];
		const end = next === undefined ? text.length : text.indexOf(`${BRIEFING_SEPARATOR}${next.lead}`, start);
		return text.slice(start, end);
	});
}

describe("fleet briefing builder (ContextFold CF-10)", () => {
	it("keeps parts verbatim at the cap and clips one byte over it", () => {
		const parts = [framing, task("t".repeat(900)), seat("a", "a".repeat(700)), failed("b")];
		const exact = bytes(whole(parts));
		deepStrictEqual(buildBriefing(parts, exact, notice), { text: whole(parts), bytes: exact, clips: [] });
		const over = buildBriefing(parts, exact - 1, notice);
		ok(over.bytes <= exact - 1, `${over.bytes} within ${exact - 1}`);
		strictEqual(over.bytes, bytes(over.text));
		ok(over.clips.length > 0);
	});

	it("counts separators and notices against the cap", () => {
		const parts = Array.from({ length: 12 }, (_, index) => seat(`s${index}`, "x".repeat(200)));
		const content = parts.reduce((sum, part) => sum + bytes(part.lead) + bytes(part.body ?? ""), 0);
		const built = buildBriefing(parts, content, notice);
		ok(built.bytes <= content, "the separators alone overflow a cap sized to the content");
		strictEqual(built.clips.length, parts.length);
		for (const cap of [content - 200, 1_200, 640, 97]) {
			const tight = buildBriefing(parts, cap, notice);
			ok(tight.bytes <= cap, `${tight.bytes} within ${cap}`);
		}
	});

	const rows: ReadonlyArray<{ name: string; parts: BriefingPart[]; cap: number }> = [
		{
			name: "an oversized task beside long answers",
			parts: [framing, task("t".repeat(20_000)), ...["a", "b", "c", "d"].map((label) => seat(label, "e".repeat(3_000)))],
			cap: 8_192,
		},
		{
			name: "five long answers and a failed seat",
			parts: [
				framing,
				task("t".repeat(4_000)),
				failed("c"),
				...["a", "b", "d", "e"].map((label) => seat(label, "e".repeat(9_000))),
			],
			cap: 4_096,
		},
	];
	for (const row of rows) {
		it(`fills framing, then every seat, then the bounded task, then the rest: ${row.name}`, () => {
			const built = buildBriefing(row.parts, row.cap, notice);
			ok(built.bytes <= row.cap);
			const pieces = rendered(built.text, row.parts);
			strictEqual(pieces[0], framing.lead, "framing is whole");
			const evidence = row.parts.flatMap((part, index) => (part.kind === "evidence" ? [index] : []));
			for (const index of evidence) {
				const part = row.parts[index] as BriefingPart;
				strictEqual(built.text.split(part.lead).length, 2, `${part.lead} appears once`);
				const kept = bytes(pieces[index] ?? "") - bytes(part.lead);
				const floor = Math.min(bytes(part.body ?? ""), BRIEFING_MIN_EXCERPT_BYTES);
				ok(kept >= floor - 3, `${part.lead} keeps its minimum excerpt (${kept} of ${floor})`);
			}
			const separators = (row.parts.length - 1) * bytes(BRIEFING_SEPARATOR);
			const floors = evidence.reduce((sum, index) => {
				const part = row.parts[index] as BriefingPart;
				return sum + bytes(part.lead) + Math.min(bytes(part.body ?? ""), BRIEFING_MIN_EXCERPT_BYTES);
			}, 0);
			const afterSeats = row.cap - separators - bytes(framing.lead) - floors;
			ok(bytes(pieces[1] ?? "") <= Math.floor(afterSeats / 2), "the task yields half of what the seats leave");
			ok(
				built.clips.some((clip) => clip.kind === "task" && clip.index === 1),
				"the task's clip is reported",
			);
			for (const clip of built.clips) strictEqual(clip.bytesAfter, bytes(pieces[clip.index] ?? ""));
		});
	}

	it("gives a task the room short answers leave", () => {
		const parts = [framing, task("t".repeat(20_000)), seat("a", "short"), failed("b")];
		const built = buildBriefing(parts, 6_000, notice);
		ok(built.bytes <= 6_000 && built.bytes >= 6_000 - 8, `${built.bytes} fills the cap`);
		deepStrictEqual(
			built.clips.map((clip) => clip.kind),
			["task"],
		);
	});

	it("bounds a round-1 briefing of framing and task alone, under the part's own notice", () => {
		const body = `HEAD${"t".repeat(20_000)}TAIL`;
		const own = (omitted: number, total: number): string => `\n[own: ${omitted} of ${total}]\n`;
		const parts: BriefingPart[] = [framing, { kind: "task", lead: "", body, notice: own }];
		const built = buildBriefing(parts, 4_096, notice);
		ok(built.bytes <= 4_096 && built.bytes >= 4_096 - 8, `${built.bytes} fills the cap`);
		const piece = built.text.slice(`${framing.lead}${BRIEFING_SEPARATOR}`.length);
		ok(piece.startsWith("HEAD") && piece.endsWith("TAIL"), "the task keeps head and tail");
		const match = /\n\[own: (\d+) of (\d+)\]\n/u.exec(piece);
		ok(match && !piece.includes("[clio:"), "the part's notice replaces the default");
		strictEqual(bytes(piece) - bytes(match[0]) + Number(match[1]), bytes(body));
	});

	it("abbreviates head and tail with a notice that accounts for every byte", () => {
		const body = `HEAD${"m".repeat(6_000)}TAIL`;
		const parts = [framing, seat("a", body), seat("b", body)];
		const pieces = rendered(buildBriefing(parts, 2_000, notice).text, parts);
		for (const [index, label] of [
			[1, "a"],
			[2, "b"],
		] as const) {
			const piece = pieces[index] ?? "";
			ok(piece.startsWith(`[${label}] HEAD`) && piece.endsWith("TAIL"), `${label} keeps head and tail`);
			const match = /\n\[clio: (\d+) of (\d+) bytes omitted\]\n/u.exec(piece);
			ok(match, `${label} carries the notice`);
			strictEqual(Number(match[2]), bytes(body));
			strictEqual(bytes(piece) - bytes(`[${label}] `) - bytes(match[0]) + Number(match[1]), bytes(body));
		}
	});

	it("never splits a multibyte character at any cap", () => {
		const parts = [
			framing,
			task("é".repeat(3_000)),
			seat("a", "🌍".repeat(2_000)),
			seat("b", "é".repeat(2_001)),
			failed("c"),
		];
		for (let cap = 2_000; cap < 2_016; cap += 1) {
			const built = buildBriefing(parts, cap, notice);
			ok(built.bytes <= cap);
			ok(!built.text.includes("\uFFFD") && !/[\uD800-\uDFFF]/u.test(built.text), `cap ${cap}`);
			for (const part of parts) ok(built.text.includes(part.lead), `cap ${cap} keeps ${part.lead}`);
		}
		const tiny = buildBriefing(parts, 40, notice);
		ok(tiny.bytes <= 40 && !tiny.text.includes("\uFFFD"), "a cap under the framing still holds");
	});
});
