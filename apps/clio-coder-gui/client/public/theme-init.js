(() => {
	const root = document.documentElement;
	let choice = "system";
	try {
		const saved = localStorage.getItem("clio-coder-gui-theme");
		if (saved === "light" || saved === "dark") choice = saved;
	} catch {
		// Blocked storage leaves the system preference in charge of first paint.
	}
	if (choice !== "system") root.dataset.theme = choice;
	const theme = choice === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : choice;
	root.style.colorScheme = theme;
	const paper = getComputedStyle(root).getPropertyValue("--paper").trim();
	const meta = document.querySelector('meta[name="theme-color"]');
	if (meta) {
		meta.setAttribute("content", paper || meta.dataset[theme] || meta.content);
		root.style.backgroundColor = `var(--paper, ${meta.content})`;
	}
})();
