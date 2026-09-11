/**
 * Embeds one handmade documentation blueprint inside the application.
 *
 * The blueprint loads in an opaque-origin iframe (`sandbox="allow-scripts"`
 * only) from `/docs-html/<file>?embed=1&theme=…`; the server injects the
 * presentation bridge described in server/http/docs-presentation.ts. This
 * side of the bridge validates `event.source`, narrows navigation requests to
 * an allowlist of app routes, bounds the reported height, and pushes theme
 * changes down. External links never become parent commands: the child
 * refuses to follow them and the parent shows an explicit link instead.
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

export const BLUEPRINT_ROUTE = "/docs/blueprints/";
const MIN_HEIGHT = 320;
const MAX_HEIGHT = 60_000;
const CHROME_HEIGHT = 58 + 28;
const READY_TIMEOUT_MS = 12_000;
const SEGMENT = "[A-Za-z0-9._~%-]+";
/** App routes a blueprint may ask the parent to open: the docs map, a Markdown page or another blueprint. */
const INTERNAL_HREF = new RegExp(
	`^/docs(?:/(?:blueprints/${SEGMENT}\\.html?|(?:${SEGMENT}/)*${SEGMENT}\\.md))?(?:#[A-Za-z0-9._~%-]*)?$`,
	"i",
);

/** True only for a well-formed application route whose decoded segments cannot climb or smuggle separators. */
export function isInternalRoute(href: string): boolean {
	if (href.length > 1024 || !INTERNAL_HREF.test(href)) return false;
	const path = href.split("#")[0] ?? "";
	for (const segment of path.split("/").slice(1)) {
		let decoded: string;
		try {
			decoded = decodeURIComponent(segment);
		} catch {
			return false;
		}
		// biome-ignore lint/suspicious/noControlCharactersInRegex: Control characters are exactly what this rejects.
		if (decoded === "." || decoded === ".." || /[/\\\x00-\x1f\x7f]/.test(decoded)) return false;
	}
	return true;
}

export type Theme = "light" | "dark";

function readTheme(): Theme {
	return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** Follows the application theme that ThemeToggle writes to `<html data-theme>`. */
export function useAppTheme(): Theme {
	const [theme, setTheme] = useState<Theme>(readTheme);
	useEffect(() => {
		setTheme(readTheme());
		const observer = new MutationObserver(() => setTheme(readTheme()));
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
		return () => observer.disconnect();
	}, []);
	return theme;
}

export function blueprintRoute(file: string, hash = ""): string {
	return `${BLUEPRINT_ROUTE}${encodeURIComponent(file)}${hash}`;
}

export function blueprintSource(file: string, theme: Theme, hash = ""): string {
	return `/docs-html/${encodeURIComponent(file)}?embed=1&theme=${theme}${hash}`;
}

function clampHeight(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(value)));
}

function useViewportHeight(): number {
	const [height, setHeight] = useState(() => window.innerHeight);
	useEffect(() => {
		let frame = 0;
		const update = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => setHeight(window.innerHeight));
		};
		window.addEventListener("resize", update);
		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener("resize", update);
		};
	}, []);
	return height;
}

interface BlueprintFrameProps {
	readonly file: string;
	/** Fragment from the application route, forwarded to the document. */
	readonly hash: string;
	/** Accessible name for the frame, shown nowhere else. */
	readonly title: string;
	/** Receives the document's own heading once it announces readiness. */
	readonly onTitle?: (title: string) => void;
}

export function BlueprintFrame(props: BlueprintFrameProps) {
	const theme = useAppTheme();
	const themeRef = useRef(theme);
	themeRef.current = theme;
	// The theme in the URL only seeds the first paint; later changes travel by message so the frame never reloads.
	const src = useMemo(() => blueprintSource(props.file, themeRef.current, props.hash), [props.file, props.hash]);
	return <BlueprintDocument key={src} src={src} theme={theme} {...props} />;
}

function BlueprintDocument({
	src,
	theme,
	file,
	title,
	onTitle,
}: BlueprintFrameProps & { readonly src: string; readonly theme: Theme }) {
	const navigate = useNavigate();
	const frame = useRef<HTMLIFrameElement>(null);
	const viewport = useViewportHeight();
	const [state, setState] = useState<"loading" | "ready" | "timeout">("loading");
	const [contentHeight, setContentHeight] = useState<number | null>(null);
	const [external, setExternal] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const probe = useQuery({
		queryKey: ["docs-blueprint-probe", file, attempt],
		queryFn: async () => {
			// A GET rather than HEAD: Chromium reports a bodiless HEAD response as an aborted request.
			const response = await fetch(blueprintSource(file, "light"), { cache: "no-store", credentials: "same-origin" });
			await response.arrayBuffer();
			return { ok: response.ok, status: response.status };
		},
		staleTime: 60_000,
		retry: false,
	});
	const mounted = probe.data?.ok === true;
	useEffect(() => {
		function onMessage(event: MessageEvent) {
			const child = frame.current?.contentWindow;
			if (!child || event.source !== child) return;
			const data: unknown = event.data;
			if (!data || typeof data !== "object" || (data as { type?: unknown }).type !== "clio:blueprint") return;
			const message = data as { event?: unknown; height?: unknown; href?: unknown; title?: unknown };
			switch (message.event) {
				case "ready": {
					setState("ready");
					const height = clampHeight(message.height);
					if (height !== null) setContentHeight(height);
					if (typeof message.title === "string" && message.title.trim()) onTitle?.(message.title.trim().slice(0, 200));
					return;
				}
				case "resize": {
					const height = clampHeight(message.height);
					if (height !== null) setContentHeight((current) => (current === height ? current : height));
					return;
				}
				case "navigate":
					if (typeof message.href === "string" && isInternalRoute(message.href)) void navigate(message.href);
					return;
				case "external":
					if (typeof message.href === "string" && message.href.length <= 2048 && /^https?:\/\/[^\s]+$/i.test(message.href))
						setExternal(message.href);
					return;
				default:
					return;
			}
		}
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [navigate, onTitle]);
	useEffect(() => {
		if (state !== "ready") return;
		// The child's origin is opaque, so "*" is the only deliverable target; the payload is just the theme name.
		frame.current?.contentWindow?.postMessage({ type: "clio:blueprint-theme", theme }, "*");
	}, [theme, state]);
	useEffect(() => {
		if (!mounted || state !== "loading") return;
		const timer = setTimeout(() => setState("timeout"), READY_TIMEOUT_MS);
		return () => clearTimeout(timer);
	}, [mounted, state]);
	const available = Math.max(MIN_HEIGHT, viewport - CHROME_HEIGHT);
	const height = contentHeight === null ? available : Math.min(available, contentHeight + 2);
	if (probe.isPending) {
		return (
			<p className="blueprint-status" role="status">
				Checking the blueprint…
			</p>
		);
	}
	if (probe.error || !probe.data.ok) {
		const status = probe.data?.status;
		return (
			<div className="blueprint-problem" role="alert">
				<h3>Blueprint unavailable</h3>
				<p>
					{probe.error
						? `The blueprint could not be requested: ${probe.error.message}`
						: status === 404
							? `No blueprint file named ${file} exists in this installation.`
							: status === 403
								? "This blueprint path is outside the documentation root."
								: `The server answered with status ${status}.`}
				</p>
				<button type="button" onClick={() => setAttempt((current) => current + 1)}>
					Try again
				</button>
			</div>
		);
	}
	return (
		<div className={`blueprint-frame is-${state}`}>
			{state === "loading" && (
				<p className="blueprint-status" role="status">
					Loading the blueprint…
				</p>
			)}
			{state === "timeout" && (
				<div className="blueprint-problem" role="alert">
					<p>The blueprint has not finished loading. It may still appear below.</p>
					<button
						type="button"
						onClick={() => {
							setState("loading");
							setAttempt((current) => current + 1);
						}}
					>
						Reload blueprint
					</button>
				</div>
			)}
			{external !== null && (
				<div className="blueprint-external" role="status">
					<p>
						This blueprint links outside the application:{" "}
						<a href={external} target="_blank" rel="noopener noreferrer">
							{external}
						</a>
					</p>
					<button type="button" onClick={() => setExternal(null)}>
						Dismiss
					</button>
				</div>
			)}
			<iframe
				ref={frame}
				key={attempt}
				className="blueprint-frame__document"
				title={`${title} · blueprint`}
				src={src}
				sandbox="allow-scripts"
				referrerPolicy="no-referrer"
				style={{ height }}
			/>
		</div>
	);
}
