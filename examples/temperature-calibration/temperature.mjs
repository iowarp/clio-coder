const CELSIUS_KELVIN_OFFSET = 273.15;
const ABSOLUTE_ZERO_C = -273.15;
const ABSOLUTE_ZERO_F = -459.67;

function validateTemperature(value, unit) {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new TypeError(`${unit} must be a finite number, received ${value}`);
	}
}

export function celsiusToKelvin(celsius) {
	validateTemperature(celsius, "Celsius");
	if (celsius < ABSOLUTE_ZERO_C) {
		throw new RangeError(`Celsius temperature ${celsius} is below absolute zero (-273.15°C)`);
	}
	return celsius + CELSIUS_KELVIN_OFFSET;
}

export function kelvinToCelsius(kelvin) {
	validateTemperature(kelvin, "Kelvin");
	if (kelvin < 0) {
		throw new RangeError(`Kelvin temperature ${kelvin} is below absolute zero (0 K)`);
	}
	return kelvin - CELSIUS_KELVIN_OFFSET;
}

export function celsiusToFahrenheit(celsius) {
	validateTemperature(celsius, "Celsius");
	if (celsius < ABSOLUTE_ZERO_C) {
		throw new RangeError(`Celsius temperature ${celsius} is below absolute zero (-273.15°C)`);
	}
	return (celsius * 9) / 5 + 32;
}

export function fahrenheitToCelsius(fahrenheit) {
	validateTemperature(fahrenheit, "Fahrenheit");
	if (fahrenheit < ABSOLUTE_ZERO_F) {
		throw new RangeError(`Fahrenheit temperature ${fahrenheit} is below absolute zero (-459.67°F)`);
	}
	return ((fahrenheit - 32) * 5) / 9;
}
