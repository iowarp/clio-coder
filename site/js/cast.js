// Recorded captures: the page shows the poster still, a download, and the
// transcript. Play loads the terminal player and its styles on first press only;
// nothing plays on its own, and with reduced motion the player opens paused.
(() => {
	const script = document.currentScript;
	const figures = document.querySelectorAll("figure[data-cast]");
	if (!script || !figures.length) return;
	const reduced = matchMedia("(prefers-reduced-motion: reduce)");
	let loading;

	function load() {
		loading ??= new Promise((resolve, reject) => {
			for (const href of [script.dataset.playerCss, script.dataset.castCss]) {
				const link = document.createElement("link");
				link.rel = "stylesheet";
				link.href = href;
				document.head.append(link);
			}
			const player = document.createElement("script");
			player.src = script.dataset.playerSrc;
			player.onload = () => (window.AsciinemaPlayer ? resolve(window.AsciinemaPlayer) : reject(new Error("player")));
			player.onerror = reject;
			document.head.append(player);
		});
		return loading;
	}

	for (const figure of figures) {
		const frame = figure.querySelector(".capture-frame");
		if (!frame) continue;
		const stage = document.createElement("div");
		stage.className = "cast-stage";
		frame.replaceWith(stage);
		stage.append(frame);
		const button = document.createElement("button");
		button.type = "button";
		button.className = "cast-play";
		button.textContent = `▶ Play recording · ${figure.dataset.castLength}`;
		stage.append(button);
		button.addEventListener("click", async () => {
			button.disabled = true;
			button.textContent = "Loading the player…";
			try {
				const AsciinemaPlayer = await load();
				const host = document.createElement("div");
				host.className = "capture-frame cast-player";
				const player = AsciinemaPlayer.create(figure.dataset.cast, host, {
					cols: Number(figure.dataset.castCols),
					rows: Number(figure.dataset.castRows),
					autoPlay: !reduced.matches,
					preload: true,
					fit: "width",
					idleTimeLimit: 1,
					poster: `npt:${figure.dataset.castPoster}`,
				});
				stage.replaceWith(host);
				host.querySelector(".ap-player")?.focus?.();
				figure.dataset.castState = "playing";
				figure.castPlayer = player;
			} catch {
				button.disabled = false;
				button.textContent = "The player did not load. Use the download or transcript.";
			}
		});
	}
})();
