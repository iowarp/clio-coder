const paths = {
	overview: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
	sessions: "M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0ZM7 9h10M7 14h6",
	traces: "M3 12h4l3-8 4 16 3-8h4",
	toolchain: "m14 6 4 4M4 20l-1-3L15 5l4-2 2 2-2 4L7 21Z",
	docs: "M12 5v16M12 5C8 2 4 3 2 4v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-2-1-6-2-10 1Z",
	settings: "M4 7h9m4 0h3M4 17h3m4 0h9M13 4v6M7 14v6",
	fleet: "M12 8v5M5 16v-3h14v3M9 2h6v6H9zM2 16h6v6H2zM16 16h6v6h-6z",
	evidence: "M8 3H5v18h14V3h-3M8 2h8v4H8zM8 12l2 2 5-5M8 18h8",
	evals: "M4 3v18h17M8 17v-5m5 5V7m5 10V4",
	library: "M3 3h4v18H3zM10 3h4v18h-4zM17 4l3-1 3 17-3 1z",
	system: "M3 4h18v13H3zM8 21h8m-4-4v4M6 8l3 3-3 3m6 0h5",
	sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5",
	moon: "M20.8 13A9 9 0 0 1 11 3.2 9 9 0 1 0 20.8 13Z",
	menu: "M4 6h16M4 12h16M4 18h16",
	close: "m6 6 12 12M6 18 18 6",
	more: "M5 11v2m7-2v2m7-2v2",
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
