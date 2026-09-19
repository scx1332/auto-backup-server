# Auto backup server

A Bun server with zero package dependencies for storing already-encrypted files
as opaque bytes. It accepts one upload at a time with a one-hour total deadline.

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
| `BACKUP_DIR` | `./backups` | Directory for completed and temporary files |

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
Examples assume `BACKUP_TOKEN` and optionally `PORT` are exported in your shell.

### `POST /upload/<sha1>`

Send a single file as a raw request body, using its SHA-1 checksum in the URL.
The checksum must contain exactly 40 hexadecimal characters; either case is
accepted. Original filenames and query parameters are ignored.

```sh
checksum=$(sha1sum backup.enc | cut -d ' ' -f 1)
curl --fail-with-body -X POST \
  -H "Authorization: Bearer $BACKUP_TOKEN" \
  -H 'Content-Type: application/octet-stream' \
  -T backup.enc \
  "http://localhost:${PORT:-3000}/upload/$checksum"
```

The server streams the body to a temporary file, flushes and closes it, then
**reopens and rereads the saved file** to calculate SHA-1. Only a matching file is
renamed to its final timestamp name and made visible in `/list`. Both transfer
and verification run under the same upload lock and one-hour deadline. Memory
usage is bounded by stream chunks.

Success (`201`):

```json
{"name":"2026-01-01T12-30-00.123Z.backup","size":3,"sha1":"a9993e364706816aba3e25717850c26c9cd0d89d"}
```

On mismatch, the server returns `422` with
`{"error":"SHA-1 checksum mismatch"}`, discards the temporary file, and releases
the upload lock. No completed backup is created.

### `POST /upload`

The original raw-body endpoint remains available without checksum verification.
It returns `201` with `{ "name": "...", "size": 123 }` after flushing the file and
publishing its final name.

### `GET /list`

Returns completed files, newest first, with sizes in bytes:

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $BACKUP_TOKEN" \
  "http://localhost:${PORT:-3000}/list"
```

```json
{"files":[{"name":"2026-01-01T12-30-00.123Z.backup","size":3}]}
```

The list stays available during uploads and verification; temporary files are
never listed. Compare the upload response's name and size with this list.
Restore files directly from the storage directory.

### Errors

| Status | Meaning |
| --- | --- |
| `400` | Invalid checksum format, empty body, or incomplete/interrupted upload |
| `401` | Missing or incorrect token |
| `408` | One-hour total deadline reached |
| `409` | `{"error":"upload in progress"}`; retry later |
| `415` | Multipart body; send one raw file instead |
| `422` | Saved file does not match the supplied SHA-1 checksum |
| `500` | Storage or server error |

Chunked bodies are supported. There is no configured file-size cap; available
disk space and the deadline are the limits. Timeout or disconnect removes the
partial file and releases the lock. Startup removes a partial file left by a
crash. Interrupted uploads cannot resume.

## Storage and retention

Completed filenames use the UTC completion time, with milliseconds advanced if
needed to avoid collisions. Files have mode `0600`. The server never interprets
or decrypts their contents.

Retention runs at startup, after successful uploads, and every minute. It uses
timestamps in filenames, not filesystem modification times. In each age band:

| Backup age | Keep |
| --- | --- |
| Up to and including 1 hour | Every file |
| More than 1 hour, up to and including 48 hours | Newest file per populated UTC hour |
| More than 48 hours, up to and including one calendar month | Newest file per populated UTC day |
| More than one calendar month | Newest file per populated UTC month, indefinitely |

A calendar month means the same UTC time on the previous month's date, clamped
to its last day when necessary. Retention ignores unrelated filenames,
directories, and symbolic links. Empty time buckets do not create new backups.

## Tests and releases

```sh
bun test
```

The built-in test runner exercises real HTTP requests, concurrent uploads,
timeouts, disconnects, stored-byte integrity, on-disk corruption detection,
checksum failures, and UTC retention boundaries.

GitHub Actions runs tests on `main`, pull requests, and version tags. A stable
`vMAJOR.MINOR.PATCH` tag matching `package.json` publishes a Linux amd64 container
using the built-in `GITHUB_TOKEN`, then creates a release containing the immutable
image reference in `image-digest.txt`.
