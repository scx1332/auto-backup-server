import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { backupName, HOUR, listBackups, pruneBackups } from "./retention.js";
import { DEFAULT_PROJECT_ID, migrateLegacyBackups, normalizeProjectId, projectDirectory, projectIds } from "./projects.js";

const json = (body, status = 200, headers = {}) => Response.json(body, {
  status,
  headers: { "Cache-Control": "no-store", ...headers },
});

class UploadError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function createBackupServer({
  token,
  directory = "./backups",
  hostname = "0.0.0.0",
  port = 3000,
  uploadTimeoutMs = HOUR,
  retentionIntervalMs = 60_000,
} = {}) {
  if (typeof token !== "string" || !token.trim() || token === "change-me") {
    throw new Error("Set a non-empty BACKUP_TOKEN in .env before starting the server");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid PORT");
  directory = resolve(directory);
  await mkdir(directory, { recursive: true });
  await migrateLegacyBackups(directory);
  const projects = new Map();
  let maintenance;
  const authorization = Buffer.from(`Bearer ${token}`);

  function project(id) {
    if (!projects.has(id)) {
      projects.set(id, {
        id,
        directory: join(directory, id),
        initialized: false,
        lastTimestamp: 0,
        uploading: false,
        activeUpload: undefined,
        uploadFinished: Promise.resolve(),
        pruning: undefined,
      });
    }
    return projects.get(id);
  }

  // A single server owns the root directory. Clear crash remnants in each
  // existing project before serving requests; never touch other directories.
  for (const id of await projectIds(directory)) {
    const state = project(id);
    await projectDirectory(directory, id);
    await rm(join(state.directory, ".upload.part"), { force: true });
    await pruneBackups(state.directory);
    state.lastTimestamp = (await listBackups(state.directory))[0]?.time ?? 0;
    state.initialized = true;
  }

  function prune(state) {
    if (!state.pruning) {
      state.pruning = projectDirectory(directory, state.id)
        .then((path) => path ? pruneBackups(path) : undefined)
        .catch((error) => console.error("Retention failed:", error.message))
        .finally(() => { state.pruning = undefined; });
    }
    return state.pruning;
  }

  function pruneAll() {
    if (!maintenance) {
      maintenance = projectIds(directory)
        .then((ids) => Promise.all(ids.map((id) => prune(project(id)))))
        .catch((error) => console.error("Retention failed:", error.message))
        .finally(() => { maintenance = undefined; });
    }
    return maintenance;
  }

  async function upload(request, state, expectedSha1, legacy) {
    if (state.uploading) return json({ error: "upload in progress" }, 409, { Connection: "close" });
    if (!request.body) return json({ error: "Upload body is required" }, 400);
    if (request.headers.get("content-type")?.toLowerCase().startsWith("multipart/")) {
      return json({ error: "Send one raw file body, not multipart/form-data" }, 415, { Connection: "close" });
    }

    // Acquire before the first await so simultaneous requests cannot both enter.
    state.uploading = true;
    let finish;
    state.uploadFinished = new Promise((resolve) => { finish = resolve; });
    const controller = new AbortController();
    state.activeUpload = controller;
    const temporaryPath = join(state.directory, ".upload.part");
    const reader = request.body.getReader();
    const abort = () => { void reader.cancel(controller.signal.reason).catch(() => {}); };
    controller.signal.addEventListener("abort", abort, { once: true });
    const disconnected = () => controller.abort(new UploadError("Upload interrupted", 400));
    request.signal.addEventListener("abort", disconnected, { once: true });
    if (request.signal.aborted) disconnected();
    const timer = setTimeout(() => controller.abort(new UploadError("Upload timed out after 1 hour", 408)), uploadTimeoutMs);
    let file;
    let ownsTemporaryFile = false;
    let size = 0;
    try {
      await projectDirectory(directory, state.id, true);
      if (!state.initialized) {
        state.lastTimestamp = (await listBackups(state.directory))[0]?.time ?? 0;
        state.initialized = true;
      }
      controller.signal.throwIfAborted();
      file = await open(temporaryPath, "wx", 0o600);
      ownsTemporaryFile = true;
      while (true) {
        controller.signal.throwIfAborted();
        const { done, value } = await reader.read();
        controller.signal.throwIfAborted();
        if (done) break;
        // Await disk writes before reading more: memory is bounded by stream chunks.
        let offset = 0;
        while (offset < value.byteLength) {
          controller.signal.throwIfAborted();
          const { bytesWritten } = await file.write(value, offset, value.byteLength - offset);
          if (bytesWritten === 0) throw new Error("Unable to write upload");
          offset += bytesWritten;
        }
        size += value.byteLength;
      }
      if (size === 0) throw new UploadError("Upload body is empty", 400);
      const contentLength = request.headers.get("content-length");
      if (contentLength !== null && Number(contentLength) !== size) {
        throw new UploadError("Incomplete upload", 400);
      }
      await file.sync();
      await file.close();
      file = undefined;
      controller.signal.throwIfAborted();
      // Verify the saved bytes by reopening the flushed file, keeping the lock
      // and deadline active until verification finishes.
      const hash = createHash("sha1");
      for await (const chunk of createReadStream(temporaryPath, { signal: controller.signal })) {
        controller.signal.throwIfAborted();
        hash.update(chunk);
      }
      controller.signal.throwIfAborted();
      const sha1 = hash.digest("hex");
      if (sha1 !== expectedSha1) throw new UploadError("SHA-1 checksum mismatch", 422);
      // Completion time keeps a long-running upload in the full-retention window.
      // Incrementing milliseconds also handles rapid sequential uploads/clock rollback.
      const timestamp = Math.max(Date.now(), state.lastTimestamp + 1);
      const name = backupName(timestamp);
      clearTimeout(timer);
      await rename(temporaryPath, join(state.directory, name));
      state.lastTimestamp = timestamp;
      void prune(state);
      return json({ ...(legacy ? {} : { projectId: state.id }), name, size, sha1 }, 201);
    } catch (error) {
      const cause = controller.signal.aborted ? controller.signal.reason : error;
      if (!(cause instanceof UploadError)) console.error("Upload failed:", cause.message);
      return json({ error: cause instanceof UploadError ? cause.message : "Unable to store upload" },
        cause instanceof UploadError ? cause.status : 500, { Connection: "close" });
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", disconnected);
      controller.signal.removeEventListener("abort", abort);
      void reader.cancel().catch(() => {});
      try {
        if (file) await file.close();
        if (ownsTemporaryFile) await rm(temporaryPath, { force: true });
      } finally {
        state.activeUpload = undefined;
        state.uploading = false;
        finish();
      }
    }
  }

  const server = Bun.serve({
    hostname,
    port,
    // Backups can exceed Bun's default body limit; stream them without buffering.
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    async fetch(request, server) {
      const supplied = Buffer.from(request.headers.get("authorization") ?? "");
      if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
        return json({ error: "Unauthorized" }, 401, { "WWW-Authenticate": "Bearer", Connection: "close" });
      }
      const path = new URL(request.url).pathname;
      if (path === "/upload" || path.startsWith("/upload/")) {
        if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
        const parts = path.split("/").slice(2);
        const legacy = parts.length === 0 || (parts.length === 1 && /^[a-f0-9]{40}$/i.test(parts[0]));
        const id = legacy ? DEFAULT_PROJECT_ID : normalizeProjectId(parts[0]);
        if (!id || parts.length > 2) {
          return json({ error: "A valid project UUID is required" }, 400, { Connection: "close" });
        }
        const expectedSha1 = (legacy ? parts[0] : parts[1])?.toLowerCase();
        if (!expectedSha1 || !/^[a-f0-9]{40}$/.test(expectedSha1)) {
          return json({ error: "SHA-1 is required and must be 40 hexadecimal characters" }, 400, { Connection: "close" });
        }
        // Bun's idle timeout is not the one-hour total upload deadline.
        server.timeout(request, 0);
        return upload(request, project(id), expectedSha1, legacy);
      }
      if (path === "/list" || path.startsWith("/list/")) {
        if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
        const legacy = path === "/list";
        const id = legacy ? DEFAULT_PROJECT_ID : normalizeProjectId(path.slice("/list/".length));
        if (!id) return json({ error: "A valid project UUID is required" }, 400);
        const pathForProject = await projectDirectory(directory, id);
        const files = pathForProject ? await listBackups(pathForProject) : [];
        return json({ ...(legacy ? {} : { projectId: id }), files: files.map(({ name, size }) => ({ name, size })) });
      }
      return json({ error: "Not found" }, 404);
    },
    error(error) {
      console.error("Request failed:", error.message);
      return json({ error: "Internal server error" }, 500);
    },
  });
  const interval = setInterval(pruneAll, retentionIntervalMs);
  interval.unref();

  return {
    server,
    async stop() {
      clearInterval(interval);
      for (const state of projects.values()) {
        state.activeUpload?.abort(new UploadError("Server is shutting down", 503));
      }
      await server.stop(true);
      await Promise.all([...projects.values()].map((state) => state.uploadFinished));
      await maintenance;
      await Promise.all([...projects.values()].map((state) => state.pruning));
    },
  };
}

if (import.meta.main) {
  const app = await createBackupServer({
    token: process.env.BACKUP_TOKEN,
    directory: process.env.BACKUP_DIR || "./backups",
    port: Number(process.env.PORT || 3000),
  });
  console.log(`Backup server listening on ${app.server.url}`);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, async () => {
      await app.stop();
      process.exit(0);
    });
  }
}
