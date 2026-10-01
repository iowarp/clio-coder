/**
 * The sizes ClioPulse is drawn at, defined once. An inline mark beside a word, a list or task row,
 * a step in a plan, and a stage (the setup wizard, an empty state). Pass one of these, not a number.
 */
export const PULSE_SIZE = { inline: 12, row: 14, step: 16, stage: 24 } as const;

/**
 * The one "Clio is working" indicator in the app: the brand's concentric "C", drawn as three
 * counter-rotating arcs so the mark itself is the activity indicator. Outer rings use the accent, the
 * inner one the secondary, as in the logo. Motion is CSS only and stops under `prefers-reduced-motion`.
 *
 * It means Clio, a worker, a tool or the setup child is doing something right now. It is never
 * decoration and never stands for ordinary data loading. It is decorative to assistive technology
 * unless it gets a `label`, so pair it with a word that carries the state.
 */
export function ClioPulse({ size = 16, label }: { size?: number; label?: string }) {
	return (
		<svg
			className="clio-pulse"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			strokeLinecap="round"
			role={label ? "img" : undefined}
			aria-label={label}
			aria-hidden={label ? undefined : true}
		>
			<circle className="clio-pulse__ring clio-pulse__ring--outer" cx="12" cy="12" r="10" pathLength="100" />
			<circle className="clio-pulse__ring clio-pulse__ring--mid" cx="12" cy="12" r="6.4" pathLength="100" />
			<circle className="clio-pulse__ring clio-pulse__ring--core" cx="12" cy="12" r="2.8" pathLength="100" />
		</svg>
	);
}

export function ClioLogo({ size = 24 }: { size?: number }) {
	return <img src="/clio-coder-logo.webp" alt="" width={size} height={Math.round((size * 128) / 117)} />;
}
