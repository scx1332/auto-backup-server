import { describe, expect, test } from "bun:test";
import { backupName, backupTime, expiredBackups, HOUR, monthAgo } from "../src/retention.js";

const at = (date) => ({ time: Date.parse(date), name: backupName(Date.parse(date)) });
const expired = (dates, now) => expiredBackups(dates.map(at), Date.parse(now)).map(({ name }) => name);

describe("UTC retention", () => {
  test("keeps every backup through exactly one hour, including future timestamps", () => {
    const now = Date.parse("2026-09-20T12:30:00.000Z");
    expect(expiredBackups([0, 1, HOUR - 1, HOUR, -HOUR].map((age) => ({ time: now - age })), now)).toEqual([]);
  });

  test("keeps newest per UTC hour, including the exact 48-hour boundary", () => {
    const dates = [
      "2026-09-20T10:01:00Z", "2026-09-20T10:59:00Z", "2026-09-20T09:01:00Z",
      "2026-09-18T12:30:00Z", "2026-09-18T12:59:00Z", "2026-09-18T13:01:00Z",
    ];
    expect(expired(dates, "2026-09-20T12:30:00Z")).toEqual([
      at(dates[0]).name, at(dates[3]).name,
    ]);
  });

  test("keeps the newest backup in each UTC day after 48 hours", () => {
    const dates = ["2026-09-17T00:01:00Z", "2026-09-17T23:59:00Z", "2026-09-16T23:59:00Z"];
    expect(expired(dates, "2026-09-20T12:30:00Z")).toEqual([at(dates[0]).name]);
  });

  test("keeps newest monthly forever, with separate buckets across years", () => {
    const dates = [
      "2026-08-01T12:00:00Z", "2026-08-19T23:59:00Z", "2026-07-01T00:00:00Z",
      "2026-07-31T23:59:00Z", "2025-07-01T00:00:00Z", "2025-07-31T23:59:00Z",
    ];
    expect(expired(dates, "2026-09-20T12:30:00Z")).toEqual([at(dates[0]).name, at(dates[2]).name, at(dates[4]).name]);
  });

  test("uses a clamped calendar month, preserving UTC time and leap years", () => {
    for (const [now, expected] of [
      ["2026-03-31T12:30:00.123Z", "2026-02-28T12:30:00.123Z"],
      ["2024-03-31T12:30:00.123Z", "2024-02-29T12:30:00.123Z"],
      ["2026-01-31T12:30:00.123Z", "2025-12-31T12:30:00.123Z"],
    ]) expect(new Date(monthAgo(Date.parse(now))).toISOString()).toBe(expected);
  });

  test("the calendar-month boundary remains daily until strictly older", () => {
    const dates = ["2026-02-28T12:30:00Z", "2026-02-28T23:59:00Z", "2026-02-27T12:30:00Z"];
    expect(expired(dates, "2026-03-31T12:30:00Z")).toEqual([at(dates[0]).name]);
  });

  test("only recognizes exact generated timestamp filenames", () => {
    const time = Date.parse("2026-09-20T12:30:00.123Z");
    expect(backupTime(backupName(time))).toBe(time);
    for (const name of ["notes.txt", ".upload.part", "2026-02-30T12-30-00.123Z.backup", "../2026-09-20T12-30-00.123Z.backup"]) {
      expect(backupTime(name)).toBeNull();
    }
  });
});
