import { useEffect, useRef, useState } from "react";
import { ClioPulse, PULSE_SIZE } from "../shell/ClioMark.js";
import type { SceneId } from "./wizard-model.js";

// The site's black-matte clips retain their own dark surface in both themes.
type Film = { video: string; poster: string; width: number; height: number };
const SCENES: Readonly<Record<SceneId, Film>> = {
	read: {
		video: new URL("./media/read.mp4", import.meta.url).href,
		poster: new URL("./media/read.webp", import.meta.url).href,
		width: 720,
		height: 540,
	},
	focus: {
		video: new URL("./media/focus.mp4", import.meta.url).href,
		poster: new URL("./media/focus.webp", import.meta.url).href,
		width: 720,
		height: 540,
	},
	helpers: {
		video: new URL("./media/helpers.mp4", import.meta.url).href,
		poster: new URL("./media/helpers.webp", import.meta.url).href,
		width: 720,
		height: 540,
	},
	inspect: {
		video: new URL("./media/inspect.mp4", import.meta.url).href,
		poster: new URL("./media/inspect.webp", import.meta.url).href,
		width: 720,
		height: 540,
	},
	finale: {
		video: new URL("./media/finale.mp4", import.meta.url).href,
		poster: new URL("./media/finale.webp", import.meta.url).href,
		width: 960,
		height: 540,
	},
};

/** Motion plays only when the person allows it: no reduced-motion preference and no data saver. */
function motionAllowed(): boolean {
	if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
	const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
	return connection?.saveData !== true;
}

function useMotionAllowed(): boolean {
	const [allowed, setAllowed] = useState(motionAllowed);
	useEffect(() => {
		if (typeof matchMedia !== "function") return;
		const query = matchMedia("(prefers-reduced-motion: reduce)");
		const change = () => setAllowed(motionAllowed());
		query.addEventListener("change", change);
		return () => query.removeEventListener("change", change);
	}, []);
	return allowed;
}

/**
 * The left half of the wizard: one of the Clio films, a still when motion is off, and one line under it.
 * A film plays once and rests on its last frame. While the child is working, the Clio spinner and a
 * word say so, because a film that has finished looks like a frozen page.
 */
export function Stage({
	scene,
	caption,
	working,
}: {
	scene: SceneId;
	caption: string;
	/** What Clio, a worker or the setup child is doing right now, or null when nothing is. */
	working: string | null;
}) {
	const motion = useMotionAllowed();
	const video = useRef<HTMLVideoElement>(null);
	const [playing, setPlaying] = useState(false);
	const source = SCENES[scene];
	const { width, height } = source;
	// biome-ignore lint/correctness/useExhaustiveDependencies: the scene id selects the clip; its URL is read from the table.
	useEffect(() => {
		const node = video.current;
		setPlaying(false);
		if (!node || !motion) return;
		let finished = false;
		node.src = source.video;
		const start = () => {
			if (document.visibilityState === "visible" && !finished) void node.play().catch(() => {});
		};
		const visible = () => {
			if (document.visibilityState === "visible") start();
			else node.pause();
		};
		node.addEventListener("playing", () => setPlaying(true), { once: true });
		node.addEventListener("ended", () => {
			finished = true;
		});
		document.addEventListener("visibilitychange", visible);
		start();
		return () => {
			document.removeEventListener("visibilitychange", visible);
			node.pause();
			node.removeAttribute("src");
			node.load();
		};
	}, [scene, motion]);
	return (
		<div className="wizard-stage" data-scene={scene}>
			<div className="wizard-stage__frame" data-playing={playing && motion ? "yes" : undefined}>
				<img
					key={scene}
					className="wizard-stage__poster"
					src={source.poster}
					width={width}
					height={height}
					alt=""
					decoding="async"
				/>
				<video
					ref={video}
					className="wizard-stage__film"
					width={width}
					height={height}
					muted
					playsInline
					preload="none"
					disablePictureInPicture
					disableRemotePlayback
					tabIndex={-1}
					aria-hidden="true"
				/>
			</div>
			<div className="wizard-stage__text">
				{working !== null ? (
					<p className="wizard-stage__working" role="status">
						<ClioPulse size={PULSE_SIZE.stage} />
						<span>{working}</span>
					</p>
				) : (
					<p className="wizard-stage__caption">{caption}</p>
				)}
			</div>
		</div>
	);
}
