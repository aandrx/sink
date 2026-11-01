# Grey-screen stability investigation

## What is established

Source inspection found real defects, but no Obsidian renderer crash dump or reproduction was available. Fixing these defects does **not** prove that Sink caused (or now eliminates) the grey screen. Unhandled promise rejections are errors, not evidence by themselves of a renderer-process crash.

| Defect | Risk | Mitigation |
| --- | --- | --- |
| Device metadata queries read every database document, repeatedly during sync | Loading all file content, chunks, and snapshots into the renderer | ID-range queries; snapshot lists read one document at a time and retain summaries only |
| Vault listeners registered again on each sync restart | Duplicate work, deletions, and renames | Register once per plugin load; serialize starts/stops and close old IndexedDB connections |
| Incoming callbacks launched async work without awaiting/catching it | Overlapping preparation/review/write operations and hidden failures | Serialize vault operations; coalesce incoming document IDs; catch background failures |
| Incoming writes ignored the config-sync toggle | Unexpected settings writes | Enforce path policy during preparation and immediately before writes, including custom config directories |
| Chunked text reviewed/merged as an empty string | Empty or incorrect note content | Reconstruct and decrypt text before comparison/merge; defer incomplete documents until chunks arrive |
| Chunk decryption errors fell back to ciphertext | Corrupt files after a wrong key or damaged chunk | Fail closed: do not overwrite local files |
| Parent documents published before their chunks | Readers encounter incomplete files | Persist immutable chunks first, including conflict retries |
| Write-suppression timeout expired during long writes and was removed immediately afterward | Feedback uploads and repeat work | Keep suppression active for the entire write and briefly afterward |
| Whole-file reads, per-byte string building, full-database pulls, unbounded diffs | Renderer memory pressure or UI stalls | File/snapshot budgets, block base64 encoding, small replication buffers, paged pulls, bounded diff work |

## Changed behavior and limits

- Config sync defaults to **off for new installations**. Existing saved settings remain unchanged; turn it off explicitly while diagnosing crashes.
- Regardless of the toggle, Sink excludes the config directory's workspace state, community/core plugin-enable lists, and its own entire plugin directory. This prevents those paths from being used to change the enabled plugin list or replace Sink. This is preventive; it does not establish that Sink previously changed that list.
- Paths with traversal, absolute-path syntax, or noncanonical separators are rejected.
- Uploads and incoming nondeleted files have a **20 MiB per-file limit**. This is a conservative guard, not streaming support. Larger files are not synced; errors are reported to the developer console. Replication may still download oversized existing remote documents into IndexedDB: these limits are not a hard cap on renderer memory or database size.
- Each automatic safety snapshot has a **32 MiB estimated in-memory budget**. A batch needing a larger backup is refused rather than applied without a backup.
- Diff previews are restricted to 1 MiB combined text and 4,000 combined lines. Divergent edits require an explicit side choice; the previous patch-based replacement was not a genuine three-way merge.
- 0.2.15 provides one review for a complete pull, with paged discovery/application and lazy previews. It also reconciles offline local edits/new files/deletions/divergence after startup, and resolves retained CouchDB revisions through an explicit Local/Remote choice. These are logical operations, not atomic filesystem transactions. A cancelled review ends the operation without applying selected changes.
- Local edits made while a review is open are detected and skipped, requiring another pull.
- Disabling config sync does not delete existing server documents, prevent raw database replication, or undo earlier writes. Obsidian's usual vault APIs do not enumerate hidden config files like ordinary notes; this patch does not add a hidden-file watcher or guarantee complete config-folder syncing.
- 0.2.15 keeps new snapshots local-only and encrypts their payload when vault encryption is configured. Conflict resolution intentionally retires the retained remote revisions that were reviewed and not chosen; the local snapshot does not back up those remote revisions. Snapshots still embed whole files and are not automatically pruned. Legacy snapshots may already have replicated as plaintext; new encryption does not undo historical exposure. Large legacy snapshots can remain expensive to read; do not rebuild/delete the sync database as a diagnostic shortcut without backups.

## Safe verification procedure

1. Keep Sink disabled in the live vault. Back up both the vault **including its config folder** and CouchDB. Establish whether Obsidian stays stable with Sink disabled over a comparable workload and time period.
2. Use a disposable vault and a **separate test CouchDB database**. Do not connect a disposable device with a new identity to the production database: deletions/merges could replicate back to other devices.
3. Install the current 0.2.15 development build into the disposable vault only. Set config sync off explicitly. Use the same updated build on both test devices because Sink's version gate compares exact versions. Preparing a local release commit/tag does not publish or deploy the plugin.
4. Open desktop developer tools (Ctrl+Shift+I), enable **Preserve log**, and monitor Task Manager's Obsidian/Electron processes while testing. Do not paste credentials, setup URIs, or note contents into bug reports.
5. First test a handful of notes. Then test repeated connection restarts, simultaneous edits on two devices, encrypted text above the chunk threshold (64 KiB), binary attachments, a cancelled review, and disabling Sink while a review is open.
6. Check that a file above 20 MiB is refused without a vault overwrite and that incomplete/badly encrypted chunks leave local files unchanged. Watch for steadily growing memory during repeated pulls/restarters, unexpected uploads after incoming writes, or duplicate review dialogs.
7. Confirm workspace state, plugin-enable lists, and Sink's own directory remain untouched even when config sync is enabled in the test vault.
8. If a grey screen recurs, record the exact operation/time, last console errors, memory trend, plugin list, OS/Obsidian versions, and any OS/Electron crash report. Distinguish UI stalls, an empty workspace, and a renderer-process termination. Repeat with other plugins disabled before attributing the failure.
9. Only consider a live-vault rollout after these tests pass, with config sync still off and backups available. Do not enable the old build as the test.

## Automated checks

The repository provides `npm test`, `npm run typecheck`, and `npm run build`. Unit tests exercise real TypeScript classes with small Obsidian/PouchDB substitutes and a DOM environment. `npm run test:e2e` separately targets isolated real Obsidian/Electron, IndexedDB, and CouchDB; it requires Docker, Obsidian, and a graphical display. See [0.2.15 verification evidence](verification/0.2.15.md) for actual results and untested cases. Neither test layer proves absence of a grey-screen crash.

Dependency audit also reports moderate advisories in the existing PouchDB/UUID dependency chain. They are not established as the crash cause. No forced dependency downgrade or breaking audit fix was applied.