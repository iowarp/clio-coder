import { useEffect, useState, useSyncExternalStore } from "react";
import { forgetBrowser, rememberBrowser, rememberedTokenKey } from "../api/token.js";

type InstallPrompt = Event & { prompt(): Promise<unknown>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

/**
 * The browser fires `beforeinstallprompt` once, early, so it is captured here at the shell and not
 * where the Install button lives. A page that mounted late would never see it.
 */
interface PwaState {
	readonly prompt: InstallPrompt | null;
	readonly installed: boolean;
	readonly storage: boolean;
	readonly message: string;
}
let state: PwaState = { prompt: null, installed: false, storage: true, message: "" };
const listeners = new Set<() => void>();
function update(next: Partial<PwaState>): void {
	state = { ...state, ...next };
	for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};
const read = () => state;

/** Mounted once by the shell: install prompt capture, token memory, offline recovery and cross-tab sign-out. */
export function PwaBoot({ enabled, token }: { enabled: boolean; token: string }) {
	useEffect(() => {
		update({
			installed:
				window.matchMedia("(display-mode: standalone)").matches ||
				window.matchMedia("(display-mode: window-controls-overlay)").matches,
		});
		const ready = (event: Event) => {
			event.preventDefault();
			update({ prompt: event as InstallPrompt });
		};
		const completed = () =>
			update({
				installed: true,
				prompt: null,
				message: "Clio Coder is installed. Open it from your applications whenever you need it.",
			});
		const changed = (event: StorageEvent) => {
			if (event.key === rememberedTokenKey && event.newValue !== token) {
				try {
					sessionStorage.removeItem("clio-coder-token");
				} catch {
					/* Reload still drops the in-memory token. */
				}
				location.reload();
			}
		};
		window.addEventListener("beforeinstallprompt", ready);
		window.addEventListener("appinstalled", completed);
		window.addEventListener("storage", changed);
		return () => {
			window.removeEventListener("beforeinstallprompt", ready);
			window.removeEventListener("appinstalled", completed);
			window.removeEventListener("storage", changed);
		};
	}, [token]);
	useEffect(() => {
		if (!enabled || !token) return;
		update({ storage: rememberBrowser(token) });
		if ("serviceWorker" in navigator)
			void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() =>
				update({
					message: "Offline recovery could not be prepared. The connected app is still available; try reloading this page.",
				}),
			);
	}, [enabled, token]);
	return null;
}

/** The install and sign-out controls shown in General settings. */
export function AppPreferencesPanel({
	enabled,
	desktopManaged = false,
	version,
	platform,
}: {
	enabled: boolean;
	desktopManaged?: boolean;
	version: string | undefined;
	/** The server's `process.platform-arch`, which decides whether background setup exists at all. */
	platform: string | undefined;
}) {
	const pwa = useSyncExternalStore(subscribe, read, read);
	const [note, setNote] = useState("");
	const message = note || pwa.message;
	return (
		<div className="pwa-controls">
			<p className="app-version">{version ? `Version ${version}` : "Connecting to Clio…"}</p>
			{desktopManaged ? (
				<>
					<p>
						Open Clio Coder from the Windows Start Menu or run <code>clio-coder gui</code>. You can pin its window to the
						taskbar.
					</p>
					{pwa.prompt ? (
						<button
							type="button"
							onClick={() => {
								const prompt = pwa.prompt;
								if (!prompt) return;
								void prompt.prompt().catch(() => setNote("Use your browser’s Install app command, then reopen Clio Coder."));
							}}
						>
							Install integrated app window
						</button>
					) : null}
					<p>
						The installed app supports an integrated title bar. Use its Hide title bar control once; Windows keeps minimize,
						maximize and close. Reopening from the Start Menu keeps that choice.
					</p>
				</>
			) : enabled ? (
				<>
					<p>Keep Clio Coder beside your other apps. It uses the same projects and tasks as this browser.</p>
					{!pwa.storage ? (
						<p role="alert">
							This browser cannot save your connection. Allow site storage before installing so Clio can reconnect when
							reopened.
						</p>
					) : pwa.prompt ? (
						<button
							type="button"
							onClick={() => {
								const current = pwa.prompt;
								if (!current) return;
								update({ prompt: null });
								void current
									.prompt()
									.then(() => current.userChoice)
									.then((choice) => {
										if (choice.outcome === "dismissed")
											setNote("Installation was dismissed. You can install later from your browser's app menu.");
									})
									.catch(() => setNote("Use your browser's app menu to install Clio Coder."));
							}}
						>
							Install app
						</button>
					) : (
						!pwa.installed && (
							<p>Use your browser’s Install app or Add to Home Screen command. Installation options depend on your browser.</p>
						)
					)}
					<p>
						This browser stays connected on this device. Forgetting it keeps saved tasks in Clio, removes unsent drafts from
						this tab, and requires a fresh launch link to reconnect.
					</p>
					<button type="button" onClick={forgetBrowser}>
						Forget this browser
					</button>
				</>
			) : (
				<div className="app-dialog__launch">
					<p>This window's server belongs to the terminal that started it, and its address changes each time it starts.</p>
					{platform?.startsWith("linux") ? (
						<p>
							For one address from login that this browser can install as an app, run{" "}
							<code>clio-coder gui background install --open</code> in a terminal. Afterwards <code>clio-coder gui</code>{" "}
							reopens it.
						</p>
					) : (
						<p>Keeping Clio Coder at one address from login currently needs Linux with a systemd user session.</p>
					)}
				</div>
			)}
			{message && <p role="status">{message}</p>}
		</div>
	);
}
