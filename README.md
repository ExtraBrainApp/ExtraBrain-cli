# ExtraBrain CLI

`extrabrain` is a standalone local command for documents and read-only session evidence in a running ExtraBrain desktop app. Document commands and session reads use the app's token-free loopback HTTP API. The CLI does not launch the app, inspect its database, or require system Node or Python.

## Install

Supported release targets are macOS arm64 and x64. The current release is not Developer ID signed or notarized; macOS Gatekeeper may require an extra approval when opening a downloaded executable. Downloaded archives are checked against the release's `SHA256SUMS` before an existing executable is replaced.

macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/ExtraBrainApp/ExtraBrain-cli/master/install.sh | bash
```

Open a new terminal window, then check the installed version:

```sh
extrabrain --version
```

The installer puts the standalone executable in `~/.local/bin` for your account. It needs no administrator password, Node, or Python. For zsh and bash, it adds a small PATH block to your shell startup files automatically, so no manual export command is needed. It uses `curl`, `tar`, and `shasum` or `sha256sum`.

For zsh, it updates `.zprofile` and `.zshrc` in `ZDOTDIR` or your home directory. For bash, it updates `.bashrc` and the first existing login file among `.bash_profile`, `.bash_login`, and `.profile`, creating `.bash_profile` if none exists. Existing content is preserved, and reinstalling does not duplicate the block. Set `EXTRABRAIN_NO_MODIFY_PATH=1` in the installer's environment to leave shell configuration untouched. Other shells can use `~/.local/bin/extrabrain` directly or a custom destination already on PATH.

Set `EXTRABRAIN_INSTALL_DIR` in the installer's environment for a custom destination. Custom destinations outside `~/.local/bin` do not change shell profiles. The installer warns if a custom destination is outside PATH or another ExtraBrain executable takes precedence. If automatic shell setup cannot write a profile, it reports the file and the installed executable's full path.

To install for all local accounts, explicitly select `/usr/local/bin`:

```sh
curl -fsSL https://raw.githubusercontent.com/ExtraBrainApp/ExtraBrain-cli/master/install.sh | env EXTRABRAIN_INSTALL_DIR=/usr/local/bin bash
```

This optional mode requests administrator approval when needed and installs a root-owned executable with permissions `755`. Downloads and checksum verification run before elevation; only installation filesystem operations use administrator privileges. Run it in a terminal if authentication is needed.

If you previously installed in `~/.local/bin`, rerun the default installer to configure your shell automatically. If you have another installation, check `command -v extrabrain` in your new terminal and remove an older copy only if it still takes precedence over the intended installation.

Install a particular stable release with `EXTRABRAIN_VERSION=v0.1.1` in the installer environment. The default is the latest stable GitHub release. Release tags use `vMAJOR.MINOR.PATCH`; CLI and app API versions are independent. An installed executable stays at its installed version during document commands. Run `extrabrain update` or rerun the installer to update it explicitly. `extrabrain update` replaces the running packaged executable in its current directory unless `EXTRABRAIN_INSTALL_DIR` explicitly overrides the destination. Updating a system-wide installation requires administrator approval when needed, just like installation. Check the version separately with `extrabrain --version` after the update completes.

To uninstall the default installation, run `rm ~/.local/bin/extrabrain`. You can leave the PATH block in place for other tools in that directory, or remove the block marked `# ExtraBrain CLI: user-local PATH` from the configured shell files. For a system-wide installation, run `sudo rm /usr/local/bin/extrabrain`; for a custom installation, remove only `extrabrain` from that directory. Removing the command leaves ExtraBrain application data, imported documents, and import resume manifests intact.

## App compatibility

The CLI requires a running app listener on `127.0.0.1:37373` by default. If the app's document API uses another port, set `EXTRABRAIN_PORT` to that numeric port. The CLI checks discovery API version `v1` and each required document capability before a document command. It reports exit code `3` when no app is running and `8` for an unsupported API version or disabled capability. It never starts a second app instance.

| CLI release | Required app API | App build | Status |
| --- | --- | --- | --- |
| 0.1.0 | `v1` discovery and document capabilities from ExtraBrain PR #985 | Direct download with document automation enabled | Protocol tests pass; installed-app acceptance pending |
| 0.1.0 | Same API | Mac App Store | Live acceptance pending app listener support |

The CLI has no distribution-channel check. A Mac App Store app will work when it exposes the same approved local API. The app currently proposed in PR #985 does not start that listener in MAS builds.

## Agent workflow

The app must be running and its document automation listener enabled. Current ExtraBrain V2 document HTTP commands require no pairing or stored credential, including on a clean installation. Retired document pairing endpoints return not found; the legacy `pair` command is not needed for this API. MCP retains its separate credential and approval requirements.

```sh
extrabrain --json capabilities
extrabrain --json documents import -- report.pdf notes.md
extrabrain --json documents status <batch-id>
extrabrain --json documents status --item <item-id>
extrabrain --json documents resume <resume-id>
extrabrain --json documents groups
extrabrain --json documents list
```

Read extracted text, search, export originals, and delete through the same token-free document API:

```sh
extrabrain --json documents search --limit 10 "release risks"
extrabrain --json documents text --generation 2 --offset 0 --max-chars 5000 <document-id>

extrabrain --json documents export --output ./report-copy.pdf <document-id>

extrabrain --json documents delete --revision 4 <document-id>
```

Delete requires explicit user intent, one document ID, and its current revision. On a revision conflict, read current metadata and ask again rather than retrying deletion automatically. Original export writes the exact managed bytes to a new path and refuses to overwrite an existing file. Extracted text is bounded and tied to an index generation; it is not a reconstruction of the original.

The CLI reads files from its own filesystem namespace. A container or remote agent cannot import a desktop-only path. Use the app's native file picker when the CLI cannot read the file. Imports are additive: missing directory entries never delete app documents. Supported inputs are UTF-8 `.txt`, `.md`, and `.pdf`, at most 10 MiB per file and 20 files per batch. Nested directories require `--recursive`. Symlinks, devices, and other non-regular files are rejected. Put paths beginning with `-` after `--`. On interruption, use the returned resume ID to retry unchanged files. Changed source bytes require a fresh import intent.

JSON commands return `{ "code": number, "data": object | null, "message": string }`. Exit codes: `0` success, `1` failure, `2` usage, `3` app not running, `4` authentication or revocation, `5` conflict, `6` partial batch, `7` protected storage unavailable, `8` unsupported API or capability. A partial batch reports every file and a resume ID. No binary content or credential appears in command output.

## Profiles

Profile commands require an app that advertises `profileApiVersion: "v1"` and the relevant `profileRead`, `profileWrite`, `profileSelection`, or `profileActions` capability. They require the capability-compatible application proposed in [ExtraBrain PR #1047](https://github.com/ExtraBrainApp/ExtraBrain/pull/1047); released apps may not yet expose these routes. Like document and session commands, they use the token-free loopback listener and `EXTRABRAIN_PORT`, never launch the app, and never write application settings directly.

```sh
extrabrain --json profiles list
extrabrain --json profiles get system assistant
extrabrain --json profiles get custom <profile-id>
extrabrain --json profiles selection

extrabrain --json profiles create --name "Research" --description "Evidence first" --prompt "Inspect the evidence" --icon brain --use-full-session-context
extrabrain --json profiles update custom <profile-id> --description "" --reset-use-full-session-context
extrabrain --json profiles update system <profile-id> --disabled
extrabrain --json profiles delete custom <profile-id>

extrabrain --json profiles pin system assistant
extrabrain --json profiles pin custom <profile-id>
extrabrain --json profiles auto
```

Use `--enabled` or `--disabled` for profiles and actions. Profile behavior flags are `--expand-window-on-analysis`, `--analyze-on-region-capture`, `--use-full-session-context`, `--auto-analyze-topics`, and `--auto-analyze-questions`; add `--no-` to set false or `--reset-` to remove a stored override. Empty quoted text clears `description` or `prompt`. Create and update also accept one strict JSON object with `--input '<json>'` or `--input-file path`; JSON input cannot be mixed with field flags. The app enforces the published limits and icon allowlists, and the CLI rejects malformed local inputs before sending them.

```sh
extrabrain --json profiles actions list system assistant
extrabrain --json profiles actions get custom <profile-id> <action-id>
extrabrain --json profiles actions create custom <profile-id> --name "Inspect" --prompt "Inspect evidence" --icon target
extrabrain --json profiles actions update system assistant <action-id> --disabled
extrabrain --json profiles actions delete custom <profile-id> <action-id>
extrabrain --json profiles actions order system assistant <action-id-1> <action-id-2>
```

Action ordering must list every action owned by that profile exactly once, including disabled actions. The profile path binds ownership. Built-in actions may only be enabled or disabled and cannot be deleted; the app also enforces the different Pro rules for custom profiles, custom actions, system controls, and existing custom actions under system profiles.

Every mutation sends `expectedRevision` and `requestId`. By default the CLI reads the target first to use its current revision and generates a UUID request ID, which it returns with the expected revision in JSON data and human output. Supply those values with `--revision <n> --request-id <id>` to make an exact retry. For a lost response, reuse the exact command, route, payload, revision, and ID. The CLI never silently retries conflicts or uncertain results. On `REVISION_CONFLICT`, read again, merge, and submit a new request ID. On `REQUEST_ID_REUSE` or `OPERATION_STATE_UNKNOWN`, inspect profiles/actions before deciding whether a new intent is needed. Recorded app replays retain their `replayed` and `revision` response fields.

## Document groups

Create a named group or append another batch to the same group:

```sh
extrabrain --json documents import --group "Acme interview" -- resume.pdf notes.md
extrabrain --json documents import --group "Acme interview" -- follow-up.md
extrabrain --json documents import --group-id <group-id> -- another-note.md
extrabrain --json documents resume <resume-id>
```

`--group` and `--group-id` are mutually exclusive. Names support Unicode; quote spaces and use `--group=-name` for a name beginning with a dash. Grouped imports require the app's `documentGroups` capability. Existing commands without a group continue to work with apps that lack that capability. Group listing, ID lookup, and grouped resume require no credential.

Each batch accepts up to 20 files; append additional batches to grow a group beyond 20. The same content can be imported independently into different named groups. Imports without a destination remain Ungrouped and retain library-wide duplicate checks.

JSON results include the destination's stable ID and current name. Resume keeps the original group ID, batch key, and item keys and skips successful files. A renamed group remains the same destination. A deleted group fails without falling back to Ungrouped or binding to a new group with the old name. Destination flags cannot override a resume.

The CLI saves its resolution key before sending a name request, so a lost response can be retried safely. An unresolved name request expires after seven days and requires a new, explicit import. Once the group ID is saved, resume never resolves its name again. Legacy version-1 manifests remain supported as ungrouped imports. Failed setup messages include the saved resume command.

## Session reads

These commands require a future compatible app that advertises `sessionApiVersion: "v1"` and the operation's `sessionMetadata`, `sessionSearch`, `sessionCurrent`, `sessionData`, or `analysisData` capability at `/.well-known/extrabrain`. The current document-only app does not yet expose these routes. Session reads need no CLI pairing or credential. They use the same `127.0.0.1` listener and `EXTRABRAIN_PORT` override.

```sh
extrabrain --json sessions list --limit 50 --since 1760000000 --until 1760100000
extrabrain --json sessions search --limit 50 "release risks"
extrabrain --json sessions current
extrabrain --json sessions get <session-id>
extrabrain --json sessions transcripts --limit 200 <session-id>
extrabrain --json sessions screenshots <session-id>
extrabrain --json sessions facts <session-id>
extrabrain --json sessions topics <session-id>
extrabrain --json sessions questions <session-id>
extrabrain --json sessions chat-turns <session-id>
extrabrain --json sessions insights <session-id>
extrabrain --json sessions analyses list <session-id>
extrabrain --json sessions analyses get <session-id> <analysis-id>
```

`list` and `search` accept `--limit`, `--cursor`, `--since`, and `--until`. Collection and analysis lists accept `--limit` and `--cursor`. The default page size is 50 and maximum is 200. Time filters are Unix seconds. Follow `data.nextCursor` on the same command with `--cursor`, keeping the original query and time filters. Pages include `items`, `totalCount`, `nextCursor`, and `snapshot`; an empty terminal page is valid. A snapshot conflict exits with code 5 and requires a fresh traversal. `current` reports bounded live coverage as supplied by the app, including a null active session ID when idle. Historical reads use persisted session IDs and app snapshots.

Records retain stored text, source, speaker, relative timing, relationships, and additive app fields. Long text may appear as a content reference. Read it with the originating snapshot, then follow `nextOffset` until null:

```sh
extrabrain --json sessions content --snapshot <snapshot> --offset 0 --max-chars 10000 <session-id> <content-id>
```

Content offsets and `totalChars` use JavaScript UTF-16 code units, as required by the proposed API contract. The CLI preserves unfiltered stored transcripts; any cleaned or model-supplied version is a separate labelled record. Relative audio timing fields retain milliseconds.

Analysis `get` exhausts every available manifest part and referenced text under one snapshot, with a 16 MiB JSON bound. Its `retrieval.complete` means all advertised available text was fetched. The app's `provenance.status` remains `complete`, `partial`, or `legacy_partial`, with missing categories and reasons. Older analyses cannot supply prompts, model attempts, continuity evidence, tool results, or final model input that the app did not retain. The CLI does not reconstruct them from current settings. Image descriptors contain identity and availability, never inline binary bytes. An oversized get returns `OUTPUT_TOO_LARGE` and recommends analysis export.

The proposed app contract uses `/api/v1/sessions`, `/search`, `/current`, `/{sessionId}`, `/{sessionId}/{collection}`, `/{sessionId}/analyses`, `/{sessionId}/analyses/{analysisId}`, `/{sessionId}/analyses/{analysisId}/parts/{partId}`, `/{sessionId}/content/{contentId}`, and `/{sessionId}/screenshots/{screenshotId}/image`. IDs and cursors are opaque and URL encoded. Every related page carries `snapshot`; content pages carry `contentId`, `text`, `offset`, `nextOffset`, and `totalChars`. Analysis manifests carry `schemaVersion`, scoped IDs, provenance, part descriptors and counts, and image descriptors. The app must retain immutable historical request/result, profile and prompts, strategy, provider/model attempts, primary and continuity evidence, prior context, facts/topics/questions, tools and results, budget decisions, and final model input wherever available. Image descriptors must identify each advertised representation, availability, media type, byte length, and SHA-256. The separate app implementation has not yet been verified against this proposed contract.

## Session exports

Export commands require `screenshotExport` in discovery. Full session export also requires `sessionMetadata`, `sessionData`, and `analysisData`; individual analysis export requires `analysisData`. Each destination must be a new path.

```sh
extrabrain --json sessions screenshot export --output ./screenshot.jpg <session-id> <screenshot-id>
extrabrain --json sessions screenshot export --output ./original.png --representation original <session-id> <screenshot-id>
extrabrain --json sessions analyses export --output ./analysis-bundle <session-id> <analysis-id>
extrabrain --json sessions export --output ./session-bundle <session-id>
```

Screenshot export selects the app-advertised default representation unless `--representation` names another advertised available one. The CLI streams and checks the advertised byte length and SHA-256 before publishing the new file. JSON contains identity, representation, media type, length, hash, and snapshot, not image bytes or the app's internal path. An unavailable original stays unavailable; the CLI does not recreate it from a reduced analysis image.

Session directories contain `manifest.json`, one JSONL file for each of `transcripts`, `screenshots`, `facts`, `topics`, `questions`, `chat-turns`, and `insights`, plus `content/`, `screenshots/`, and `analyses/`. Analysis directories contain `manifest.json`, `parts/*.jsonl`, `content/`, and `screenshots/`. Manifests map generated safe filenames to original IDs, describe representations and missing evidence, and record counts and retrieval completeness. Analysis subdirectories are self-contained. Files are private on POSIX systems (directories 0700, files 0600); protect exported session data when sharing it elsewhere.

An export starts with `incomplete.json` and writes `manifest.json` only after every advertised page, referenced text, and available image succeeds under one snapshot. On failure, the directory and progress marker remain for inspection, and the command reports the failure. Retry at a fresh destination after resolving the cause; there is no in-place resume. A completed export can still have `partial` or `legacy_partial` provenance when the app did not retain historical inputs.

## Develop

Use Node 24.20.0 and npm 11.19.0 to build from source. `npm ci`, `npm run typecheck`, and `npm test` validate the CLI. `npm run build:sea` creates a self-contained executable for the host platform in `dist/`. Source and direct tests were extracted from ExtraBrain PR #985. The app owns the local API, approval flow, ingestion, and persistence; this repository owns only the CLI.

## Release

Run the `Standalone CLI release` workflow on `master` and choose `patch`, `minor`, or `major`. The workflow increments the version in `package.json` and `package-lock.json`, builds macOS arm64 and x64 archives, then commits the new version, creates its tag, and publishes the archives with `SHA256SUMS`. The CLI reads its version from `package.json`, so there is no separate version to edit. A future signed and notarized build should use a new release version because signing changes the executable and its checksum.

## License

MIT. See [LICENSE](LICENSE).
