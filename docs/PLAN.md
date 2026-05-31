# Sink — Obsidian LiveSync Plugin (Simplified Fork)

## Overview

**Sink** is a simplified, reliability-focused Obsidian sync plugin built on CouchDB. It strips away the complexity of obsidian-livesync while keeping the core functionality: real-time bidirectional sync between all your devices via a self-hosted CouchDB instance on your home server, accessed through Tailscale.

---

## How the Existing Plugin (obsidian-livesync) Works

### Architecture Overview

The existing plugin is a massive, modular system with ~50+ modules organized into:

- **Core Engine** (`LiveSyncBaseCore`) — orchestrates everything
- **Service Hub** — injectable services (vault, database, replication, settings, conflict, UI, etc.)
- **Modules** — features registered as plugins within the plugin (settings tab, conflict resolver, periodic sync, replicator, P2P, etc.)
- **Add-ons** — ConfigSync, HiddenFileSync, LocalDatabaseMaintenance

### Sync Mechanism

```
File saved → StorageEventManager catches Obsidian vault event
  → File content split into chunks (content-addressed via xxHash)
  → Metadata doc (file path, mtime, chunk IDs) + chunk docs written to local PouchDB (IndexedDB)
  → PouchDB replication protocol pushes only NEW/CHANGED docs to remote CouchDB over HTTP
  → Remote CouchDB notifies other connected clients via continuous _changes feed
  → Other clients pull new docs, reassemble chunks → write to their vault
```

### Data Structure in CouchDB

Each file becomes:
1. **Header doc** — `_id` = hash of path, contains `{path, mtime, ctime, size, children: [chunkID1, chunkID2, ...]}`
2. **Chunk docs** — `_id` = hash of chunk content, contains `{data: "chunk content"}`. Content-addressed, so identical content is deduplicated across files.

### Why It Breaks for Multi-Device

The existing plugin has too many sync modes, edge cases, and configuration permutations:
- Config mismatch detection creates confusing "Tweaks Mismatched" popups
- Plugin/config sync can overwrite local state unexpectedly
- Background mobile sync doesn't maintain the WebSocket/long-poll connection
- The setup wizard has ~10 steps with unclear terminology
- Multiple sync modes (LiveSync, periodic, on-save, event-based) that can get out of sync with each other

---

## Key Decisions

### Database: CouchDB (keeping it)

**Rationale:**
- PouchDB (the client-side DB in Obsidian) has a built-in replication protocol that speaks CouchDB natively — no adapter needed
- CouchDB's `_changes` feed provides real-time push notifications (exactly what's needed for live sync)
- It handles conflict resolution at the protocol level (MVCC with revision trees)
- Lightweight, runs well on a home server, mature and stable
- The alternatives (PostgreSQL, SQLite, custom WebSocket) would require building an entire sync protocol from scratch

**Alternatives considered and rejected:**
- **MinIO/S3** — No real-time change notification, poll-based only, higher latency
- **PostgreSQL + custom sync** — Over-engineered for this use case, massive implementation effort
- **Git-based** — Merge conflicts are a nightmare for non-text (attachments), no live sync possible

### Networking: Tailscale (no TLS needed)

Since all devices are on a Tailscale tailnet, CouchDB is accessed via Tailscale IP (e.g., `http://100.x.y.z:5984`). No HTTPS/TLS certificates needed — Tailscale's WireGuard tunnel already encrypts all traffic. This eliminates reverse proxy, certificate management, and CORS headaches.

### Sync Strategy

- **Always LiveSync** — no periodic/on-save modes to confuse things
- **Debounce at 1 second** — after you stop typing for 1s, push changes
- **Aggressive reconnection** — if connection drops, retry every 3s with exponential backoff up to 30s
- **Simplified document storage** — store whole files for notes <64KB (most notes), only chunk larger files/attachments

---

## Sink Plugin Architecture

### File Structure

```
sink/
├── main.ts                    # Plugin entry (thin, delegates to SinkPlugin)
├── manifest.json              # Obsidian plugin manifest
├── styles.css                 # Minimal styles
├── package.json               # Dependencies
├── esbuild.config.mjs         # Build config
├── tsconfig.json
│
├── src/
│   ├── SinkPlugin.ts          # Main plugin class
│   ├── settings.ts            # Settings interface + defaults
│   ├── sync/
│   │   ├── SyncEngine.ts      # Core sync orchestration
│   │   ├── LocalDB.ts         # PouchDB wrapper
│   │   ├── RemoteDB.ts        # CouchDB connection manager
│   │   ├── Replicator.ts      # Continuous replication manager
│   │   ├── ConflictResolver.ts # Auto-merge logic
│   │   └── FileSerializer.ts  # File ↔ DB document conversion
│   ├── ui/
│   │   ├── SettingsTab.ts     # Single settings page
│   │   ├── SetupWizard.ts     # 3-step setup wizard
│   │   ├── StatusBar.ts       # Sync status indicator
│   │   └── ConflictModal.ts   # Manual conflict resolution UI
│   └── utils/
│       ├── crypto.ts          # E2E encryption (AES-256-GCM)
│       ├── uri.ts             # Setup URI generation/parsing
│       └── debounce.ts        # Sync debouncing
│
└── server/
    ├── docker-compose.yml     # One-command server setup
    ├── local.ini              # Pre-configured CouchDB settings
    └── setup.sh               # Server initialization script
```

### Settings — Radically Simplified

The existing plugin has **100+** settings. Sink has **8 user-facing settings**:

| Setting | Default | Description |
|---------|---------|-------------|
| Server URL | `""` | CouchDB address (e.g., `http://100.64.0.1:5984`) |
| Username | `""` | CouchDB user |
| Password | `""` | CouchDB password |
| Database Name | `"sink"` | Name of the CouchDB database |
| Encryption Passphrase | `""` | E2E encryption key (recommended) |
| Sync Delay | `1000` | Milliseconds after last edit to push |
| Auto-resolve Conflicts | `true` | Auto-merge or ask user |
| Device Name | `(hostname)` | Friendly name for this device |

Everything else is hardcoded to sane defaults:
- LiveSync: always on
- Chunk threshold: 64KB (only chunk files larger than this)
- Reconnection: automatic with exponential backoff
- Config folder sync: enabled (`.obsidian/` plugins, themes, snippets)

### Setup Flow

**First device (server + primary client):**
1. Install Docker on server → `docker compose up -d` (one command)
2. Run `setup.sh` to initialize the database
3. Install Sink plugin in Obsidian → enter Server URL + credentials → "Test & Connect"
4. Choose "Push my vault to server" → Done
5. Plugin generates a **Setup URI** for other devices

**Additional devices:**
1. Install Sink plugin → paste Setup URI
2. Choose: "Pull from server" (clean device) OR "Merge" (existing vault)
3. Done. LiveSync starts automatically.

### Sync Triggers

| Event | Action |
|-------|--------|
| File modified | Push after debounce (1s default) |
| File created | Push after debounce |
| File renamed/moved | Immediate push |
| File deleted | Immediate push |
| Plugin loaded | Pull all changes since last sync |
| Connection restored | Full bidirectional catch-up |
| Heartbeat (30s) | Verify connection, pull missed changes |
| CouchDB `_changes` event | Immediate pull of changed doc |

### Conflict Resolution

1. **Identical content** → silently discard duplicate (most common)
2. **One side newer + other unchanged** → take newer (fast-forward)
3. **Both modified (text)** → 3-way merge using diff-match-patch
4. **Merge failed / binary** → create `filename.conflict.md` alongside original, notify user

No confusing "Tweaks Mismatched" popups. No surprise config overwrites.

---

## Server Setup

### docker-compose.yml

```yaml
version: "3.8"
services:
  couchdb:
    image: couchdb:3
    restart: unless-stopped
    environment:
      COUCHDB_USER: ${COUCHDB_USER:-admin}
      COUCHDB_PASSWORD: ${COUCHDB_PASSWORD}
    volumes:
      - ./data:/opt/couchdb/data
      - ./local.ini:/opt/couchdb/etc/local.d/local.ini
    ports:
      - "5984:5984"
```

### CouchDB Config (local.ini)

```ini
[chttpd]
max_http_request_size = 4294967296
enable_cors = true
bind_address = 0.0.0.0

[couchdb]
max_document_size = 50000000

[cors]
origins = app://obsidian.md, capacitor://localhost, http://localhost
credentials = true
methods = GET, PUT, POST, HEAD, DELETE
headers = accept, authorization, content-type, origin, referer, cache-control

[chttpd_auth]
require_valid_user = true
```

### setup.sh

```bash
#!/bin/bash
COUCH="http://${COUCHDB_USER:-admin}:${COUCHDB_PASSWORD}@localhost:5984"

# Create the sync database
curl -X PUT "$COUCH/sink"
# System databases
curl -X PUT "$COUCH/_users"
curl -X PUT "$COUCH/_replicator"

echo "Sink server ready!"
```

No reverse proxy, no TLS certificates — Tailscale handles encryption.

---

## Security Measures

1. **Tailscale network isolation** — CouchDB only accessible within your tailnet
2. **CouchDB authentication** — `require_valid_user = true` (no anonymous access)
3. **E2E Encryption** — note content encrypted client-side with AES-256-GCM before storage in CouchDB
4. **Setup URI encryption** — credentials encrypted in URI; passphrase shared separately
5. **CORS restrictions** — only Obsidian app origins allowed
6. **No eval/dynamic code** — clean plugin that passes Obsidian review requirements

---

## What Sink Removes (vs. obsidian-livesync)

| Removed | Why |
|---------|-----|
| P2P/WebRTC sync via Nostr | You have a dedicated server |
| MinIO/S3 backend | Using CouchDB only |
| Journal sync mode | One mode: LiveSync |
| 10-tab settings page | Single page, 8 settings |
| Periodic sync / on-save modes | Always-on live sync |
| "Tweaks Mismatched" system | Just use latest config |
| Separate plugin/config sync module | Sync `.obsidian/` as regular files |
| QR code setup | URI-based only |
| Fly.io / Cloudant deployment | Docker on your server |
| Multiple chunk strategies | Simple 64KB threshold split |
| "Incubation period" for chunks | Immediate sync |
| Dev/test/benchmark modules | Not shipping test infra |
| Internationalization (i18n) | English only |
| Web app / CLI / webpeer variants | Obsidian plugin only |

---

## Tech Stack

| Component | Tool |
|-----------|------|
| Language | TypeScript (ES2018 target) |
| Build | esbuild |
| Local DB | PouchDB (IndexedDB adapter) |
| Remote DB | CouchDB 3.x (Docker) |
| Encryption | Web Crypto API (AES-256-GCM) |
| Diff/Merge | diff-match-patch |
| UI | Obsidian native API (SettingTab, Modal, StatusBarItem) |
| Networking | Tailscale (WireGuard) |

### Dependencies (minimal)

```json
{
  "pouchdb-core": "^9.0.0",
  "pouchdb-adapter-idb": "^9.0.0",
  "pouchdb-adapter-http": "^9.0.0",
  "pouchdb-replication": "^9.0.0",
  "pouchdb-mapreduce": "^9.0.0",
  "diff-match-patch": "^1.0.5"
}
```

~6 dependencies vs. the existing plugin's 30+.

---

## Things to Consider

1. **Initial sync of large vaults** — first push of thousands of notes takes time. Need a progress indicator and batch processing.

2. **Binary files (images, PDFs)** — stored as base64 in CouchDB docs when >64KB, chunked. Consider a file size limit (~100MB).

3. **`.obsidian/` config sync** — this is where the existing plugin causes the most damage. Sink will sync config files but with a "Device X updated plugin Y — apply?" prompt rather than silent overwrite.

4. **Mobile (future)** — Obsidian mobile kills background processes. The architecture supports "catch up on open" since PouchDB replication is resumable from where it left off.

5. **Database growth** — CouchDB stores revisions. Schedule periodic compaction via cron: `curl -X POST http://admin:pass@localhost:5984/sink/_compact`

6. **IndexedDB limits** — PouchDB in IndexedDB has ~2GB browser storage limits. For very large vaults with many attachments, this could be a concern.

7. **Race conditions** — two devices editing same file simultaneously. The 1s debounce + CouchDB's MVCC revision system handles this; conflicts resolved automatically or flagged to user.

8. **Obsidian plugin installation** — final output is 3 files (`main.js`, `manifest.json`, `styles.css`) dropped into `.obsidian/plugins/sink/`.
