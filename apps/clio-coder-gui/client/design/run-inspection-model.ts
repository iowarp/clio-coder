export function inspectionTabIndex(key: string, current: number, length: number): number {
	if (length < 1) return -1;
	if (key === "Home") return 0;
	if (key === "End") return length - 1;
	if (key === "ArrowRight") return (current + 1) % length;
	if (key === "ArrowLeft") return (current + length - 1) % length;
	return -1;
}
