import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackupServer } from "../src/server.js";
import { backupName, HOUR, pruneBackups } from "../src/retention.js";

const token = "test-secret-token";
const headers = { Authorization: `Bearer ${token}` };
const cleanup = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()(); });

async function fixture(options = {}, setup = async () => {}) {
  const directory = await mkdtemp(join(tmpdir(), "backup-server-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await setup(directory);
  const app = await createBackupServer({ token, directory, port: 0, hostname: "127.0.0.1", ...options });
  cleanup.push(() => app.stop());
  return { ...app, directory, url: app.server.url.href.slice(0, -1) };
}

async function eventually(check) {
  const deadline = Date.now() + 2000;
  while (true) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("Condition did not become true");
    await Bun.sleep(10);
  }
}

function streamingUpload(url, path = "/upload") {
  let request;
  const response = new Promise((resolve, reject) => {
    request = httpRequest(`${url}${path}`, { method: "POST", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      res.on("error", reject);
    });
    request.on("error", reject);
    request.flushHeaders();
  });
  // A test may deliberately disconnect without awaiting the response.
  response.catch(() => {});
  cleanup.push(async () => { request.destroy(); });
  return { request, response };
}

test("requires configuration and guards both endpoints", async () => {
  await expect(createBackupServer({ token: "" })).rejects.toThrow("BACKUP_TOKEN");
  const { url } = await fixture();
  for (const path of ["/upload", `/upload/${"a".repeat(40)}`, "/list"]) {
    for (const authorization of ["", "Bearer wrong", "Bearer test-secret-tokeN"]) {
      const res = await fetch(`${url}${path}`, { headers: { Authorization: authorization }, method: path.startsWith("/upload") ? "POST" : "GET" });
      expect(res.status).toBe(401);
    }
  }
  expect((await fetch(`${url}/list`, { headers })).status).toBe(200);
  expect((await fetch(`${url}/upload`, { headers })).status).toBe(405);
  expect((await fetch(`${url}/upload/${"a".repeat(40)}`, { headers })).status).toBe(405);
  expect((await fetch(`${url}/list`, { headers, method: "POST" })).status).toBe(405);
  expect((await fetch(`${url}/other`, { headers })).status).toBe(404);
});

test("stores opaque bytes, exceeds Bun's default body limit, and lists exact sizes", async () => {
  const { url, directory } = await fixture();
  const body = Buffer.alloc(12 * 1024 * 1024);
  for (let i = 0; i < body.length; i += 4096) body[i] = (i / 4096) % 256;
  const response = await fetch(`${url}/upload?filename=original-secret-name`, { method: "POST", headers, body });
  expect(response.status).toBe(201);
  const record = await response.json();
  expect(record.name).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.backup$/);
  expect(record.size).toBe(body.length);
  expect(await readFile(join(directory, record.name))).toEqual(body);
  expect((await stat(join(directory, record.name))).mode & 0o777).toBe(0o600);
  expect(await (await fetch(`${url}/list`, { headers })).json()).toEqual({ files: [record] });
});

test("verified upload returns the on-disk SHA-1 and accepts uppercase checksums", async () => {
  const { url, directory } = await fixture();
  const body = Buffer.alloc(2 * 1024 * 1024, 0xa5);
  const sha1 = createHash("sha1").update(body).digest("hex");
  const response = await fetch(`${url}/upload/${sha1.toUpperCase()}`, { method: "POST", headers, body });
  expect(response.status).toBe(201);
  const record = await response.json();
  expect(record.sha1).toBe(sha1);
  expect(record.size).toBe(body.length);
  expect(await readFile(join(directory, record.name))).toEqual(body);
  expect(await (await fetch(`${url}/list`, { headers })).json()).toEqual({ files: [{ name: record.name, size: body.length }] });
});

test("checksum mismatch discards the upload and releases the lock", async () => {
  const { url, directory } = await fixture();
  const body = "saved content";
  const response = await fetch(`${url}/upload/${"0".repeat(40)}`, { method: "POST", headers, body });
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({ error: "SHA-1 checksum mismatch" });
  expect(await readdir(directory)).toEqual([]);
  expect(await (await fetch(`${url}/list`, { headers })).json()).toEqual({ files: [] });
  const sha1 = createHash("sha1").update(body).digest("hex");
  expect((await fetch(`${url}/upload/${sha1}`, { method: "POST", headers, body })).status).toBe(201);
});

test("validates checksum syntax before writing a file", async () => {
  const { url, directory } = await fixture();
  for (const sha1 of ["", "abc", "g".repeat(40), "a".repeat(39), "a".repeat(41), `${"a".repeat(40)}/extra`]) {
    expect((await fetch(`${url}/upload/${sha1}`, { method: "POST", headers, body: "contents" })).status).toBe(400);
  }
  expect(await readdir(directory)).toEqual([]);
});

test("verification detects saved-file corruption after receipt instead of hashing only the request", async () => {
  const { url, directory } = await fixture();
  const body = Buffer.alloc(64 * 1024, 0xa5);
  const sha1 = createHash("sha1").update(body).digest("hex");
  const stream = streamingUpload(url, `/upload/${sha1}`);
  stream.request.write(body);
  const temporaryPath = join(directory, ".upload.part");
  await eventually(async () => (await stat(temporaryPath).catch(() => null))?.size === body.length);
  expect((await fetch(`${url}/upload/${sha1}`, { method: "POST", headers, body })).status).toBe(409);
  // Change the on-disk bytes before ending the request. A network-only hash
  // would accept this upload even though its stored content is wrong.
  await writeFile(temporaryPath, Buffer.alloc(body.length, 0x5a));
  stream.request.end();
  expect(await stream.response).toEqual({ status: 422, body: { error: "SHA-1 checksum mismatch" } });
  expect(await readdir(directory)).toEqual([]);
});

test("verified uploads retain the total timeout and clean up partial files", async () => {
  const { url, directory } = await fixture({ uploadTimeoutMs: 150 });
  const stream = streamingUpload(url, `/upload/${"a".repeat(40)}`);
  stream.request.write("partial");
  expect((await stream.response).status).toBe(408);
  expect(await readdir(directory)).toEqual([]);
});

test("rejects concurrent uploads immediately, hides partial files, then releases the lock", async () => {
  const { url, directory } = await fixture();
  const stream = streamingUpload(url);
  stream.request.write("first-");
  await eventually(async () => (await stat(join(directory, ".upload.part")).catch(() => null))?.size > 0);
  const other = streamingUpload(url);
  other.request.write("second");
  expect(await other.response).toEqual({ status: 409, body: { error: "upload in progress" } });
  expect(await (await fetch(`${url}/list`, { headers })).json()).toEqual({ files: [] });
  stream.request.end("last");
  const first = await stream.response;
  expect(first.status).toBe(201);
  expect(await readFile(join(directory, first.body.name), "utf8")).toBe("first-last");
  expect((await fetch(`${url}/upload`, { method: "POST", headers, body: "next" })).status).toBe(201);
  expect((await readdir(directory)).length).toBe(2);
});

test("times out a stalled upload, removes its partial file, and permits the next upload", async () => {
  const { url, directory } = await fixture({ uploadTimeoutMs: 150 });
  const stream = streamingUpload(url);
  stream.request.write("partial");
  expect((await stream.response).status).toBe(408);
  expect(await readdir(directory)).toEqual([]);
  expect((await fetch(`${url}/upload`, { method: "POST", headers, body: "complete" })).status).toBe(201);
});

test("the deadline is total duration, even when chunks keep arriving", async () => {
  const { url, directory } = await fixture({ uploadTimeoutMs: 200 });
  const stream = streamingUpload(url);
  stream.request.write("start");
  const interval = setInterval(() => stream.request.write("more"), 20);
  try { expect((await stream.response).status).toBe(408); }
  finally { clearInterval(interval); }
  expect(await readdir(directory)).toEqual([]);
});

test("the deadline also applies before the first body byte arrives", async () => {
  const { url, directory } = await fixture({ uploadTimeoutMs: 150 });
  const stream = streamingUpload(url);
  expect((await stream.response).status).toBe(408);
  expect(await readdir(directory)).toEqual([]);
});

test("disconnect removes partial data and releases the upload lock", async () => {
  const { url, directory } = await fixture();
  const stream = streamingUpload(url);
  stream.request.write("partial");
  await eventually(async () => (await stat(join(directory, ".upload.part")).catch(() => null))?.size > 0);
  stream.request.destroy();
  await eventually(async () => (await readdir(directory)).length === 0);
  expect((await fetch(`${url}/upload`, { method: "POST", headers, body: "complete" })).status).toBe(201);
});

test("rejects empty/multipart uploads without leaving files or blocking later uploads", async () => {
  const { url, directory } = await fixture();
  expect((await fetch(`${url}/upload`, { method: "POST", headers })).status).toBe(400);
  const form = new FormData();
  form.set("file", new Blob(["contents"]), "secret-name");
  expect((await fetch(`${url}/upload`, { method: "POST", headers, body: form })).status).toBe(415);
  expect(await readdir(directory)).toEqual([]);
  expect((await fetch(`${url}/upload`, { method: "POST", headers, body: "complete" })).status).toBe(201);
});

test("storage failure returns an error and releases the lock for recovery", async () => {
  const { url, directory } = await fixture();
  await rename(directory, `${directory}-offline`);
  try {
    expect((await fetch(`${url}/upload`, { method: "POST", headers, body: "cannot-store" })).status).toBe(500);
  } finally {
    await rename(`${directory}-offline`, directory);
  }
  expect((await fetch(`${url}/upload`, { method: "POST", headers, body: "complete" })).status).toBe(201);
});

test("startup discards interrupted upload, prunes old backups, and ignores unrelated files/symlinks", async () => {
  const now = Date.now();
  const hourStart = Math.floor((now - 5 * HOUR) / HOUR) * HOUR;
  const older = backupName(hourStart + 1000);
  const newer = backupName(hourStart + 2000);
  const link = backupName(hourStart + 3000);
  const { directory, url } = await fixture({}, async (dir) => {
    await writeFile(join(dir, older), "old");
    await writeFile(join(dir, newer), "new");
    await writeFile(join(dir, ".upload.part"), "incomplete");
    await writeFile(join(dir, "notes.txt"), "unrelated");
    await symlink(join(dir, "notes.txt"), join(dir, link));
  });
  expect((await readdir(directory)).sort()).toEqual([newer, link, "notes.txt"].sort());
  expect(await (await fetch(`${url}/list`, { headers })).json()).toEqual({ files: [{ name: newer, size: 3 }] });
  expect(await pruneBackups(directory)).toBe(0);
});

test("periodic retention runs without new uploads", async () => {
  const { directory } = await fixture({ retentionIntervalMs: 20 });
  const hour = Math.floor((Date.now() - 5 * HOUR) / HOUR) * HOUR;
  await writeFile(join(directory, backupName(hour)), "old");
  await writeFile(join(directory, backupName(hour + 1000)), "new");
  await eventually(async () => (await readdir(directory)).length === 1);
  expect(await readdir(directory)).toEqual([backupName(hour + 1000)]);
});

test("rapid uploads and restart never overwrite existing backups", async () => {
  const { url, directory } = await fixture({}, async (dir) => {
    // Existing timestamp ahead of the clock also exercises clock rollback.
    await writeFile(join(dir, backupName(Date.now() + HOUR)), "existing");
  });
  const names = new Set(await readdir(directory));
  for (let i = 0; i < 10; i++) {
    const response = await fetch(`${url}/upload`, { method: "POST", headers, body: `backup-${i}` });
    expect(response.status).toBe(201);
    names.add((await response.json()).name);
  }
  expect(names.size).toBe(11);
  expect((await readdir(directory)).length).toBe(11);
});
