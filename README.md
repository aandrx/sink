# Sink

A minimal self-hosted sync plugin for [Obsidian](https://obsidian.md). Always-on live sync via your own CouchDB instance, accessible over [Tailscale](https://tailscale.com).

Forked from the architecture of [obsidian-livesync](https://github.com/vrtmrz/obsidian-livesync), stripped to the essentials.

## Release: 0.2.23

Adds a full-screen iOS-style review workspace for Obsidian mobile: file cards, segmented Local/Remote/Skip decisions, a detail sheet with unified diffs, and a safe-area action bar. Desktop keeps the existing side-by-side review. Includes the 0.2.22 attachment-identity and focused-startup-review fixes. See [0.2.23 release notes](docs/releases/0.2.23.md), [0.2.22 notes](docs/releases/0.2.22.md), [0.2.21 notes](docs/releases/0.2.21.md), [0.2.20 notes](docs/releases/0.2.20.md), [0.2.19 notes](docs/releases/0.2.19.md), [0.2.18 notes](docs/releases/0.2.18.md), [0.2.17 notes](docs/releases/0.2.17.md), [0.2.16 notes](docs/releases/0.2.16.md), and [0.2.15 notes](docs/releases/0.2.15.md). Grey-screen crash causality remains unconfirmed; use the [controlled test plan](docs/STABILITY.md) before enabling Sink in a live vault. Development checks require Node.js 22.22.2+ (Node 22 LTS recommended).

---

## Features

- **Live sync** — changes replicate instantly across all devices
- **Self-hosted** — CouchDB on your own server via Docker, no third-party cloud
- **End-to-end encryption** — AES-256-GCM with PBKDF2 key derivation (optional)
- **Explicit conflict resolution** — choose Local or Remote; divergent edits and retained CouchDB revisions are never silently merged
- **Desktop diff viewer** — aligned side-by-side lines, red/green and inline highlights, synchronized scrolling, collapsible context, and change navigation
- **Mobile review workspace** — full-screen iOS-style cards, segmented Local/Remote/Skip decisions, a detail sheet with unified diffs, and a safe-area action bar
- **Stable attachments** — one content identity for inline, chunked, encrypted, and plaintext binaries; unchanged attachments no longer reappear in startup reviews
- **Local safety snapshots** — the five most recent snapshots are shown in Settings; older snapshots remain stored
- **Setup URI** — share connection settings to new devices in one paste
- **Compact settings** — ten focused options, no configuration sprawl

---

## Mobile review

On Obsidian mobile, a sync review opens as a full-screen workspace instead of the desktop split view. Files are cards with a Local/Remote/Skip control; tapping a card opens a detail sheet with the consequence and a unified diff. Apply stays in a safe-area bottom bar.

| Files | Detail |
| --- | --- |
| <img src="https://raw.githubusercontent.com/aandrx/sink/0.2.23/docs/releases/0.2.23/mobile-list-dark.png" width="240" alt="Mobile review file cards in dark theme"> | <img src="https://raw.githubusercontent.com/aandrx/sink/0.2.23/docs/releases/0.2.23/mobile-detail-light.png" width="240" alt="Mobile unified diff detail view in light theme"> |

The decisions are identical to desktop: Local, Remote, and Skip; deletions still require confirmation; blocked rows cannot be applied. Settings and the setup wizard keep Obsidian's native mobile controls. See the [0.2.23 release notes](docs/releases/0.2.23.md) for more mockups.

---

## Requirements

**Server:**
- Linux machine (Ubuntu, Debian, etc.) with Docker and Docker Compose
- [Tailscale](https://tailscale.com) installed (or accessible on your LAN)

**Client (each device):**
- Obsidian 1.4.0+
- Tailscale connected to the same network as the server

---

## Quick Start

### 1. Server

```bash
cd ~/docker
git clone https://github.com/aandrx/sink.git && cd sink
mv server/* . && rm -rf server/ src/ docs/ *.ts *.mjs *.json *.css main.ts

cp .env.example .env
nano .env  # set COUCHDB_PASSWORD

docker compose up -d
bash setup.sh
```

Your CouchDB is now running at `http://localhost:5985`. Get your Tailscale IP:
```bash
tailscale ip -4
```

### 2. First device (desktop)

```bash
git clone https://github.com/aandrx/sink.git ~/sink
cd ~/sink && npm install && npm run build
# Note: npm install is required before building — it fetches the `events`
# polyfill that makes the plugin load on mobile (iOS/Android).

VAULT="$HOME/Documents/MyVault"
mkdir -p "$VAULT/.obsidian/plugins/sink"
cp main.js manifest.json styles.css "$VAULT/.obsidian/plugins/sink/"
```

Open Obsidian → Settings → Community Plugins → enable **Sink** → follow the Setup Wizard.

Enter your Tailscale IP as the server URL: `http://<tailscale-ip>:5985`

Choose **"Push vault to server"** on your first device.

### 3. Additional devices

1. On your configured device: **Settings → Sink → Copy URI**
2. Send the URI to your other device via a **secure channel** (Signal, AirDrop, etc.)
3. Open the URI on the new device — Obsidian opens the wizard with credentials pre-filled
4. Choose **"Pull from server"**

For full instructions including **mobile setup** and **giving a friend access**, see [docs/setup.md](docs/setup.md).

---

## Status Indicators

**Status bar** (bottom of Obsidian window):

| Text | Meaning |
|------|---------|
| `Sink ✓` | Connected, live sync active |
| `Sink ↑↓` | Actively syncing |
| `Sink ⏸` | Waiting for review or upload permission; open Settings → Sink → Troubleshooting |
| `Sink ✗` | Sync blocked; open Settings → Sink → Troubleshooting |
| `Sink ○` | Disconnected |

Hover or long-press the status bar item for a tooltip with details. The status bar is the accessible status surface.

**Floating overlay** (top-right of editor, decorative and hidden from assistive tech):

| Text | Meaning |
|------|---------|
| `Connected` | Connected and idle |
| `Syncing` | Sync in progress |
| `Receiving  filename.md` | Receiving a file from the server |
| `Sending  filename.md` | Sending a file to the server |
| `Review` | Waiting for a sync review |
| `Blocked` | Sync error |
| `Disconnected` | Disconnected |

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Server URL | — | CouchDB address, e.g. `http://100.64.1.23:5985` |
| Username | — | CouchDB username |
| Password | — | CouchDB password |
| Database name | `sink` | Database to replicate |
| Encryption passphrase | — | AES-256-GCM passphrase; leave empty to disable |
| Sync delay | `1000ms` | Debounce time after last edit before pushing |
| Auto-apply safe updates | `true` | Verified fast-forwards; divergent edits and deletions still require review |
| Sync config folder | `false` | Allow config-folder sync; workspace state, plugin-enable lists, and Sink itself are always excluded |
| Device name | generated | Friendly name shown in review and conflict metadata |
| Device role | `Primary` | Secondary devices must confirm before uploading changes |

---

## Security Notes

- The **Setup URI** encodes credentials as base64 — it is not encrypted. Only share it via a secure, private channel.
- The **`.env` file** on the server contains your CouchDB password — it is gitignored and must never be committed.
- The **`server/data/` directory** contains your database — also gitignored, back it up regularly.
- All devices share one CouchDB account. There is no per-user access control.
- With an **encryption passphrase** set, note content is encrypted before leaving the device. Without one, content is stored in plaintext in CouchDB.

---

## Architecture

```
Obsidian Vault
     │
     ▼
SyncEngine (SyncEngine.ts)
  ├── FileSerializer  — vault file ↔ CouchDB document conversion
  ├── CryptoHelper    — AES-256-GCM encrypt/decrypt
  ├── LocalDB         — PouchDB (IndexedDB) local cache
  ├── RemoteDB        — PouchDB HTTP adapter → CouchDB
  ├── Replicator      — continuous bidirectional replication
  └── ConflictResolver — retained revision analysis; explicit side choice
```

Transport: PouchDB replication over HTTP to CouchDB 3, tunnelled over Tailscale.

---

## Maintenance

**Compact the database** (run on server, prevents unbounded growth):
```bash
cd ~/docker/sink && source .env
curl -X POST "http://${COUCHDB_USER}:${COUCHDB_PASSWORD}@localhost:5985/sink/_compact" \
     -H "Content-Type: application/json"
```

**Backup:**
```bash
tar czf ~/backups/sink-db-$(date +%Y%m%d).tar.gz -C ~/docker/sink data/
```

**Update plugin:**
```bash
cd ~/sink && git pull && npm install && npm run build
cp main.js manifest.json styles.css "/path/to/vault/.obsidian/plugins/sink/"
```

---

## Troubleshooting

For suspected grey-screen crashes, keep Sink disabled in the live vault until a controlled test succeeds. See [docs/STABILITY.md](docs/STABILITY.md) for findings, safety limits, and a staged verification procedure. The new config default does **not** override an existing saved setting.

| Problem | Fix |
|---------|-----|
| "Connection failed" | Verify Tailscale is running; `curl http://<ip>:5985/` should return JSON |
| "Authentication failed" | Credentials don't match `.env` |
| Status shows "Blocked" | Auth error — re-enter password in Settings → Sink |
| Plugin not appearing | All 3 files must be in `.obsidian/plugins/sink/`; reload plugins |
| Mobile can't reach server | Open Tailscale on phone; try the server URL in a browser first |
| CORS errors | Restart the container: `docker compose restart` |
| Sync loop / thrashing | Check that `.obsidian/plugins/sink/data.json` is excluded (it is by default) |

---

## License

MIT
