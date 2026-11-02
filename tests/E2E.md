# Real Obsidian/CouchDB E2E

Run `npm run test:e2e` from the repository. Requires Node.js 22.22.2+, Docker with `couchdb:3` available, a graphical X11 display, and an installed Obsidian/Electron binary. Set `OBSIDIAN_BIN` and `OBSIDIAN_APP` to override the default Linux paths. `SINK_E2E_ARTIFACTS` selects a new evidence directory.

## Isolation

The harness launches two instances with temporary HOME, XDG config/data/cache/state/runtime directories, private D-Bus sessions, vaults, and Electron profiles. CDP and a uniquely named CouchDB container bind loopback. Test credentials are random, redacted, and removed with temporary state. CORS is enabled only inside this test container. Electron web security is not disabled; the harness uses `--no-sandbox` for its isolated local test processes, so this is not a security-sandbox validation.

The current source is bundled directly into each disposable vault with all three plugin assets. Repository `main.js` and live vault/profile configuration are not used. Cleanup targets only owned process groups, container, and temporary directories. Screenshots/evidence are retained separately.

## Test controls

Real DOM controls drive review decisions, cancellation, and secondary permission. Real Obsidian/plugin APIs drive file edits, role setup, explicit pulls, replication pause/resume, and local database inspection. No runtime stubs or permission bypasses are used. Replication pauses make the complete-pull fixture deterministic; this is not proof that every background catch-up forms one review.

The controller tracks one pending manual pull at a time. It does not wait blindly for a manual pull while a separate automatic review needs a decision. Failure cleanup cancels, never approves, leftover dialogs so later scenarios are not blocked by an earlier failed case.

## Scenarios

- 12-file pull: exact review count, cancel applies none, confirm and on-disk content/hash equality.
- Desktop/narrow and light/dark: actual theme classes, footer inside modal, no pager/preview overlap, two diff panes.
- Secondary publication permission once per engine session.
- Divergent edits preserved before a choice, then explicit device publication/server adoption converges.
- Engine stop/restart catch-up.
- Encrypted >64 KiB file and chunk transfer with no plaintext marker in CouchDB.
- Built-in inbound selector excludes legacy snapshots while allowing files, chunks, devices, tombstones, and live updates.
- Real conflicting CouchDB revisions: revision selector, non-winning choice, retirement of losing leaves, and conflict-free results.
- Startup reconciliation after an offline local edit, new file, deletion, and divergence, with one startup review and primary adoption.

## Recorded verification

Parent-verified run: **9 passed, zero failed**.

Evidence: `/tmp/sink-e2e-artifacts/2026-11-02T00-26-41-264Z-e37e8f/evidence.json`.

See `docs/verification/0.2.19.md`, `docs/verification/0.2.18.md`, `docs/verification/0.2.17.md`, and `docs/verification/0.2.16.md` for the patch evidence and `docs/verification/0.2.15.md` for the release review, audit findings, cleanup, and remaining verification limits. The final full run passed 9/9. Earlier failed runs are intentionally preserved in separate artifact directories rather than overwritten.

Two local processes do not establish cross-device/OS/mobile behavior, real tailnet outage recovery, or long-duration grey-screen/memory stability. Never run this against a production vault/database.
