// Feature 5001 -- billed hours, the one pure function
//
// AC5  one entry of 58 minutes bills 1.0h; 8:07am-11:05am bills 3.0h; a return
//      entry of 20 minutes with the minimum at 30 bills 0.5h; the first-visit
//      rule goes to the EARLIEST entry, whatever order they were typed in
import { describe, expect, test } from "vitest";
import { billedHours, billedMinutesOf } from "../src/jobs/billed-hours.js";

/** An entry on the given day at hh:mm, lasting `minutes`. */
function entry(day: number, hour: number, minute: number, minutes: number) {
  const startedAt = new Date(Date.UTC(2026, 9, day, hour, minute));
  return { startedAt, endedAt: new Date(startedAt.getTime() + minutes * 60_000) };
}

describe("AC5 -- billed hours", () => {
  test("AC5: a 58-minute first visit bills the one-hour floor", () => {
    expect(billedHours([entry(7, 0, 7, 58)], 30)).toBe(1);
  });

  test("AC5: 8:07am-11:05am (178 minutes) rounds up to 3.0h", () => {
    expect(billedHours([entry(7, 0, 7, 178)], 30)).toBe(3);
  });

  test("AC5: a return entry of 20 minutes with the minimum at 30 bills 0.5h on top of the first visit", () => {
    expect(billedHours([entry(7, 0, 7, 178), entry(9, 1, 0, 20)], 30)).toBe(3.5);
  });

  test("AC5: the first-visit rule goes to the EARLIEST entry, whatever order they were typed in", () => {
    const first = entry(7, 0, 7, 20); // 20 minutes -> the one-hour floor
    const back = entry(9, 1, 0, 20); // 20 minutes -> the return minimum (0.5h)
    expect(billedHours([first, back], 30)).toBe(1.5);
    expect(billedHours([back, first], 30)).toBe(1.5);
  });

  test("AC5: the return floor is the settings minimum, not a constant", () => {
    const first = entry(7, 0, 0, 60);
    const back = entry(9, 1, 0, 10);
    expect(billedHours([first, back], 45)).toBe(1.75);
    expect(billedHours([first, back], 15)).toBe(1.25);
  });

  test("AC5: above its floor each entry rounds UP to the next 15 minutes, per entry", () => {
    expect(billedMinutesOf(61, 60)).toBe(75);
    expect(billedMinutesOf(75, 60)).toBe(75);
    expect(billedMinutesOf(31, 30)).toBe(45);
    // Two 40-minute return entries round separately: 45 + 45, not 80 -> 90.
    const first = entry(7, 0, 0, 60);
    expect(billedHours([first, entry(8, 0, 0, 40), entry(9, 0, 0, 40)], 30)).toBe(2.5);
  });

  test("no entries bill nothing", () => {
    expect(billedHours([], 30)).toBe(0);
  });
});
