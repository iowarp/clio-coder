// Runs before first paint; use the operating-system preference until explicitly changed.
(() => {
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
			: matchMedia("(prefers-color-scheme: light)").matches
				? "light"
				: "dark";
	document.documentElement.dataset.theme = theme;
	const meta = document.querySelector('meta[name="theme-color"]');
	if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue("--paper").trim();
})();
