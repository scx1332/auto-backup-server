import { describe, expect, test } from "bun:test";
import { backupName, backupTime, expiredBackups, DAY, HOUR } from "../src/retention.js";

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

  test("uses exactly 30 days across short months, leap years, and year boundaries", () => {
    for (const now of ["2026-03-15T12:30:00Z", "2024-03-15T12:30:00Z", "2026-01-15T12:30:00Z"]) {
      const timestamp = Date.parse(now);
      const backups = [29, 30, 31].map((days) => ({ time: timestamp - days * DAY }));
      expect(expiredBackups(backups, timestamp)).toEqual([backups[2]]);
    }
  });

  test("keeps daily backups at exactly 30 days and prunes strictly older duplicates", () => {
    const dates = ["2026-03-01T12:30:00.000Z", "2026-03-02T12:30:00.000Z", "2026-03-01T12:29:59.999Z"];
    expect(expired(dates, "2026-03-31T12:30:00Z")).toEqual([at(dates[2]).name]);
  });

  test("deletes every older file in a month already represented by retained daily backups", () => {
    const dates = ["2026-01-01T12:00:00Z", "2026-01-29T12:00:00Z", "2026-01-30T12:30:00Z", "2026-01-31T23:59:00Z"];
    expect(expired(dates, "2026-03-01T12:30:00Z")).toEqual([at(dates[1]).name, at(dates[0]).name]);
  });

  test("recent and hourly backups also represent their calendar month", () => {
    for (const newer of ["2026-03-31T23:00:00Z", "2026-03-31T20:00:00Z"]) {
      const dates = ["2026-03-01T00:00:00Z", newer];
      expect(expired(dates, "2026-03-31T23:30:00Z")).toEqual([at(dates[0]).name]);
    }
  });

  test("keeps the newest old file when no other backup remains in its calendar month", () => {
    const dates = ["2026-01-01T12:00:00Z", "2026-01-29T23:59:00Z", "2026-02-28T23:59:00Z"];
    expect(expired(dates, "2026-03-01T12:30:00Z")).toEqual([at(dates[0]).name]);
  });

  test("pruning over time never removes the final backup for a populated calendar month", () => {
    let backups = ["2026-01-01T12:00:00Z", "2026-01-29T23:59:00Z", "2026-01-31T23:59:00Z"].map(at);
    for (const now of ["2026-02-15T12:30:00Z", "2026-03-01T12:30:00Z", "2026-04-01T12:30:00Z", "2030-01-01T00:00:00Z"]) {
      const removed = new Set(expiredBackups(backups, Date.parse(now)).map(({ name }) => name));
      backups = backups.filter(({ name }) => !removed.has(name));
      expect(backups.length).toBeGreaterThan(0);
    }
    expect(backups).toEqual([at("2026-01-31T23:59:00Z")]);
  });

  test("only recognizes exact generated timestamp filenames", () => {
    const time = Date.parse("2026-09-20T12:30:00.123Z");
    expect(backupTime(backupName(time))).toBe(time);
    for (const name of ["notes.txt", ".upload.part", "2026-02-30T12-30-00.123Z.backup", "../2026-09-20T12-30-00.123Z.backup"]) {
      expect(backupTime(name)).toBeNull();
    }
  });
});
