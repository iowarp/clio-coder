(() => {
	const root = document.documentElement;
	const announcement = document.createElement("p");
	announcement.className = "sr-only";
	announcement.setAttribute("role", "status");
	document.body.append(announcement);

	function applyTheme(theme) {
		root.dataset.theme = theme;
		try {
			localStorage.setItem("clio-theme", theme);
		} catch {
			// The palette works even when storage is unavailable.
		}
		const meta = document.querySelector('meta[name="theme-color"]');
		if (meta) meta.content = getComputedStyle(root).getPropertyValue("--paper").trim();
		for (const button of document.querySelectorAll("[data-theme-toggle]")) {
			button.setAttribute("aria-label", theme === "light" ? "Switch to dark theme" : "Switch to light theme");
			button.innerHTML = `<span aria-hidden="true">${theme === "light" ? "◑" : "◐"}</span>`;
		}
	}
	applyTheme(root.dataset.theme || "dark");
	for (const button of document.querySelectorAll("[data-theme-toggle]")) {
		button.addEventListener("click", () => applyTheme(root.dataset.theme === "light" ? "dark" : "light"));
	}

	const menus = [...document.querySelectorAll(".nav-more, .nav-product")];
	for (const menu of menus) {
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
		if (pre.closest(".product-preview")) continue;
		const button = document.createElement("button");
		button.type = "button";
		button.className = "copy code-copy";
		button.textContent = "Copy";
		button.setAttribute("aria-label", "Copy code example");
		button.dataset.copy = pre.textContent.trim();
		pre.append(button);
	}
	for (const button of document.querySelectorAll("[data-copy-from]")) {
		const source = document.querySelector(button.dataset.copyFrom);
		if (source) button.dataset.copy = source.textContent.trim();
	}
	for (const button of document.querySelectorAll("[data-copy]")) {
		button.addEventListener("click", async () => {
			const previous = button.textContent;
			try {
				await navigator.clipboard.writeText(button.dataset.copy || "");
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
	}
})();
