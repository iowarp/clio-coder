(() => {
	const stage = document.querySelector(".companion-stage");
	if (!stage || !("IntersectionObserver" in window)) return;
	const chapters = [...document.querySelectorAll("[data-chapter]")];
	const heroSlot = document.querySelector(".hero-portrait .scene-slot");
	const reduced = matchMedia("(prefers-reduced-motion: reduce)");
	const wide = matchMedia("(min-width: 1001px) and (min-height: 651px)");
	const root = document.documentElement;
	const settle = parseFloat(getComputedStyle(root).getPropertyValue("--motion-base"));
	const toggles = [...document.querySelectorAll("[data-motion-toggle]")];
	const replay = document.querySelector("[data-replay]");
	const links = [...document.querySelectorAll(".chapter-nav a")];
	const scenes = [...document.querySelectorAll("[data-scene]:has(video)")].map((element) => ({
		element,
		id: element.dataset.scene,
		video: element.querySelector("video"),
		owner: element.parentElement,
		chapter: element.closest("[data-chapter]"),
		visible: false,
		complete: false,
		failed: false,
		pending: false,
		generation: 0,
		position: 0,
	}));
	const byElement = new Map(scenes.map((scene) => [scene.element, scene]));
	const heroScene = scenes.find((scene) => scene.id === "hello");
	const finale = scenes.find((scene) => scene.id === "finale");
	let paused = Boolean(navigator.connection?.saveData);
	try {
		const preference = sessionStorage.getItem("clio-coder-motion-paused");
		if (preference !== null) paused = preference === "true";
	} catch {
		// Storage is optional; the controls still work for this page.
	}
	let ready = false;
	let current = null;
	let presented = null;
	let journeyVisible = false;
	let activeChapter = null;
	let playbackTimer;
	let startAt = 0;
	let frame = 0;
	let measureNeeded = true;
	let geometry;
	const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
	const ease = (value) => value * value * (3 - 2 * value);
	const mix = (from, to, progress) => from + (to - from) * progress;
	const canMove = () => ready && !paused && !reduced.matches && !document.hidden;
	const eligible = (scene) =>
		!scene.complete && !scene.failed && (scene === finale ? scene.visible : scene === presented && journeyVisible);

	function reconcile() {
		clearTimeout(playbackTimer);
		const next = canMove() ? (current && eligible(current) ? current : scenes.find(eligible)) : null;
		if (next !== current) {
			current = next;
			startAt = performance.now() + settle;
		}
		for (const scene of scenes) if (scene !== next && !scene.video.paused) scene.video.pause();
		if (!next) return;
		const remaining = startAt - performance.now();
		if (remaining > 0) {
			playbackTimer = setTimeout(reconcile, remaining);
			return;
		}
		if (next.pending || !next.video.paused) return;
		const video = next.video;
		if (!video.hasAttribute("src")) {
			const light = root.dataset.theme === "light";
			next.element.dataset.matte = light ? "light" : "dark";
			video.muted = true;
			video.src = light ? video.dataset.lightSrc : video.dataset.src;
		}
		const generation = next.generation;
		next.pending = true;
		video
			.play()
			.then(() => {
				if (generation !== next.generation) return;
				next.pending = false;
				if (current !== next || !canMove()) video.pause();
			})
			.catch((error) => {
				if (generation !== next.generation) return;
				next.pending = false;
				// An interrupted handoff can abort play without making the clip unusable.
				if (error.name !== "AbortError") next.failed = true;
			});
	}
	function releaseSource(scene) {
		scene.position = scene.video.currentTime;
		scene.generation++;
		scene.pending = false;
		scene.video.pause();
		scene.video.removeAttribute("src");
		scene.video.load();
		delete scene.element.dataset.frame;
	}
	for (const scene of scenes) {
		scene.video.addEventListener("loadedmetadata", () => {
			if (scene.position) scene.video.currentTime = scene.position;
		});
		scene.video.addEventListener("playing", () => {
			if (current === scene && canMove()) scene.element.dataset.frame = "";
			else scene.video.pause();
		});
		scene.video.addEventListener("ended", () => {
			scene.complete = true;
			reconcile();
		});
		scene.video.addEventListener("error", () => {
			if (!scene.video.hasAttribute("src")) return;
			scene.failed = true;
			delete scene.element.dataset.frame;
		});
	}
	const visible = new IntersectionObserver(
		(entries) => {
			for (const entry of entries)
				byElement.get(entry.target).visible = entry.isIntersecting && entry.intersectionRatio >= 0.35;
			reconcile();
		},
		{ threshold: [0, 0.35] },
	);
	visible.observe(finale.element);

	function place(scene, parent) {
		if (scene.element.parentElement === parent) return;
		// Preserve playback state across docking and viewport changes where supported.
		if (parent.moveBefore) parent.moveBefore(scene.element, null);
		else parent.append(scene.element);
	}
	function present(scene, show) {
		if (presented === scene && journeyVisible === show) return;
		presented = scene;
		journeyVisible = show;
		stage.toggleAttribute("data-visible", show);
		for (const item of scenes) {
			if (item === finale) continue;
			const selected = item === scene && show;
			item.element.toggleAttribute("data-active", selected);
			place(item, selected ? stage : item.owner);
		}
		reconcile();
	}
	function selectChapter(chapter) {
		if (chapter === activeChapter) return;
		activeChapter = chapter;
		for (const link of links) {
			if (chapter && link.hash === `#${chapter.id}`) link.setAttribute("aria-current", "location");
			else link.removeAttribute("aria-current");
		}
	}
	function measure() {
		const position = (element) => {
			const rect = element.getBoundingClientRect();
			return {
				left: rect.left,
				top: rect.top + scrollY,
				width: rect.width,
				height: rect.height,
				bottom: rect.bottom + scrollY,
				x: rect.left + rect.width / 2,
			};
		};
		geometry = {
			width: innerWidth,
			height: innerHeight,
			header: document.querySelector(".mast").getBoundingClientRect().height,
			hero: position(heroSlot),
			chapters: chapters.map((element) => ({
				element,
				...position(element),
				lane: position(element.querySelector(".chapter-visual")),
				slot: position(element.querySelector(".scene-slot")),
				padding: parseFloat(getComputedStyle(element).paddingTop),
				scene: scenes.find((scene) => scene.chapter === element) ?? null,
			})),
		};
		measureNeeded = false;
	}
	function paint(x, y, width, scene, opacity = 1) {
		// A fixed-size canvas needs only a compositor transform as it travels.
		stage.style.transform = `translate3d(${(x - width / 2).toFixed(2)}px, ${(y - width * 0.375).toFixed(2)}px, 0) scale(${width / 720})`;
		stage.style.setProperty("--companion-visibility", String(opacity));
		present(scene, true);
	}
	function desktopJourney(y) {
		const { hero, chapters: stops, height } = geometry;
		const viewportY = height * 0.45;
		const documentY = Math.max(y + viewportY, hero.top + hero.height / 2);
		const first = stops[0];
		const last = stops.at(-1);
		if (documentY >= last.bottom) {
			present(null, false);
			return;
		}
		const index = Math.max(
			0,
			stops.findLastIndex((stop) => stop.top <= documentY),
		);
		const stop = stops[index];
		const base = Math.min(320, stop.lane.width - 32);
		const introduction = ease(
			clamp((documentY - hero.top - hero.height / 2) / (first.lane.top - hero.top - hero.height / 2)),
		);
		if (introduction < 1) {
			paint(
				mix(hero.x, first.lane.x, introduction),
				documentY - y,
				mix(hero.width * 1.18, base, introduction),
				documentY < first.top ? heroScene : first.scene,
			);
			return;
		}
		let x = stop.lane.x;
		let width = base;
		let drift = Math.sin(clamp((documentY - stop.top) / stop.height) * Math.PI) * 24;
		const boundary = stops.slice(1).find((item) => Math.abs(documentY - item.top) < item.padding * 1.4);
		if (boundary) {
			const previous = stops[stops.indexOf(boundary) - 1];
			const offset = documentY - boundary.top;
			const bridge = boundary.padding * 0.4;
			const progress = ease(clamp((offset + bridge) / (bridge * 2)));
			x = mix(previous.lane.x, boundary.lane.x, progress);
			const proximity = ease(clamp(Math.abs(offset) / (boundary.padding * 1.4)));
			width = mix(Math.min(base, boundary.padding * 1.3), base, proximity);
			drift *= proximity;
		}
		paint(x, documentY - y + drift, width, stop.scene);
	}
	function mobileJourney(y) {
		const { hero, chapters: stops, height, header, width } = geometry;
		const bands = [
			{ slot: hero, scene: heroScene, reverse: false },
			...stops.map((stop, index) => ({ ...stop, reverse: index % 2 === 1 })),
		];
		const band = bands
			.filter(
				({ slot }) =>
					Math.min(slot.bottom - y, height) - Math.max(slot.top - y, header) >= Math.min(slot.height * 0.35, 64),
			)
			.sort(
				(a, b) =>
					Math.abs(a.slot.top + a.slot.height / 2 - y - height * 0.45) -
					Math.abs(b.slot.top + b.slot.height / 2 - y - height * 0.45),
			)[0];
		if (!band) {
			present(null, false);
			return;
		}
		const { slot } = band;
		const size = Math.min(232, width * 0.58, slot.width, slot.height / 0.75);
		let progress = ease(clamp(((y + height - slot.top) / (height + slot.height) - 0.2) / 0.6));
		if (band.reverse) progress = 1 - progress;
		const fraction = (Math.min(slot.bottom - y, height) - Math.max(slot.top - y, header)) / slot.height;
		paint(
			slot.left + size / 2 + (slot.width - size) * progress,
			slot.top + slot.height / 2 - y,
			size,
			band.scene,
			ease(clamp((fraction - 0.35) / 0.4)),
		);
	}
	function render() {
		frame = 0;
		if (measureNeeded) measure();
		const y = scrollY;
		selectChapter(geometry.chapters.findLast((stop) => stop.top <= y + geometry.height * 0.4)?.element ?? null);
		if (!canMove()) return;
		if (wide.matches) desktopJourney(y);
		else mobileJourney(y);
	}
	function schedule() {
		if (!frame) frame = requestAnimationFrame(render);
	}
	function layout() {
		measureNeeded = true;
		schedule();
	}
	function updateControls() {
		const stopped = paused || reduced.matches;
		document.body.toggleAttribute("data-motion-paused", stopped);
		document.body.toggleAttribute("data-companion-enabled", ready && !stopped);
		if (stopped) present(null, false);
		if (reduced.matches) for (const scene of scenes) delete scene.element.dataset.frame;
		for (const button of toggles) {
			button.hidden = false;
			button.disabled = reduced.matches;
			button.setAttribute("aria-pressed", String(stopped));
			button.textContent = reduced.matches ? "Reduced motion" : paused ? "Resume motion" : "Pause motion";
		}
		replay.hidden = false;
		replay.disabled = stopped;
		layout();
		reconcile();
	}
	for (const button of toggles)
		button.addEventListener("click", () => {
			paused = !paused;
			if (!paused) for (const scene of scenes) scene.failed = false;
			try {
				sessionStorage.setItem("clio-coder-motion-paused", String(paused));
			} catch {
				/* A blocked storage area must not prevent pausing the films. */
			}
			updateControls();
		});
	replay.addEventListener("click", () => {
		finale.complete = false;
		finale.failed = false;
		finale.position = 0;
		finale.video.currentTime = 0;
		reconcile();
	});
	new MutationObserver(() => {
		for (const scene of scenes) if (scene.video.hasAttribute("src")) releaseSource(scene);
		reconcile();
	}).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
	addEventListener("scroll", schedule, { passive: true });
	addEventListener("resize", layout);
	if ("ResizeObserver" in window) new ResizeObserver(layout).observe(document.querySelector("main"));
	wide.addEventListener("change", layout);
	reduced.addEventListener("change", updateControls);
	document.addEventListener("visibilitychange", () => {
		reconcile();
		schedule();
	});
	const start = () => {
		ready = true;
		updateControls();
	};
	if (document.readyState === "complete") start();
	else addEventListener("load", start, { once: true });
	updateControls();
})();
