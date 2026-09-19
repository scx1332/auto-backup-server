import { link, lstat, mkdir, readdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { listBackups } from "./retention.js";

// The nil UUID preserves the original endpoints without mixing new projects.
export const DEFAULT_PROJECT_ID = "00000000-0000-0000-0000-000000000000";

export function normalizeProjectId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase() : null;
}

export async function projectDirectory(root, id, create = false) {
  if (normalizeProjectId(id) !== id) throw new Error("Invalid project UUID");
  const directory = join(root, id);
  if (create) {
    await mkdir(directory, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  const info = await lstat(directory).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (!info) return null;
  // Never follow a project symlink into another project's directory.
  if (!info.isDirectory()) throw new Error("Project path must be a real directory");
  return directory;
}

export async function projectIds(root) {
  return (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && normalizeProjectId(entry.name) === entry.name)
    .map((entry) => entry.name);
}

export async function migrateLegacyBackups(root) {
  await rm(join(root, ".upload.part"), { force: true });
  const backups = await listBackups(root);
  if (!backups.length) return;
  const directory = await projectDirectory(root, DEFAULT_PROJECT_ID, true);
  for (const { name } of backups) {
    const source = join(root, name);
    const target = join(directory, name);
    try {
      // A same-filesystem hard link avoids overwriting an existing backup.
      await link(source, target);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const [from, to] = await Promise.all([lstat(source), lstat(target)]);
      // Resume a migration interrupted between linking and unlinking.
      if (from.dev !== to.dev || from.ino !== to.ino) {
        throw new Error(`Existing default-project backup conflicts with migration: ${name}`);
      }
    }
    await unlink(source);
  }
}
