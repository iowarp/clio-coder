/*
 * One icon family, drawn here and nowhere else. Every glyph sits on a 24 unit grid inside a 2 unit
 * margin, with round caps and joins and a 2 unit radius on a container corner, so no icon looks a
 * size larger or a weight heavier than its neighbour. The stroke does not scale with the glyph
 * (`vector-effect` below): a 14px icon in a dense row and an 18px icon in the rail carry the same
 * line, set once by --icon-stroke.
 */

const n = (value: number) => Number(value.toFixed(2));

/** A rounded rectangle as a closed subpath. */
const box = (x: number, y: number, w: number, h: number, r = 2) =>
	`M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1-${r} ${r}h-${w - 2 * r}a${r} ${r} 0 0 1-${r}-${r}v-${h - 2 * r}a${r} ${r} 0 0 1 ${r}-${r}Z`;

/** A circle as a closed subpath. */
const ring = (cx: number, cy: number, r: number) =>
	`M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0-${2 * r} 0Z`;

/** A cog outline: flat teeth between a root circle and a tip circle, softened by the round joins. */
const cog = (teeth: number, tip: number, root: number) => {
	const at = (radius: number, angle: number) =>
		`${n(12 + radius * Math.sin(angle))} ${n(12 - radius * Math.cos(angle))}`;
	const step = (2 * Math.PI) / teeth;
	const points: string[] = [];
	for (let tooth = 0; tooth < teeth; tooth += 1) {
		const centre = tooth * step;
		points.push(
			at(root, centre - step * 0.3),
			at(tip, centre - step * 0.19),
			at(tip, centre + step * 0.19),
			at(root, centre + step * 0.3),
		);
	}
	return `M${points.join("L")}Z`;
};

/** A sheet with a folded corner; the document icons write on it. */
const SHEET = "M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM14 3v5h5";
const SLIDERS = `M3 7h9.5M17.5 7H21M3 17h3.5M11.5 17H21${ring(15, 7, 2.5)}${ring(9, 17, 2.5)}`;

const paths = {
	overview: box(3, 3, 7, 7, 1.5) + box(14, 3, 7, 7, 1.5) + box(3, 14, 7, 7, 1.5) + box(14, 14, 7, 7, 1.5),
	sessions: "M6 4h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-4.5 4v-4A2 2 0 0 1 4 14V6a2 2 0 0 1 2-2ZM8 8.5h8M8 12h5",
	traces: "M3 12h4l3-8 4 16 3-8h4",
	toolchain:
		"M16.5 3.2 13.8 5.9l.7 2.9 2.9.7 2.7-2.7a5.2 5.2 0 0 1-6.9 6.1l-6 6a2.1 2.1 0 0 1-3-3l6-6a5.2 5.2 0 0 1 6.3-6.7Z",
	docs: "M12 6.5C10 4.6 6.5 4 3 4.5V19c3.5-.5 7 .1 9 2 2-1.9 5.5-2.5 9-2V4.5c-3.5-.5-7 .1-9 2ZM12 6.5V21",
	settings: SLIDERS,
	fleet: `${box(9, 2, 6, 6, 1.5) + box(2, 16, 6, 6, 1.5) + box(16, 16, 6, 6, 1.5)}M12 8v4M5 16v-2a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2`,
	evidence: `${box(8, 2, 8, 4, 1)}M16 4h1a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1M9 14l2 2 4-4`,
	library: "M4 4v16M8.5 4v16M13 7v13M16.5 7.6l3.8 12.2",
	system: `${box(2, 3, 20, 14)}M8 21h8M12 17v4M6.5 7.5l3 2.5-3 2.5M12.5 12.5h4`,
	sun: `${ring(12, 12, 4)}M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4`,
	moon: "M20.5 14A9 9 0 1 1 10 3.5a7 7 0 0 0 10.5 10.5Z",
	menu: "M4 6h16M4 12h16M4 18h16",
	sidebar: `${box(3, 4, 18, 16)}M9 4v16`,
	close: "M6 6l12 12M18 6 6 18",
	more: ring(5, 12, 1) + ring(12, 12, 1) + ring(19, 12, 1),
	// Status glyphs mirror client/design/status.tsx: shape, never hue alone.
	running: `${ring(12, 12, 9)}M10 8.5v7l5.5-3.5Z`,
	success: `${ring(12, 12, 9)}M8.5 12.2l2.4 2.4 4.6-5`,
	warn: "M12 9v4m0 3v.5M10.3 4.2 2.6 17.4A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3.1L13.7 4.2a2 2 0 0 0-3.4 0Z",
	fail: `${ring(12, 12, 9)}M9 9l6 6M15 9l-6 6`,
	unverified:
		"M12 3a9 9 0 0 1 4.5 1.2M20 8a9 9 0 0 1 .8 5.4M18.5 18a9 9 0 0 1-4.7 2.8M9 20.6A9 9 0 0 1 4.6 18M3.2 13.4A9 9 0 0 1 4.9 7.2",
	chevronDown: "m6 9 6 6 6-6",
	chevronRight: "m9 6 6 6-6 6",
	copy: `${box(9, 9, 12, 12)}M5 15h-.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5`,
	search: `${ring(11, 11, 7)}M20.5 20.5 16 16`,
	diff: `${ring(6, 6, 2.5) + ring(18, 18, 2.5)}M12 6h4a2 2 0 0 1 2 2v7.5M12 18H8a2 2 0 0 1-2-2V8.5`,
	plus: "M12 5v14M5 12h14",
	folder: "M3 6a2 2 0 0 1 2-2h4l2.5 3H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
	arrowUp: "M12 19V5M5.5 11.5 12 5l6.5 6.5",
	paperclip: "M20 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8",
	artifacts: `${SHEET}M9 13h6M9 17h6`,
	gear: cog(8, 9.8, 7.6) + ring(12, 12, 3),
	filter: "M4 5h16l-6 7.5V19l-4 1.5v-8Z",
	external: "M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4",
	play: "M7 4.5v15l12-7.5Z",
	stop: box(6, 6, 12, 12),
	// Workbench shell.
	compose: "M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5M18.4 3.6a2 2 0 0 1 2.8 2.8l-8.7 8.8L9 16l.8-3.5Z",
	folderOpen:
		"M3 18V6a2 2 0 0 1 2-2h4l2.5 3H18a2 2 0 0 1 2 2v1M3 18l2.3-6.6A2 2 0 0 1 7.2 10h13.4a1 1 0 0 1 .95 1.32l-2.1 7.3A2 2 0 0 1 17.5 20H5a2 2 0 0 1-2-2Z",
	skills:
		"M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8ZM19 15l.7 1.8 1.8.7-1.8.7L19 20l-.7-1.8-1.8-.7 1.8-.7Z",
	models: `${box(5, 5, 14, 14) + box(9, 9, 6, 6, 1)}M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3`,
	sliders: SLIDERS,
	usage: "M5 20v-9M12 20V4M19 20v-6",
	panelRight: `${box(3, 4, 18, 16)}M15 4v16`,
	check: "m5 12.5 4.5 4.5L19 7",
	branch: `${ring(6, 18, 2.5) + ring(18, 6, 2.5)}M6 3v12.5M18 8.5c0 5-3.5 8.5-9.5 9.5`,
	arrowLeft: "M19 12H5M11.5 5.5 5 12l6.5 6.5",
	trash:
		"M4 7h16M9.5 7V4.5a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 .5.5V7M6 7l.8 12.1a2 2 0 0 0 2 1.9h6.4a2 2 0 0 0 2-1.9L18 7M10 11v6M14 11v6",
	pencil: "M4 20l1-4.5L16.4 4.1a2.1 2.1 0 0 1 3 3L8 18.6ZM14.5 6l3 3",
	archive: `${box(3, 4, 18, 4, 1)}M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M10 12h4`,
	clock: `${ring(12, 12, 9)}M12 7v5l3 2`,
	circle: ring(12, 12, 8),
	fileDiff: `${SHEET}M9.5 11.5h5M12 9v5M9.5 17.5h5`,
	shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6Z",
	bolt: "M13 2.5 4.5 13.5H11l-1 8 8.5-11H12Z",
	layers: "M12 2.5 3 7.5l9 5 9-5ZM3 12l9 5 9-5M3 16.5l9 5 9-5",
	listChecks: "M3 6.5 4.5 8l3-3M3 12.5 4.5 14l3-3M3 18.5 4.5 20l3-3M11 6.5h10M11 12.5h10M11 18.5h10",
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name }: { name: IconName }) {
	return (
		<svg
			className="icon"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={paths[name]} vectorEffect="non-scaling-stroke" />
		</svg>
	);
}
