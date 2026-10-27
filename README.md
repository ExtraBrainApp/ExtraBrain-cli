# ExtraBrain CLI

The ExtraBrain CLI is a small add-on for the [ExtraBrain](https://extrabrain.app) app on Mac and Windows. It lets you work with your ExtraBrain library by typing short commands in Terminal (Mac) or PowerShell (Windows) instead of clicking through the app. It is also handy for AI assistants and scripts that need to read from or add to your library.

To learn more about ExtraBrain itself, or to download the app, visit **[extrabrain.app](https://extrabrain.app)**.

> **Good to know:** The CLI is a companion to the app, not a replacement. **ExtraBrain must be open and running** on your computer whenever you use it. Everything stays on your computer; nothing is sent over the internet.

## What you need

- A Mac (Apple Silicon or Intel), or a Windows 10 or 11 PC (Intel/AMD or ARM).
- The ExtraBrain app, installed and open. Get it at [extrabrain.app](https://extrabrain.app).
- About two minutes. You do not need to install anything else (no Node, no Python), and no administrator password.

## Install

### Mac

1. Open the **Terminal** app. (Press `⌘ Space`, type "Terminal", and press Return.)
2. Copy the line below, paste it into Terminal, and press Return:

```sh
curl -fsSL https://raw.githubusercontent.com/ExtraBrainApp/ExtraBrain-cli/master/install.sh | bash
```

3. When it finishes, **close Terminal and open a new window**.
4. Check that it worked:

```sh
extrabrain --version
```

If you see a version number such as `0.1.8`, you are done.

**If macOS blocks the program the first time:** this release is not yet signed by Apple, so macOS may ask for extra approval. Open **System Settings → Privacy & Security**, scroll down, and choose **Open Anyway** next to the message about `extrabrain`.

**If Terminal says "command not found":** close every Terminal window and open a new one. The installer adds the command to your shell setup, and that only takes effect in new windows.

### Windows

1. Open **PowerShell**. (Press the Windows key, type "PowerShell", and press Enter.)
2. Copy the line below, paste it into PowerShell, and press Enter:

```powershell
irm https://raw.githubusercontent.com/ExtraBrainApp/ExtraBrain-cli/master/install.ps1 | iex
```

3. When it finishes, **close PowerShell and open a new window**.
4. Check that it worked:

```powershell
extrabrain --version
```

If you see a version number such as `0.1.8`, you are done.

The installer puts `extrabrain.exe` in `%LOCALAPPDATA%\ExtraBrain\bin` and adds that folder to your user `PATH`. It works for both Intel/AMD and ARM PCs and picks the right version automatically.

**If Windows shows "Windows protected your PC" or Microsoft Defender warns about the program:** this release is not yet signed by Microsoft, so Windows may ask for extra approval. Choose **More info → Run anyway**.

**If PowerShell says "'extrabrain' is not recognized":** close every PowerShell and Command Prompt window and open a new one. The installer adds the command to your `PATH`, and that only takes effect in new windows.

### Update

```sh
extrabrain update
```

Check the new version afterwards with `extrabrain --version`. On Windows the update finishes just after the command exits, so check the version with a new command. Updating never happens automatically.

### Uninstall

On a Mac:

```sh
rm ~/.local/bin/extrabrain
```

On Windows, in PowerShell:

```powershell
Remove-Item "$env:LOCALAPPDATA\ExtraBrain\bin\extrabrain.exe"
```

To also remove the folder from your `PATH` on Windows:

```powershell
$dir = "$env:LOCALAPPDATA\ExtraBrain\bin"
$path = ([Environment]::GetEnvironmentVariable('Path', 'User') -split ';' | Where-Object { $_ -and $_ -ne $dir }) -join ';'
[Environment]::SetEnvironmentVariable('Path', $path, 'User')
```

This removes only the command. Your ExtraBrain app, documents, and settings are not touched.

## Try it

1. Open the ExtraBrain app.
2. In Terminal (Mac) or PowerShell (Windows), run:

```sh
extrabrain capabilities
```

If it lists what your app supports, everything is connected. If it says the app is not running, open ExtraBrain and try again.

## What the CLI can do

Think of these as its skills. Each one is a group of commands, and they work the same on Mac and Windows. Add `--json` right after `extrabrain` (for example `extrabrain --json documents list`) when a script or AI assistant needs machine-readable results.

### 1. Documents: add files to your library

Put your own files into ExtraBrain so it can use them.

| Command | What it does |
| --- | --- |
| `extrabrain documents import -- report.pdf notes.md` | Adds files to your library. Works with `.txt`, `.md`, and `.pdf` files, up to 10 MB each and 20 files at a time. |
| `extrabrain documents import --recursive -- ./my-folder` | Adds everything inside a folder. |
| `extrabrain documents status <batch-id>` | Shows whether an import finished. |
| `extrabrain documents resume <resume-id>` | Picks up an interrupted import where it stopped. Files already added are skipped. |

Imports only ever add; they never delete anything already in the app.

### 2. Document groups: keep files organized

Put related files together under one name, such as "Acme interview".

| Command | What it does |
| --- | --- |
| `extrabrain documents import --group "Acme interview" -- resume.pdf notes.md` | Adds files to a named group, creating it if needed. |
| `extrabrain documents import --group-id <group-id> -- another-note.md` | Adds more files to an existing group. |
| `extrabrain documents groups` | Lists your groups. |

### 3. Find and read documents

| Command | What it does |
| --- | --- |
| `extrabrain documents list` | Lists every document in your library. |
| `extrabrain documents search --limit 10 "release risks"` | Searches your documents for words or phrases. |
| `extrabrain documents text <document-id>` | Prints the text ExtraBrain extracted from a document. |

### 4. Export and delete documents

| Command | What it does |
| --- | --- |
| `extrabrain documents export --output ./copy.pdf <document-id>` | Saves an exact copy of the original file. It will not overwrite an existing file. |
| `extrabrain documents delete --revision 4 <document-id>` | Deletes one document. This cannot be undone, so use it deliberately. |

### 5. Profiles: control how ExtraBrain behaves

Profiles are saved setups (a name, instructions, and quick actions) that shape how ExtraBrain assists you.

| Command | What it does |
| --- | --- |
| `extrabrain profiles list` | Shows all profiles. |
| `extrabrain profiles create --name "Research" --prompt "Inspect the evidence"` | Makes a new profile. |
| `extrabrain profiles update custom <profile-id> --description "Evidence first"` | Edits a profile. |
| `extrabrain profiles delete custom <profile-id>` | Deletes a custom profile. |
| `extrabrain profiles pin custom <profile-id>` | Makes a profile the active one. |
| `extrabrain profiles auto` | Lets ExtraBrain choose the profile automatically again. |
| `extrabrain profiles actions list system assistant` | Lists a profile's quick actions (you can also create, edit, reorder, and delete them). |

This skill needs a recent version of the app. If a profiles command says it is unsupported, update ExtraBrain from [extrabrain.app](https://extrabrain.app). Some profile features are part of ExtraBrain Pro.

### 6. Sessions: look back at past meetings and interviews

Read-only access to what ExtraBrain recorded during your sessions. It never changes anything.

| Command | What it does |
| --- | --- |
| `extrabrain sessions list` | Lists your sessions. |
| `extrabrain sessions search "release risks"` | Searches across sessions. |
| `extrabrain sessions current` | Shows the session happening right now, if any. |
| `extrabrain sessions get <session-id>` | Shows a session's details. |
| `extrabrain sessions transcripts <session-id>` | Prints what was said. |
| `extrabrain sessions screenshots <session-id>` | Lists captured screenshots. |
| `extrabrain sessions facts <session-id>` | Shows the facts ExtraBrain noted. |
| `extrabrain sessions topics <session-id>` | Shows the topics discussed. |
| `extrabrain sessions questions <session-id>` | Shows the questions that came up. |
| `extrabrain sessions chat-turns <session-id>` | Shows your chat with ExtraBrain during the session. |
| `extrabrain sessions insights <session-id>` | Shows the insights ExtraBrain generated. |
| `extrabrain sessions analyses list <session-id>` | Lists the analyses ExtraBrain ran. |

This skill needs a recent version of the app. If a sessions command says it is unsupported, update ExtraBrain from [extrabrain.app](https://extrabrain.app).

### 7. Session exports: save a session to a folder

| Command | What it does |
| --- | --- |
| `extrabrain sessions export --output ./session-bundle <session-id>` | Saves a whole session (transcripts, screenshots, facts, analyses) into a new folder. |
| `extrabrain sessions analyses export --output ./analysis <session-id> <analysis-id>` | Saves one analysis. |
| `extrabrain sessions screenshot export --output ./shot.jpg <session-id> <screenshot-id>` | Saves one screenshot. |

Exports go to a **new** location and never overwrite existing files. They contain your private session data, so be careful where you share them.

### Housekeeping commands

| Command | What it does |
| --- | --- |
| `extrabrain --version` | Shows the installed version. |
| `extrabrain capabilities` | Shows what your running app supports. |
| `extrabrain update` | Updates the CLI. |

## Troubleshooting

| What you see | What to do |
| --- | --- |
| "App not running" (exit code `3`) | Open the ExtraBrain app, then try again. |
| "Unsupported API version or capability" (exit code `8`) | Your app is too old, or that feature is turned off. Update ExtraBrain from [extrabrain.app](https://extrabrain.app). |
| `command not found` (Mac) | Close Terminal and open a new window. |
| `'extrabrain' is not recognized` (Windows) | Close PowerShell and open a new window. |
| "Windows protected your PC" | Choose **More info → Run anyway**. The program is not yet signed by Microsoft. |
| Wrong port | The CLI talks to the app on port `37373`. If your app uses another port, set `EXTRABRAIN_PORT` to that number (`export EXTRABRAIN_PORT=37374` on a Mac, `$env:EXTRABRAIN_PORT = 37374` in PowerShell). |

## Advanced

<details>
<summary>Installer options</summary>

On a Mac:

- **Install location:** by default the installer puts `extrabrain` in `~/.local/bin` and adds that folder to your shell setup (zsh and bash). Set `EXTRABRAIN_NO_MODIFY_PATH=1` to skip changing shell files, or `EXTRABRAIN_INSTALL_DIR=<folder>` to choose another folder.
- **All users on the Mac:** run the installer with `EXTRABRAIN_INSTALL_DIR=/usr/local/bin`. It asks for an administrator password only when it needs one. Uninstall with `sudo rm /usr/local/bin/extrabrain`.
- **A specific version:** set `EXTRABRAIN_VERSION=v0.1.1` (any release tag).

```sh
curl -fsSL https://raw.githubusercontent.com/ExtraBrainApp/ExtraBrain-cli/master/install.sh | env EXTRABRAIN_INSTALL_DIR=/usr/local/bin bash
```

On Windows:

- **Install location:** by default the installer puts `extrabrain.exe` in `%LOCALAPPDATA%\ExtraBrain\bin` and adds that folder to your user `PATH`. Set `$env:EXTRABRAIN_INSTALL_DIR` to choose another folder; the installer then leaves `PATH` unchanged.
- **A specific version:** set `$env:EXTRABRAIN_VERSION` to any release tag that includes Windows builds, as in the example below (replace `vX.Y.Z`). The setting lasts only for that PowerShell window, so open a new window afterwards.
- **Requirements:** Windows PowerShell 5.1 (built into Windows 10 and 11) or PowerShell 7.

```powershell
$env:EXTRABRAIN_VERSION = 'vX.Y.Z'; irm https://raw.githubusercontent.com/ExtraBrainApp/ExtraBrain-cli/master/install.ps1 | iex
```

On both, downloads are checked against the release's `SHA256SUMS` before anything is replaced.

</details>

<details>
<summary>For scripts and AI assistants</summary>

Use `--json` to get `{ "code": number, "data": object | null, "message": string }`. Exit codes: `0` success, `1` failure, `2` usage, `3` app not running, `4` authentication or revocation, `5` conflict, `6` partial batch, `7` protected storage unavailable, `8` unsupported API or capability.

- The CLI talks to the app over a local-only connection (`127.0.0.1`) and needs no password or token. It never starts the app or reads its database.
- `extrabrain pair` keeps its credential in the macOS Keychain on a Mac, or in a file protected with Windows DPAPI under `%LOCALAPPDATA%\ExtraBrain` on Windows. There is no plaintext fallback.
- Interrupted imports are remembered in `~/.local/state/extrabrain/imports` on a Mac and `%LOCALAPPDATA%\ExtraBrain\state\imports` on Windows, so `documents resume` can continue them.
- Put file paths that begin with `-` after `--`. Symlinks and non-regular files are rejected. The CLI reads files from its own filesystem, so a sandboxed or remote agent cannot import a desktop-only path.
- Deleting requires one document ID and its current revision. On a revision conflict, read the document again and confirm with the user instead of retrying.
- List commands accept `--limit` and `--cursor`; time filters (`--since`, `--until`) are Unix seconds. Follow `data.nextCursor` to page through results.
- Profile changes send a revision and request ID. Use `--revision <n> --request-id <id>` to retry an exact request safely.

</details>

<details>
<summary>Building from source</summary>

Use Node 24.20.0 and npm 11.19.0. `npm ci`, `npm run typecheck`, and `npm test` validate the CLI; `npm run build:sea` creates a self-contained executable for your computer in `dist/`.

To build for another platform, pass one or more targets: `npm run build:sea -- --target win32-x64 --target win32-arm64` (also `darwin-arm64` and `darwin-x64`). Each lands in `dist/<target>/`. The build downloads the matching official Node.js binary and checks it against the Node.js release's `SHA256SUMS`.

- macOS executables must be built on a Mac (they are signed ad hoc with `codesign`).
- Windows executables can be built anywhere. On Windows the build uses `signtool` from the Windows SDK (or `EXTRABRAIN_SIGNTOOL_PATH`); elsewhere it needs `osslsigncode`. `scripts/build-windows.sh` does the whole Windows build in a Docker container.

To release, run the `Standalone CLI release` workflow on `master` and choose `patch`, `minor`, or `major`. It runs on the ExtraBrain self-hosted runners: macOS archives are built in a disposable Tart VM on the shared Mac mini, and Windows archives are cross-built in Docker on Linux.

</details>

## License

MIT. See [LICENSE](LICENSE).
