#!/usr/bin/env node
// Reports what a built client costs before first paint and on the first open of a task, and fails when a budget
// is exceeded. Sizes are bytes in the JSON; budgets are KB of 1,000 bytes, as Vite's own build summary prints
// them, and gzip is `gzipSync` at its default level 6.
//
//   node scripts/bundle-report.mjs --client <dir> [--max-eager-js-gzip KB] [--max-eager-css-gzip KB]
//     [--max-chunk <prefix>=<KB raw>]... [--max-route-js-gzip KB] [--forbid-in-route <string>]...
//
// A budget flag that is left out takes the budget below. Eager JS allows no growth over the 172,361 bytes the
// client measured before the cold-start work, with 0.1 KB of tolerance for the deep-link snapshot read: the
// lead's restatement of the spec's 172 KB, which that baseline already exceeded.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const usage =
	"usage: node scripts/bundle-report.mjs --client <dir> [--max-eager-js-gzip KB] [--max-eager-css-gzip KB] [--max-chunk <prefix>=<KB raw>]... [--max-route-js-gzip KB] [--forbid-in-route <string>]...";

function fail(message) {
	console.error(message);
	console.error(usage);
	process.exit(2);
}

function number(flag, value) {
	const parsed = Number(value);
	if (value === undefined || value === "" || !Number.isFinite(parsed) || parsed < 0)
		fail(`${flag} needs a non-negative number of KB.`);
	return parsed;
}

const budgets = {
	eagerJs: 172.5,
	eagerCss: 22.5,
	routeJs: 116,
	chunks: [{ prefix: "model-picker-model", limit: 8 }],
	forbid: ["~kind"],
};
const options = {
	client: undefined,
	eagerJs: undefined,
	eagerCss: undefined,
	routeJs: undefined,
	chunks: [],
	forbid: [],
};
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
	const flag = argv[index];
	const value = argv[index + 1];
	index += 1;
	if (flag === "--client") options.client = value;
	else if (flag === "--max-eager-js-gzip") options.eagerJs = number(flag, value);
	else if (flag === "--max-eager-css-gzip") options.eagerCss = number(flag, value);
	else if (flag === "--max-route-js-gzip") options.routeJs = number(flag, value);
	else if (flag === "--max-chunk") {
		const match = /^([^=]+)=(.*)$/.exec(value ?? "");
		if (!match) fail("--max-chunk needs <prefix>=<KB raw>.");
		options.chunks.push({ prefix: match[1], limit: number(flag, match[2]) });
	} else if (flag === "--forbid-in-route") {
		if (value === undefined || value === "") fail("--forbid-in-route needs a string.");
		options.forbid.push(value);
	} else fail(`Unknown argument: ${flag}`);
}
if (!options.client) fail("--client is required.");
options.eagerJs ??= budgets.eagerJs;
options.eagerCss ??= budgets.eagerCss;
options.routeJs ??= budgets.routeJs;
if (options.chunks.length === 0) options.chunks = budgets.chunks;
if (options.forbid.length === 0) options.forbid = budgets.forbid;
const client = options.client;
if (!existsSync(join(client, "index.html"))) fail(`No index.html in ${client}.`);

const KB = 1000;
const kb = (bytes) => Math.round((bytes / KB) * 10) / 10;
const sizes = new Map();
function measure(file) {
	let size = sizes.get(file);
	if (!size) {
		const bytes = readFileSync(join(client, file));
		size = { file, raw: bytes.length, gzip: gzipSync(bytes).length, text: bytes.toString("utf8") };
		sizes.set(file, size);
	}
	return size;
}
const sum = (files) => {
	const measured = files.map(measure);
	return {
		files: measured.map(({ file, raw, gzip }) => ({ file, raw, gzip })),
		raw: measured.reduce((total, size) => total + size.raw, 0),
		gzip: measured.reduce((total, size) => total + size.gzip, 0),
	};
};

// Every `/assets/` reference the HTML makes before the app runs: the module entry, its modulepreloads and the
// stylesheets. Attribute order differs between builds, so each tag's attributes are read on their own.
const html = readFileSync(join(client, "index.html"), "utf8");
const eagerJs = [];
const eagerCss = [];
for (const tag of html.matchAll(/<(script|link)\b([^>]*)>/gi)) {
	const attributes = new Map();
	for (const attribute of tag[2].matchAll(/([a-zA-Z-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g))
		attributes.set(attribute[1].toLowerCase(), attribute[2] ?? attribute[3] ?? attribute[4] ?? "");
	const name = tag[1].toLowerCase();
	const url = name === "script" ? attributes.get("src") : attributes.get("href");
	if (!url?.startsWith("/assets/")) continue;
	const file = url.slice(1).split(/[?#]/)[0];
	const rel = (attributes.get("rel") ?? "").toLowerCase().split(/\s+/);
	if (name === "script" && attributes.get("type") === "module") eagerJs.push(file);
	else if (name === "link" && rel.includes("modulepreload")) eagerJs.push(file);
	else if (name === "link" && rel.includes("stylesheet")) eagerCss.push(file);
}
const eagerSet = new Set([...eagerJs, ...eagerCss]);

const assets = readdirSync(join(client, "assets")).map((name) => `assets/${name}`);
const scripts = assets.filter((file) => file.endsWith(".js"));

// The build emits a small eager `sessions-*.js` beside the lazy route chunk; the route is the one not preloaded.
// Its cost is its static import closure minus what the first paint already fetched; dynamic imports load later.
const routeEntry = scripts.filter((file) => /^assets\/sessions-[^/]*\.js$/.test(file) && !eagerSet.has(file));
const closure = new Set();
const pending = [...routeEntry];
while (pending.length > 0) {
	const file = pending.pop();
	if (closure.has(file) || !existsSync(join(client, file))) continue;
	closure.add(file);
	const text = measure(file).text;
	for (const found of text.matchAll(/(?:\bfrom|\bimport)\s*["'](\.{1,2}\/[^"']+\.js)["']/g)) {
		const target = join("assets", found[1]).replaceAll("\\", "/");
		if (!closure.has(target)) pending.push(target);
	}
}
const routeFiles = [...closure].filter((file) => !eagerSet.has(file)).sort();

const violations = [];
const eager = { js: sum(eagerJs), css: sum(eagerCss) };
const route = { entry: routeEntry, ...sum(routeFiles), forbidden: [] };
if (routeEntry.length === 0) violations.push("No lazy assets/sessions-*.js chunk was found.");
if (eager.js.gzip > options.eagerJs * KB)
	violations.push(`Eager JS is ${eager.js.gzip} bytes gzip (${kb(eager.js.gzip)} KB), over ${options.eagerJs} KB.`);
if (eager.css.gzip > options.eagerCss * KB)
	violations.push(`Eager CSS is ${kb(eager.css.gzip)} KB gzip, over ${options.eagerCss} KB.`);
if (route.gzip > options.routeJs * KB)
	violations.push(`Session route JS beyond the eager set is ${kb(route.gzip)} KB gzip, over ${options.routeJs} KB.`);
for (const needle of options.forbid) {
	const files = routeFiles.filter((file) => measure(file).text.includes(needle));
	route.forbidden.push({ string: needle, files });
	if (files.length > 0)
		violations.push(`The session route closure contains ${JSON.stringify(needle)} in ${files.join(", ")}.`);
}
const chunks = options.chunks.map(({ prefix, limit }) => {
	const files = scripts.filter((file) => file.startsWith(`assets/${prefix}-`)).map(measure);
	for (const { file, raw } of files)
		if (raw > limit * KB) violations.push(`${file} is ${kb(raw)} KB raw, over ${limit} KB.`);
	return { prefix, limit, files: files.map(({ file, raw, gzip }) => ({ file, raw, gzip })) };
});
const everything = sum(assets.filter((file) => file.endsWith(".js") || file.endsWith(".css")));

console.log(
	JSON.stringify(
		{
			unit: "bytes; budgets in KB of 1000 bytes, gzip level 6",
			eager,
			route,
			chunks,
			total: { files: everything.files.length, raw: everything.raw, gzip: everything.gzip },
			violations,
		},
		null,
		2,
	),
);
process.exit(violations.length > 0 ? 1 : 0);
