#!/usr/bin/env node
/**
 * Interleaved before/after runs of `pnpm tui:bench`.
 *
 * A render bench on a shared host drifts by multiples between runs of the
 * same code, so sequential before and after numbers compare the host's load,
 * not the change. This alternates the two trees run by run and reports the
 * median of each metric across runs, so both sides see the same load.
 *
 *   node --import tsx scripts/tui-bench-ab.ts --before <tree> [--after <tree>] [--runs 5]
 *        [-- <tui:bench flags>]
 *
 * A tree is a checkout with `scripts/tui-dev.ts`, with its
 * own `node_modules` (a symlink farm is enough). `--after` defaults to this
 * checkout.
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

interface Distribution {
	p50: number;
	p99: number;
}
interface FrameSample {
	frameMs: number;
	bytes: number;
	fullRedraw: boolean;
}
interface ScaleResult {
	entries: number;
	mode: string;
	lines: number;
	streaming: { frame: Distribution; panel: Distribution; bytesPerDelta: Distribution; fullRedraws: number };
	keystrokeSettled: { frame: Distribution };
	keystrokeStreaming: { frame: Distribution };
	finalize: FrameSample;
	styleSwitch: FrameSample[];
	styleSwitchWarm?: FrameSample[];
}

function option(name: string, fallback?: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : fallback;
}

const before = option("before");
if (before === undefined) {
	process.stderr.write("usage: tui-bench-ab.ts --before <tree> [--after <tree>] [--runs 5] [-- <bench flags>]\n");
	process.exit(2);
}
const after = option("after", resolve(new URL("..", import.meta.url).pathname)) as string;
const runs = Number(option("runs", "5"));
const passthrough = process.argv.includes("--") ? process.argv.slice(process.argv.indexOf("--") + 1) : [];

function bench(tree: string): ScaleResult[] {
	const result = spawnSync(
		process.execPath,
		["--import", "tsx", "scripts/tui-dev.ts", "bench", "--json", ...passthrough],
		{ cwd: tree, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	);
	if (result.status !== 0) throw new Error(`bench failed in ${tree}: ${result.stderr}`);
	return (JSON.parse(result.stdout) as { results: ScaleResult[] }).results;
}

const collected: Record<"before" | "after", ScaleResult[][]> = { before: [], after: [] };
for (let run = 0; run < runs; run += 1) {
	// Alternate which side goes first so a load trend does not favor one of them.
	const order: Array<"before" | "after"> = run % 2 === 0 ? ["before", "after"] : ["after", "before"];
	for (const side of order) collected[side].push(bench(side === "before" ? resolve(before) : after));
	process.stderr.write(`run ${run + 1}/${runs}\n`);
}

const median = (values: number[]): number => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor((sorted.length - 1) / 2)] ?? Number.NaN;
};

const metrics: Array<[string, (scale: ScaleResult) => number]> = [
	["stream frame p50 ms", (s) => s.streaming.frame.p50],
	["stream frame p99 ms", (s) => s.streaming.frame.p99],
	["panel p50 ms", (s) => s.streaming.panel.p50],
	["key settled p50 ms", (s) => s.keystrokeSettled.frame.p50],
	["key settled p99 ms", (s) => s.keystrokeSettled.frame.p99],
	["key streaming p50 ms", (s) => s.keystrokeStreaming.frame.p50],
	["bytes per delta p50", (s) => s.streaming.bytesPerDelta.p50],
	["finalize ms", (s) => s.finalize.frameMs],
	["finalize bytes", (s) => s.finalize.bytes],
	["finalize full redraw", (s) => (s.finalize.fullRedraw ? 1 : 0)],
	["Alt+O max ms", (s) => Math.max(...s.styleSwitch.map((f) => f.frameMs))],
	["Alt+O max bytes", (s) => Math.max(...s.styleSwitch.map((f) => f.bytes))],
	["Alt+O again max ms", (s) => Math.max(...(s.styleSwitchWarm ?? s.styleSwitch).map((f) => f.frameMs))],
];

const scales = collected.after[0] ?? [];
const rows: string[][] = [["mode", "entries", "metric", "before", "after", "change"]];
for (let index = 0; index < scales.length; index += 1) {
	const scale = scales[index] as ScaleResult;
	for (const [name, pick] of metrics) {
		const b = median(collected.before.map((results) => pick(results[index] as ScaleResult)));
		const a = median(collected.after.map((results) => pick(results[index] as ScaleResult)));
		const change = b === 0 ? "" : `${(((a - b) / b) * 100).toFixed(0)}%`;
		const fmt = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(2));
		rows.push([scale.mode, String(scale.entries), name, fmt(b), fmt(a), change]);
	}
}
const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length))) ?? [];
for (const row of rows)
	process.stdout.write(`${row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ")}\n`);
