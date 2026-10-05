import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { brandEase, dashes, LG, useStill } from "./ClioMark.js";
import "./stage.css";

/** The teal rings, outer first; the copper core is the last ring of the large geometry. */
const TEAL = LG.rings.filter((ring) => ring.tone === "accent");
const CORE = LG.rings[LG.rings.length - 1];
const HALF = LG.box / 2;

const ENTRY = 1100;
const GLINT = 1300;
/** How long the finale keeps its caption before the stage settles to the plain mark. */
const FINALE_HOLD = 4200;

/**
 * The first-run stage: setup progress assembles the Clio mark. Pending rings are still, faint code
 * dashes; each finished step sweeps its ring into the mark on the brand ease, inner rings first.
 * Finishing the last step plays the finale from the site's closing film: the outer ring lands,
 * a glint travels the ring, and the copper core beats once. The same element is the plain mark on an
 * ordinary new task, so finishing setup flows into the composer without a cut.
 *
 * `done` is the number of finished steps, or null while that is still unknown. The entrance and the
 * finale play only for changes seen while mounted, never for the state a page loads with.
 */
export function ClioStage({ done, total }: { done: number | null; total: number }) {
	const still = useStill();
	const known = done !== null;
	const complete = known && done >= total;
	const assembled = known ? Math.round((TEAL.length * Math.min(done, total)) / total) : 0;
	const lit = (index: number) => index >= TEAL.length - assembled;

	const root = useRef<HTMLDivElement>(null);
	const mark = useRef<HTMLSpanElement>(null);
	const halo = useRef<HTMLDivElement>(null);
	const core = useRef<SVGSVGElement>(null);
	const glint = useRef<SVGCircleElement>(null);
	const rings = useRef<(SVGSVGElement | null)[]>([]);
	const mask = `clio-stage-${useId().replace(/[^\w-]/g, "")}`;

	const [finale, setFinale] = useState(false);
	const sawIncomplete = useRef(false);
	const lastAssembled = useRef<number | null>(null);
	const lastWidth = useRef(0);

	// A ring that joins the mark while the operator watches sweeps in from a turn away.
	useLayoutEffect(() => {
		if (!known) return;
		const before = lastAssembled.current;
		lastAssembled.current = assembled;
		if (before === null || assembled <= before || still) return;
		const joining = TEAL.map((_, index) => index)
			.filter((index) => lit(index) && index < TEAL.length - before)
			.reverse();
		joining.forEach((index, order) => {
			const turn = index % 2 ? 140 : -140;
			rings.current[index]?.animate(
				[
					{ opacity: 0, transform: `rotate(${turn}deg) scale(1.16)` },
					{ opacity: 1, transform: "none" },
				],
				{ duration: ENTRY, delay: order * 140, easing: brandEase(), fill: "backwards" },
			);
		});
	});

	useEffect(() => {
		if (known && !complete) sawIncomplete.current = true;
		if (!complete || !sawIncomplete.current) return;
		sawIncomplete.current = false;
		setFinale(true);
		const timer = window.setTimeout(() => setFinale(false), FINALE_HOLD);
		if (!still) {
			const ease = brandEase();
			glint.current?.animate(
				[
					{ opacity: 0, transform: "rotate(-30deg)" },
					{ opacity: 1, offset: 0.2 },
					{ opacity: 1, offset: 0.75 },
					{ opacity: 0, transform: "rotate(330deg)" },
				],
				{ duration: GLINT, delay: ENTRY * 0.6, easing: ease, fill: "backwards" },
			);
			core.current?.animate([{ transform: "none" }, { transform: "scale(1.16)" }, { transform: "none" }], {
				duration: 720,
				delay: ENTRY * 0.6 + GLINT * 0.7,
				easing: ease,
			});
			halo.current?.animate(
				[
					{ opacity: 0.2, transform: "scale(0.9)" },
					{ opacity: 1, transform: "none" },
				],
				{ duration: ENTRY + GLINT, easing: ease, fill: "backwards" },
			);
		}
		return () => window.clearTimeout(timer);
	}, [known, complete, still]);

	// The stage is larger during setup than on a new task. When its box changes size, the mark scales
	// from its old size instead of jumping (transform only; the box itself changes once).
	useLayoutEffect(() => {
		const width = root.current?.offsetWidth ?? 0;
		const before = lastWidth.current;
		lastWidth.current = width;
		if (!before || !width || before === width || still) return;
		mark.current?.animate([{ transform: `scale(${before / width})` }, { transform: "none" }], {
			duration: 640,
			easing: brandEase(),
		});
	});

	const caption = finale ? "Ready" : known && !complete ? `Step ${done + 1} of ${total}` : "";
	return (
		<div ref={root} className="clio-stage" data-finale={finale || undefined}>
			<div ref={halo} className="clio-stage__halo" aria-hidden="true" />
			<span ref={mark} className="clio-stage__mark" aria-hidden="true">
				{TEAL.map((ring, index) => (
					<svg
						key={`ghost-${ring.r}`}
						className="clio-stage__layer clio-stage__ghost"
						data-lit={lit(index) || undefined}
						viewBox={`0 0 ${LG.box} ${LG.box}`}
						aria-hidden="true"
					>
						<circle cx={HALF} cy={HALF} r={ring.r} pathLength={100} strokeWidth={Math.min(ring.w * 0.4, 1.4)} />
					</svg>
				))}
				{TEAL.map((ring, index) => (
					<svg
						key={`ring-${ring.r}`}
						ref={(node) => {
							rings.current[index] = node;
						}}
						className="clio-stage__layer clio-stage__ring"
						data-lit={lit(index) || undefined}
						viewBox={`0 0 ${LG.box} ${LG.box}`}
						aria-hidden="true"
					>
						<circle
							cx={HALF}
							cy={HALF}
							r={ring.r}
							pathLength={100}
							strokeWidth={ring.w}
							strokeDasharray={dashes(ring)}
							strokeDashoffset={-ring.gap / 2}
						/>
					</svg>
				))}
				{CORE ? (
					<svg
						ref={core}
						className="clio-stage__layer clio-stage__core"
						viewBox={`0 0 ${LG.box} ${LG.box}`}
						aria-hidden="true"
					>
						<circle
							cx={HALF}
							cy={HALF}
							r={CORE.r}
							pathLength={100}
							strokeWidth={CORE.w}
							strokeDasharray={dashes(CORE)}
							strokeDashoffset={-CORE.gap / 2}
						/>
					</svg>
				) : null}
				{TEAL[0] ? (
					<svg className="clio-stage__layer clio-stage__glint" viewBox={`0 0 ${LG.box} ${LG.box}`} aria-hidden="true">
						<defs>
							<mask id={mask}>
								<circle
									cx={HALF}
									cy={HALF}
									r={TEAL[0].r}
									pathLength={100}
									strokeWidth={TEAL[0].w}
									strokeDasharray={dashes(TEAL[0])}
									strokeDashoffset={-TEAL[0].gap / 2}
								/>
							</mask>
						</defs>
						<g mask={`url(#${mask})`}>
							<circle
								ref={glint}
								cx={HALF}
								cy={HALF}
								r={TEAL[0].r}
								pathLength={100}
								strokeWidth={TEAL[0].w + 1}
								strokeDasharray="10 90"
							/>
						</g>
					</svg>
				) : null}
			</span>
			<p className="clio-stage__caption">{caption}</p>
		</div>
	);
}
