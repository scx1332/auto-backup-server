import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackupServer } from "../src/server.js";
import { DEFAULT_PROJECT_ID } from "../src/projects.js";
import { backupName, HOUR } from "../src/retention.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const token = "project-test-token";
const headers = { Authorization: `Bearer ${token}` };
const cleanup = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()(); });

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "backup-project-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fixture(options = {}, setup = async () => {}) {
  const directory = await temporaryDirectory();
  await setup(directory);
  const app = await createBackupServer({ token, directory, hostname: "127.0.0.1", port: 0, ...options });
  cleanup.push(() => app.stop());
  const url = app.server.url.href.slice(0, -1);
  const list = async (id) => {
    const response = await fetch(`${url}/list/${id}`, { headers });
    expect(response.status).toBe(200);
    return response.json();
  };
  return { ...app, directory, url, list };
}

async function eventually(check) {
  const deadline = Date.now() + 2000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Condition did not become true");
    await Bun.sleep(10);
  }
}

const sha1Of = (body) => createHash("sha1").update(body).digest("hex");
const uploadUrl = (url, id, body) => `${url}/upload/${id}/${sha1Of(body)}`;

function streamUpload(url, id, expectedBody = "first") {
  let request;
  const response = new Promise((resolve, reject) => {
    request = httpRequest(uploadUrl(url, id, expectedBody), { method: "POST", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      res.on("error", reject);
    });
    request.on("error", reject);
    request.flushHeaders();
  });
  response.catch(() => {});
  cleanup.push(async () => { request.destroy(); });
  return { request, response };
}

test("consumer-selected UUIDs create separate directories and lists", async () => {
  const { directory, url, list } = await fixture();
  expect(await list(A)).toEqual({ projectId: A, files: [] });
  expect(await readdir(directory)).toEqual([]);
  const records = [];
  for (const [id, body] of [[A, "project A"], [B, "project B contents"]]) {
    const response = await fetch(uploadUrl(url, id, body), { method: "POST", headers, body });
    expect(response.status).toBe(201);
    const record = await response.json();
    records.push(record);
    expect(record.projectId).toBe(id);
    expect(await readFile(join(directory, id, record.name), "utf8")).toBe(body);
    expect((await stat(join(directory, id))).mode & 0o777).toBe(0o700);
  }
  for (const record of records) {
    expect(await list(record.projectId)).toEqual({ projectId: record.projectId, files: [{ name: record.name, size: record.size }] });
  }
  expect((await readdir(directory)).sort()).toEqual([A, B]);
  expect(await (await fetch(`${url}/list`, { headers })).json()).toEqual({ files: [] });
  expect((await fetch(`${url}/projects`, { headers })).status).toBe(404);
});

test("UUID and checksum casing normalize without splitting a project", async () => {
  const { directory, url, list } = await fixture();
  const body = "checked contents";
  const sha1 = createHash("sha1").update(body).digest("hex");
  const response = await fetch(`${url}/upload/${A.toUpperCase()}/${sha1.toUpperCase()}`, { method: "POST", headers, body });
  expect(response.status).toBe(201);
  const record = await response.json();
  expect(record).toMatchObject({ projectId: A, sha1, size: body.length });
  expect(await list(A.toUpperCase())).toEqual(await list(A));
  expect(await readdir(directory)).toEqual([A]);
  expect((await fetch(`${url}/upload/${A}/${"0".repeat(40)}`, { method: "POST", headers, body })).status).toBe(422);
  expect((await list(A)).files).toEqual([{ name: record.name, size: body.length }]);
  expect(await readdir(join(directory, A))).toEqual([record.name]);
});

test("validates project paths, checksums, methods, and authentication before creating directories", async () => {
  const { directory, url } = await fixture();
  for (const path of [`/upload/${A}`, `/upload/${A}/${"a".repeat(40)}`, `/list/${A}`]) {
    expect((await fetch(`${url}${path}`, { method: path.startsWith("/upload") ? "POST" : "GET" })).status).toBe(401);
  }
  for (const id of ["", "not-a-uuid", A.replaceAll("-", ""), `${A}/extra`, "%2e%2e%2f", `%2f${A}`, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaag"]) {
    expect((await fetch(uploadUrl(url, id, "contents"), { method: "POST", headers, body: "contents" })).status).toBe(400);
    expect((await fetch(`${url}/list/${id}`, { headers })).status).toBe(400);
  }
  expect((await fetch(`${url}/upload/${A}/invalid`, { method: "POST", headers, body: "contents" })).status).toBe(400);
  for (const path of ["/upload", `/upload/${A}`, `/upload/${A}/`]) {
    const response = await fetch(`${url}${path}`, { method: "POST", headers, body: "no checksum" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("SHA-1 is required");
  }
  expect((await fetch(`${url}/upload/${A}`, { headers })).status).toBe(405);
  expect((await fetch(`${url}/list/${A}`, { headers, method: "POST" })).status).toBe(405);
  expect(await readdir(directory)).toEqual([]);
});

test("different UUIDs upload concurrently while each UUID rejects a second upload", async () => {
  const { directory, url, list } = await fixture();
  const first = streamUpload(url, A);
  first.request.write("first");
  const second = streamUpload(url, B, "second");
  second.request.write("second");
  await eventually(async () => {
    const sizes = await Promise.all([A, B].map(async (id) => (await stat(join(directory, id, ".upload.part")).catch(() => null))?.size ?? 0));
    return sizes.every((size) => size > 0);
  });
  for (const id of [A.toUpperCase(), B]) {
    const other = await fetch(uploadUrl(url, id, "blocked"), { method: "POST", headers, body: "blocked" });
    expect(other.status).toBe(409);
    expect(await other.json()).toEqual({ error: "upload in progress" });
  }
  expect((await list(A)).files).toEqual([]);
  expect((await list(B)).files).toEqual([]);
  second.request.end();
  expect((await second.response).status).toBe(201);
  expect((await fetch(uploadUrl(url, B, "another"), { method: "POST", headers, body: "another" })).status).toBe(201);
  expect((await fetch(uploadUrl(url, A, "still blocked"), { method: "POST", headers, body: "still blocked" })).status).toBe(409);
  first.request.end();
  expect((await first.response).status).toBe(201);
  expect((await list(A)).files.length).toBe(1);
  expect((await list(B)).files.length).toBe(2);
});

test("one project's timeout leaves other project data and locks independent", async () => {
  const { directory, url, list } = await fixture({ uploadTimeoutMs: 150 });
  const first = streamUpload(url, A);
  first.request.write("incomplete");
  expect((await fetch(uploadUrl(url, B, "complete"), { method: "POST", headers, body: "complete" })).status).toBe(201);
  expect((await first.response).status).toBe(408);
  expect(await readdir(join(directory, A))).toEqual([]);
  expect((await list(B)).files.length).toBe(1);
  expect((await fetch(uploadUrl(url, A, "retry"), { method: "POST", headers, body: "retry" })).status).toBe(201);
});

test("shutdown cleans up every active project upload", async () => {
  const { directory, url, stop } = await fixture();
  for (const id of [A, B]) {
    const stream = streamUpload(url, id);
    stream.request.write("partial");
  }
  await eventually(async () => (await Promise.all([A, B].map(async (id) => (await stat(join(directory, id, ".upload.part")).catch(() => null))?.size ?? 0))).every((size) => size > 0));
  await stop();
  expect(await readdir(join(directory, A))).toEqual([]);
  expect(await readdir(join(directory, B))).toEqual([]);
});

test("startup retention and crash cleanup stay within each UUID", async () => {
  const hour = Math.floor((Date.now() - 5 * HOUR) / HOUR) * HOUR;
  const older = backupName(hour + 1000);
  const newer = backupName(hour + 2000);
  const { directory, list } = await fixture({}, async (root) => {
    for (const id of [A, B]) {
      await mkdir(join(root, id));
      await writeFile(join(root, id, older), id);
      await writeFile(join(root, id, ".upload.part"), "interrupted");
    }
    await writeFile(join(root, A, newer), "newer A");
    await mkdir(join(root, "unrelated"));
    await writeFile(join(root, "unrelated", ".upload.part"), "keep me");
  });
  expect(await readdir(join(directory, A))).toEqual([newer]);
  expect(await readdir(join(directory, B))).toEqual([older]);
  expect((await list(A)).files).toEqual([{ name: newer, size: 7 }]);
  expect((await list(B)).files).toEqual([{ name: older, size: B.length }]);
  expect(await readFile(join(directory, "unrelated", ".upload.part"), "utf8")).toBe("keep me");
});

test("periodic retention discovers project directories and never combines their buckets", async () => {
  const { directory } = await fixture({ retentionIntervalMs: 20 });
  const hour = Math.floor((Date.now() - 5 * HOUR) / HOUR) * HOUR;
  const older = backupName(hour + 1000);
  const newer = backupName(hour + 2000);
  for (const id of [A, B]) {
    await mkdir(join(directory, id));
    await writeFile(join(directory, id, older), id);
  }
  await writeFile(join(directory, A, newer), "newer A");
  await eventually(async () => (await readdir(join(directory, A))).length === 1);
  expect(await readdir(join(directory, B))).toEqual([older]);
});

test("project symlinks cannot expose, overwrite, or clean up another project", async () => {
  const { directory, url, list } = await fixture({}, async (root) => {
    await mkdir(join(root, A));
    await symlink(join(root, A), join(root, B));
  });
  const temporaryPath = join(directory, A, ".upload.part");
  await writeFile(temporaryPath, "other project's in-flight bytes");
  expect((await fetch(uploadUrl(url, B, "overwrite"), { method: "POST", headers, body: "overwrite" })).status).toBe(500);
  expect((await fetch(`${url}/list/${B}`, { headers })).status).toBe(500);
  expect(await readFile(temporaryPath, "utf8")).toBe("other project's in-flight bytes");
  expect((await list(A)).files).toEqual([]);
});

test("migrates old root backups into the default UUID and preserves both legacy endpoints", async () => {
  const name = backupName(Date.now());
  const { directory, url, list } = await fixture({}, async (root) => {
    await writeFile(join(root, name), "existing encrypted backup");
    await writeFile(join(root, ".upload.part"), "interrupted old upload");
    await writeFile(join(root, "notes.txt"), "unrelated");
  });
  expect((await readdir(directory)).sort()).toEqual([DEFAULT_PROJECT_ID, "notes.txt"].sort());
  expect(await readFile(join(directory, DEFAULT_PROJECT_ID, name), "utf8")).toBe("existing encrypted backup");
  const oldList = await (await fetch(`${url}/list`, { headers })).json();
  expect(await list(DEFAULT_PROJECT_ID)).toEqual({ projectId: DEFAULT_PROJECT_ID, ...oldList });
  expect((await fetch(`${url}/upload/${sha1Of("another backup")}`, { method: "POST", headers, body: "another backup" })).status).toBe(201);
  expect((await list(DEFAULT_PROJECT_ID)).files.length).toBe(2);
});

test("migration resumes after linking without deleting a different existing backup", async () => {
  const directory = await temporaryDirectory();
  const name = backupName(Date.now());
  const destination = join(directory, DEFAULT_PROJECT_ID);
  await mkdir(destination);
  await writeFile(join(directory, name), "original");
  await writeFile(join(destination, name), "different");
  await expect(createBackupServer({ token, directory, port: 0 })).rejects.toThrow("conflicts with migration");
  expect(await readFile(join(directory, name), "utf8")).toBe("original");
  expect(await readFile(join(destination, name), "utf8")).toBe("different");
  await rm(join(destination, name));
  await link(join(directory, name), join(destination, name));
  const app = await createBackupServer({ token, directory, port: 0 });
  cleanup.push(() => app.stop());
  expect(await readdir(directory)).toEqual([DEFAULT_PROJECT_ID]);
  expect(await readFile(join(destination, name), "utf8")).toBe("original");
});

test("projects and their separate lists survive a server restart", async () => {
  const { directory, url, stop } = await fixture();
  for (const id of [A, B]) {
    expect((await fetch(uploadUrl(url, id, id), { method: "POST", headers, body: id })).status).toBe(201);
  }
  await stop();
  const restarted = await createBackupServer({ token, directory, hostname: "127.0.0.1", port: 0 });
  cleanup.push(() => restarted.stop());
  for (const id of [A, B]) {
    const response = await fetch(new URL(`/list/${id}`, restarted.server.url), { headers });
    const body = await response.json();
    expect(body.projectId).toBe(id);
    expect(body.files.length).toBe(1);
    expect(await readFile(join(directory, id, body.files[0].name), "utf8")).toBe(id);
  }
});
