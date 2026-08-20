# Sink

A minimal self-hosted sync plugin for [Obsidian](https://obsidian.md). Always-on live sync via your own CouchDB instance, accessible over [Tailscale](https://tailscale.com).

Forked from the architecture of [obsidian-livesync](https://github.com/vrtmrz/obsidian-livesync), stripped to the essentials.

---

## Features

- **Live sync** — changes replicate instantly across all devices
- **Self-hosted** — CouchDB on your own server via Docker, no third-party cloud
- **End-to-end encryption** — AES-256-GCM with PBKDF2 key derivation (optional)
- **Automatic conflict resolution** — 3-way merge via diff-match-patch, manual fallback
- **Mobile support** — works on iOS and Android via Obsidian mobile
- **Setup URI** — share connection settings to new devices in one paste
- **8 settings total** — no configuration sprawl

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
| `Sink` | Connected, live sync active |
| `Sink ↑↓` | Actively syncing |
| `Sink ✗` | Error — check credentials |
| `Sink ○` | Disconnected |

Hover the status bar item for a tooltip with details.

**Floating overlay** (top-right of editor):

| Text | Meaning |
|------|---------|
| `Full` | Connected and idle |
| `Flowing` | Sync in progress |
| `Filling  filename.md` | Receiving file from server |
| `Draining  filename.md` | Sending file to server |
| `Blocked` | Sync error |
| `Empty` | Disconnected |

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
| Auto-resolve conflicts | `true` | 3-way merge; false = prompt manually |
| Sync config folder | `true` | Sync `.obsidian/` folder across devices |

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
  └── ConflictResolver — 3-way merge via diff-match-patch
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
