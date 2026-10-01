(() => {
	const root = document.documentElement;
	const system = matchMedia("(prefers-color-scheme: light)");
	system.addEventListener("change", () => {
		let saved;
		try {
			saved = localStorage.getItem("clio-theme");
		} catch {
			/* Storage is optional. */
		}
		const requested = new URLSearchParams(location.search).get("theme");
		if (
			document.querySelector('meta[name="clio-default-theme"]')?.content === "system" &&
			!["light", "dark"].includes(saved) &&
			!["light", "dark"].includes(requested)
		)
			applyTheme(system.matches ? "light" : "dark", false);
	});
	const announcement = document.createElement("p");
	announcement.className = "sr-only";
	announcement.setAttribute("role", "status");
	document.body.append(announcement);

	function applyTheme(theme, persist = true) {
		root.dataset.theme = theme;
		try {
			if (persist) localStorage.setItem("clio-theme", theme);
		} catch {
			// The palette works even when storage is unavailable.
		}
		const meta = document.querySelector('meta[name="theme-color"]');
		if (meta) meta.content = getComputedStyle(root).getPropertyValue("--paper").trim();
		for (const button of document.querySelectorAll("[data-theme-toggle]")) {
			button.setAttribute("aria-label", theme === "light" ? "Switch to dark theme" : "Switch to light theme");
			if (!button.querySelector("span")) button.innerHTML = '<span aria-hidden="true">◐</span>';
		}
	}
	applyTheme(root.dataset.theme || "dark", false);
	for (const button of document.querySelectorAll("[data-theme-toggle]")) {
		button.addEventListener("click", () => applyTheme(root.dataset.theme === "light" ? "dark" : "light"));
	}

	const menus = [...document.querySelectorAll(".nav-more")];
	for (const menu of menus) {
		menu.addEventListener("focusout", () =>
			requestAnimationFrame(() => {
				if (!menu.contains(document.activeElement)) menu.open = false;
			}),
		);
		menu.addEventListener("toggle", () => {
			if (menu.open) for (const other of menus) if (other !== menu) other.open = false;
		});
	}
	document.addEventListener("click", (event) => {
		for (const menu of menus) if (!menu.contains(event.target)) menu.open = false;
	});
	document.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") return;
		for (const menu of menus) {
			if (!menu.open) continue;
			menu.open = false;
			menu.querySelector("summary").focus();
		}
	});

	for (const pre of document.querySelectorAll("pre")) {
		if (!pre.querySelector("code") || pre.classList.contains("no-copy")) continue;
		const button = document.createElement("button");
		button.type = "button";
		button.className = "copy code-copy";
		button.textContent = "Copy";
		button.setAttribute("aria-label", "Copy code example");
		button.dataset.copy = pre.textContent.trim();
		let block = pre.closest(".code-block");
		if (!block) {
			block = document.createElement("div");
			block.className = "code-block";
			pre.before(block);
			block.append(pre);
		}
		block.append(button);
	}
	for (const button of document.querySelectorAll("[data-copy-from]")) {
		const source = document.querySelector(button.dataset.copyFrom);
		if (source) button.dataset.copy = source.textContent.trim();
	}
	const copyTimers = new WeakMap();
	const feedback = parseFloat(getComputedStyle(root).getPropertyValue("--motion-feedback")) || 1800;
	for (const button of document.querySelectorAll("[data-copy]")) {
		button.addEventListener("click", async () => {
			const previous = button.dataset.copyLabel ?? button.textContent;
			button.dataset.copyLabel = previous;
			clearTimeout(copyTimers.get(button));
			try {
				await navigator.clipboard.writeText(button.dataset.copy || "");
				button.textContent = "Copied";
				button.dataset.copyState = "success";
				announcement.textContent = "Copied to clipboard.";
			} catch {
				button.textContent = "Copy failed";
				button.dataset.copyState = "error";
				announcement.textContent = "Copy failed. Select and copy the command text.";
			}
			copyTimers.set(
				button,
				window.setTimeout(() => {
					button.textContent = previous;
					delete button.dataset.copyState;
				}, feedback),
			);
		});
	}
	const captures = [...document.querySelectorAll('a[href^="/assets/"][href$=".png"]')].filter((link) =>
		link.querySelector("img"),
	);
	if (captures.length && "HTMLDialogElement" in window && "showModal" in HTMLDialogElement.prototype) {
		const viewer = document.createElement("dialog");
		viewer.className = "media-dialog";
		viewer.setAttribute("aria-labelledby", "media-title");
		viewer.setAttribute("aria-describedby", "media-caption");
		viewer.innerHTML = `<div class="media-header"><h2 id="media-title">Clio Coder</h2><button class="media-close" type="button" aria-label="Close screenshot">Close <span aria-hidden="true">×</span></button></div><div class="image-view"><img alt="" decoding="async"></div><div class="media-footer"><p class="caption" id="media-caption"></p><div class="media-controls"><button type="button" data-media="previous" aria-label="Previous screenshot">←</button><button type="button" data-media="next" aria-label="Next screenshot">→</button><button type="button" data-media="zoom" aria-pressed="false">Actual size</button><a class="text-link" data-media="original" target="_blank" rel="noopener">Open original <span class="arrow arrow-diagonal" aria-hidden="true">↗</span></a></div></div>`;
		document.body.append(viewer);
		const image = viewer.querySelector("img");
		const viewport = viewer.querySelector(".image-view");
		const zoom = viewer.querySelector('[data-media="zoom"]');
		let current = 0;
		let opener;
		const fit = () => {
			delete viewport.dataset.zoom;
			zoom.setAttribute("aria-pressed", "false");
			zoom.textContent = "Actual size";
			viewport.scrollTo(0, 0);
		};
		const show = (position) => {
			current = (position + captures.length) % captures.length;
			const link = captures[current];
			const source = link.querySelector("img");
			// Load the full WebP only when a reader opens the viewer; keep the original PNG available.
			image.src = new URL(link.href).pathname.replace(/\.png$/, ".webp");
			image.alt = source.alt;
			image.width = Number(source.getAttribute("width"));
			image.height = Number(source.getAttribute("height"));
			viewer.querySelector("#media-caption").textContent = source.alt;
			viewer.querySelector('[data-media="original"]').href = link.href;
			fit();
		};
		for (const [position, link] of captures.entries())
			link.addEventListener("click", (event) => {
				if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
				event.preventDefault();
				opener = link;
				show(position);
				viewer.showModal();
				viewer.querySelector(".media-close").focus();
			});
		viewer.querySelector(".media-close").addEventListener("click", () => viewer.close());
		viewer.querySelector('[data-media="previous"]').addEventListener("click", () => show(current - 1));
		viewer.querySelector('[data-media="next"]').addEventListener("click", () => show(current + 1));
		for (const control of viewer.querySelectorAll('[data-media="previous"], [data-media="next"]'))
			control.hidden = captures.length < 2;
		zoom.addEventListener("click", () => {
			if (viewport.dataset.zoom) fit();
			else {
				viewport.dataset.zoom = "actual";
				zoom.setAttribute("aria-pressed", "true");
				zoom.textContent = "Fit view";
			}
		});
		viewer.addEventListener("keydown", (event) => {
			if (!viewport.dataset.zoom && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
				event.preventDefault();
				show(current + (event.key === "ArrowRight" ? 1 : -1));
			}
		});
		viewer.addEventListener("click", (event) => {
			if (event.target !== viewer) return;
			const box = viewer.getBoundingClientRect();
			if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)
				viewer.close();
		});
		viewer.addEventListener("close", () => opener?.focus({ preventScroll: true }));
	}
	// Capture sequences: one frame at a time behind a tab list. The frames share
	// one grid cell, so switching never moves the page. Without script every
	// frame stays visible in order.
	for (const [number, sequence] of [...document.querySelectorAll("[data-sequence]")].entries()) {
		const frames = [...sequence.querySelectorAll(".guide-frame")];
		const tabs = document.createElement("div");
		tabs.className = "guide-tabs";
		tabs.setAttribute("role", "tablist");
		tabs.setAttribute("aria-label", sequence.querySelector("figcaption")?.textContent.trim() || "Screens");
		const buttons = frames.map((frame, index) => {
			const button = document.createElement("button");
			button.type = "button";
			button.id = `sequence-${number}-tab-${index}`;
			button.setAttribute("role", "tab");
			button.setAttribute("aria-controls", frame.id);
			button.innerHTML = `<span class="step-number">${String(index + 1).padStart(2, "0")}</span> `;
			button.append(frame.dataset.label);
			frame.setAttribute("role", "tabpanel");
			frame.setAttribute("aria-labelledby", button.id);
			tabs.append(button);
			return button;
		});
		const select = (index, focus = false) => {
			for (const [position, button] of buttons.entries()) {
				const active = position === index;
				button.setAttribute("aria-selected", String(active));
				button.tabIndex = active ? 0 : -1;
				frames[position].dataset.active = String(active);
				frames[position].inert = !active;
			}
			if (focus) buttons[index].focus();
		};
		tabs.addEventListener("click", (event) => {
			const button = event.target.closest("[role=tab]");
			if (button) select(buttons.indexOf(button));
		});
		tabs.addEventListener("keydown", (event) => {
			const current = buttons.indexOf(document.activeElement);
			const next = { ArrowRight: current + 1, ArrowLeft: current - 1, Home: 0, End: buttons.length - 1 }[event.key];
			if (current < 0 || next === undefined) return;
			event.preventDefault();
			select((next + buttons.length) % buttons.length, true);
		});
		// The frames become tab panels, so the list stops being a list.
		sequence.querySelector(".guide-frames")?.setAttribute("role", "none");
		sequence.prepend(tabs);
		sequence.dataset.sequence = "ready";
		select(0);
	}
	const wideNav = matchMedia("(min-width: 601px)");
	wideNav.addEventListener("change", () => {
		if (wideNav.matches)
			for (const menu of menus) {
				if (menu.contains(document.activeElement)) document.querySelector(".nav a[aria-current], .brand").focus();
				menu.open = false;
			}
	});
	const reduced = matchMedia("(prefers-reduced-motion: reduce)");
	let reveals;
	function finishReveals() {
		reveals?.disconnect();
		for (const el of document.querySelectorAll("[data-reveal]")) el.dataset.reveal = "visible";
	}
	if (!reduced.matches && "IntersectionObserver" in window) {
		reveals = new IntersectionObserver(
			(entries) => {
				for (const entry of entries)
					if (entry.isIntersecting) {
						entry.target.dataset.reveal = "visible";
						reveals.unobserve(entry.target);
					}
			},
			{ threshold: 0.08, rootMargin: "0px 0px -32px 0px" },
		);
		for (const el of document.querySelectorAll(
			".section-heading, .interface-grid, .model-routes, .workflow-grid, .tutorial-card, .project-section, .guide-step, .guide-capture, .guide-sequence, .guide-diagram, .guide-result",
		)) {
			if (el.getBoundingClientRect().top < innerHeight - 32) continue;
			el.dataset.reveal = "pending";
			reveals.observe(el);
		}
	}
	reduced.addEventListener("change", () => {
		if (reduced.matches) finishReveals();
	});
	document.addEventListener("focusin", (event) => {
		const el = event.target.closest('[data-reveal="pending"]');
		if (el) {
			el.dataset.reveal = "visible";
			reveals?.unobserve(el);
		}
	});
})();
