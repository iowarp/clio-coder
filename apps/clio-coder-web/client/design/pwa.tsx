import { useEffect, useRef, useState } from "react";
import { forgetBrowser, rememberBrowser, rememberedTokenKey } from "../api/token.js";

import { Icon } from "./icons.js";

type InstallPrompt = Event & { prompt(): Promise<unknown>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
function PwaControls({ enabled, token }: { enabled: boolean; token: string }) {
	const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
	const [installed, setInstalled] = useState(false);
	const [storage, setStorage] = useState(true);
	const [message, setMessage] = useState("");
	useEffect(() => {
		setInstalled(window.matchMedia("(display-mode: standalone)").matches);
		const ready = (event: Event) => {
			event.preventDefault();
			setPrompt(event as InstallPrompt);
		};
		const completed = () => {
			setInstalled(true);
			setPrompt(null);
			setMessage("Clio Coder is installed. Open it from your applications whenever you need it.");
		};
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
		setStorage(rememberBrowser(token));
		if ("serviceWorker" in navigator)
			void navigator.serviceWorker
				.register("/sw.js", { scope: "/", updateViaCache: "none" })
				.catch(() =>
					setMessage(
						"Offline recovery could not be prepared. The connected app is still available; try reloading this page.",
					),
				);
	}, [enabled, token]);
	if (!enabled) return null;
	return (
		<details className="pwa-controls">
			<summary>{installed ? "Installed app preferences" : "Install Clio Coder"}</summary>
			<p>Keep Clio beside your other apps. It uses the same projects and conversations as this browser.</p>
			{!storage ? (
				<p role="alert">
					This browser cannot save your connection. Allow site storage before installing so Clio can reconnect when reopened.
				</p>
			) : prompt ? (
				<button
					type="button"
					onClick={() => {
						const current = prompt;
						setPrompt(null);
						void current
							.prompt()
							.then(() => current.userChoice)
							.then((choice) => {
								if (choice.outcome === "dismissed")
									setMessage("Installation was dismissed. You can install later from your browser's app menu.");
							})
							.catch(() => setMessage("Use your browser's app menu to install Clio Coder."));
					}}
				>
					Install app
				</button>
			) : (
				!installed && (
					<p>Use your browser’s Install app or Add to Home Screen command. Installation options depend on your browser.</p>
				)
			)}
			<p>
				This browser stays connected on this device. Forgetting it keeps your work in Clio and requires the Clio desktop
				launcher to reconnect.
			</p>
			<button type="button" onClick={forgetBrowser}>
				Forget this browser
			</button>
			{message && <p role="status">{message}</p>}
		</details>
	);
}

export function AppPreferences({
	enabled,
	token,
	version,
}: {
	enabled: boolean;
	token: string;
	version: string | undefined;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	return (
		<>
			<button
				className="icon-button"
				type="button"
				aria-label="App preferences"
				title="App preferences"
				onClick={() => dialog.current?.showModal()}
			>
				<Icon name="more" />
			</button>
			<dialog ref={dialog} className="app-dialog" aria-label="App preferences">
				<div className="toast-heading">
					<strong className="brand">
						<img src="/clio-coder-logo.webp" alt="" width="36" height="36" />
						Clio Coder
					</strong>
					<button
						className="icon-button"
						type="button"
						aria-label="Close app preferences"
						onClick={() => dialog.current?.close()}
					>
						<Icon name="close" />
					</button>
				</div>
				<p className="app-version">{version ? `Version ${version}` : "Connecting to Clio…"}</p>
				<PwaControls enabled={enabled} token={token} />
				{!enabled && (
					<p>
						Clio is running for this session. To keep the installed app available, enable the background server from the
						terminal.
					</p>
				)}
			</dialog>
		</>
	);
}
