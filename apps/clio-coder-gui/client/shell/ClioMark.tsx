/**
 * The brand's concentric "C", drawn as three counter-rotating arcs so the mark itself is the
 * activity indicator. Outer rings use the accent, the inner one the secondary, as in the logo.
 * Motion is CSS only and stops under `prefers-reduced-motion`, where the arcs read as the static mark.
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
