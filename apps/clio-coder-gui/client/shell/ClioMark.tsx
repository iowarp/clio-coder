import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * The sizes ClioPulse is drawn at, defined once. An inline mark beside a word, a list or task row,
 * a step in a plan, and a stage (the setup wizard, an empty state). Pass one of these, not a number.
 * The smallest is 14px because that is the least room in which the copper core and two teal rings
 * stay apart; with fewer rings the glyph reads as a letter C, not as Clio.
 */
export const PULSE_SIZE = { inline: 14, row: 16, step: 16, stage: 24 } as const;

/** One ring of the mark: a C that opens to the right, optionally cut like the maze in the logo. */
export type Ring = { r: number; w: number; gap: number; tone: "accent" | "secondary"; cuts?: readonly number[] };
/** `cycle` is one beat in ms; larger marks travel farther per turn, so they turn more slowly. */
type Geometry = { box: number; cycle: number; stagger: number; rings: readonly Ring[]; check: string };

/*
 * Geometry per rendered size, drawn in device pixels at the bucket's own size so every ring keeps a
 * stroke of at least 1.1px and a clear gap of about 1px. Every bucket holds the copper core inside at
 * least two teal rings, which is the least that still reads as the logo. The large bucket carries the
 * logo's maze cuts.
 */
const XS: Geometry = {
	cycle: 2000,
	stagger: 130,
	box: 14,
	rings: [
		{ r: 6.3, w: 1.2, gap: 22, tone: "accent" },
		{ r: 4.05, w: 1.1, gap: 25, tone: "accent" },
		{ r: 1.8, w: 1.2, gap: 30, tone: "secondary" },
	],
	check: "M3.4 7.3 5.9 9.8 10.7 4.5",
};
const SM: Geometry = {
	cycle: 2000,
	stagger: 130,
	box: 16,
	rings: [
		{ r: 7.1, w: 1.4, gap: 22, tone: "accent" },
		{ r: 4.55, w: 1.2, gap: 24, tone: "accent" },
		{ r: 2.05, w: 1.4, gap: 30, tone: "secondary" },
	],
	check: "M4 8.3 6.8 11.1 12.2 5.2",
};
const MD: Geometry = {
	cycle: 2200,
	stagger: 140,
	box: 24,
	rings: [
		{ r: 10.6, w: 2.2, gap: 20, tone: "accent" },
		{ r: 7, w: 1.8, gap: 22, tone: "accent" },
		{ r: 3.4, w: 2.2, gap: 28, tone: "secondary" },
	],
	check: "M6 12.4 10.2 16.6 18.2 7.8",
};
export const LG: Geometry = {
	cycle: 2800,
	stagger: 160,
	box: 48,
	rings: [
		{ r: 20.5, w: 5, gap: 19, tone: "accent", cuts: [25, 50, 75] },
		{ r: 15.2, w: 3, gap: 21, tone: "accent", cuts: [37.5, 62.5] },
		{ r: 11, w: 2.6, gap: 23, tone: "accent", cuts: [25, 75] },
		{ r: 6, w: 3.4, gap: 28, tone: "secondary" },
	],
	check: "M13 24.6 20.6 32.2 35.4 16",
};

function geometry(size: number): { name: string; shape: Geometry } {
	if (size <= 14) return { name: "xs", shape: XS };
	if (size <= 19) return { name: "sm", shape: SM };
	if (size <= 35) return { name: "md", shape: MD };
	return { name: "lg", shape: LG };
}

/** Width of a maze cut, in pathLength units (about 6 degrees). */
const CUT = 1.6;

/**
 * A dash pattern that leaves the opening centred on three o'clock and breaks the arc at each cut.
 * Paired with a dash offset of half the opening, so the stroke starts just after the opening.
 */
export function dashes({ gap, cuts = [] }: Ring): string {
	const start = gap / 2;
	const end = 100 - gap / 2;
	const out: number[] = [];
	let at = start;
	for (const cut of cuts) {
		out.push(cut - CUT / 2 - at, CUT);
		at = cut + CUT / 2;
	}
	out.push(end - at, gap);
	return out.map((value) => Number(value.toFixed(2))).join(" ");
}

/** What the mark is asked to show: the logo at rest, the logo turning, or the check it resolves to. */
type Mode = "rest" | "working" | "done";
type Phase = Mode | "settling";

/** The fraction of a beat at which a ring lands back in the mark; the rest of the beat is the mark at rest. */
const LANDS = 0.6;

const STILL = "(prefers-reduced-motion: reduce)";
const subscribeStill = (notify: () => void) => {
	const query = window.matchMedia(STILL);
	query.addEventListener("change", notify);
	return () => query.removeEventListener("change", notify);
};
const prefersStill = () => window.matchMedia(STILL).matches;
/** True while the operator asks for reduced motion; follows changes made during the visit. */
export function useStill(): boolean {
	return useSyncExternalStore(subscribeStill, prefersStill, () => true);
}

const curves = new Map<string, string>();
function curve(token: string, fallback: string): string {
	let value = curves.get(token);
	if (value === undefined) {
		value = getComputedStyle(document.documentElement).getPropertyValue(token).trim() || fallback;
		curves.set(token, value);
	}
	return value;
}
/** The site's easing, read once from the generated brand tokens so an entrance has no curve of its own. */
export function brandEase(): string {
	return curve("--ease-standard", "ease-out");
}

/** One eased turn that lands back in the mark at LANDS and rests there for the rest of the beat. */
function turn(direction: 1 | -1): Keyframe[] {
	const home = `rotate(${360 * direction}deg)`;
	return [
		{ offset: 0, transform: "rotate(0deg)", easing: curve("--ease-turn", "ease-in-out") },
		{ offset: LANDS, transform: home },
		{ offset: 1, transform: home },
	];
}

/**
 * The brand's concentric C, at rest or working. Working, the teal rings turn around the copper core
 * like the tumblers of a lock: neighbours in opposite directions, the outer one first, each making one
 * eased turn and landing back in its place. The core never moves, so the mark stays recognisable in
 * the middle of a turn, every beat ends on the logo itself, and the reduced-motion still is the logo.
 * Rings rotate as separate SVG layers, transform only, and every mark starts at the document
 * timeline's origin so a rail of running tasks beats together.
 *
 * The turns use the Web Animations API, not CSS keyframes. React listens for animation events at its
 * root, and while anything listens Chrome dispatches every CSS animationiteration on the main thread,
 * which measured at a style recalc per frame with a few dozen pulses on screen. Script-created
 * animations fire no iteration events and stay on the compositor.
 *
 * Leaving `working`, the rings finish the turn they are on before the mark rests or resolves, so a
 * state change never snaps a ring back.
 */
function Mark({ size, mode, label, variant }: { size: number; mode: Mode; label?: string; variant: "pulse" | "logo" }) {
	const { name, shape } = geometry(size);
	const root = useRef<HTMLSpanElement>(null);
	const turns = useRef<Animation[]>([]);
	const still = useStill();
	const [phase, setPhase] = useState<Phase>(mode);
	const current = useRef(phase);
	current.current = phase;
	// A fresh key remounts the rings when work resumes, so a new beat starts from the rest pose.
	const [lap, setLap] = useState(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new lap remounts the rings and needs new turns.
	useLayoutEffect(() => {
		if (still || current.current !== "working") return;
		const rings = root.current?.querySelectorAll<SVGSVGElement>("svg.clio-pulse__ring--accent") ?? [];
		turns.current = [...rings].map((ring, index) => {
			const animation = ring.animate(turn(index % 2 === 0 ? 1 : -1), {
				duration: shape.cycle,
				delay: shape.stagger * index,
				iterations: Number.POSITIVE_INFINITY,
			});
			animation.startTime = 0;
			return animation;
		});
		return () => {
			for (const animation of turns.current) animation.cancel();
			turns.current = [];
		};
	}, [lap, still, shape]);

	useLayoutEffect(() => {
		if (mode === "working") {
			if (current.current !== "working") {
				setPhase("working");
				setLap((value) => value + 1);
			}
			return;
		}
		const running = turns.current;
		const turning = current.current === "working" || current.current === "settling";
		if (!turning || running.length === 0) {
			setPhase(mode);
			return;
		}
		if (current.current === "working") {
			setPhase("settling");
			for (const animation of running) {
				const timing = animation.effect?.getComputedTiming();
				// Before its stagger delay a ring has no iteration yet and already rests in the mark.
				const iteration = timing?.currentIteration ?? 0;
				const progress = timing?.progress ?? 0;
				// A turning ring ends where it lands; a resting one ends now. Either way it stops in the mark.
				const end = progress < LANDS ? iteration + LANDS : iteration + progress;
				animation.effect?.updateTiming({ iterations: end, fill: "forwards" });
			}
		}
		let live = true;
		void Promise.allSettled(running.map((animation) => animation.finished)).then(() => {
			if (live) setPhase(mode);
		});
		return () => {
			live = false;
		};
	}, [mode]);

	const half = shape.box / 2;
	return (
		<span
			ref={root}
			className={variant === "logo" ? "clio-pulse clio-logo" : "clio-pulse"}
			data-size={name}
			data-phase={phase}
			style={{ width: size, height: size }}
			{...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
		>
			<span className="clio-pulse__mark" key={lap}>
				{shape.rings.map((ring, index) => (
					<svg
						// biome-ignore lint/suspicious/noArrayIndexKey: the rings are a fixed geometry, never reordered.
						key={index}
						className={`clio-pulse__ring clio-pulse__ring--${ring.tone}`}
						viewBox={`0 0 ${shape.box} ${shape.box}`}
						aria-hidden="true"
					>
						<circle
							cx={half}
							cy={half}
							r={ring.r}
							pathLength={100}
							strokeWidth={ring.w}
							strokeDasharray={dashes(ring)}
							strokeDashoffset={-ring.gap / 2}
						/>
					</svg>
				))}
			</span>
			{variant === "pulse" ? (
				<svg className="clio-pulse__check" viewBox={`0 0 ${shape.box} ${shape.box}`} aria-hidden="true">
					<path d={shape.check} strokeWidth={shape.rings[0]?.w} />
				</svg>
			) : null}
		</span>
	);
}

/**
 * The "Clio is working" indicator. It means Clio, a worker, a tool or the setup child is doing
 * something right now. It is never decoration and never stands for ordinary data loading. It is
 * decorative to assistive technology unless it gets a `label`, so pair it with a word that carries
 * the state.
 *
 * `done` resolves it: rings finish the turn they are on, the mark holds a beat, then gives way to a
 * check. A pulse mounted already done shows the check without replaying the resolve.
 */
export function ClioPulse({ size = 16, label, done = false }: { size?: number; label?: string; done?: boolean }) {
	return <Mark size={size} mode={done ? "done" : "working"} variant="pulse" {...(label ? { label } : {})} />;
}

/**
 * The Clio mark as the product's logo, drawn from the theme's own teal and copper so it sits in the
 * light theme as it does in the dark one. `working` turns its rings the way ClioPulse does, for the
 * places where the logo itself should show that Clio is busy.
 */
export function ClioLogo({ size = 24, working = false }: { size?: number; working?: boolean }) {
	return <Mark size={size} mode={working ? "working" : "rest"} variant="logo" />;
}
