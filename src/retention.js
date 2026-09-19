import { readdir, lstat, unlink } from "node:fs/promises";
import { join } from "node:path";

export const HOUR = 60 * 60 * 1000;
export const backupName = (time) => new Date(time).toISOString().replaceAll(":", "-") + ".backup";

export function backupTime(name) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.backup$/.test(name)) return null;
  const time = Date.parse(name.slice(0, 24).replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3"));
  return Number.isFinite(time) && backupName(time) === name ? time : null;
}

// Clamp March 31 -> February 28/29, preserving the UTC time of day.
export function monthAgo(time) {
  const date = new Date(time);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - 1);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.getTime();
}

export function expiredBackups(backups, now = Date.now()) {
  const cutoff = monthAgo(now);
  const seen = new Set();
  return [...backups].sort((a, b) => b.time - a.time).filter(({ time }) => {
    const age = now - time;
    if (age <= HOUR) return false;
    const utc = new Date(time).toISOString();
    const bucket = age <= 48 * HOUR ? `hour:${utc.slice(0, 13)}`
      : time >= cutoff ? `day:${utc.slice(0, 10)}`
      : `month:${utc.slice(0, 7)}`;
    if (seen.has(bucket)) return true;
    seen.add(bucket);
    return false;
  });
}

export async function listBackups(directory) {
  const backups = [];
  for (const name of await readdir(directory)) {
    const time = backupTime(name);
    if (time === null) continue;
    try {
      const info = await lstat(join(directory, name));
      if (info.isFile()) backups.push({ name, size: info.size, time });
    } catch (error) {
      // Retention can remove a file while /list is reading it.
      if (error.code !== "ENOENT") throw error;
    }
  }
  return backups.sort((a, b) => b.time - a.time);
}

export async function pruneBackups(directory, now = Date.now()) {
  const expired = expiredBackups(await listBackups(directory), now);
  for (const { name } of expired) {
    await unlink(join(directory, name)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return expired.length;
}
