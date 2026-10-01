(() => {
	const chapters = [...document.querySelectorAll("[data-chapter]")];
	const stage = document.querySelector(".companion-stage");
	if (!stage || !("IntersectionObserver" in window)) return;

	const reduced = matchMedia("(prefers-reduced-motion: reduce)");
	const wide = matchMedia("(min-width: 1001px) and (min-height: 651px)");
	const toggles = [...document.querySelectorAll("[data-motion-toggle]")];
	const replay = document.querySelector("[data-replay]");
	const caption = document.querySelector("[data-companion-caption]");
	const links = [...document.querySelectorAll(".chapter-nav a")];
	for (const scene of document.querySelectorAll(".chapter-visual .clio-scene")) {
		stage.append(scene.cloneNode(true));
	}
	const scenes = [...document.querySelectorAll(".clio-scene:has(video)")].map((element) => ({
		element,
		video: element.querySelector("video"),
		visible: false,
		complete: false,
		failed: false,
		pending: false,
	}));
	let paused = Boolean(navigator.connection?.saveData);
	try {
		const preference = sessionStorage.getItem("clio-motion-paused");
		if (preference !== null) paused = preference === "true";
	} catch {
		// Motion controls still work when session storage is unavailable.
	}
	let ready = false;
	let current = null;
	let activeChapter = null;
	let scheduled = false;
	const canMove = () => ready && !paused && !reduced.matches && !document.hidden;
	const isEligible = (scene) => {
		if (!scene.visible || scene.complete || scene.failed) return false;
		if (scene.element.parentElement === stage)
			return wide.matches && scene.element.dataset.scene === activeChapter?.dataset.chapterScene;
		if (scene.element.closest(".chapter-visual")) return !wide.matches;
		return true;
	};
	function reconcile() {
		const eligible = canMove() ? scenes.filter(isEligible) : [];
		const next = eligible.sort((a, b) => {
			const distance = (scene) => {
				const box = scene.element.getBoundingClientRect();
				return Math.abs(box.top + box.height / 2 - innerHeight / 2);
			};
			return distance(a) - distance(b);
		})[0] ?? null;
		current = next;
		for (const scene of scenes) {
			if (scene !== next) scene.video.pause();
			if (paused || reduced.matches) delete scene.element.dataset.playing;
		}
		if (!next || next.pending || !next.video.paused) return;
		const video = next.video;
		if (!video.hasAttribute("src")) {
			video.muted = true;
			video.src = video.dataset.src;
		}
		next.pending = true;
		video.play().then(() => {
			next.pending = false;
			if (current !== next || !canMove()) video.pause();
		}).catch((error) => {
			next.pending = false;
			// Leaving a chapter can interrupt play; a rejected autoplay keeps its still image.
			if (error.name !== "AbortError") next.failed = true;
			delete next.element.dataset.playing;
		});
	}
	for (const scene of scenes) {
		scene.video.addEventListener("playing", () => {
			if (current === scene && canMove()) scene.element.dataset.playing = "";
			else scene.video.pause();
		});
		scene.video.addEventListener("ended", () => {
			scene.complete = true;
			delete scene.element.dataset.playing;
			reconcile();
		});
		scene.video.addEventListener("error", () => {
			scene.failed = true;
			delete scene.element.dataset.playing;
		});
	}
	const visible = new IntersectionObserver((entries) => {
		for (const entry of entries) {
			const scene = scenes.find((item) => item.element === entry.target);
			scene.visible = entry.isIntersecting && entry.intersectionRatio >= 0.35;
		}
		reconcile();
	}, { threshold: [0, 0.35] });
	for (const scene of scenes) visible.observe(scene.element);

	function updateChapter() {
		scheduled = false;
		const line = innerHeight * 0.4;
		activeChapter = chapters.findLast((chapter) => chapter.getBoundingClientRect().top <= line) ?? chapters[0];
		caption.textContent = activeChapter.dataset.chapter;
		for (const scene of stage.querySelectorAll("[data-scene]:not(.rail-rest)")) {
			scene.toggleAttribute("data-active", scene.dataset.scene === activeChapter.dataset.chapterScene);
		}
		for (const link of links) {
			if (link.hash === `#${activeChapter.id}`) link.setAttribute("aria-current", "location");
			else link.removeAttribute("aria-current");
		}
		reconcile();
	}
	function updateControls() {
		document.body.toggleAttribute("data-motion-paused", paused || reduced.matches);
		for (const button of toggles) {
			button.hidden = false;
			button.disabled = reduced.matches;
			button.setAttribute("aria-pressed", String(paused || reduced.matches));
			button.textContent = reduced.matches ? "Reduced motion" : paused ? "Resume motion" : "Pause motion";
		}
		replay.hidden = false;
		replay.disabled = paused || reduced.matches;
		reconcile();
	}
	for (const button of toggles) button.addEventListener("click", () => {
		paused = !paused;
		if (!paused) for (const scene of scenes) scene.failed = false;
		try {
			sessionStorage.setItem("clio-motion-paused", String(paused));
		} catch {
			// A blocked storage area must not prevent pausing the films.
		}
		updateControls();
	});
	replay.addEventListener("click", () => {
		const finale = scenes.find((scene) => scene.element.dataset.scene === "finale");
		finale.complete = false;
		finale.failed = false;
		finale.video.currentTime = 0;
		reconcile();
	});
	addEventListener("scroll", () => {
		if (!scheduled) {
			scheduled = true;
			requestAnimationFrame(updateChapter);
		}
	}, { passive: true });
	addEventListener("resize", updateChapter);
	wide.addEventListener("change", updateChapter);
	reduced.addEventListener("change", updateControls);
	document.addEventListener("visibilitychange", reconcile);
	// The initial image and fonts finish before decorative video competes for bandwidth.
	const start = () => { ready = true; reconcile(); };
	if (document.readyState === "complete") start();
	else addEventListener("load", start, { once: true });
	updateChapter();
	updateControls();
})();
