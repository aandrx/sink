# Sink — Full Setup Guide

This guide walks you through setting up Sink from scratch: CouchDB on your server, then the Obsidian plugin on your client machine(s).

---

## Part 1: Server Setup (Ubuntu Server)

### Prerequisites

- Docker and Docker Compose installed
- The server is accessible via Tailscale (or direct LAN IP)

If Docker isn't installed yet:
```bash
# Install Docker on Ubuntu
sudo apt update
sudo apt install -y docker.io docker-compose-v2
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
# Log out and back in for group to take effect
```

### 1. Clone and prepare

```bash
cd ~/docker
git clone https://github.com/aandrx/sink.git
cd sink

# Remove everything except server files
rm -rf src/ node_modules/ obsidian-livesync/ main.ts esbuild.config.mjs \
       tsconfig.json package.json package-lock.json styles.css manifest.json \
       .gitignore docs/
mv server/* .
rm -rf server/
```

You should now have:
```
~/docker/sink/
├── docker-compose.yml
├── local.ini
├── setup.sh
└── .env.example
```

### 2. Create your credentials

```bash
cp .env.example .env
```

Edit `.env` and set a strong password:
```bash
nano .env
```

Contents:
```
COUCHDB_USER=admin
COUCHDB_PASSWORD=your-strong-password-here
```

Pick something strong — this protects your entire vault's sync data.

### 3. Start CouchDB

```bash
docker compose up -d
```

Verify it's running — run this **on the server**:
```bash
docker compose ps
# Should show couchdb container as "running"

curl http://localhost:5985/
# Should return: {"couchdb":"Welcome", ...}
```

### 4. Initialize the database

Run this **on the server**:
```bash
bash setup.sh
```

This creates the `sink` database and required system databases. You should see:
```
Waiting for CouchDB to be ready...
Creating system databases...
Creating sink database...

=== Sink server ready! ===
CouchDB URL: http://localhost:5985
Database:    sink
Fauxton UI:  http://localhost:5985/_utils
```

### 5. Verify access via Fauxton

Open the Fauxton admin UI in a browser:

**From any device on your Tailscale network** (recommended):
```
http://<server-tailscale-ip>:5985/_utils
```

**From the server itself:**
```
http://localhost:5985/_utils
```

Log in with the username/password from your `.env` file. You should see the `sink` database listed.

### 6. Get your Tailscale IP

Run this **on the server**:
```bash
tailscale ip -4
# Example output: 100.64.1.23
```

Verify it's reachable — run this **from your laptop**:
```bash
curl http://100.64.1.23:5985/
# Should return: {"couchdb":"Welcome", ...}
```

That's your Server URL for the plugin: `http://100.64.1.23:5985`

---

## Part 2: Desktop Setup (Linux / macOS / Windows)

### Prerequisites

- Node.js (v18+) and npm installed
- Obsidian installed with a vault already open
- Connected to the same Tailscale network as the server

### 1. Clone and build

```bash
git clone https://github.com/aandrx/sink.git ~/sink
cd ~/sink
npm install
npm run build
```

This produces `main.js` in the project root.

### 2. Install the plugin

```bash
# Replace with your actual vault path
VAULT="$HOME/Documents/MyVault"

mkdir -p "$VAULT/.obsidian/plugins/sink"
cp main.js manifest.json styles.css "$VAULT/.obsidian/plugins/sink/"
```

On Windows (PowerShell):
```powershell
$VAULT = "$HOME\Documents\MyVault"
New-Item -ItemType Directory -Force "$VAULT\.obsidian\plugins\sink"
Copy-Item main.js, manifest.json, styles.css "$VAULT\.obsidian\plugins\sink\"
```

### 3. Enable the plugin

1. Open Obsidian
2. Go to **Settings → Community Plugins** and disable Safe Mode if prompted
3. Enable **Sink** in the list
4. The Setup Wizard opens automatically

### 4. Configure in the Setup Wizard

Enter:
- **Server URL**: `http://<your-tailscale-ip>:5985`
- **Username**: `admin` (or whatever you set in `.env`)
- **Password**: your password from `.env`
- **Database name**: `sink` (default)
- **Encryption passphrase**: recommended — all devices must use the same one

Click **Test & Continue**.

### 5. Choose sync direction

For your **first device** (the one with existing notes):
→ Choose **"Push vault to server"**

For any subsequent device with an empty vault:
→ Choose **"Pull from server"**

For a device that already has notes and you want to merge:
→ Choose **"Merge"**

### 6. Generate Setup URI for other devices

After setup completes:
1. Go to **Settings → Sink**
2. Click **"Copy URI"** under Actions
3. Share this URI with your other devices via a **secure channel** (e.g. Signal, AirDrop, local file) — it contains your credentials in base64

---

## Part 3: Mobile Setup (iOS / Android)

Obsidian mobile supports community plugins installed manually. Sink works on mobile since it uses the Web Crypto API and PouchDB's IndexedDB adapter (both available in Obsidian's mobile WebView).

### Prerequisites

- Obsidian installed on your phone
- A vault already created (can be empty)
- Your phone connected to Tailscale (install the Tailscale app from the App Store / Play Store)

### 1. Get the plugin files onto your phone

You need `main.js`, `manifest.json`, and `styles.css` on your device. Choose one method:

**Option A — Via iCloud / Google Drive:**
1. On your desktop, copy the three files to a shared folder (iCloud Drive, Google Drive, etc.)
2. On your phone, use the Files app to navigate to that folder

**Option B — Via USB:**
- Connect phone to computer, navigate to vault folder, copy files directly

**Option C — Direct download from GitHub (if a release is published):**
- Download the release zip, extract the three plugin files

### 2. Place the files in your vault

Navigate to your vault folder on the phone and create the plugin directory:
```
<vault>/.obsidian/plugins/sink/
```

Place `main.js`, `manifest.json`, and `styles.css` in that folder.

On iOS this path is typically:
```
On My iPhone → Obsidian → <VaultName> → .obsidian → plugins → sink
```

> **Tip:** On iOS, the `.obsidian` folder is hidden in the Files app by default.  
> Enable hidden files: tap the three-dot menu (⋯) in Files → Show Hidden Files.

### 3. Enable the plugin

1. Open Obsidian on your phone
2. Go to **Settings → Community Plugins**
3. Disable Safe Mode if prompted
4. Tap the reload button (↺) to rescan plugins
5. Enable **Sink**

### 4. Connect to your server

**Recommended: Import via Setup URI**

If you already set up a desktop device:
1. On desktop: **Settings → Sink → Copy URI**
2. Send it to your phone via Signal, AirDrop, etc.
3. Open the URI on your phone — Obsidian handles the `obsidian://sink-setup` protocol and opens the wizard with credentials pre-filled
4. Choose **"Pull from server"** to download your vault

**Alternative: Manual entry**

Open the Setup Wizard on mobile and enter the same server URL, username, password, database name, and encryption passphrase as your other devices.

> **Note:** Make sure Tailscale is running on your phone and the server's Tailscale IP is reachable. You can verify by opening `http://<tailscale-ip>:5985/` in Safari/Chrome — you should see a JSON response.

---

## Part 4: Giving a Friend Access

> **Important — read before proceeding:**
> - Sink uses a single shared CouchDB account. There are no per-user permissions.
> - Giving a friend access means they can **read and write all notes** in the database.
> - If you use an encryption passphrase, they must have the **same passphrase** to decrypt anything.
> - The Setup URI contains your credentials in base64 (not encrypted). **Only share it via a secure, private channel** (Signal DM, encrypted email, in person). Do not post it publicly or send via SMS.

### Option A: Shared vault (you both sync the same notes)

This is straightforward — your friend uses the same credentials and database as you.

1. Generate a Setup URI on your device: **Settings → Sink → Copy URI**
2. Send the URI to your friend via Signal or another end-to-end encrypted channel
3. Your friend opens the URI on their device — the wizard opens with credentials pre-filled
4. They choose **"Pull from server"** (to receive your vault) or **"Merge"** (if they have existing notes to combine)

Both vaults now stay in sync in real time.

### Option B: Separate vault (friend gets their own isolated database)

If you want your friend to have their own private sync without access to your notes:

1. **On the server**, create a second database:
   ```bash
   cd ~/docker/sink
   source .env
   curl -X PUT "http://${COUCHDB_USER}:${COUCHDB_PASSWORD}@localhost:5985/friend-vault"
   ```

2. **Give your friend** the same server URL and credentials but a different database name (`friend-vault` instead of `sink`)

3. Their data is fully isolated from yours — same CouchDB instance, different database

### Revoking access

To revoke a friend's access, change the CouchDB password on the server:

```bash
cd ~/docker/sink
# Edit .env with a new password
nano .env

# Update the running container
docker compose down
docker compose up -d

# Re-initialize (only needed if you wiped data; otherwise just restart)
# bash setup.sh
```

After this, update your own devices with the new password via **Settings → Sink**.

---

## Maintenance

### Compacting the database

CouchDB stores revision history which grows over time. Compact periodically:

```bash
cd ~/docker/sink
source .env
curl -X POST "http://${COUCHDB_USER}:${COUCHDB_PASSWORD}@localhost:5985/sink/_compact" \
     -H "Content-Type: application/json"
```

To automate monthly:
```bash
crontab -e
# Add:
0 3 1 * * cd ~/docker/sink && source .env && curl -sX POST "http://${COUCHDB_USER}:${COUCHDB_PASSWORD}@localhost:5985/sink/_compact" -H "Content-Type: application/json"
```

### Updating the plugin

```bash
cd ~/sink
git pull
npm install
npm run build
cp main.js manifest.json styles.css "/path/to/vault/.obsidian/plugins/sink/"
# Restart Obsidian or reload plugins (Ctrl+P → Reload app without saving)
```

For mobile, repeat the file transfer steps from Part 3.

### Backup

The CouchDB data lives in `~/docker/sink/data/`. Back this up periodically:
```bash
tar czf ~/backups/sink-db-$(date +%Y%m%d).tar.gz -C ~/docker/sink data/
```

### Troubleshooting

| Problem | Fix |
|---------|-----|
| "Connection failed" | Check Tailscale is running on both devices, verify `curl http://<ip>:5985/` works |
| "Authentication failed" | Double-check username/password match your `.env` |
| Plugin not appearing | Ensure all 3 files (`main.js`, `manifest.json`, `styles.css`) are in `.obsidian/plugins/sink/` and tap reload |
| Sync stops after credential change | Re-enter credentials in Settings → Sink |
| CORS errors | Verify `local.ini` has correct CORS settings, restart container: `docker compose restart` |
| Mobile can't reach server | Open Tailscale app on phone and confirm it's connected; try opening the server URL in a browser |
| Status bar shows "Blocked" | Auth error — check password in settings |

---

## File Reference

**Server (`~/docker/sink/`):**
| File | Purpose |
|------|---------|
| `docker-compose.yml` | CouchDB container definition |
| `local.ini` | CouchDB config (CORS, auth, limits) |
| `setup.sh` | One-time database initialization |
| `.env` | Your credentials — **never commit, never share publicly** |
| `data/` | CouchDB persistent storage — back this up |

**Plugin (installed in vault):**
| File | Purpose |
|------|---------|
| `main.js` | Compiled plugin |
| `manifest.json` | Plugin metadata |
| `styles.css` | Plugin styles |
