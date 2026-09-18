<div align="center">

<img src="icon.svg" alt="File & Folder Transfer logo" width="96" height="96">

# File & Folder Transfer

**Fast, secure, LAN-only file and folder transfer between your PC and any phone or tablet — no cloud, no cables, no accounts.**

![Version](https://img.shields.io/badge/version-0.0.1-479ef5?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square)
![License](https://img.shields.io/badge/license-ISC-informational?style=flat-square)
![Node](https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)

</div>

---

## Overview

File & Folder Transfer turns your computer into a private, PIN-protected LAN transfer hub. Open the dashboard, scan the QR code (or type the PIN) on your phone's browser, and drag files across — in either direction. Everything happens over your local Wi-Fi/USB-tether/hotspot; nothing ever leaves your network.

It ships three ways: an **installed Tauri desktop app**, a **portable Tauri build** (native window, no installer, no Node.js needed), or a **portable browser-based executable** (via `pkg`) that opens the dashboard in your default browser instead of a native window.

## Features

| | |
|---|---|
| **⚡ High-throughput transfers** | Tiered chunking (64KB–2MB based on file size), zero-copy `ArrayBuffer` transfers off the main thread via Web Workers, `perMessageDeflate` disabled to avoid wasting CPU compressing already-binary data, and up to 3 files uploaded concurrently. |
| **↕ Two-way transfer** | Phones upload to the PC as usual — and the dashboard can now push files *to* any connected device directly from a native file picker, with a simple Accept/Decline prompt on the receiving end. |
| **📁 Full folder support** | Preserves nested folder structure on upload, whether picked via file dialog or dragged-and-dropped. |
| **🔒 Secure pairing** | 4-digit PIN or QR-token authentication, plus strict path-traversal sandboxing on every write. |
| **📱 QR code pairing** | Scan once from the dashboard to connect — no typing IPs. |
| **📊 Live dashboard** | Real-time transfer progress, connected-device list, completed-file history, and a scrollable activity log. |
| **🌐 Smart network detection** | Automatically ranks available network adapters (USB tether > hotspot > Ethernet > Wi-Fi) and lets you switch the active one from the dashboard. |
| **🛡️ Disconnect failsafes** | Mid-transfer disconnects clean up partial files and streams automatically. |
| **🎨 Modern UI** | Built with Fluent UI Web Components, full light/dark theming. |
| **📦 Three build targets** | Installed Tauri desktop app, portable Tauri build (native window, no install), or a dependency-free single-file portable executable (browser-based). |

## Quick Start

```bash
npm install
npm start
```

The dashboard opens automatically at `http://<your-local-ip>:5000/server`. Scan the QR code (or share the PIN) with any device on the same network to start sending files.

## Building

### Desktop app (Tauri) — installer

Native window, installer, and full system integration (including the two-way file-picker feature, which requires the Tauri runtime).

```bash
npm run tauri:dev     # development
npm run tauri:build   # production installer (MSI/NSIS on Windows, DMG on macOS, deb/AppImage on Linux)
```

### Desktop app (Tauri) — portable, no installer

Same native app, but as a plain `.exe` you can copy anywhere — no installer, no admin rights, no Node.js on the target machine.

```bash
npm run portable
```

This builds the native window and bundled backend, then copies the validated portable pair into `dist/portable/`: `file-folder-transfer.exe` and `server.exe`. **Ship both files together in that folder.** The target computer needs Microsoft WebView2 Runtime, but does not need Node.js or an installer.

`beforeBuildCommand` in `tauri.conf.json` runs `scripts/build-sidecar.js` automatically before every Tauri build, which packages `server.js` via `pkg` into `src-tauri/binaries/` (patching in the app icon on Windows along the way — see below) so the sidecar is always fresh.

### Portable executable, browser-based (no native window)

Bundles Node.js and all dependencies into one file — copy it anywhere and run it. Opens the dashboard in your system's default browser rather than a native window (a plain Node/`pkg` binary has no windowing capability of its own — that's what the Tauri portable build above is for).

```bash
npm run build
```

Outputs to `dist/`:
- `File-Folder-Transfer-win-x64.exe`
- `File-Folder-Transfer-macos-x64`
- `File-Folder-Transfer-linux-x64`

On Windows, this first patches the app icon onto the `.exe` (`scripts/patch-portable-icon.js`, run automatically via the `prebuild` step) — `pkg` has no built-in icon support, so this stamps our icon onto pkg's cached base Node binary before the payload is appended, which is the only way to do it without corrupting the packaged executable.

## Configuration

| Setting | Where | Notes |
|---|---|---|
| Upload directory | Dashboard | Defaults to `Desktop/FileTransfer_Received/<Device Name>/`; changeable live. |
| PIN code | Dashboard | Random 4 digits on launch; regenerate anytime. |
| Server name | Dashboard | Broadcasts instantly to all connected devices on change. |
| Port | `PORT` env var | Defaults to `5000`. |

## Tech Stack

Node.js · Express · Socket.IO · Web Workers · Tauri 2 (Rust) · Fluent UI Web Components

## License

ISC License.
