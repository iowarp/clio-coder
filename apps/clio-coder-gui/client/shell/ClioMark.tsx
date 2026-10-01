import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

/** One ring of the mark: a C that opens to the right, optionally cut like the maze in the logo. */
export type Ring = { r: number; w: number; gap: number; tone: "accent" | "secondary"; cuts?: readonly number[] };
/** `cycle` is one beat in ms; larger marks travel farther per turn, so they turn more slowly. */
type Geometry = { box: number; cycle: number; stagger: number; rings: readonly Ring[]; check: string };

/*
 * Geometry per rendered size, drawn in device pixels at the bucket's own size so every ring keeps a
 * stroke of at least 1.3px and a clear gap of about 1px. A 12px glyph cannot hold four rings without
 * them fusing into a blob, so the small buckets keep the outer ring and the copper core and drop rings
 * inward as room runs out. The large bucket carries the logo's maze cuts.
 */
const XS: Geometry = {
	cycle: 1500,
	stagger: 120,
	box: 12,
	rings: [
		{ r: 4.6, w: 1.6, gap: 24, tone: "accent" },
		{ r: 1.75, w: 1.5, gap: 30, tone: "secondary" },
	],
	check: "M3 6.2 5.2 8.4 9.2 3.8",
};
const SM: Geometry = {
	cycle: 1700,
	stagger: 100,
	box: 16,
	rings: [
		{ r: 6.6, w: 1.5, gap: 22, tone: "accent" },
		{ r: 4.3, w: 1.1, gap: 24, tone: "accent" },
		{ r: 2, w: 1.4, gap: 30, tone: "secondary" },
	],
	check: "M4 8.3 6.8 11.1 12.2 5.2",
};
const MD: Geometry = {
	cycle: 1900,
	stagger: 110,
	box: 24,
	rings: [
		{ r: 10.2, w: 2.4, gap: 20, tone: "accent" },
		{ r: 6.9, w: 1.8, gap: 22, tone: "accent" },
		{ r: 3.5, w: 2.2, gap: 28, tone: "secondary" },
	],
	check: "M6 12.4 10.2 16.6 18.2 7.8",
};
export const LG: Geometry = {
	cycle: 2600,
	stagger: 140,
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
	if (size <= 13) return { name: "xs", shape: XS };
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

type Phase = "working" | "settling" | "done";

/** The fraction of a beat at which a ring lands back in the mark; the rest of the beat is the mark at rest. */
const LANDS = 0.58;

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

let ease: string | undefined;
/** The site's easing, read once from the generated brand tokens so the pulse has no curve of its own. */
export function brandEase(): string {
	ease ??= getComputedStyle(document.documentElement).getPropertyValue("--ease-standard").trim() || "ease-out";
	return ease;
}

/** One eased turn that lands back in the mark at LANDS and rests there for the rest of the beat. */
function turn(direction: 1 | -1): Keyframe[] {
	const home = `rotate(${360 * direction}deg)`;
	return [
		{ offset: 0, transform: "rotate(0deg)", easing: brandEase() },
		{ offset: LANDS, transform: home },
		{ offset: 1, transform: home },
	];
}

/**
 * The brand's concentric C as the "Clio is working" indicator. Each ring makes one eased turn and
 * lands back in its place in the mark, outer ring first, so every beat ends on the logo itself and the
 * reduced-motion still is the mark. Rings rotate as separate SVG layers, transform only, and every
 * pulse starts at the document timeline's origin so a rail of running tasks beats together.
 *
 * The turns use the Web Animations API, not CSS keyframes. React listens for animation events at its
 * root, and while anything listens Chrome dispatches every CSS animationiteration on the main thread,
 * which measured at a style recalc per frame with a few dozen pulses on screen. Script-created
 * animations fire no iteration events and stay on the compositor.
 *
 * `done` resolves it: rings finish the turn they are on, the mark holds a beat, then gives way to a
 * check. A pulse mounted already done shows the check without replaying the resolve.
 */
export function ClioPulse({ size = 16, label, done = false }: { size?: number; label?: string; done?: boolean }) {
	const { name, shape } = geometry(size);
	const root = useRef<HTMLSpanElement>(null);
	const turns = useRef<Animation[]>([]);
	const still = useStill();
	const [phase, setPhase] = useState<Phase>(done ? "done" : "working");
	const current = useRef(phase);
	current.current = phase;
	// A fresh key remounts the rings when work resumes, so a new beat starts from the rest pose.
	const [lap, setLap] = useState(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new lap remounts the rings and needs new turns.
	useLayoutEffect(() => {
		if (still || current.current !== "working") return;
		const rings = root.current?.querySelectorAll<SVGSVGElement>(".clio-pulse__ring") ?? [];
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
		if (!done) {
			if (current.current !== "working") {
				setPhase("working");
				setLap((value) => value + 1);
			}
			return;
		}
		if (current.current !== "working") return;
		const running = turns.current;
		if (running.length === 0) {
			setPhase("done");
			return;
		}
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
		let live = true;
		void Promise.allSettled(running.map((animation) => animation.finished)).then(() => {
			if (live) setPhase("done");
		});
		return () => {
			live = false;
		};
	}, [done]);

	const half = shape.box / 2;
	return (
		<span
			ref={root}
			className="clio-pulse"
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
			<svg className="clio-pulse__check" viewBox={`0 0 ${shape.box} ${shape.box}`} aria-hidden="true">
				<path d={shape.check} strokeWidth={shape.rings[0]?.w} />
			</svg>
		</span>
	);
}

export function ClioLogo({ size = 24 }: { size?: number }) {
	return <img src="/clio-coder-logo.webp" alt="" width={size} height={Math.round((size * 128) / 117)} />;
}
