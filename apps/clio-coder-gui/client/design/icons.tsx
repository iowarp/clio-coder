const paths = {
	overview: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
	sessions: "M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0ZM7 9h10M7 14h6",
	traces: "M3 12h4l3-8 4 16 3-8h4",
	toolchain: "m14 6 4 4M4 20l-1-3L15 5l4-2 2 2-2 4L7 21Z",
	docs: "M12 5v16M12 5C8 2 4 3 2 4v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-2-1-6-2-10 1Z",
	settings: "M4 7h9m4 0h3M4 17h3m4 0h9M13 4v6M7 14v6",
	fleet: "M12 8v5M5 16v-3h14v3M9 2h6v6H9zM2 16h6v6H2zM16 16h6v6h-6z",
	evidence: "M8 3H5v18h14V3h-3M8 2h8v4H8zM8 12l2 2 5-5M8 18h8",
	library: "M3 3h4v18H3zM10 3h4v18h-4zM17 4l3-1 3 17-3 1z",
	system: "M3 4h18v13H3zM8 21h8m-4-4v4M6 8l3 3-3 3m6 0h5",
	sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5",
	moon: "M20.8 13A9 9 0 0 1 11 3.2 9 9 0 1 0 20.8 13Z",
	menu: "M4 6h16M4 12h16M4 18h16",
	sidebar: "M4 4h16v16H4zM9 4v16",
	close: "m6 6 12 12M6 18 18 6",
	more: "M5 11v2m7-2v2m7-2v2",
	// Status glyphs mirror client/design/status.tsx: shape, never hue alone.
	running: "M10 8l6 4-6 4V8ZM12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z",
	success: "m8 12 3 3 5-6M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z",
	warn: "M12 9v4m0 3v.5M10.3 4.2 2.6 17.4A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3.1L13.7 4.2a2 2 0 0 0-3.4 0Z",
	fail: "m9 9 6 6m-6 0 6-6M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z",
	unverified:
		"M12 3a9 9 0 0 1 4.5 1.2M20 8a9 9 0 0 1 .8 5.4M18.5 18a9 9 0 0 1-4.7 2.8M9 20.6A9 9 0 0 1 4.6 18M3.2 13.4A9 9 0 0 1 4.9 7.2",
	chevronDown: "m6 9 6 6 6-6",
	chevronRight: "m9 6 6 6-6 6",
	copy: "M9 9h10v12H9zM5 15H3V3h12v2",
	search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM21 21l-5-5",
	diff:
		"M6 3v12m0 6v-2M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM18 21V9m0-6v2M18 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM9 6h4a5 5 0 0 1 5 5",
	plus: "M12 5v14M5 12h14",
	folder: "M3 7V5h6l2 2h10v13H3Z",
	arrowUp: "M12 19V5m-6 6 6-6 6 6",
	paperclip: "m8 13 7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l9-9m-5 12 8-8",
	keyboard: "M2 5h20v14H2zM6 9h1m4 0h1m4 0h1M6 13h1m4 0h1m4 0h1M7 16h10",
	artifacts: "M4 3h12l4 4v14H4ZM16 3v5h4M8 12h8M8 16h8",
	gear:
		"M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1Z",
	filter: "M3 5h18l-7 8v6l-4 2v-8Z",
	external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
	play: "M7 5l12 7-12 7V5Z",
	stop: "M6 6h12v12H6z",
	// Workbench shell.
	compose: "M11 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6M17.5 3.5l3 3L12 15l-4 1 1-4Z",
	folderOpen: "M3 19V5h6l2 2h8v3M3 19l3-9h16l-3 9Z",
	skills:
		"M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8ZM19 15l.7 1.8 1.8.7-1.8.7L19 20l-.7-1.8-1.8-.7 1.8-.7Z",
	models: "M7 7h10v10H7zM10 10h4v4h-4zM9 3v4m6-4v4M9 17v4m6-4v4M3 9h4m10 0h4M3 15h4m10 0h4",
	sliders: "M4 7h9m4 0h3M4 17h3m4 0h9M13 4v6M7 14v6",
	usage: "M5 20V10M12 20V4M19 20v-7",
	panelRight: "M4 4h16v16H4zM15 4v16",
	check: "m5 12 4.5 4.5L19 7",
	branch: "M6 3v12M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM18 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM18 9a6 6 0 0 1-6 6H9",
	arrowLeft: "M19 12H5m6-6-6 6 6 6",
	trash: "M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3",
	pencil: "m4 20 1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19Z",
	archive: "M4 4h16v4H4zM5 8v12h14V8M10 12h4",
	clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 7v5l3 2",
	circle: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z",
	fileDiff: "M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M13 9v6M10 17h6",
	listChecks: "M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17M11 6h9M11 12h9M11 18h9",
} as const;

export function Icon({ name }: { name: keyof typeof paths }) {
	return (
		<svg
			className="icon"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={paths[name]} />
		</svg>
	);
}
