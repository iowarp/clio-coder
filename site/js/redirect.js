(() => {
	const link = document.querySelector("[data-redirect]");
	if (link) {
		const target = new URL(link.href);
		if (!target.hash) target.hash = location.hash;
		location.replace(target.href);
	}
})();
