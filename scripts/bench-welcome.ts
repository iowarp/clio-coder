/** Isolated render-cost observations, not end-to-end startup or CI thresholds. */
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { iterations: { type: "string", default: "2000" } } });
const iterations = Number(values.iterations);
if (!Number.isInteger(iterations) || iterations <= 0) throw new Error("iterations must be a positive integer");
// Fix the benchmark environment before the shared theme is first constructed.
process.env.TERM = "xterm-256color";
process.env.COLORTERM = "truecolor";
process.env.CLIO_CODER_THEME = "dark";
process.env.CLIO_CODER_SCREEN_READER = "0";
process.env.NO_COLOR = "";
const [
	{ DEFAULT_SETTINGS },
	{ createBootWelcome },
	{ paintWelcomeWordmark, WELCOME_WORDMARK_WIDE },
	{ createClioTheme },
] = await Promise.all([
	import("../src/core/defaults.js"),
	import("../src/interactive/welcome-dashboard.js"),
	import("../src/interactive/welcome-art.js"),
	import("../src/interactive/theme/tokens.js"),
]);

function measure(label: string, render: () => string[]): void {
	for (let index = 0; index < 100; index++) render();
	const started = performance.now();
	let lines: string[] = [];
	for (let index = 0; index < iterations; index++) lines = render();
	const elapsed = performance.now() - started;
	console.log(
		`${label}: ${elapsed.toFixed(2)}ms/${iterations} calls; ${((elapsed / iterations) * 1000).toFixed(2)}µs/call; ${lines.length} rows; ${Buffer.byteLength(lines.join("\n"))} encoded bytes`,
	);
}

for (const demo of [true, false]) {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.interface.demo = demo;
	const label = demo ? "full" : "normal";
	const cached = createBootWelcome(settings, "Enter");
	measure(`${label} cached Stage 0`, () => cached.render(180));
	measure(`${label} fresh Stage 0`, () => createBootWelcome(settings, "Enter").render(180));
}
for (const [label, options] of [
	["truecolor", { color: true, truecolor: true }],
	["indexed", { color: true, truecolor: false }],
	["monochrome", { color: false }],
] as const) {
	const theme = createClioTheme(options);
	measure(`${label} wordmark paint`, () => paintWelcomeWordmark(WELCOME_WORDMARK_WIDE, theme));
}
