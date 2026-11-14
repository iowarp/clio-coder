#!/usr/bin/env node
// Turns a hand-driven asciicast v2 take into the site's recording, its stills and
// a README GIF. Scenarios with `"animation": true` in scenarios.json describe
// them: run.mjs does not drive these, because they need the maintainer's own
// subscription logins in a scratch home that a published harness must not hold.
// The take is recorded with `asciinema rec -f asciicast-v2 --window-size COLSxROWS`
// in a real terminal pane, then finished here:
//
//   node site/capture/animation.mjs --scratch <dir> --id <scenario> --raw <take.cast> --version <x.y.z> [--publish]
//
// Idle gaps are capped like run.mjs does, markers are placed where their `match`
// text first appears in the output (`nth` for a later one), the take ends `hold`
// seconds after the `endAt` marker, and compact.mjs shrinks it losslessly. The
// still, the transcript (the terminal's text at each marker, read from the site's
// own player) and the GIF (agg, with the scenario's theme) come from that cast.
// The GIF must stay within about 20 s and 2 MB. Without --publish everything stays
// in <scratch>/<id>/out; --publish copies the cast, transcript and stills into
// site/, the GIF into assets/animations/ with its media-manifest.json entry, and
// the registry entry into content/captures.json. Every figure in the alt and
// caption goes through alt-check.mjs first.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { altCheck, printAltCheck } from "./alt-check.mjs";
import { compactEvents } from "./compact.mjs";
import { plain, privacyHits, scanChunks } from "./privacy.mjs";
import { renderStills } from "./stills.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const site = dirname(here);
const repo = dirname(site);
const { values } = parseArgs({
	options: {
		scratch: { type: "string" },
		id: { type: "string" },
		raw: { type: "string" },
		version: { type: "string" },
		publish: { type: "boolean", default: false },
		chrome: { type: "string", default: process.env.CLIO_CODER_CHROME ?? "/usr/bin/google-chrome" },
	},
});
for (const name of ["scratch", "id", "raw", "version"]) if (!values[name]) throw new Error(`--${name} is required.`);
const spec = JSON.parse(readFileSync(join(here, "scenarios.json"), "utf8"));
const scenario = spec.scenarios.find((item) => item.id === values.id && item.animation);
if (!scenario) throw new Error(`${values.id} is not an animation scenario in scenarios.json.`);
const scratch = resolve(values.scratch);
const outDir = join(scratch, scenario.id, "out");
mkdirSync(outDir, { recursive: true });
const run = (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const secrets = [
	process.env.LITELLM_API_KEY,
	process.env.CLIO_CAPTURE_GATEWAY_URL,
	process.env.CLIO_CAPTURE_GATEWAY_URL && new URL(process.env.CLIO_CAPTURE_GATEWAY_URL).host,
	userInfo().username,
	homedir(),
	hostname(),
	scratch,
];

// Idle gaps capped as run.mjs does; the raw clock is kept to place markers.
const [, ...lines] = readFileSync(resolve(values.raw), "utf8").trimEnd().split("\n");
const events = lines.map((line) => JSON.parse(line)).filter(([, kind]) => kind === "o" || kind === "r");
let shift = 0;
let last = 0;
for (const event of events) {
	const gap = event[0] - last;
	if (gap > spec.idleCap) shift += gap - spec.idleCap;
	last = event[0];
	event[0] = Math.round((event[0] - shift) * 1e6) / 1e6;
}

// A marker sits at the event where its text first completes in the output stream.
let stream = "";
const markers = scenario.markers.map((marker) => ({ ...marker, found: false }));
const ends = new Set();
for (const [index, event] of events.entries()) {
	if (event[1] !== "o") continue;
	stream += plain(event[2]);
	for (const marker of markers) {
		if (marker.found) continue;
		const count = stream.split(marker.match).length - 1;
		if (count >= (marker.nth ?? 1)) {
			marker.found = true;
			marker.index = index;
			marker.time = Math.round((event[0] + 0.05) * 1000) / 1000;
		}
	}
	ends.add(index);
}
const missing = markers.filter((marker) => !marker.found).map((marker) => marker.label);
if (missing.length) throw new Error(`${scenario.id}: markers never reached: ${missing.join(", ")}`);
const end = markers.find((marker) => marker.label === scenario.endAt);
if (!end) throw new Error(`${scenario.id}: endAt ${scenario.endAt} is not a marker.`);
const kept = events.slice(0, end.index + 1);
const stop = kept.at(-1)[0];
// A silent event holds the last frame for the player and for agg.
kept.push([Math.round((stop + (scenario.hold ?? 2.5)) * 1e6) / 1e6, "o", ""]);
const cutMarkers = markers.filter((marker) => marker.index <= end.index);
const all = compactEvents(
	[...kept, ...cutMarkers.map((marker) => [marker.time, "m", marker.label])].sort((a, b) => a[0] - b[0]),
);
const header = { version: 2, width: scenario.cols, height: scenario.rows, theme: spec.theme };
const castText = `${[JSON.stringify(header), ...all.map((event) => JSON.stringify(event))].join("\n")}\n`;
const duration = all.at(-1)[0];

const hits = [
	...scanChunks(
		kept.map(([, , data]) => plain(data)),
		secrets,
	),
	...scanChunks(
		kept.map(([, , data]) => data),
		secrets,
	),
	...privacyHits([JSON.stringify(header), ...cutMarkers.map((marker) => marker.label)].join("\n"), secrets),
];
if (hits.length) throw new Error(`${scenario.id}: privacy scan failed: ${[...new Set(hits)].join("; ")}`);
writeFileSync(join(outDir, `${scenario.id}.cast`), castText);

// Stills and per-marker terminal text, from the same player the site embeds.
const poster = cutMarkers.find((marker) => marker.label === scenario.poster);
if (!poster) throw new Error(`${scenario.id}: the poster marker ${scenario.poster} was not reached.`);
const frames = cutMarkers.map((marker) => ({ id: marker.label, time: marker.time, rows: scenario.rows }));
const rendered = await renderStills(
	castText,
	[{ id: scenario.id, time: poster.time, rows: scenario.rows }, ...frames],
	outDir,
	values.chrome,
);
const chapters = rendered.slice(1).map(({ id, text }) => {
	const body = text.map((line) => line.trimEnd());
	while (body.length && !body.at(-1)) body.pop();
	return `== ${id}\n\n${body.join("\n")}`;
});
const transcript = `${scenario.title}\nRecorded with CLIO Coder ${values.version}. Each section is the terminal screen at that moment.\n\n${chapters.join("\n\n")}\n`;
const transcriptHits = privacyHits(transcript, secrets);
if (transcriptHits.length)
	throw new Error(`${scenario.id}: privacy scan failed on the transcript: ${transcriptHits.join("; ")}`);
writeFileSync(join(outDir, `${scenario.id}.txt`), transcript);
const main = rendered[0];
run("python3", [
	"-c",
	"import sys;from PIL import Image;Image.open(sys.argv[1]).save(sys.argv[2],'WEBP',quality=90,method=6)",
	main.path,
	main.path.replace(/\.png$/, ".webp"),
]);

// The README GIF, from the finished cast, with the scenario's theme (carried by its header).
const gif = join(outDir, `${scenario.id}.gif`);
const gifSpec = scenario.gif ?? {};
run("agg", [
	"--speed",
	String(gifSpec.speed ?? 1),
	"--fps-cap",
	String(gifSpec.fps ?? 15),
	"--font-size",
	String(gifSpec.fontSize ?? 16),
	"--last-frame-duration",
	"3",
	join(outDir, `${scenario.id}.cast`),
	gif,
]);
const gifBytes = statSync(gif).size;
const gifSeconds = Math.round(((duration - spec.idleCap) / (gifSpec.speed ?? 1) + 3) * 10) / 10;
const gifSize = readFileSync(gif);
const gifWidth = gifSize.readUInt16LE(6);
const gifHeight = gifSize.readUInt16LE(8);
console.log(
	`${scenario.id}: cast ${Math.round(duration)}s ${castText.length} B, gif ${gifWidth}x${gifHeight} ${gifBytes} B, about ${gifSeconds}s`,
);
if (gifBytes > 2_000_000) throw new Error(`${scenario.id}: the GIF is ${gifBytes} B; raise speed or trim the take.`);
if (gifSeconds > 22)
	throw new Error(`${scenario.id}: the GIF runs about ${gifSeconds}s; raise speed or trim the take.`);

const today = new Date().toISOString().slice(0, 10);
const png = readFileSync(main.path);
const source = `CLIO Coder ${values.version} installed with npm install -g, recorded with asciinema v2 in a terminal pane (scenario ${scenario.id}, hand-driven) in a scratch profile: home /home/researcher, host lab, ${scenario.cols}x${scenario.rows} terminal, idle capped at ${spec.idleCap}s. Environment: CLIO_CODER_REDUCE_MOTION=1. Settings: ${scenario.settings.join("; ")}.${scenario.sourceNote ? ` ${scenario.sourceNote}` : ""}`;
const entry = {
	image: scenario.capture.image ?? `assets/guides/${scenario.id}.webp`,
	original: (scenario.capture.image ?? `assets/guides/${scenario.id}.webp`).replace(/\.webp$/, ".png"),
	width: png.readUInt32BE(16),
	height: png.readUInt32BE(20),
	label: scenario.capture.label,
	alt: scenario.capture.alt,
	caption: scenario.capture.caption,
	interface: "Terminal",
	version: values.version,
	capturedAt: today,
	source,
	cast: `assets/casts/${scenario.id}.cast`,
	transcript: `assets/casts/${scenario.id}.txt`,
	cols: scenario.cols,
	rows: scenario.rows,
	duration: Math.round(duration * 10) / 10,
	posterAt: poster.time,
};
const registryHits = privacyHits(JSON.stringify(entry), secrets);
if (registryHits.length)
	throw new Error(`${scenario.id}: privacy scan failed on the registry entry: ${registryHits.join("; ")}`);
writeFileSync(join(outDir, "captures.json"), `${JSON.stringify({ [scenario.id]: entry }, null, "\t")}\n`);

const alts = altCheck({ scratch, ids: [scenario.id], entries: { [scenario.id]: entry } });
printAltCheck(alts);
if (alts.misses.length) {
	process.exitCode = 1;
	console.log("alt-check: nothing published; fix the alt or caption in scenarios.json and rerun.");
} else if (values.publish) {
	mkdirSync(join(site, "assets/casts"), { recursive: true });
	for (const ext of ["cast", "txt"])
		copyFileSync(join(outDir, `${scenario.id}.${ext}`), join(site, `assets/casts/${scenario.id}.${ext}`));
	mkdirSync(dirname(join(site, entry.image)), { recursive: true });
	copyFileSync(main.path, join(site, entry.original));
	copyFileSync(main.path.replace(/\.png$/, ".webp"), join(site, entry.image));
	const registryPath = join(site, "content/captures.json");
	const registry = JSON.parse(readFileSync(registryPath, "utf8"));
	registry.captures[scenario.id] = entry;
	writeFileSync(registryPath, `${JSON.stringify(registry, null, "\t")}\n`);
	// The GIF is a master under assets/ for the README, listed in the media manifest.
	const gifPath = `assets/animations/${scenario.id}.gif`;
	mkdirSync(join(repo, "assets/animations"), { recursive: true });
	copyFileSync(gif, join(repo, gifPath));
	const manifestPath = join(repo, "assets/media-manifest.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const item = {
		id: `animation-${scenario.id.replace(/^anim-/, "")}`,
		source: gifPath,
		sha256: createHash("sha256").update(readFileSync(gif)).digest("hex"),
		provenance: `Rendered by agg from site/assets/casts/${scenario.id}.cast, recorded from CLIO Coder ${values.version} by site/capture/animation.mjs.`,
		dimensions: { width: gifWidth, height: gifHeight },
		role: scenario.capture.label,
		channels: ["repository", "readme"],
		altTextSeed: entry.alt,
		representation: "captured-recording",
		copies: [],
	};
	const at = manifest.assets.findIndex((asset) => asset.id === item.id);
	if (at < 0) manifest.assets.push(item);
	else manifest.assets[at] = item;
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	console.log(`${scenario.id}: published to site/assets, content/captures.json and ${gifPath}`);
}
