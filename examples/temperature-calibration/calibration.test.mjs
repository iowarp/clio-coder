import assert from "node:assert/strict";
import { test } from "node:test";
import { celsiusToFahrenheit, celsiusToKelvin, fahrenheitToCelsius, kelvinToCelsius } from "./temperature.mjs";

test("freezing point: 0°C = 273.15 K = 32°F", () => {
	assert.equal(celsiusToKelvin(0), 273.15);
	assert.equal(kelvinToCelsius(273.15), 0);
	assert.equal(celsiusToFahrenheit(0), 32);
	assert.equal(fahrenheitToCelsius(32), 0);
});

test("boiling point: 100°C = 373.15 K = 212°F", () => {
	assert.equal(celsiusToKelvin(100), 373.15);
	assert.equal(kelvinToCelsius(373.15), 100);
	assert.equal(celsiusToFahrenheit(100), 212);
	assert.equal(fahrenheitToCelsius(212), 100);
});

test("absolute zero: 0 K = -273.15°C = -459.67°F", () => {
	assert.equal(kelvinToCelsius(0), -273.15);
	assert.equal(celsiusToKelvin(-273.15), 0);
	assert.equal(fahrenheitToCelsius(-459.67), -273.15);
	// -459.67°F is not exactly representable in binary; use approximate equality
	assert.ok(Math.abs(celsiusToFahrenheit(-273.15) - -459.67) < 1e-10);
});

test("round trips within 1e-10", () => {
	const values = [25, -10, 36.6, 100, 273.15, 0, -40];
	for (const celsius of values) {
		const kelvin = celsiusToKelvin(celsius);
		const backToCelsius = kelvinToCelsius(kelvin);
		assert.ok(Math.abs(backToCelsius - celsius) < 1e-10, `Celsius→Kelvin→Celsius round trip failed for ${celsius}`);

		const fahrenheit = celsiusToFahrenheit(celsius);
		const backToCelsius2 = fahrenheitToCelsius(fahrenheit);
		assert.ok(Math.abs(backToCelsius2 - celsius) < 1e-10, `Celsius→Fahrenheit→Celsius round trip failed for ${celsius}`);
	}
});

test("rejects non-numeric inputs with TypeError", () => {
	const inputs = ["25", null, undefined, {}, [], true, Symbol("temp")];
	for (const input of inputs) {
		assert.throws(() => celsiusToKelvin(input), TypeError, "celsiusToKelvin");
		assert.throws(() => kelvinToCelsius(input), TypeError, "kelvinToCelsius");
		assert.throws(() => celsiusToFahrenheit(input), TypeError, "celsiusToFahrenheit");
		assert.throws(() => fahrenheitToCelsius(input), TypeError, "fahrenheitToCelsius");
	}
});

test("rejects non-finite inputs with TypeError", () => {
	assert.throws(() => celsiusToKelvin(NaN), TypeError);
	assert.throws(() => celsiusToKelvin(Infinity), TypeError);
	assert.throws(() => celsiusToKelvin(-Infinity), TypeError);
	assert.throws(() => kelvinToCelsius(NaN), TypeError);
	assert.throws(() => celsiusToFahrenheit(Infinity), TypeError);
	assert.throws(() => fahrenheitToCelsius(-Infinity), TypeError);
});

test("rejects temperatures below absolute zero with RangeError", () => {
	assert.throws(() => celsiusToKelvin(-274), RangeError);
	assert.throws(() => celsiusToKelvin(-300), RangeError);
	assert.throws(() => kelvinToCelsius(-0.001), RangeError);
	assert.throws(() => kelvinToCelsius(-1), RangeError);
	assert.throws(() => celsiusToFahrenheit(-274), RangeError);
	assert.throws(() => fahrenheitToCelsius(-460), RangeError);
	assert.throws(() => fahrenheitToCelsius(-1000), RangeError);
});
