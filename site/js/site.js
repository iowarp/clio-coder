(() => {
	// Theme toggle management
	function getActiveTheme() {
		return document.documentElement.getAttribute("data-theme") || "dark";
	}

	function applyTheme(theme) {
		document.documentElement.setAttribute("data-theme", theme);
		try {
			localStorage.setItem("clio-theme", theme);
		} catch {
			// localStorage not available
		}

		const metaTheme = document.querySelector('meta[name="theme-color"]');
		if (metaTheme) {
			metaTheme.setAttribute("content", getComputedStyle(document.documentElement).getPropertyValue("--paper").trim());
		}

		document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
			const isLight = theme === "light";
			btn.setAttribute("aria-label", isLight ? "Switch to dark theme" : "Switch to paper theme");
			btn.innerHTML = isLight
				? '<span class="theme-icon" aria-hidden="true">■</span> <span>Dark</span>'
				: '<span class="theme-icon" aria-hidden="true">□</span> <span>Paper</span>';
		});
	}

	// Initialize theme toggle buttons
	const urlTheme = new URLSearchParams(window.location.search).get("theme");
	if (urlTheme === "light" || urlTheme === "dark") {
		applyTheme(urlTheme);
	} else {
		applyTheme(getActiveTheme());
	}

	document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
		btn.addEventListener("click", () => {
			const next = getActiveTheme() === "light" ? "dark" : "light";
			applyTheme(next);
		});
	});

	// Close mobile menu on outside click
	document.addEventListener("click", (event) => {
		const navMore = document.querySelector(".nav-more[open]");
		if (navMore && !navMore.contains(event.target)) {
			navMore.removeAttribute("open");
		}
	});
	document.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") return;
		const menu = document.querySelector(".nav-more[open]");
		if (menu) {
			menu.open = false;
			menu.querySelector("summary").focus();
		}
	});

	const tabs = [...document.querySelectorAll('.workflow-tabs [role="tab"]')];
	function selectTab(tab) {
		for (const item of tabs) {
			const selected = item === tab;
			item.setAttribute("aria-selected", String(selected));
			item.tabIndex = selected ? 0 : -1;
			document.getElementById(item.getAttribute("aria-controls")).hidden = !selected;
		}
	}
	for (const tab of tabs) {
		tab.addEventListener("click", () => selectTab(tab));
		tab.addEventListener("keydown", (event) => {
			let next;
			const index = tabs.indexOf(tab);
			if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
			if (event.key === "ArrowLeft") next = tabs[(index + tabs.length - 1) % tabs.length];
			if (event.key === "Home") next = tabs[0];
			if (event.key === "End") next = tabs.at(-1);
			if (next) {
				event.preventDefault();
				selectTab(next);
				next.focus();
			}
		});
	}

	const announcement = document.createElement("p");
	announcement.className = "sr-only";
	announcement.setAttribute("role", "status");
	document.body.append(announcement);

	// Post on X intent links
	document.querySelectorAll("[data-tweet]").forEach((link) => {
		const text = link.getAttribute("data-tweet") || "";
		const intent = new URL("https://x.com/intent/tweet");
		intent.searchParams.set("text", text);
		if (link.getAttribute("data-include-url") !== "0") {
			intent.searchParams.set("url", link.getAttribute("data-url") || "https://coder.iowarp.ai");
		}
		link.href = intent.toString();
		link.setAttribute("target", "_blank");
		link.setAttribute("rel", "noopener noreferrer");
	});

	// Copy from element
	document.querySelectorAll("[data-copy-from]").forEach((button) => {
		const source = document.querySelector(button.getAttribute("data-copy-from"));
		if (source) button.setAttribute("data-copy", source.textContent.trim());
	});

	// Copy click handler
	document.querySelectorAll("[data-copy]").forEach((button) => {
		button.addEventListener("click", async () => {
			const value = button.getAttribute("data-copy") || "";
			const previous = button.textContent;
			try {
				await navigator.clipboard.writeText(value);
				button.textContent = "Copied";
				announcement.textContent = "Copied to clipboard.";
			} catch {
				button.textContent = "Copy failed";
				announcement.textContent = "Copy failed. Select and copy the command text.";
			}
			window.setTimeout(() => {
				button.textContent = previous;
			}, 1400);
		});
	});
})();
