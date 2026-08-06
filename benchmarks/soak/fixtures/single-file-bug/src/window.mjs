/**
 * Rolling window statistics over a series of samples.
 *
 * `rollingMean` is expected to return one mean per complete window, so a series
 * of n samples with window size k yields n - k + 1 values.
 */

export function rollingMean(values, size) {
	if (!Array.isArray(values)) throw new TypeError("values must be an array");
	if (!Number.isInteger(size) || size < 1) throw new RangeError("size must be a positive integer");
	if (values.length < size) return [];
	const means = [];
	for (let start = 0; start < values.length - size; start += 1) {
		let sum = 0;
		for (let offset = 0; offset < size; offset += 1) sum += values[start + offset];
		means.push(sum / size);
	}
	return means;
}
