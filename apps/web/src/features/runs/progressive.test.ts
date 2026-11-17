import { describe, expect, test } from "bun:test";
import { tailWindow } from "./progressive";

describe("tailWindow", () => {
	test("a list shorter than the window is shown whole", () => {
		expect(tailWindow(12, 50)).toEqual({
			start: 0,
			visible: 12,
			hiddenBefore: 0,
		});
	});

	test("a list longer than the window keeps the newest rows", () => {
		expect(tailWindow(200, 50)).toEqual({
			start: 150,
			visible: 50,
			hiddenBefore: 150,
		});
	});

	test("the exact window size hides nothing", () => {
		expect(tailWindow(50, 50)).toEqual({
			start: 0,
			visible: 50,
			hiddenBefore: 0,
		});
	});

	test("an empty list yields an empty window", () => {
		expect(tailWindow(0, 50)).toEqual({
			start: 0,
			visible: 0,
			hiddenBefore: 0,
		});
	});

	test("non-finite or negative inputs collapse instead of producing NaN", () => {
		expect(tailWindow(Number.NaN, 50)).toEqual({
			start: 0,
			visible: 0,
			hiddenBefore: 0,
		});
		expect(tailWindow(-5, 50)).toEqual({
			start: 0,
			visible: 0,
			hiddenBefore: 0,
		});
		// A non-finite window size reveals nothing rather than everything; the
		// reveal control is what recovers the view.
		expect(tailWindow(10, Number.POSITIVE_INFINITY)).toEqual({
			start: 10,
			visible: 0,
			hiddenBefore: 10,
		});
		expect(tailWindow(10, -1)).toEqual({
			start: 10,
			visible: 0,
			hiddenBefore: 10,
		});
	});

	test("fractional inputs floor rather than straddle a boundary", () => {
		expect(tailWindow(10.9, 4.9)).toEqual({
			start: 6,
			visible: 4,
			hiddenBefore: 6,
		});
	});
});
