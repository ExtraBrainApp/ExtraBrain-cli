# ExtraBrain CLI

`extrabrain` is a standalone local command for the document API of a running ExtraBrain desktop app. The CLI reads local files and sends their bytes to the app through its authenticated loopback API. It does not launch the app, inspect its database, or require system Node or Python.

## Install

Supported release targets are macOS arm64 and x64. The current release is not Developer ID signed or notarized; macOS Gatekeeper may require an extra approval when opening a downloaded executable. Downloaded archives are checked against the release's `SHA256SUMS` before an existing executable is replaced.

macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/ExtraBrainApp/ExtraBrain-cli/master/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
extrabrain --version
```

The installer needs no administrator privileges. It uses `curl`, `tar`, and `shasum` or `sha256sum`.

Install a particular stable release with `EXTRABRAIN_VERSION=v0.1.1` in the installer environment. The default is the latest stable GitHub release. Release tags use `vMAJOR.MINOR.PATCH`; CLI and app API versions are independent. An installed executable stays at its installed version during document commands. Run `extrabrain update` or rerun the installer to update it explicitly. `extrabrain --version` reports the installed version.

To uninstall, remove only `~/.local/bin/extrabrain`. Removing the command leaves ExtraBrain application data, imported documents, and import resume manifests intact. Revoke the CLI's pairing in the app if access should end.

## App compatibility

The CLI requires a running app listener on `127.0.0.1:37373` by default. If the app's document API uses another port, set `EXTRABRAIN_PORT` to that numeric port. The CLI checks discovery API version `v1` and each required document capability before a protected command. It reports exit code `3` when no app is running and `8` for an unsupported API version or disabled capability. It never starts a second app instance.

| CLI release | Required app API | App build | Status |
| --- | --- | --- | --- |
| 0.1.0 | `v1` discovery and document capabilities from ExtraBrain PR #985 | Direct download with document automation enabled | Protocol tests pass; installed-app acceptance pending |
| 0.1.0 | Same API | Mac App Store | Live acceptance pending app listener support |

The CLI has no distribution-channel check. A Mac App Store app will work when it exposes the same approved local API. The app currently proposed in PR #985 does not start that listener in MAS builds.

## Agent workflow

The app must be running and its document automation listener enabled. Approve the pairing request in the app. Pairing stores the credential in macOS Keychain. There is no plaintext fallback. Pairing defaults to `documents.metadata.read` and `documents.import`.

```sh
extrabrain --json capabilities
extrabrain pair
extrabrain --json documents import -- report.pdf notes.md
extrabrain --json documents status <batch-id>
extrabrain --json documents status --item <item-id>
extrabrain --json documents resume <resume-id>
extrabrain --json documents list
```

Request elevated scopes explicitly and approve the new request in the app before reading extracted text, deleting, or exporting originals:

```sh
extrabrain pair --scope documents.metadata.read --scope documents.text.read
extrabrain --json documents search --limit 10 "release risks"
extrabrain --json documents text --generation 2 --offset 0 --max-chars 5000 <document-id>

extrabrain pair --scope documents.metadata.read --scope documents.original.export
extrabrain --json documents export --output ./report-copy.pdf <document-id>

extrabrain pair --scope documents.metadata.read --scope documents.delete
extrabrain --json documents delete --revision 4 <document-id>
```

A new pairing request replaces the CLI's stored credential. Request all needed scopes together if one workflow uses several elevated operations. Delete requires explicit user intent, one document ID, and its current revision. On a revision conflict, read current metadata and ask again rather than retrying deletion automatically. Original export writes the exact managed bytes to a new path and refuses to overwrite an existing file. Extracted text is bounded and tied to an index generation; it is not a reconstruction of the original.

The CLI reads files from its own filesystem namespace. A container or remote agent cannot import a desktop-only path. Use the app's native file picker when the CLI cannot read the file. Imports are additive: missing directory entries never delete app documents. Supported inputs are UTF-8 `.txt`, `.md`, and `.pdf`, at most 10 MiB per file and 20 files per batch. Nested directories require `--recursive`. Symlinks, devices, and other non-regular files are rejected. Put paths beginning with `-` after `--`. On interruption, use the returned resume ID to retry unchanged files. Changed source bytes require a fresh import intent.

JSON commands return `{ "code": number, "data": object | null, "message": string }`. Exit codes: `0` success, `1` failure, `2` usage, `3` app not running, `4` authentication or revocation, `5` conflict, `6` partial batch, `7` protected storage unavailable, `8` unsupported API or capability. A partial batch reports every file and a resume ID. No binary content or credential appears in command output.

## Develop

Use Node 24.20.0 and npm 11.19.0 to build from source. `npm ci`, `npm run typecheck`, and `npm test` validate the CLI. `npm run build:sea` creates a self-contained executable for the host platform in `dist/`. Source and direct tests were extracted from ExtraBrain PR #985. The app owns the local API, approval flow, ingestion, and persistence; this repository owns only the CLI.

## Release

Run the `Standalone CLI release` workflow on `master` and choose `patch`, `minor`, or `major`. The workflow increments the version in `package.json` and `package-lock.json`, builds macOS arm64 and x64 archives, then commits the new version, creates its tag, and publishes the archives with `SHA256SUMS`. The CLI reads its version from `package.json`, so there is no separate version to edit. A future signed and notarized build should use a new release version because signing changes the executable and its checksum.

## License

MIT. See [LICENSE](LICENSE).
