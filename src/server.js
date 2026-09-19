import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { backupName, HOUR, listBackups, pruneBackups } from "./retention.js";

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
  const temporaryPath = join(directory, ".upload.part");
  // A single server owns this directory. A crash never publishes a partial file.
  await rm(temporaryPath, { force: true });
  await pruneBackups(directory);
  let lastTimestamp = (await listBackups(directory))[0]?.time ?? 0;
  let uploading = false;
  let activeUpload;
  let uploadFinished = Promise.resolve();
  let pruning;
  const authorization = Buffer.from(`Bearer ${token}`);

  function prune() {
    if (!pruning) {
      pruning = pruneBackups(directory)
        .catch((error) => console.error("Retention failed:", error.message))
        .finally(() => { pruning = undefined; });
    }
    return pruning;
  }

  async function upload(request, expectedSha1) {
    if (uploading) return json({ error: "upload in progress" }, 409, { Connection: "close" });
    if (!request.body) return json({ error: "Upload body is required" }, 400);
    if (request.headers.get("content-type")?.toLowerCase().startsWith("multipart/")) {
      return json({ error: "Send one raw file body, not multipart/form-data" }, 415, { Connection: "close" });
    }

    // Acquire before the first await so simultaneous requests cannot both enter.
    uploading = true;
    let finish;
    uploadFinished = new Promise((resolve) => { finish = resolve; });
    const controller = new AbortController();
    activeUpload = controller;
    const reader = request.body.getReader();
    const abort = () => { void reader.cancel(controller.signal.reason).catch(() => {}); };
    controller.signal.addEventListener("abort", abort, { once: true });
    const disconnected = () => controller.abort(new UploadError("Upload interrupted", 400));
    request.signal.addEventListener("abort", disconnected, { once: true });
    if (request.signal.aborted) disconnected();
    const timer = setTimeout(() => controller.abort(new UploadError("Upload timed out after 1 hour", 408)), uploadTimeoutMs);
    let file;
    let size = 0;
    try {
      file = await open(temporaryPath, "wx", 0o600);
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
      let sha1;
      if (expectedSha1) {
        // Verify the saved bytes by reopening the flushed file, keeping the lock
        // and deadline active until verification finishes.
        const hash = createHash("sha1");
        for await (const chunk of createReadStream(temporaryPath, { signal: controller.signal })) {
          controller.signal.throwIfAborted();
          hash.update(chunk);
        }
        controller.signal.throwIfAborted();
        sha1 = hash.digest("hex");
        if (sha1 !== expectedSha1) throw new UploadError("SHA-1 checksum mismatch", 422);
      }
      // Completion time keeps a long-running upload in the full-retention window.
      // Incrementing milliseconds also handles rapid sequential uploads/clock rollback.
      const timestamp = Math.max(Date.now(), lastTimestamp + 1);
      const name = backupName(timestamp);
      clearTimeout(timer);
      await rename(temporaryPath, join(directory, name));
      lastTimestamp = timestamp;
      void prune();
      return json({ name, size, ...(sha1 ? { sha1 } : {}) }, 201);
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
        await rm(temporaryPath, { force: true });
      } finally {
        activeUpload = undefined;
        uploading = false;
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
        const expectedSha1 = path === "/upload" ? undefined : path.slice("/upload/".length).toLowerCase();
        if (expectedSha1 !== undefined && !/^[a-f0-9]{40}$/.test(expectedSha1)) {
          return json({ error: "SHA-1 must be 40 hexadecimal characters" }, 400, { Connection: "close" });
        }
        // Bun's idle timeout is not the one-hour total upload deadline.
        server.timeout(request, 0);
        return upload(request, expectedSha1);
      }
      if (path === "/list") {
        if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
        return json({ files: (await listBackups(directory)).map(({ name, size }) => ({ name, size })) });
      }
      return json({ error: "Not found" }, 404);
    },
    error(error) {
      console.error("Request failed:", error.message);
      return json({ error: "Internal server error" }, 500);
    },
  });
  const interval = setInterval(prune, retentionIntervalMs);
  interval.unref();

  return {
    server,
    async stop() {
      clearInterval(interval);
      activeUpload?.abort(new UploadError("Server is shutting down", 503));
      await server.stop(true);
      await uploadFinished;
      await pruning;
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
