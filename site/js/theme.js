// Runs before first paint; explicit choices take priority over the sanctioned default.
(() => {
	const defaultTheme = document.querySelector('meta[name="clio-default-theme"]')?.content ?? "dark";
	const requested = new URLSearchParams(location.search).get("theme");
	let saved;
	try {
		saved = localStorage.getItem("clio-theme");
	} catch {
		/* Storage is optional. */
	}
	const theme = ["light", "dark"].includes(requested)
		? requested
		: ["light", "dark"].includes(saved)
			? saved
			: defaultTheme === "system"
				? matchMedia("(prefers-color-scheme: light)").matches
					? "light"
					: "dark"
				: defaultTheme === "light"
					? "light"
					: "dark";
	document.documentElement.dataset.theme = theme;
	const meta = document.querySelector('meta[name="theme-color"]');
	if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue("--paper").trim();
})();
