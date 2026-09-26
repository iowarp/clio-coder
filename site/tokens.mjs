import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const file = (path) => fileURLToPath(new URL(path, import.meta.url));
export async function tokenCSS() {
	const { palette, themes, motion } = JSON.parse(await readFile(file("design-system.json"), "utf8"));
	const theme = (name) =>
		Object.entries(themes[name])
			.map(([key, color]) => {
				if (!palette[color]) throw new Error(`Unknown sanctioned color: ${color}`);
				return `\t--${key}: var(--clio-${color});`;
			})
			.join("\n");
	return `/* Generated from design-system.json by tokens.mjs. Edit the source, then regenerate. */
@font-face { font-family: "IBM Plex Sans"; font-style: normal; font-weight: 100 700; font-display: swap; src: url("../assets/fonts/plex-sans.woff2") format("woff2"); }
@font-face { font-family: "IBM Plex Mono"; font-style: normal; font-weight: 400; font-display: swap; src: url("../assets/fonts/plex-400.woff2") format("woff2"); }
@font-face { font-family: "IBM Plex Mono"; font-style: normal; font-weight: 500; font-display: swap; src: url("../assets/fonts/plex-500.woff2") format("woff2"); }
@font-face { font-family: "Newsreader"; font-style: normal; font-weight: 500; font-display: swap; src: url("../assets/fonts/news-normal-500.woff2") format("woff2"); }
@font-face { font-family: "Newsreader"; font-style: italic; font-weight: 480; font-display: swap; src: url("../assets/fonts/news-italic-480.woff2") format("woff2"); }
:root {
${Object.entries(palette)
	.map(([key, value]) => `\t--clio-${key}: ${value};`)
	.join("\n")}
  color-scheme: dark;
${theme("dark")}
  --font-ui: "IBM Plex Sans", sans-serif;
  --font-display: "Newsreader", Georgia, serif;
  --font-mono: "IBM Plex Mono", monospace;
  --page: 1248px;
  --measure: 65ch;
  --header: 5rem;
  --space-1: .25rem; --space-2: .5rem; --space-3: .75rem; --space-4: 1rem;
  --space-5: 1.5rem; --space-6: 2rem; --space-7: 3rem; --space-8: 4rem; --space-9: 6rem;
  --radius: .35rem;
${Object.entries(motion)
	.map(([key, value]) => `  --motion-${key}: ${value};`)
	.join("\n")}
  --code: var(--clio-charcoal); --code-ink: var(--clio-ivory);
  --code-muted: var(--clio-stone); --code-border: var(--clio-darkControl);
  --code-sunk: var(--clio-graphite);
  --selection-bg: var(--accent); --selection-ink: var(--on-accent);
  --menu-shadow: 0 12px 36px color-mix(in srgb, var(--clio-black) 25%, transparent);
  /* Compatibility aliases for the social-card templates. */
  --cyan: var(--accent); --rule: var(--line); --line-strong: var(--ink);
  --well-cyan: var(--clio-teal); --well-sage: var(--clio-teal);
  --paper-elevated: var(--paper-raised);
}
html[data-theme="light"] {
  color-scheme: light;
${theme("light")}
}
@media (prefers-color-scheme: light) {
  html:not([data-theme]) {
    color-scheme: light;
${theme("light")}
  }
}
`;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const css = await tokenCSS();
	if (process.argv.includes("--check")) {
		if ((await readFile(file("css/brand.css"), "utf8")) !== css)
			throw new Error("brand.css differs from the sanctioned tokens. Run node site/tokens.mjs.");
	} else await writeFile(file("css/brand.css"), css);
}
