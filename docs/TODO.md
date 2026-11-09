# Sink — Implementation TODO

## Phase 0: Project Setup
- [x] Initialize npm project with package.json
- [x] Configure tsconfig.json
- [x] Configure esbuild.config.mjs (build to main.js)
- [x] Create manifest.json for Obsidian
- [x] Create styles.css (minimal)
- [x] Verify build pipeline produces installable plugin files

## Phase 1: Server Setup
- [x] Create `server/docker-compose.yml`
- [x] Create `server/local.ini` (CouchDB config with CORS, auth, max sizes)
- [x] Create `server/setup.sh` (initialize database + system DBs)
- [x] Create `server/.env.example` with placeholder credentials
- [x] Document: test server is reachable via Tailscale IP

## Phase 2: Core Sync Engine
- [x] `src/settings.ts` — Define SinkSettings interface + DEFAULT_SETTINGS
- [x] `src/sync/LocalDB.ts` — PouchDB wrapper (init, destroy, get, put, allDocs)
- [x] `src/sync/RemoteDB.ts` — CouchDB connection (test connection, create DB if missing)
- [x] `src/sync/FileSerializer.ts` — Convert vault files to/from DB documents
  - [x] Small files (<64KB): store content directly in doc
  - [x] Large files (≥64KB): split into chunks, store chunk refs in header doc
  - [x] Handle binary files (base64 encoding)
- [x] `src/sync/Replicator.ts` — Continuous bidirectional replication
  - [x] Start/stop continuous replication
  - [x] Handle connection drops + auto-reconnect (exponential backoff)
  - [x] Change feed listener for incoming changes
  - [x] Debounced push on local changes
  - [x] Auth errors (401/403) stop replication instead of retrying (prevents credential flood)
- [x] `src/sync/ConflictResolver.ts` — Conflict handling
  - [x] Detect conflicts from PouchDB revision tree
  - [x] Auto-resolve: identical content
  - [x] Auto-resolve: fast-forward (one side unchanged)
  - [ ] Auto-resolve: 3-way text merge — intentionally not offered without a common ancestor
  - [x] Fallback: explicit Local/Remote review via BatchReviewModal
- [x] `src/sync/SyncEngine.ts` — Orchestration layer
  - [x] Wire together LocalDB + RemoteDB + Replicator + ConflictResolver
  - [x] Vault event listeners (create, modify, delete, rename)
  - [x] DB change → vault write pipeline
  - [x] Vault change → DB write pipeline (with debounce)

## Phase 3: Encryption
- [x] `src/utils/crypto.ts` — E2E encryption module
  - [x] Key derivation from passphrase (PBKDF2, 100k iterations, SHA-256)
  - [x] Encrypt document content (AES-256-GCM, random 96-bit IV per document)
  - [x] Decrypt document content
  - [ ] Encrypt/decrypt file paths (path obfuscation) — not yet implemented

## Phase 4: Obsidian Plugin Integration
- [x] `src/SinkPlugin.ts` — Main plugin class
  - [x] `onload()` — initialize SyncEngine, register event handlers, add UI
  - [x] `onunload()` — stop replication, cleanup
  - [x] Register vault event listeners (on create/modify/delete/rename)
  - [x] Load/save settings to Obsidian data.json
- [x] `main.ts` — Entry point (thin wrapper exporting SinkPlugin as default)

## Phase 5: UI
- [x] `src/ui/StatusBar.ts` — Sync status in bottom bar
  - [x] States: connected, syncing, error, disconnected, paused
  - [x] Hover tooltip showing status detail
- [x] `src/ui/FloatingStatus.ts` — Top-right floating overlay
  - [x] Activity text (Sending/Receiving + filename) with 4s revert
  - [x] Plain status labels: Connected, Syncing, Review, Blocked, Disconnected
  - [x] Matches obsidian-livesync .livesync-status style
- [x] `src/ui/SettingsTab.ts` — Plugin settings page (10 settings + actions)
- [x] `src/ui/SetupWizard.ts` — First-run wizard (3 steps)
- [x] `src/ui/ConflictModal.ts` — Legacy single-conflict modal (two-pane diff)
- [x] `src/ui/BatchReviewModal.ts` — Complete review workspace, paging, bulk actions, Local/Remote decisions
  - [x] Desktop side-by-side diff
  - [x] Mobile iOS-style cards, segmented decisions, detail sheet, unified diff (0.2.23)
- [x] `src/ui/DiffView.ts` — Side-by-side and unified diff renderers

## Phase 6: Setup URI System
- [x] `src/utils/uri.ts` — URI generation and parsing
  - [x] Generate URI containing: server URL, username, password, DB name, passphrase
  - [x] Parse URI and extract settings
  - [x] Register `obsidian://sink-setup` protocol handler
  - [ ] URI encryption (currently base64 only — treat as sensitive, share via secure channel)

## Phase 7: Config Folder Sync
- [x] Handle `.obsidian/` folder sync (optional toggle)
- [x] Exclude `.obsidian/plugins/sink/data.json` (device-specific settings)
- [ ] Prompt user before applying config changes from another device

## Phase 8: Testing & Polish
- [x] Plugin loads without errors
- [x] Live sync confirmed working between two devices
- [x] Auth error flood prevention (401/403 stops replication)
- [ ] Test: conflict generation and resolution
- [ ] Test: large file (>64KB) sync
- [ ] Test: binary file (image) sync
- [ ] Test: Setup URI flow on second device
- [ ] Test: encryption (verify CouchDB content is unreadable)
- [ ] Test: mobile (iOS/Android) setup

## Phase 9: Documentation
- [x] `docs/setup.md` — Full setup guide (server + desktop + mobile + friend access)
- [x] `README.md` — Project overview and quick start
- [x] CouchDB maintenance documented (compaction cron)

## Known Limitations / Future Work
- [ ] File path encryption (paths visible in CouchDB if no passphrase)
- [ ] Setup URI is base64-only — share only via secure channel (Signal, etc.)
- [ ] No per-user CouchDB accounts — all devices share one admin credential
- [ ] Mobile requires manual or BRAT installation (not on the community plugins list)

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
- Compact settings (10 total)
- Auto-reconnect on failure
- Silent only for identical content and verified fast-forwards; divergent edits require a side choice
- No surprise config overwrites
