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

Verify it's running:
```bash
docker compose ps
# Should show couchdb container as "running"

curl http://localhost:5984/
# Should return: {"couchdb":"Welcome", ...}
```

### 4. Initialize the database

```bash
bash setup.sh
```

This creates the `sink` database and required system databases. You should see:
```
Waiting for CouchDB to be ready...
Creating system databases...
Creating sink database...

=== Sink server ready! ===
CouchDB URL: http://localhost:5984
Database:    sink
Fauxton UI:  http://localhost:5984/_utils
```

### 5. Verify access

Open the Fauxton admin UI in a browser:
```
http://localhost:5984/_utils
```

Log in with the username/password from your `.env` file. You should see the `sink` database listed.

### 6. Get your Tailscale IP

```bash
tailscale ip -4
# Example output: 100.64.1.23
```

Verify it's accessible from another device on your tailnet:
```bash
# From your laptop:
curl http://100.64.1.23:5984/
# Should return the CouchDB welcome JSON
```

That's your Server URL for the plugin: `http://100.64.1.23:5984`

---

## Part 2: Obsidian Plugin Setup (Arch Linux Laptop)

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

### 3. Enable the plugin

1. Open Obsidian
2. Go to Settings → Community Plugins
3. Enable "Sink" in the list
4. The Setup Wizard will open automatically

### 4. Configure in the Setup Wizard

Enter:
- **Server URL**: `http://<your-tailscale-ip>:5984` (e.g., `http://100.64.1.23:5984`)
- **Username**: `admin` (or whatever you set in `.env`)
- **Password**: your password from `.env`
- **Database name**: `sink` (default)
- **Encryption passphrase**: pick something (optional but recommended)

Click **Test & Continue**.

### 5. Choose sync direction

For your **first device** (the one with the vault you want to sync FROM):
→ Choose **"Push vault to server"**

This uploads all your notes to CouchDB.

### 6. Generate Setup URI for other devices

After setup completes:
1. Go to Settings → Sink
2. Click **"Copy URI"** under Actions
3. Save this URI — you'll paste it on your other devices

---

## Part 3: Adding More Devices

### Option A: Setup URI (recommended)

1. Install the plugin (same steps as Part 2, steps 1-3)
2. When the Setup Wizard opens, paste the Setup URI under "Option A"
3. Click **Import**
4. Choose **"Pull from server"** (if empty vault) or **"Merge"** (if vault has existing content)

### Option B: Manual entry

Enter the same server URL, username, password, database name, and encryption passphrase as the first device.

---

## Maintenance

### Compacting the database

CouchDB stores revision history which grows over time. Compact periodically:

```bash
# Run on your server (or add to cron)
source ~/docker/sink/.env
curl -X POST "http://${COUCHDB_USER}:${COUCHDB_PASSWORD}@localhost:5984/sink/_compact" \
     -H "Content-Type: application/json"
```

To automate monthly:
```bash
crontab -e
# Add:
0 3 1 * * source ~/docker/sink/.env && curl -sX POST "http://${COUCHDB_USER}:${COUCHDB_PASSWORD}@localhost:5984/sink/_compact" -H "Content-Type: application/json"
```

### Updating the plugin

```bash
cd ~/sink
git pull
npm install
npm run build
cp main.js manifest.json styles.css "/path/to/vault/.obsidian/plugins/sink/"
# Restart Obsidian or reload plugins
```

### Backup

The CouchDB data lives in `~/docker/sink/data/`. Back this up periodically:
```bash
tar czf ~/backups/sink-db-$(date +%Y%m%d).tar.gz -C ~/docker/sink data/
```

### Troubleshooting

| Problem | Fix |
|---------|-----|
| "Connection failed" | Check Tailscale is running, verify `curl http://<ip>:5984/` works |
| "Authentication failed" | Double-check username/password match your `.env` |
| Plugin not appearing | Ensure all 3 files (`main.js`, `manifest.json`, `styles.css`) are in `.obsidian/plugins/sink/` |
| Sync stops working | Try: Settings → Sink → Rebuild local database |
| CORS errors | Verify `local.ini` has correct CORS settings, restart container: `docker compose restart` |

---

## File Reference

**Server (`~/docker/sink/`):**
| File | Purpose |
|------|---------|
| `docker-compose.yml` | CouchDB container definition |
| `local.ini` | CouchDB config (CORS, auth, limits) |
| `setup.sh` | One-time database initialization |
| `.env` | Your credentials (never commit this) |
| `data/` | CouchDB persistent storage |

**Plugin (`~/sink/` → vault):**
| File | Purpose |
|------|---------|
| `main.js` | Compiled plugin (goes in vault) |
| `manifest.json` | Plugin metadata (goes in vault) |
| `styles.css` | Plugin styles (goes in vault) |
