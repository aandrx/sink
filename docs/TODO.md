# Sink — Implementation TODO

## Phase 0: Project Setup
- [ ] Initialize npm project with package.json
- [ ] Configure tsconfig.json
- [ ] Configure esbuild.config.mjs (build to main.js)
- [ ] Create manifest.json for Obsidian
- [ ] Create styles.css (minimal)
- [ ] Verify build pipeline produces installable plugin files

## Phase 1: Server Setup
- [ ] Create `server/docker-compose.yml`
- [ ] Create `server/local.ini` (CouchDB config with CORS, auth, max sizes)
- [ ] Create `server/setup.sh` (initialize database + system DBs)
- [ ] Create `server/.env.example` with placeholder credentials
- [ ] Document: test server is reachable via Tailscale IP

## Phase 2: Core Sync Engine
- [ ] `src/settings.ts` — Define SinkSettings interface + DEFAULT_SETTINGS
- [ ] `src/sync/LocalDB.ts` — PouchDB wrapper (init, destroy, get, put, allDocs)
- [ ] `src/sync/RemoteDB.ts` — CouchDB connection (test connection, create DB if missing)
- [ ] `src/sync/FileSerializer.ts` — Convert vault files to/from DB documents
  - [ ] Small files (<64KB): store content directly in doc
  - [ ] Large files (≥64KB): split into chunks, store chunk refs in header doc
  - [ ] Handle binary files (base64 encoding)
- [ ] `src/sync/Replicator.ts` — Continuous bidirectional replication
  - [ ] Start/stop continuous replication
  - [ ] Handle connection drops + auto-reconnect (exponential backoff)
  - [ ] Change feed listener for incoming changes
  - [ ] Debounced push on local changes
- [ ] `src/sync/ConflictResolver.ts` — Conflict handling
  - [ ] Detect conflicts from PouchDB revision tree
  - [ ] Auto-resolve: identical content
  - [ ] Auto-resolve: fast-forward (one side unchanged)
  - [ ] Auto-resolve: 3-way text merge (diff-match-patch)
  - [ ] Fallback: create .conflict file + notify user
- [ ] `src/sync/SyncEngine.ts` — Orchestration layer
  - [ ] Wire together LocalDB + RemoteDB + Replicator + ConflictResolver
  - [ ] Vault event listeners (create, modify, delete, rename)
  - [ ] DB change → vault write pipeline
  - [ ] Vault change → DB write pipeline (with debounce)

## Phase 3: Encryption
- [ ] `src/utils/crypto.ts` — E2E encryption module
  - [ ] Key derivation from passphrase (PBKDF2)
  - [ ] Encrypt document content (AES-256-GCM)
  - [ ] Decrypt document content
  - [ ] Encrypt/decrypt file paths (path obfuscation)

## Phase 4: Obsidian Plugin Integration
- [ ] `src/SinkPlugin.ts` — Main plugin class
  - [ ] `onload()` — initialize SyncEngine, register event handlers, add UI
  - [ ] `onunload()` — stop replication, cleanup
  - [ ] Register vault event listeners (on create/modify/delete/rename)
  - [ ] Load/save settings to Obsidian data.json
- [ ] `main.ts` — Entry point (thin wrapper exporting SinkPlugin as default)

## Phase 5: UI
- [ ] `src/ui/StatusBar.ts` — Sync status in bottom bar
  - [ ] States: connected, syncing, error, offline
  - [ ] Show upload/download counts
- [ ] `src/ui/SettingsTab.ts` — Plugin settings page
  - [ ] Server URL input
  - [ ] Username + Password inputs
  - [ ] Database name input
  - [ ] Encryption passphrase input
  - [ ] Sync delay slider
  - [ ] Auto-resolve conflicts toggle
  - [ ] Device name input
  - [ ] "Test Connection" button
  - [ ] "Generate Setup URI" button
  - [ ] "Rebuild Local DB" button (emergency)
- [ ] `src/ui/SetupWizard.ts` — First-run wizard (modal)
  - [ ] Step 1: Enter server credentials + test connection
  - [ ] Step 2: Choose direction (push to server / pull from server / merge)
  - [ ] Step 3: Confirm + start initial sync
  - [ ] Option: paste Setup URI instead of manual entry
- [ ] `src/ui/ConflictModal.ts` — Manual conflict resolution
  - [ ] Show diff between versions
  - [ ] Choose: keep mine / keep theirs / manual edit

## Phase 6: Setup URI System
- [ ] `src/utils/uri.ts` — URI generation and parsing
  - [ ] Generate encrypted URI containing: server URL, username, password, DB name, encryption passphrase
  - [ ] Parse URI and extract settings
  - [ ] Register `obsidian://sink-setup` protocol handler
  - [ ] Clipboard copy helper

## Phase 7: Config Folder Sync
- [ ] Handle `.obsidian/` folder sync
  - [ ] Sync plugins, themes, snippets, workspace files
  - [ ] Exclude `workspace.json` (device-specific)
  - [ ] Exclude `.obsidian/plugins/sink/data.json` (device-specific settings)
  - [ ] Prompt user before applying config changes from another device

## Phase 8: Testing & Polish
- [ ] Test: single device push/pull to empty CouchDB
- [ ] Test: two devices syncing simultaneously
- [ ] Test: conflict generation and resolution
- [ ] Test: large file (>64KB) sync
- [ ] Test: binary file (image) sync
- [ ] Test: connection drop and reconnection
- [ ] Test: initial vault sync (large vault)
- [ ] Test: Setup URI flow on second device
- [ ] Test: encryption (verify CouchDB content is unreadable)
- [ ] Clean up console logging (use Obsidian Notice for user-facing messages)
- [ ] Final build → verify `main.js`, `manifest.json`, `styles.css` are correct
- [ ] Install in actual vault and verify functionality

## Phase 9: Documentation
- [ ] README.md — Quick start guide
  - [ ] Server setup instructions
  - [ ] First device setup
  - [ ] Additional device setup
  - [ ] Troubleshooting common issues
- [ ] Document CouchDB maintenance (compaction cron job)

---

## Quick Reference

**Build command:** `npm run build`
**Dev command:** `npm run dev`
**Output files:** `main.js`, `manifest.json`, `styles.css`
**Install location:** `<vault>/.obsidian/plugins/sink/`

**Server:**
- CouchDB on Docker: `cd server && docker compose up -d`
- Initialize: `cd server && bash setup.sh`
- Access: `http://<tailscale-ip>:5984/_utils`

**Design principles:**
- One sync mode (LiveSync, always on)
- Minimal settings (8 total)
- Auto-reconnect on failure
- Silent conflict resolution where possible
- No surprise config overwrites
