# Auto backup server

A Bun server with zero package dependencies for storing already-encrypted files
as opaque bytes. Consumers choose a UUID for each project. Each project has its
own directory, retention, listing, and upload lock. Different projects can upload
concurrently; each allows one upload at a time with a one-hour total deadline.
Every upload requires a SHA-1 checksum, verified by rereading the saved file.

## Run

Requires Bun 1.4.0 or newer. No dependency installation or build step is needed.

```sh
cp .env.example .env
# Set BACKUP_TOKEN to a secret, for example: openssl rand -hex 32
bun start
```

Bun automatically loads `.env`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `BACKUP_TOKEN` | required | Shared Bearer token for every endpoint |
| `PORT` | `3000` | HTTP port |
| `BACKUP_DIR` | `./backups` | Storage root containing a directory per project UUID |

Generic Docker Compose support is included:

```sh
docker compose up -d --build
```

Compose maps `BACKUP_DIR` to `/data/backups` and binds the configured port to
loopback. To use a published container instead, set `BACKUP_IMAGE` to its image
reference and run `docker compose up -d --no-build --pull always`.
Run one instance per storage directory. Host-specific routing, certificates,
credentials, and production configuration are managed separately.

## API

All endpoints require `Authorization: Bearer <BACKUP_TOKEN>`.
Authentication uses the shared token; UUIDs select projects, not separate
credentials. There is no project registration or project enumeration endpoint.
Every listing contains only the requested project's files.

Choose a UUID once per project and reuse it. UUIDs must use the hyphenated
`8-4-4-4-12` hexadecimal format. Both letter cases are accepted and normalized to
lowercase. The directory is created automatically on the first valid upload.
Listing an unused UUID returns an empty list without creating a directory.

Examples assume `BACKUP_TOKEN`, `PROJECT_UUID`, and optionally `PORT` are exported
in your shell. Generate a UUID locally with `uuidgen` or `crypto.randomUUID()`.

### `POST /upload/<uuid>/<sha1>`

Send a single file as a raw request body, using its SHA-1 checksum in the URL.
The checksum must contain exactly 40 hexadecimal characters; either case is
accepted. Original filenames and query parameters are ignored.

```sh
checksum=$(sha1sum backup.enc | cut -d ' ' -f 1)
curl --fail-with-body -X POST \
  -H "Authorization: Bearer $BACKUP_TOKEN" \
  -H 'Content-Type: application/octet-stream' \
  -T backup.enc \
  "http://localhost:${PORT:-3000}/upload/$PROJECT_UUID/$checksum"
```

The server streams the body to a temporary file, flushes and closes it, then
**reopens and rereads the saved file** to calculate SHA-1. Only a matching file is
renamed to its final timestamp name and made visible in `/list/<uuid>`. Both
transfer and verification run under the project's upload lock and one-hour deadline. Memory
usage is bounded by stream chunks.

Success (`201`):

```json
{"projectId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","name":"2026-01-01T12-30-00.123Z.backup","size":3,"sha1":"a9993e364706816aba3e25717850c26c9cd0d89d"}
```

On mismatch, the server returns `422` with
`{"error":"SHA-1 checksum mismatch"}`, discards the temporary file, and releases
the upload lock. No completed backup is created.

Requests without a checksum, including `POST /upload` and
`POST /upload/<uuid>`, return `400` and store no file.

### `GET /list/<uuid>`

Returns completed files, newest first, with sizes in bytes:

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $BACKUP_TOKEN" \
  "http://localhost:${PORT:-3000}/list/$PROJECT_UUID"
```

```json
{"projectId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","files":[{"name":"2026-01-01T12-30-00.123Z.backup","size":3}]}
```

The list stays available during uploads and verification; temporary files are
never listed. Compare the upload response's name and size with this list.
Restore files directly from the project's storage directory.

### Compatibility with existing clients

`POST /upload/<sha1>` and `GET /list` address the default project, the nil UUID
`00000000-0000-0000-0000-000000000000`. Their response shapes omit `projectId`.
They share the same lock and files as explicit requests using that UUID.
Checksum-free uploads are no longer supported.

### Errors

| Status | Meaning |
| --- | --- |
| `400` | Invalid UUID, missing/invalid checksum, empty body, or incomplete/interrupted upload |
| `401` | Missing or incorrect token |
| `408` | One-hour total deadline reached |
| `409` | `{"error":"upload in progress"}` for this UUID; retry later |
| `415` | Multipart body; send one raw file instead |
| `422` | Saved file does not match the supplied SHA-1 checksum |
| `500` | Storage or server error |

Chunked bodies are supported. There is no configured file-size cap; available
disk space and the deadline are the limits. Timeout or disconnect removes the
partial file and releases the lock. Startup removes a partial file left by a
crash. Interrupted uploads cannot resume.

## Storage and retention

Each project lives in `BACKUP_DIR/<uuid>/`, including its `.upload.part` file.
Completed filenames use the UTC completion time, with milliseconds advanced if
needed to avoid collisions within that project. Files have mode `0600` and new
project directories have mode `0700`. The server never interprets or decrypts
file contents. Project symlinks are rejected.

On upgrade, recognized backup files stored directly in the old storage root are
moved into the default UUID directory without overwriting existing files.
Unrelated files and directories are left alone. Stop the server before manually
removing an entire project directory; other projects do not depend on it.

Retention runs independently within each project at startup, after successful
uploads, and every minute. A file in one project never affects another project's
retention. It uses timestamps in filenames, not filesystem modification times.
In each age band:

| Backup age | Keep |
| --- | --- |
| Up to and including 1 hour | Every file |
| More than 1 hour, up to and including 48 hours | Newest file per populated UTC hour |
| More than 48 hours, up to and including 30 days | Newest file per populated UTC day |
| More than 30 days | Delete unless needed to retain one backup for its UTC calendar month |

The daily window is exactly 30 × 24 hours, regardless of month length. A recent,
hourly, or daily backup already represents its UTC calendar month, so any files
older than 30 days in that same month are deleted. If all backups in a month are
older than 30 days, only the newest one is kept, indefinitely. Retention ignores
unrelated filenames, directories, and symbolic links. Empty time buckets do not
create new backups.

## Tests and releases

```sh
bun test
```

The built-in test runner exercises real HTTP requests, concurrent uploads,
timeouts, disconnects, stored-byte integrity, on-disk corruption detection,
checksum failures, project isolation, migration, and UTC retention boundaries.

GitHub Actions runs tests on `main`, pull requests, and version tags. A stable
`vMAJOR.MINOR.PATCH` tag matching `package.json` publishes a Linux amd64 container
using the built-in `GITHUB_TOKEN`, then creates a release containing the immutable
image reference in `image-digest.txt`.
