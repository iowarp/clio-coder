#!/usr/bin/env node
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { tokenCSS } from "./tokens.mjs";

const site = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: { out: { type: "string", default: "/tmp/clio-brand-kit" } } });
const out = resolve(values.out);
if (out === "/" || out === site || site.startsWith(`${out}/`))
	throw new Error("The export must not replace source files.");
const marker = ".clio-brand-kit";
const existing = await readdir(out).catch((error) => {
	if (error.code === "ENOENT") return [];
	throw error;
});
if (existing.length && (!existing.includes(marker) || (await readFile(join(out, marker), "utf8")) !== `${site}\n`))
	throw new Error("Refusing to replace an export directory not owned by this tool.");
await rm(out, { recursive: true, force: true });
await mkdir(join(out, "css"), { recursive: true });
await mkdir(join(out, "assets/brand"), { recursive: true });
await mkdir(join(out, "assets/fonts"), { recursive: true });
await writeFile(join(out, marker), `${site}\n`);
await writeFile(join(out, "css/clio.css"), await tokenCSS());
await cp(join(site, "design-system.json"), join(out, "design-system.json"));
for (const name of ["clio-mark.png", "clio-mark.webp", "iowarp-mark.png", "iowarp-mark.webp", "provenance.json"])
	await cp(join(site, "assets/brand", name), join(out, "assets/brand", name));
for (const name of [
	"plex-sans.woff2",
	"plex-400.woff2",
	"plex-500.woff2",
	"news-normal-500.woff2",
	"news-italic-480.woff2",
	"IBM-Plex-Sans-OFL.txt",
	"IBM-Plex-Mono-OFL.txt",
	"Newsreader-OFL.txt",
])
	await cp(join(site, "assets/fonts", name), join(out, "assets/fonts", name));
await writeFile(
	join(out, "README.md"),
	`# Clio identity kit\n\nUse the existing cyan Clio ring with the copper center for every Clio application. Pair it with the name Clio and a product descriptor such as Coder or Kit. The IOWarp lattice identifies the parent ecosystem. Do not invent a separate product mark or recolor the selected artwork.\n\nImport css/clio.css for semantic palette, typography, and space tokens. It contains no site layout or components. Dark and light themes use the same roles; select a theme with html[data-theme], or let the system preference apply. Use --paper, --paper-raised, --ink, --ink-soft, --muted, --line, --line-control, --accent, --accent-soft, --on-accent, and --secondary. Design-system.json is the sole color source. Source changes require explicit authorization and regeneration in clio-coder/site/.\n\nThe typography is IBM Plex Sans for UI and prose, IBM Plex Mono for commands, and Newsreader for editorial headings. All fonts and their upstream licenses are included. Preserve relative asset paths when importing the CSS.\n\nOriginal artwork sources and hashes are in assets/brand/provenance.json. Public copyright wording: Copyright 2026 iowarp.ai. The Clio Coder project is Apache 2.0; third-party font licenses remain with their owners. See clio-coder/site/DESIGN.md for the complete identity and public prose rules.\n`,
);
console.log(`Exported the reusable Clio identity to ${out}`);
