import { App, Modal, Notice, TAbstractFile, TFile, Vault } from "obsidian";
import type {
  ChangeDecision,
  ConflictRevision,
  DeviceMetaDoc,
  DeviceRole,
  KnownDevice,
  PendingChange,
  ReviewResult,
  ReviewedChange,
  SinkDoc,
  SinkSettings,
  SnapshotFileEntry,
  SnapshotMetaDoc,
  SnapshotSummary,
  SyncEvent,
  SyncStatus,
} from "../settings";
import { LocalDB } from "./LocalDB";
import { RemoteDB } from "./RemoteDB";
import { Replicator } from "./Replicator";
import { FileSerializer } from "./FileSerializer";
import { CryptoHelper } from "../utils/crypto";
import { BatchReviewModal } from "../ui/BatchReviewModal";
import { arrayBufferToBase64, assertFileSize, isSyncPathAllowed, MAX_CONTENT_LENGTH, MAX_SNAPSHOT_BYTES } from "./safety";

export type SyncEventHandler = (event: SyncEvent) => void;
export type SyncProgressCallback = (path: string, done: number, total: number) => void;

interface PreparedChange extends PendingChange {
  remoteDoc: SinkDoc;
  remoteEncrypted: boolean;
  safeFastForward?: boolean;
  hasUnresolvedConflicts?: boolean;
  hasDeferredReview?: boolean;
  /** Metadata-only candidates are hydrated one at a time when applied. */
  needsHydration?: boolean;
  pinnedRev?: string;
  pinnedConflicts?: string[];
  localFingerprint?: string | null;
  remoteFingerprint?: string;
  /** Startup reconciliation never publishes or deletes without an explicit review. */
  requiresReview?: boolean;
  /** A reviewed local edit that differs from the remote without being an unknown divergence. */
  safeLocalPush?: boolean;
}

interface LocalFileState {
  exists: boolean;
  isBinary: boolean;
  content: string;
  mtime?: number;
  ctime?: number;
}

interface PinnedWriteOptions {
  /** Expected current winning revision. A mismatch aborts without retrying. */
  pinnedRev?: string;
  /** The path must still have no database document. */
  expectMissing?: boolean;
}

export class SyncEngine {
  private static readonly ACTIVE_DEVICE_WINDOW_MS = 2 * 60 * 1000;
  private static readonly DEVICE_HEARTBEAT_MS = 60 * 1000;
  private static readonly STALE_PULL_WINDOW_MS = 30 * 60 * 1000;
  private static readonly RISKY_CHANGE_COUNT = 2;
  private static readonly PULL_PAGE_SIZE = 100;
  private static readonly CONFLICT_REVIEW_MESSAGE = "Database conflict revisions were retained for review. Choose the server version to keep. Sink republishes that choice and retires the other retained revisions only after you apply it.";

  private app: App;
  private vault: Vault;
  private settings: SinkSettings;
  private vaultName: string;
  private pluginVersion: string;
  private localDB: LocalDB;
  private remoteDB: RemoteDB;
  private replicator: Replicator | null = null;
  private serializer: FileSerializer;
  private crypto: CryptoHelper | null = null;
  private handler: SyncEventHandler;
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  // Maps path → Infinity during a write, then its completion timestamp.
  // Used to skip vault events caused by our own writes.
  // Entries older than 100ms are treated as expired.
  private processing: Map<string, number> = new Map();
  private readonly PROCESSING_TIMEOUT_MS = 100;

  /** Check if a path is currently being written by sync (with age check) */
  private isProcessing(path: string): boolean {
    const ts = this.processing.get(path);
    if (!ts) return false;
    if (Date.now() - ts > this.PROCESSING_TIMEOUT_MS) {
      this.processing.delete(path); // clean stale entry
      return false;
    }
    return true;
  }
  private status: SyncStatus = "disconnected";
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private secondaryPushApproved = false;
  private approvalPromise: Promise<boolean> | null = null;
  private reviewPromise: Promise<ReviewResult> | null = null;
  private sessionMergeAllowed = false;
  private remoteHeadState: "head" | "behind" = "head";
  private stopped = false;
  private operationQueue: Promise<unknown> = Promise.resolve();
  private pendingIncoming = new Set<string>();
  private deferredIncoming = new Set<string>();
  private incomingScheduled = false;
  private reviewModal: BatchReviewModal | null = null;
  private approvalModal: Modal | null = null;
  private reviewStatusActive = false;
  private lastApplyIncomplete = false;
  private reviewCancelled = false;
  private readonly appliedFingerprints = new Map<string, string>();
  private readonly reportedConflictPaths = new Set<string>();
  private readonly deferredReviewMarkers = new Map<string, string>();
  // Held remote IDs retain the revision that was cancelled. A later revision must
  // still be eligible for review instead of being suppressed for the session.
  private readonly heldIncoming = new Map<string, string>();
  private startupRecoveryPending = false;
  private startupInProgress = true;
  private readonly startupDirtyPaths = new Set<string>();

  private reportError(context: string, error: unknown): void {
    this.handler({ type: "error", message: `${context}: ${error instanceof Error ? error.message : String(error)}` });
  }

  private isPathAllowed(path: string): boolean {
    return isSyncPathAllowed(path, this.vault.configDir, this.settings.syncConfigFolder);
  }

  /** Serialize vault mutations and uploads, without retaining incoming document bodies. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.catch(() => undefined);
    return result;
  }

  private scheduleIncoming(docs: SinkDoc[]): void {
    if (this.stopped) return;
    for (const doc of docs) {
      if (doc.type === "file" && this.isPathAllowed(doc.path)) {
        const heldRev = this.heldIncoming.get(doc._id);
        if (heldRev !== undefined && (!doc._rev || heldRev === doc._rev)) continue;
        if (heldRev !== undefined) this.heldIncoming.delete(doc._id);
        this.pendingIncoming.add(doc._id);
      }
      if (doc.type === "chunk") {
        for (const id of this.deferredIncoming) this.pendingIncoming.add(id);
        this.deferredIncoming.clear();
      }
    }
    if (this.incomingScheduled || this.pendingIncoming.size === 0) return;
    this.incomingScheduled = true;
    void this.enqueue(async () => {
      try {
        while (!this.stopped && this.pendingIncoming.size > 0) {
          // Snapshot every currently queued ID into one operation. Arrivals during
          // review stay queued for the next operation instead of extending this one.
          const ids = Array.from(this.pendingIncoming);
          for (const id of ids) this.pendingIncoming.delete(id);
          try {
            await this.handleIncomingIds(ids);
          } catch (error) {
            this.reportError("Incoming sync failed", error);
          }
          if (this.reviewCancelled) {
            // Active IDs were already removed. Keep later arrivals pending and leave
            // the engine behind so an explicit pull can review the cancelled work.
            break;
          }
          // Yield to the renderer between operations, including on fast local databases.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      } finally {
        // Clear before the queue promise resolves so the next change cannot be stranded.
        this.incomingScheduled = false;
      }
    }).catch((error) => this.reportError("Incoming queue failed", error));
  }

  private async fetchIncomingDocsPage(ids: string[]): Promise<SinkDoc[]> {
    const docs: SinkDoc[] = [];
    for (const id of ids) {
      try {
        docs.push(await this.localDB.instance.get(id, { conflicts: true } as PouchDB.Core.GetOptions) as SinkDoc & { _conflicts?: string[] });
      } catch (error: any) {
        if (error?.status !== 404) this.reportError(`Incoming document lookup failed for ${id}`, error);
      }
    }
    return docs;
  }

  private async handleIncomingIds(ids: string[]): Promise<void> {
    if (this.stopped || ids.length === 0) return;
    const candidates: PreparedChange[] = [];
    for (let offset = 0; offset < ids.length; offset += SyncEngine.PULL_PAGE_SIZE) {
      if (this.stopped) break;
      const pageIds = ids.slice(offset, offset + SyncEngine.PULL_PAGE_SIZE);
      // Keep only one document body alive while preparing operation metadata.
      for (const id of pageIds) {
        if (this.stopped) break;
        const docs = await this.fetchIncomingDocsPage([id]);
        candidates.push(...await this.prepareLightCandidates(docs));
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (candidates.length === 0) return;
    this.remoteHeadState = "behind";
    this.lastApplyIncomplete = false;
    try {
      await this.applyIncomingChangesWithReview(candidates, "Review incoming changes");
    } catch (error) {
      this.lastApplyIncomplete = true;
      throw error;
    } finally {
      if (!this.lastApplyIncomplete) this.remoteHeadState = "head";
    }
  }

  constructor(app: App, vault: Vault, settings: SinkSettings, vaultName: string, pluginVersion: string, handler: SyncEventHandler) {
    this.app = app;
    this.vault = vault;
    this.settings = settings;
    this.vaultName = vaultName;
    this.pluginVersion = pluginVersion;
    this.handler = handler;
    this.localDB = new LocalDB(vaultName);
    this.remoteDB = new RemoteDB(settings);
    this.serializer = new FileSerializer(vault, this.localDB);
  }

  /** Initialize and start syncing */
  async start(): Promise<void> {
    this.stopped = false;
    // Initialize encryption if passphrase is set
    if (this.settings.passphrase) {
      this.crypto = new CryptoHelper(this.settings.passphrase);
    }
    this.configureSnapshotCrypto();

    // Connect to remote
    this.remoteDB.connect();

    // Set up replicator with change handling
    this.replicator = new Replicator(this.localDB, this.remoteDB, (event) => {
      switch (event.type) {
        case "change":
          this.scheduleIncoming(event.docs as SinkDoc[]);
          break;
        case "status":
          if (this.startupRecoveryPending && !this.reviewStatusActive
            && (event.status === "connected" || event.status === "syncing")) {
            this.startupRecoveryPending = false;
            void this.reconcileVaultAfterStartup().catch((error) => this.reportError("Startup recovery failed", error));
          }
          if (this.reviewStatusActive || (this.remoteHeadState === "behind" && (event.status === "connected" || event.status === "syncing"))) {
            this.status = "paused";
            this.handler({ type: "status-change", status: "paused" });
            break;
          }
          this.status = event.status;
          this.handler({ type: "status-change", status: event.status });
          break;
        case "error":
          this.handler({ type: "error", message: String(event.error) });
          break;
      }
    });

    // Start continuous replication only after the startup pull has established the
    // current remote winner set. Collection is metadata-only; applying it is queued
    // so plugin startup does not wait for a review.
    this.startupInProgress = true;
    this.startupDirtyPaths.clear();
    this.reviewCancelled = false;
    let startupCandidates: PreparedChange[] = [];
    let pullFailed = false;
    try {
      try {
        await this.replicator.pullOnce();
      } catch (error) {
        pullFailed = true;
        this.startupRecoveryPending = true;
        this.remoteHeadState = "behind";
        this.lastApplyIncomplete = true;
        this.reportError("Startup pull failed", error);
      }

      if (!this.stopped && !pullFailed) {
        startupCandidates = await this.collectStartupCandidates();
      }

      if (!this.stopped) {
        if (pullFailed) {
          this.startupInProgress = false;
          this.startupDirtyPaths.clear();
        } else {
          void this.enqueue(() => this.applyStartupReconciliation(startupCandidates)).catch((error) => {
            this.reportError("Startup reconciliation failed", error);
            this.startupInProgress = false;
            this.startupDirtyPaths.clear();
          });
        }
      }
    } finally {
      if (!this.stopped) {
        // Start continuous retry even after a failed pull. The startup barrier still
        // records local edits until the queued reconciliation finishes.
        this.replicator.start();
        try {
          await this.upsertDeviceRecord();
        } catch (error: any) {
          this.handler({ type: "error", message: `Device registry update skipped at startup: ${error.message}` });
        }
        if (!this.stopped) this.startHeartbeat();
      }
    }
  }

  private async applyStartupReconciliation(candidates: PreparedChange[]): Promise<number> {
    let applied = 0;
    try {
      applied = await this.applyStartupCandidates(candidates);
      if (!this.stopped && !this.reviewCancelled && this.startupDirtyPaths.size > 0) {
        // Changes made while the first reconciliation was being prepared or reviewed
        // need one more pass. A cancelled or denied review stays behind instead of
        // immediately prompting again.
        this.startupDirtyPaths.clear();
        const dirtyCandidates = await this.collectStartupCandidates();
        applied += await this.applyStartupCandidates(dirtyCandidates);
      }
      return applied;
    } finally {
      const pendingDirty = this.startupDirtyPaths.size > 0;
      this.startupInProgress = false;
      this.startupDirtyPaths.clear();
      if (!this.stopped && pendingDirty && !this.reviewCancelled) {
        // Edits made during the final review are not silently forgotten. Run one
        // normal metadata reconciliation after the barrier is released.
        void this.reconcileVaultAfterStartup().catch((error) => this.reportError("Startup dirty reconciliation failed", error));
      }
    }
  }

  /** Reconcile the vault with the local database winner set after a startup pull. */
  async reconcileVaultAfterStartup(): Promise<number> {
    return this.enqueue(async () => {
      const candidates = await this.collectStartupCandidates();
      if (candidates.length === 0) {
        this.lastApplyIncomplete = false;
        this.remoteHeadState = "head";
        this.finishReviewStatus();
        return 0;
      }
      return await this.applyStartupCandidates(candidates);
    });
  }

  private async applyStartupCandidates(candidates: PreparedChange[]): Promise<number> {
    if (this.stopped || candidates.length === 0) return 0;
    this.remoteHeadState = "behind";
    this.lastApplyIncomplete = false;
    try {
      return await this.applyIncomingChangesWithReview(candidates, "Review changes made while Sink was stopped");
    } catch (error) {
      this.lastApplyIncomplete = true;
      throw error;
    } finally {
      if (!this.lastApplyIncomplete) this.remoteHeadState = "head";
    }
  }

  /** Recover or create a stable device identity before syncing starts */
  async initializeDeviceIdentity(): Promise<boolean> {
    const saved = this.readSavedIdentity();
    let changed = false;

    if (saved?.deviceId && saved.deviceId !== this.settings.deviceId) {
      this.settings.deviceId = saved.deviceId;
      changed = true;
    }

    if (!this.settings.deviceName && saved?.deviceName) {
      this.settings.deviceName = saved.deviceName;
      changed = true;
    }

    if (this.settings.deviceId && this.settings.deviceName) {
      this.saveIdentity(this.settings.deviceId, this.settings.deviceName);
      return changed;
    }

    if (!this.settings.deviceName) {
      this.settings.deviceName = `device-${Date.now().toString(36)}`;
      changed = true;
    }

    const docs = await this.localDB.getAllDeviceDocs();
    const matches = docs.filter((doc) => doc.deviceName === this.settings.deviceName && doc.vaultName === this.vaultName);
    const existing = matches.sort((left, right) => right.lastSeen - left.lastSeen)[0];

    if (existing) {
      this.settings.deviceId = existing.deviceId;
      this.settings.deviceName = existing.deviceName || this.settings.deviceName;
    } else {
      this.settings.deviceId = crypto.randomUUID();
    }

    this.saveIdentity(this.settings.deviceId, this.settings.deviceName);
    return true;
  }

  allowMergesForSession(): void {
    this.sessionMergeAllowed = true;
  }

  clearSessionMergeAllowance(): void {
    this.sessionMergeAllowed = false;
  }

  get isSessionMergeAllowed(): boolean {
    return this.sessionMergeAllowed;
  }

  /** Stop syncing and clean up */
  async stop(): Promise<void> {
    this.stopped = true;
    this.pendingIncoming.clear();
    this.deferredIncoming.clear();
    this.heldIncoming.clear();
    this.startupDirtyPaths.clear();
    this.startupInProgress = false;
    this.reviewModal?.close();
    this.approvalModal?.close();
    // Cancel all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.stopHeartbeat();
    this.secondaryPushApproved = false;
    this.sessionMergeAllowed = false;
    this.remoteHeadState = "head";

    // Stop replication
    if (this.replicator) {
      this.replicator.stop();
      this.replicator = null;
    }

    // Disconnect remote
    await this.remoteDB.disconnect();
  }

  /** Plugin replacements must also release the IndexedDB connection. */
  async shutdown(): Promise<void> {
    await this.stop();
    await this.operationQueue;
    await this.localDB.close();
  }

  /** Handle a file being created or modified in the vault */
  async onFileChange(file: TFile): Promise<void> {
    // Skip if this change was caused by us writing from sync
    if (this.stopped || this.isProcessing(file.path) || !this.isPathAllowed(file.path)) return;
    if (this.startupInProgress) {
      this.startupDirtyPaths.add(file.path);
      return;
    }

    // Debounce: wait for syncDelay ms of inactivity before pushing
    const existingTimer = this.debounceTimers.get(file.path);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    this.debounceTimers.set(
      file.path,
      setTimeout(() => {
        this.debounceTimers.delete(file.path);
        void this.enqueue(() => this.pushFile(file)).catch((error) => this.reportError(`Push failed for ${file.path}`, error));
      }, this.settings.syncDelay)
    );
  }

  /** Handle a file being deleted in the vault */
  async onFileDelete(file: TAbstractFile): Promise<void> {
    if (this.stopped || this.isProcessing(file.path) || !this.isPathAllowed(file.path)) return;
    if (this.startupInProgress) {
      this.startupDirtyPaths.add(file.path);
      return;
    }
    const timer = this.debounceTimers.get(file.path);
    if (timer) clearTimeout(timer);
    this.debounceTimers.delete(file.path);
    await this.enqueue(() => this.pushDeletion(file.path));
  }

  /** Handle a file being renamed in the vault */
  async onFileRename(file: TAbstractFile, oldPath: string): Promise<void> {
    if (this.stopped || this.isProcessing(file.path) || this.isProcessing(oldPath)) return;
    if (this.startupInProgress) {
      if (this.isPathAllowed(oldPath)) this.startupDirtyPaths.add(oldPath);
      if (this.isPathAllowed(file.path)) this.startupDirtyPaths.add(file.path);
      return;
    }
    const timer = this.debounceTimers.get(oldPath);
    if (timer) clearTimeout(timer);
    this.debounceTimers.delete(oldPath);
    await this.enqueue(async () => {
      // Check both sides independently when moving into/out of an excluded folder.
      if (this.isPathAllowed(oldPath)) await this.pushDeletion(oldPath);
      if (file instanceof TFile && this.isPathAllowed(file.path)) await this.pushFile(file);
    });
  }

  /** Push a local file to the database (with chunk encryption) */
  private async pushFile(file: TFile, options: PinnedWriteOptions = {}): Promise<boolean> {
    const pinned = options.expectMissing === true || options.pinnedRev !== undefined;
    try {
      if (this.stopped || !this.isPathAllowed(file.path)) return false;
      if (this.vault.getAbstractFileByPath(file.path) !== file) return false;
      if (!(await this.ensurePushAllowed(`upload ${file.path}`))) return false;

      const result = await this.serializer.fileToDoc(file);
      const plaintext = result.chunkData ? result.chunkData.join("") : result.doc.content;
      let doc = result.doc;
      doc.deviceName = this.settings.deviceName;
      doc.deviceId = this.settings.deviceId;

      // Encrypt if needed
      if (this.crypto) {
        doc = await this.encryptDoc(doc);
      }

      // Check for existing doc (to get _rev)
      const existing = await this.localDB.getByPath(file.path);
      if (options.expectMissing) {
        if (existing) {
          this.handler({ type: "error", message: `Push aborted for ${file.path}: a database document appeared during review.` });
          return false;
        }
      } else if (options.pinnedRev !== undefined) {
        if (!existing || existing._rev !== options.pinnedRev) {
          this.handler({ type: "error", message: `Push aborted for ${file.path}: the database winner changed during review.` });
          return false;
        }
        doc._rev = existing._rev;
      } else if (existing) {
        doc._rev = existing._rev;
      }

      await this.persistChunks(result.chunkData, result.chunkIds);
      if (this.stopped || !this.isPathAllowed(file.path)) return false;
      await this.localDB.put(doc);
      // Record the fingerprint only after the local database write succeeded. This
      // lets a later startup distinguish a remote fast-forward from a local edit.
      await this.saveLastAppliedFingerprint(file.path, plaintext);

      await this.upsertDeviceRecord({ lastPushAt: Date.now() });
      this.handler({ type: "doc-pushed", path: file.path });
      return true;
    } catch (e: any) {
      // Handle conflict: fetch latest and retry. Pinned startup/conflict writes must
      // fail closed instead of overwriting a winner that changed after review.
      if (e.status === 409 && !pinned) {
        const latest = await this.localDB.getByPath(file.path);
        if (!latest) return false;
        const res = await this.serializer.fileToDoc(file);
        const plaintext = res.chunkData ? res.chunkData.join("") : res.doc.content;
        res.doc._rev = latest._rev;
        res.doc.deviceName = this.settings.deviceName;
        res.doc.deviceId = this.settings.deviceId;
        await this.persistChunks(res.chunkData, res.chunkIds);
        if (this.stopped || !this.isPathAllowed(file.path)) return false;
        if (this.crypto) {
          await this.localDB.put(await this.encryptDoc(res.doc));
        } else {
          await this.localDB.put(res.doc);
        }
        await this.saveLastAppliedFingerprint(file.path, plaintext);
        await this.upsertDeviceRecord({ lastPushAt: Date.now() });
        return true;
      }
      if (e.status === 409 && pinned) {
        this.handler({ type: "error", message: `Push aborted for ${file.path}: the database winner changed during review; nothing was overwritten.` });
        return false;
      }
      this.handler({ type: "error", message: `Push failed for ${file.path}: ${e.message}` });
      return false;
    }
  }

  /** Push a deletion to the database */
  private async pushDeletion(path: string, options: PinnedWriteOptions = {}): Promise<boolean> {
    try {
      if (this.stopped || !this.isPathAllowed(path)) return false;
      if (!(await this.ensurePushAllowed(`delete ${path}`))) return false;

      const existing = await this.localDB.getByPath(path);
      if (existing) {
        if (options.pinnedRev !== undefined && existing._rev !== options.pinnedRev) {
          this.handler({ type: "error", message: `Delete aborted for ${path}: the database winner changed during review.` });
          return false;
        }
        if (this.stopped || !this.isPathAllowed(path)) return false;
        const doc = this.serializer.createDeletionDoc(path);
        doc._rev = existing._rev;
        doc.deviceName = this.settings.deviceName;
        doc.deviceId = this.settings.deviceId;
        await this.localDB.put(doc);
        this.clearLastAppliedFingerprint(path);
        await this.upsertDeviceRecord({ lastPushAt: Date.now() });
        this.handler({ type: "doc-pushed", path });
        return true;
      }
      return false;
    } catch (e: any) {
      this.handler({ type: "error", message: `Delete push failed for ${path}: ${e.message}` });
      return false;
    }
  }

  /** Handle documents coming in from replication */
  private async handleIncomingChanges(docs: SinkDoc[]): Promise<void> {
    if (this.stopped) return;
    const prepared = await this.prepareIncomingChanges(docs);
    if (prepared.length === 0) return;
    this.remoteHeadState = "behind";
    this.lastApplyIncomplete = false;
    try {
      await this.applyIncomingChangesWithReview(prepared, "Review incoming changes");
    } catch (error) {
      this.lastApplyIncomplete = true;
      throw error;
    } finally {
      if (!this.lastApplyIncomplete) this.remoteHeadState = "head";
    }
  }

  /** Encrypt a document's content before storage */
  private async encryptDoc(doc: SinkDoc): Promise<SinkDoc> {
    if (!this.crypto) return doc;
    const { ciphertext, iv } = await this.crypto.encrypt(doc.content);
    return { ...doc, content: ciphertext, iv };
  }

  /** Decrypt a document's content after retrieval */
  private async decryptDoc(doc: SinkDoc): Promise<SinkDoc> {
    if (!this.crypto || !doc.iv) return doc;
    const content = await this.crypto.decrypt(doc.content, doc.iv);
    return { ...doc, content, iv: undefined };
  }

  /** Perform initial full sync (push local vault to server) */
  async pushVaultToServer(onProgress?: SyncProgressCallback): Promise<number> {
    return this.enqueue(() => this.pushVaultToServerInternal(onProgress));
  }

  private async pushVaultToServerInternal(onProgress?: SyncProgressCallback): Promise<number> {
    if (this.stopped) return 0;
    if (!(await this.ensurePushAllowed("push the local vault to the server"))) {
      return 0;
    }

    const files = this.vault.getFiles().filter((f) => this.isPathAllowed(f.path));
    const total = files.length;
    let count = 0;
    let processed = 0;
    for (const file of files) {
      if (this.stopped) break;
      if (await this.pushFile(file)) count++;
      processed++;
      onProgress?.(file.path, processed, total);
    }
    return count;
  }

  /** Pull all docs from remote and write to vault */
  async pullServerToVault(onProgress?: SyncProgressCallback): Promise<number> {
    return this.enqueue(() => this.pullServerToVaultInternal(onProgress));
  }

  private async pullServerToVaultInternal(onProgress?: SyncProgressCallback): Promise<number> {
    if (this.stopped) return 0;
    // First do a one-shot pull (remote → local DB)
    if (this.replicator) {
      await this.replicator.pullOnce();
    }

    await this.upsertDeviceRecord({ lastPullAt: Date.now() });

    // Page only file IDs first, then read each body independently for fingerprints.
    // Neither the operation nor one metadata page retains a set of file bodies.
    const ids: string[] = [];
    let startkey = "file:";
    let skip = 0;
    while (!this.stopped) {
      const result = await this.localDB.allDocs({ startkey, endkey: "file:\uffff", limit: SyncEngine.PULL_PAGE_SIZE, skip, include_docs: false });
      if (result.rows.length === 0) break;
      for (const row of result.rows) {
        if (row.id.startsWith("file:")) ids.push(row.id);
      }
      startkey = result.rows[result.rows.length - 1].id;
      skip = 1;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    if (this.stopped || ids.length === 0) return 0;

    const prepared: PreparedChange[] = [];
    for (let offset = 0; offset < ids.length; offset += SyncEngine.PULL_PAGE_SIZE) {
      if (this.stopped) break;
      for (const id of ids.slice(offset, offset + SyncEngine.PULL_PAGE_SIZE)) {
        if (this.stopped) break;
        const docs = await this.fetchIncomingDocsPage([id]);
        prepared.push(...await this.prepareLightCandidates(docs));
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    if (prepared.length === 0) return 0;

    this.remoteHeadState = "behind";
    this.lastApplyIncomplete = false;
    try {
      const applied = await this.applyIncomingChangesWithReview(prepared, "Review pull changes");
      for (const change of prepared) onProgress?.(change.path, applied, prepared.length);
      return applied;
    } catch (error) {
      this.lastApplyIncomplete = true;
      throw error;
    } finally {
      if (!this.lastApplyIncomplete) this.remoteHeadState = "head";
    }
  }

  /**
   * Collect startup reconciliation candidates without retaining file bodies.
   * The local database must already reflect the startup pull. An empty file
   * history means this device must not auto-publish its whole vault.
   */
  private async collectStartupCandidates(): Promise<PreparedChange[]> {
    if (this.stopped) return [];

    const ids: string[] = [];
    let startkey = "file:";
    let skip = 0;
    while (!this.stopped) {
      const result = await this.localDB.allDocs({ startkey, endkey: "file:\uffff", limit: SyncEngine.PULL_PAGE_SIZE, skip, include_docs: false });
      if (result.rows.length === 0) break;
      for (const row of result.rows) {
        if (row.id.startsWith("file:")) ids.push(row.id);
      }
      startkey = result.rows[result.rows.length - 1].id;
      skip = 1;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    // No established file history after the pull: do not seed an empty database
    // from unmatched local files. Remote file docs count as established history.
    if (this.stopped || ids.length === 0) return [];

    const dbPaths = new Set<string>();
    for (const id of ids) {
      const dbPath = this.localDB.idToPath(id);
      if (dbPath && this.isPathAllowed(dbPath)) dbPaths.add(dbPath);
    }

    const prepared: PreparedChange[] = [];
    const localPaths = new Set<string>();
    const localFiles = this.vault.getFiles().filter((file) => this.isPathAllowed(file.path));
    for (const file of localFiles) {
      if (this.stopped) break;
      localPaths.add(file.path);
      const winner = await this.localDB.getByPath(file.path);
      if (winner) {
        let doc: SinkDoc = winner;
        try {
          // Include retained branches for the existing conflict UI.
          doc = await this.loadPinnedIncomingDoc(winner._id);
        } catch (error: any) {
          if (error?.status !== 404) this.reportError(`Startup winner lookup failed for ${file.path}`, error);
        }
        prepared.push(...await this.prepareLightCandidates([doc], { includeSameSource: true, startup: true }));
      } else {
        try {
          const candidate = await this.createLocalOnlyStartupCandidate(file);
          if (candidate) prepared.push(candidate);
        } catch (error) {
          // One unreadable or oversized local file must not abort every future launch.
          this.reportError(`Startup inspection failed for ${file.path}`, error);
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    for (const dbPath of dbPaths) {
      if (this.stopped) break;
      if (localPaths.has(dbPath)) continue;
      const winner = await this.localDB.getByPath(dbPath);
      if (!winner || winner.deleted) continue;
      let doc: SinkDoc = winner;
      try {
        // Remote-only paths still need retained conflict branches for the review.
        doc = await this.loadPinnedIncomingDoc(winner._id);
      } catch (error: any) {
        if (error?.status !== 404) this.reportError(`Startup winner lookup failed for ${dbPath}`, error);
      }
      prepared.push(...await this.prepareLightCandidates([doc], { includeSameSource: true, startup: true }));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    const latestByPath = new Map<string, PreparedChange>();
    for (const change of prepared) {
      const existing = latestByPath.get(change.path);
      if (!existing || change.remoteMtime >= existing.remoteMtime) {
        latestByPath.set(change.path, change);
      }
    }
    return Array.from(latestByPath.values()).sort((left, right) => left.path.localeCompare(right.path));
  }

  /** Metadata-only candidate for a local file that has no database document. */
  private async createLocalOnlyStartupCandidate(file: TFile): Promise<PreparedChange | null> {
    if (this.stopped || !this.isPathAllowed(file.path)) return null;
    const local = await this.readLocalFileState(file.path);
    const localFingerprint = local.isBinary ? null : await this.contentFingerprint(local.content);
    const path = file.path;
    const id = this.localDB.pathToId(path);
    return {
      path,
      sourceDevice: this.settings.deviceName || "this device",
      sourceDeviceId: this.settings.deviceId,
      remoteMtime: 0,
      localMtime: local.mtime,
      remoteDeleted: true,
      remoteExists: false,
      localExists: true,
      isBinary: local.isBinary,
      suggested: "keep-local",
      remoteDoc: {
        _id: id,
        path,
        content: "",
        mtime: 0,
        ctime: 0,
        size: 0,
        deleted: true,
        type: "file",
        deviceName: this.settings.deviceName,
        deviceId: this.settings.deviceId,
      },
      remoteEncrypted: false,
      safeFastForward: false,
      hasUnresolvedConflicts: false,
      pinnedConflicts: [],
      localFingerprint,
      requiresReview: true,
      safeLocalPush: true,
      loadPreview: async () => {
        const current = await this.readLocalFileState(path);
        return {
          localContent: current.isBinary ? "" : current.content,
          remoteContent: "",
        };
      },
    };
  }

  /** Test connection to remote */
  async testConnection() {
    return this.remoteDB.testConnection();
  }

  /** Get current sync status */
  getStatus(): SyncStatus {
    return this.status;
  }

  /** Destroy local database (for rebuild) */
  async destroyLocalDB(): Promise<void> {
    await this.stop();
    await this.localDB.destroy();
  }

  async listSnapshots(limit = 20): Promise<SnapshotSummary[]> {
    return this.localDB.getSnapshotSummaries(limit);
  }

  async restoreSnapshot(snapshotId: string): Promise<number> {
    return this.enqueue(() => this.restoreSnapshotInternal(snapshotId));
  }

  private async restoreSnapshotInternal(snapshotId: string): Promise<number> {
    if (this.stopped) return 0;
    this.configureSnapshotCrypto();
    const snapshot = await this.localDB.getSnapshotDoc(snapshotId);
    if (!snapshot) {
      throw new Error("Snapshot not found");
    }

    let restored = 0;
    for (const entry of snapshot.files) {
      if (this.stopped) break;
      if (!this.isPathAllowed(entry.path)) continue;
      await this.restoreSnapshotEntry(entry);
      restored += 1;
    }

    new Notice(`Sink: Restored snapshot ${snapshotId} (${restored} files)`);
    return restored;
  }

  async getSnapshotDetails(snapshotId: string): Promise<SnapshotMetaDoc | null> {
    const snapshot = await this.localDB.getSnapshotDoc(snapshotId);
    if (!snapshot) return null;

    return {
      _id: snapshot._id,
      _rev: snapshot._rev,
      type: snapshot.type,
      metaType: snapshot.metaType,
      createdAt: snapshot.createdAt,
      reason: snapshot.reason,
      sourceDevice: snapshot.sourceDevice,
      files: snapshot.files,
    };
  }

  async removeDevice(deviceId: string): Promise<void> {
    if (deviceId === this.settings.deviceId) {
      throw new Error("Cannot remove the current device");
    }

    const doc = await this.localDB.getDeviceDoc(deviceId);
    if (!doc) return;
    await this.localDB.removeStoredDoc(doc);
  }

  async refreshKnownDevices(): Promise<KnownDevice[]> {
    if (this.replicator) {
      await this.replicator.pullOnce();
    }
    await this.upsertDeviceRecord();
    return this.getKnownDevices();
  }

  async getKnownDevices(): Promise<KnownDevice[]> {
    const docs = await this.localDB.getAllDeviceDocs();
    const now = Date.now();

    return docs
      .map((doc) => ({
        deviceId: doc.deviceId,
        deviceName: doc.deviceName,
        pluginVersion: doc.pluginVersion,
        role: doc.role,
        vaultName: doc.vaultName,
        lastSeen: doc.lastSeen,
        lastPushAt: doc.lastPushAt,
        lastPullAt: doc.lastPullAt,
        isActive: now - doc.lastSeen <= SyncEngine.ACTIVE_DEVICE_WINDOW_MS,
        isCurrentDevice: doc.deviceId === this.settings.deviceId,
      }))
      .sort((left, right) => {
        if (left.role !== right.role) {
          return left.role === "primary" ? -1 : 1;
        }
        if (left.isCurrentDevice !== right.isCurrentDevice) {
          return left.isCurrentDevice ? -1 : 1;
        }
        return right.lastSeen - left.lastSeen;
      });
  }

  async setDeviceRole(deviceId: string, role: DeviceRole): Promise<void> {
    const existing = await this.localDB.getDeviceDoc(deviceId);
    const now = Date.now();
    const doc: DeviceMetaDoc = {
      _id: this.localDB.deviceMetaId(deviceId),
      _rev: existing?._rev,
      type: "meta",
      metaType: "device",
      deviceId,
      deviceName: existing?.deviceName ?? (deviceId === this.settings.deviceId ? this.settings.deviceName : deviceId),
      pluginVersion: existing?.pluginVersion ?? (deviceId === this.settings.deviceId ? this.pluginVersion : undefined),
      role,
      vaultName: existing?.vaultName ?? this.vaultName,
      lastSeen: existing?.lastSeen ?? now,
      lastPushAt: existing?.lastPushAt,
      lastPullAt: existing?.lastPullAt,
    };

    await this.localDB.put(doc);
    if (deviceId === this.settings.deviceId) {
      this.secondaryPushApproved = role === "primary";
    }
  }

  /** Update settings reference */
  updateSettings(settings: SinkSettings): void {
    this.settings = settings;
    this.remoteDB.updateSettings(settings);
    if (settings.passphrase) {
      this.crypto = new CryptoHelper(settings.passphrase);
    } else {
      this.crypto = null;
    }
    this.configureSnapshotCrypto();

    if (!this.stopped) void this.upsertDeviceRecord().catch((error) => this.reportError("Device update failed", error));
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.stopped) void this.upsertDeviceRecord().catch((error) => this.reportError("Heartbeat failed", error));
    }, SyncEngine.DEVICE_HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async getCurrentDeviceRole(): Promise<DeviceRole> {
    const doc = await this.localDB.getDeviceDoc(this.settings.deviceId);
    return doc?.role ?? "primary";
  }

  private async ensurePushAllowed(action: string): Promise<boolean> {
    if (this.stopped) return false;
    const versionAllowed = await this.ensureVersionCompatible(action);
    if (!versionAllowed) {
      return false;
    }

    if (this.sessionMergeAllowed) {
      return true;
    }

    const role = await this.getCurrentDeviceRole();
    if (role === "primary") {
      this.secondaryPushApproved = true;
      return true;
    }

    if (this.secondaryPushApproved) {
      return true;
    }

    if (!this.approvalPromise) {
      this.approvalPromise = this.showApprovalModal(action)
        .then((approved) => {
          this.secondaryPushApproved = approved;
          if (!approved) {
            this.handler({
              type: "error",
              message: `Upload cancelled: ${this.settings.deviceName || "device"} is secondary and was not approved to ${action}.`,
            });
          }
          return approved;
        })
        .finally(() => {
          this.approvalPromise = null;
        });
    }

    return this.approvalPromise;
  }

  private async showApprovalModal(action: string): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const modal = new Modal(this.app);
      this.approvalModal = modal;
      modal.onOpen = () => {
        const { contentEl } = modal;
        contentEl.empty();
        const titleId = "sink-approval-title";
        modal.modalEl?.setAttribute("role", "dialog");
        modal.modalEl?.setAttribute("aria-labelledby", titleId);
        contentEl.createEl("h2", { text: "Confirm uploads from this device", attr: { id: titleId } });
        contentEl.createEl("p", {
          text: `${this.settings.deviceName || "This device"} is marked secondary. Approval permits publishing this device's chosen versions to the database and other devices for this engine session. It does not combine text or skip conflict and deletion reviews. Deny changes nothing.`,
        });
        contentEl.createEl("p", { text: `Requested action: ${action}.`, cls: "setting-item-description" });

        const actions = contentEl.createDiv({ cls: "sink-device-row-actions" });
        const approveButton = actions.createEl("button", { text: "Allow for this session", cls: "mod-cta" });
        const cancelButton = actions.createEl("button", { text: "Cancel" });

        approveButton.addEventListener("click", () => {
          resolve(true);
          modal.close();
        });

        cancelButton.addEventListener("click", () => {
          resolve(false);
          modal.close();
        });
      };

      modal.onClose = () => {
        this.approvalModal = null;
        modal.contentEl.empty();
        resolve(false);
      };

      modal.open();
    });
  }

  private async prepareIncomingChanges(docs: SinkDoc[]): Promise<PreparedChange[]> {
    const prepared: PreparedChange[] = [];

    for (const doc of docs) {
      if (this.stopped) break;
      if (!doc.type || doc.type !== "file") continue;
      if (!doc.path || !this.isPathAllowed(doc.path)) continue;

      try {
        if (!doc.deleted) assertFileSize(doc.size, doc.path);
        if (typeof doc.content !== "string" || doc.content.length > MAX_CONTENT_LENGTH * 2) {
          throw new Error(`Invalid or oversized incoming content: ${doc.path}`);
        }
        const conflictBranches = (doc as SinkDoc & { _conflicts?: string[] })._conflicts;
        const hasUnresolvedConflicts = Array.isArray(conflictBranches) && conflictBranches.length > 0;
        if (!hasUnresolvedConflicts && doc.deviceId && doc.deviceId === this.settings.deviceId) continue;
        if (!hasUnresolvedConflicts && !doc.deviceId && doc.deviceName === this.settings.deviceName) continue;
        if (hasUnresolvedConflicts && !this.reportedConflictPaths.has(doc.path)) {
          this.reportedConflictPaths.add(doc.path);
          this.handler({
            type: "error",
            message: `${doc.path}: ${SyncEngine.CONFLICT_REVIEW_MESSAGE}`,
          });
        }
        const isBinary = this.isBinaryPath(doc.path);
        const conflictMetadata = hasUnresolvedConflicts
          ? await this.buildConflictMetadata(doc._id, doc, conflictBranches ?? [], isBinary)
          : null;
        const remoteEncrypted = !!doc.iv;
        if (remoteEncrypted && !this.crypto) throw new Error(`Encrypted file requires a passphrase: ${doc.path}`);
        let remoteDoc = doc;
        if (this.crypto && remoteEncrypted) {
          remoteDoc = await this.decryptDoc(doc);
        }
        if (!remoteDoc.deleted && !isBinary) {
          const decryptChunk = this.crypto && remoteEncrypted
            ? (data: string, iv: string) => this.crypto!.decrypt(data, iv)
            : undefined;
          // Keep the encryption flag for apply; decrypted parent IV is intentionally removed.
          remoteDoc = { ...remoteDoc, content: await this.serializer.readDocContent(remoteDoc, decryptChunk), chunks: undefined };
        }

        const local = await this.readLocalFileState(doc.path);
        if (!hasUnresolvedConflicts && !doc.deleted && local.exists && !local.isBinary && local.content === remoteDoc.content) continue;
        if (!hasUnresolvedConflicts && doc.deleted && !local.exists) continue;

        const lastApplied = this.readLastAppliedFingerprint(doc.path);
        const localFingerprint = local.isBinary ? null : await this.contentFingerprint(local.content);
        const safeFastForward = !hasUnresolvedConflicts
          && !isBinary
          && local.exists
          && !remoteDoc.deleted
          && !!lastApplied
          && lastApplied === localFingerprint
          && local.content !== remoteDoc.content;
        const suggested = hasUnresolvedConflicts
          ? (local.exists ? "keep-local" : "keep-remote")
          : safeFastForward
            ? "keep-remote"
            : this.suggestDecision(local, remoteDoc);
        const remoteContent = isBinary ? "" : (remoteDoc.deleted ? "" : remoteDoc.content);

        prepared.push({
          path: remoteDoc.path,
          sourceDevice: remoteDoc.deviceName ?? "unknown",
          sourceDeviceId: remoteDoc.deviceId,
          remoteMtime: remoteDoc.mtime,
          localMtime: local.mtime,
          remoteDeleted: !!remoteDoc.deleted,
          remoteExists: true,
          localExists: local.exists,
          localContent: local.isBinary ? "" : local.content,
          remoteContent,
          isBinary,
          suggested,
          remoteDoc,
          remoteEncrypted,
          safeFastForward,
          hasUnresolvedConflicts,
          conflictRevisions: conflictMetadata?.revisions,
          conflictRevision: conflictMetadata?.selectedRevision,
          loadConflictPreview: conflictMetadata
            ? async (rev: string) => await this.loadConflictLeafPreview(doc._id, doc.path, isBinary, rev)
            : undefined,
          hasDeferredReview: this.hasDeferredReviewMarker(remoteDoc.path),
          // The UI loads previews only for the rows it actually displays.
          loadPreview: async () => {
            const current = await this.readLocalFileState(doc.path);
            return {
              localContent: current.isBinary ? "" : current.content,
              remoteContent,
            };
          },
        });
      } catch (error: any) {
        if (error?.status === 404) this.deferredIncoming.add(doc._id);
        else this.reportError(`Prepare failed for ${doc.path}`, error);
      }
    }

    const latestByPath = new Map<string, PreparedChange>();
    for (const change of prepared) {
      const existing = latestByPath.get(change.path);
      if (!existing || change.remoteMtime >= existing.remoteMtime) {
        latestByPath.set(change.path, change);
      }
    }

    return Array.from(latestByPath.values()).sort((left, right) => left.path.localeCompare(right.path));
  }

  private conflictSet(doc: unknown): string[] {
    const branches = (doc as { _conflicts?: unknown })._conflicts;
    if (!Array.isArray(branches)) return [];
    return Array.from(new Set(branches.filter((value): value is string => typeof value === "string"))).sort();
  }

  private async loadAllLeafDocs(id: string): Promise<SinkDoc[]> {
    const response = await this.localDB.instance.get(id, {
      open_revs: "all",
      include_docs: true,
    } as unknown as PouchDB.Core.GetOptions) as unknown as Array<{ ok?: SinkDoc; missing?: string }>;
    if (!Array.isArray(response)) throw new Error("Unable to enumerate retained database revisions");
    return response
      .map((entry) => entry?.ok)
      .filter((leaf): leaf is SinkDoc => !!leaf && typeof leaf._rev === "string");
  }

  private conflictRevisionFromDoc(doc: SinkDoc, isBinary: boolean): ConflictRevision | null {
    if (!doc._rev) return null;
    return {
      rev: doc._rev,
      mtime: doc.mtime,
      deleted: !!doc.deleted,
      isBinary,
      size: doc.size,
      deviceName: doc.deviceName,
      deviceId: doc.deviceId,
    };
  }

  /** Keep only revision metadata, with the current winner first and losers sorted by revision. */
  private async buildConflictMetadata(
    id: string,
    winner: SinkDoc,
    conflictBranches: string[],
    isBinary: boolean
  ): Promise<{ revisions: ConflictRevision[]; selectedRevision?: string }> {
    const winnerRev = winner._rev;
    let leaves: SinkDoc[];
    try {
      leaves = await this.loadAllLeafDocs(id);
    } catch (error) {
      if (winnerRev) throw error;
      leaves = [winner];
    }

    if (leaves.length === 0 && winnerRev) {
      leaves = [winner];
    }

    // The current winner and the explicitly retained conflicts are the reviewable
    // leaves. Older deleted tombstones reported by open_revs are not conflicts.
    const reviewable = winnerRev
      ? new Set<string>([winnerRev, ...conflictBranches])
      : null;
    const byRev = new Map<string, SinkDoc>();
    for (const leaf of leaves) {
      if (!leaf._rev) continue;
      if (reviewable && !reviewable.has(leaf._rev)) continue;
      byRev.set(leaf._rev, leaf);
    }
    if (winnerRev) {
      for (const rev of Array.from(new Set(conflictBranches)).sort()) {
        if (byRev.has(rev)) continue;
        const leaf = await this.loadPinnedIncomingDoc(id, rev);
        if (leaf._rev === rev) byRev.set(rev, leaf);
      }
      if (!byRev.has(winnerRev)) byRev.set(winnerRev, winner);
    }

    const ordered = Array.from(byRev.values()).sort((left, right) => {
      if (left._rev === winnerRev) return -1;
      if (right._rev === winnerRev) return 1;
      return (left._rev ?? "").localeCompare(right._rev ?? "");
    });
    const revisions = ordered
      .map((leaf) => this.conflictRevisionFromDoc(leaf, isBinary))
      .filter((revision): revision is ConflictRevision => revision !== null);
    const selectedRevision = revisions.some((revision) => revision.rev === winnerRev)
      ? winnerRev
      : revisions[0]?.rev;
    return { revisions, selectedRevision };
  }

  private async readDecodedDocContent(doc: SinkDoc): Promise<string> {
    const encrypted = !!doc.iv;
    if (encrypted && !this.crypto) throw new Error(`Encrypted file requires a passphrase: ${doc.path}`);
    const decoded = encrypted ? await this.decryptDoc(doc) : doc;
    const decryptChunk = this.crypto && encrypted
      ? (data: string, iv: string) => this.crypto!.decrypt(data, iv)
      : undefined;
    return await this.serializer.readDocContent(decoded, decryptChunk);
  }

  private async loadConflictLeafPreview(
    id: string,
    path: string,
    isBinary: boolean,
    rev: string
  ): Promise<{ localContent: string; remoteContent: string }> {
    const leaf = await this.loadPinnedIncomingDoc(id, rev);
    if (leaf._rev !== rev) throw new Error("The selected database revision is no longer available");
    const current = await this.readLocalFileState(path);
    let remoteContent = "";
    if (!leaf.deleted && !isBinary) remoteContent = await this.readDecodedDocContent(leaf);
    return {
      localContent: current.isBinary ? "" : current.content,
      remoteContent,
    };
  }

  private sameConflictSet(expected: string[] | undefined, actual: string[]): boolean {
    const normalized = Array.from(new Set(expected ?? [])).sort();
    if (normalized.length !== actual.length) return false;
    return normalized.every((value, index) => value === actual[index]);
  }

  private async decodeIncomingDocForComparison(doc: SinkDoc, isBinary: boolean): Promise<SinkDoc> {
    const remoteEncrypted = !!doc.iv;
    if (remoteEncrypted && !this.crypto) throw new Error(`Encrypted file requires a passphrase: ${doc.path}`);
    let decoded = doc;
    if (this.crypto && remoteEncrypted) {
      decoded = await this.decryptDoc(doc);
    }
    if (!decoded.deleted && !isBinary) {
      const decryptChunk = this.crypto && remoteEncrypted
        ? (data: string, iv: string) => this.crypto!.decrypt(data, iv)
        : undefined;
      decoded = { ...decoded, content: await this.serializer.readDocContent(decoded, decryptChunk), chunks: undefined };
    }
    return decoded;
  }

  private async loadPinnedIncomingDoc(id: string, rev?: string): Promise<SinkDoc> {
    const options: PouchDB.Core.GetOptions = { conflicts: true };
    if (rev !== undefined) options.rev = rev;
    return await this.localDB.instance.get(id, options) as SinkDoc & { _conflicts?: string[] };
  }

  private async prepareLightCandidates(
    docs: SinkDoc[],
    options: { includeSameSource?: boolean; startup?: boolean } = {}
  ): Promise<PreparedChange[]> {
    const prepared: PreparedChange[] = [];

    for (const doc of docs) {
      if (this.stopped) break;
      if (!doc.type || doc.type !== "file") continue;
      if (!doc.path || !this.isPathAllowed(doc.path)) continue;

      const conflictBranches = (doc as SinkDoc & { _conflicts?: string[] })._conflicts;
      const hasUnresolvedConflicts = Array.isArray(conflictBranches) && conflictBranches.length > 0;
      const sameSource = (!!doc.deviceId && doc.deviceId === this.settings.deviceId)
        || (!doc.deviceId && doc.deviceName === this.settings.deviceName);
      if (sameSource && !hasUnresolvedConflicts && !options.includeSameSource) continue;

      try {
        if (!doc.deleted) assertFileSize(doc.size, doc.path);
        if (typeof doc.content !== "string" || doc.content.length > MAX_CONTENT_LENGTH * 2) {
          throw new Error(`Invalid or oversized incoming content: ${doc.path}`);
        }
        if (hasUnresolvedConflicts && !this.reportedConflictPaths.has(doc.path)) {
          this.reportedConflictPaths.add(doc.path);
          this.handler({
            type: "error",
            message: `${doc.path}: ${SyncEngine.CONFLICT_REVIEW_MESSAGE}`,
          });
        }

        const isBinary = this.isBinaryPath(doc.path);
        const conflictMetadata = hasUnresolvedConflicts
          ? await this.buildConflictMetadata(doc._id, doc, conflictBranches ?? [], isBinary)
          : null;
        const decoded = await this.decodeIncomingDocForComparison(doc, isBinary);
        const local = await this.readLocalFileState(doc.path);
        if (!hasUnresolvedConflicts && !doc.deleted && local.exists && !local.isBinary && local.content === decoded.content) continue;
        if (!hasUnresolvedConflicts && doc.deleted && !local.exists) continue;

        const localFingerprint = local.exists && !local.isBinary ? await this.contentFingerprint(local.content) : null;
        const remoteFingerprint = doc.deleted ? "" : await this.contentFingerprint(decoded.content);
        const lastApplied = this.readLastAppliedFingerprint(doc.path);
        const safeFastForward = !hasUnresolvedConflicts
          && !isBinary
          && local.exists
          && !decoded.deleted
          && !!lastApplied
          && lastApplied === localFingerprint
          && local.content !== decoded.content;
        let suggested: ChangeDecision;
        let requiresReview = false;
        let safeLocalPush = false;
        if (hasUnresolvedConflicts) {
          suggested = local.exists ? "keep-local" : "keep-remote";
          requiresReview = true;
        } else if (options.startup) {
          if (safeFastForward) {
            suggested = "keep-remote";
          } else if (!local.exists) {
            if (!lastApplied) {
              // No adoption history: this is a remote-only file, not proof that the
              // local file was deleted while Sink was stopped. Apply the server copy.
              suggested = "keep-remote";
              requiresReview = false;
            } else {
              // An offline deletion is safe only when the applied fingerprint proves
              // this device last had the remote winner. Otherwise review is forced.
              suggested = "keep-local";
              safeLocalPush = lastApplied === remoteFingerprint;
              requiresReview = true;
            }
          } else if (decoded.deleted) {
            suggested = "keep-local";
            requiresReview = true;
          } else if (!!lastApplied && lastApplied === remoteFingerprint) {
            // The device last applied the remote winner and then edited offline.
            suggested = "keep-local";
            safeLocalPush = true;
            requiresReview = true;
          } else {
            // Both sides differ from the last applied fingerprint, or the history is
            // missing. Never guess which side is the user's intended winner.
            suggested = "keep-local";
            requiresReview = true;
          }
        } else {
          suggested = safeFastForward
            ? "keep-remote"
            : this.suggestDecision(local, decoded);
        }

        const docId = doc._id;
        const pinnedRev = doc._rev;
        const pinnedConflicts = this.conflictSet(doc);
        const path = doc.path;

        // Keep only metadata here. The closure intentionally captures no body.
        prepared.push({
          path,
          sourceDevice: doc.deviceName ?? "unknown",
          sourceDeviceId: doc.deviceId,
          remoteMtime: doc.mtime,
          localMtime: local.mtime,
          remoteDeleted: !!doc.deleted,
          remoteExists: true,
          localExists: local.exists,
          isBinary,
          suggested,
          remoteDoc: {
            _id: docId,
            _rev: pinnedRev,
            path,
            content: "",
            mtime: doc.mtime,
            ctime: doc.ctime,
            size: doc.size,
            deleted: doc.deleted,
            deviceName: doc.deviceName,
            deviceId: doc.deviceId,
            type: "file",
          },
          remoteEncrypted: !!doc.iv,
          safeFastForward,
          hasUnresolvedConflicts,
          conflictRevisions: conflictMetadata?.revisions,
          conflictRevision: conflictMetadata?.selectedRevision,
          loadConflictPreview: conflictMetadata
            ? async (rev: string) => await this.loadConflictLeafPreview(docId, path, isBinary, rev)
            : undefined,
          hasDeferredReview: this.hasDeferredReviewMarker(path),
          needsHydration: true,
          pinnedRev,
          pinnedConflicts,
          localFingerprint,
          remoteFingerprint,
          requiresReview,
          safeLocalPush,
          loadPreview: async () => {
            const pinned = await this.loadPinnedIncomingDoc(docId, pinnedRev);
            const remote = await this.decodeIncomingDocForComparison(pinned, isBinary);
            const current = await this.readLocalFileState(path);
            return {
              localContent: current.isBinary ? "" : current.content,
              remoteContent: isBinary || remote.deleted ? "" : remote.content,
            };
          },
        });
      } catch (error: any) {
        if (error?.status === 404) this.deferredIncoming.add(doc._id);
        else this.reportError(`Prepare failed for ${doc.path}`, error);
      }
    }

    const latestByPath = new Map<string, PreparedChange>();
    for (const change of prepared) {
      const existing = latestByPath.get(change.path);
      if (!existing || change.remoteMtime >= existing.remoteMtime) {
        latestByPath.set(change.path, change);
      }
    }

    return Array.from(latestByPath.values()).sort((left, right) => left.path.localeCompare(right.path));
  }

  private async hydratePreparedChange(change: PreparedChange): Promise<PreparedChange> {
    if (!change.needsHydration) return change;

    const doc = await this.localDB.instance.get(change.remoteDoc._id, { conflicts: true } as PouchDB.Core.GetOptions) as SinkDoc & { _conflicts?: string[] };
    const expectedRev = change.pinnedRev ?? change.remoteDoc._rev;
    if (expectedRev !== undefined && doc._rev !== expectedRev) {
      throw new Error("Remote revision changed during review");
    }
    const freshConflicts = this.conflictSet(doc);
    if (!this.sameConflictSet(change.pinnedConflicts, freshConflicts)) {
      throw new Error("Remote conflict branches changed during review");
    }
    if (!doc.deleted) assertFileSize(doc.size, doc.path);
    if (typeof doc.content !== "string" || doc.content.length > MAX_CONTENT_LENGTH * 2) {
      throw new Error(`Invalid or oversized incoming content: ${doc.path}`);
    }

    const decoded = await this.decodeIncomingDocForComparison(doc, change.isBinary);
    if (change.remoteFingerprint !== undefined) {
      const fingerprint = doc.deleted ? "" : await this.contentFingerprint(decoded.content);
      if (fingerprint !== change.remoteFingerprint) {
        throw new Error("Remote content changed during review");
      }
    }
    const local = await this.readLocalFileState(change.path);

    return {
      ...change,
      remoteDoc: decoded,
      remoteEncrypted: !!doc.iv,
      localMtime: local.mtime,
      localExists: local.exists,
      localContent: local.isBinary ? "" : local.content,
      remoteContent: change.isBinary ? "" : (decoded.deleted ? "" : decoded.content),
      needsHydration: false,
    };
  }

  private suggestDecision(local: LocalFileState, remote: SinkDoc): ChangeDecision {
    if (!local.exists) return "keep-remote";
    if (remote.deleted) return "keep-local";
    if (local.isBinary || this.isBinaryPath(remote.path)) {
      return (local.mtime ?? 0) > remote.mtime ? "keep-local" : "keep-remote";
    }
    if (local.content === remote.content) return "keep-remote";
    if ((local.mtime ?? 0) > remote.mtime) return "keep-local";
    return "keep-remote";
  }

  private isDivergentChange(change: PreparedChange): boolean {
    if (change.safeLocalPush) return false;
    if (!change.localExists || change.remoteDeleted || change.safeFastForward) return false;
    if (change.isBinary) return (change.localMtime ?? 0) !== change.remoteMtime;
    if (change.localContent !== undefined || change.remoteContent !== undefined) {
      return (change.localContent ?? "") !== (change.remoteContent ?? "");
    }
    if (change.localFingerprint != null && change.remoteFingerprint !== undefined) {
      return change.localFingerprint !== change.remoteFingerprint;
    }
    return (change.localMtime ?? 0) !== change.remoteMtime;
  }

  private async applyIncomingChangesWithReview(
    changes: PreparedChange[],
    title: string,
    onApplied?: () => void
  ): Promise<number> {
    if (this.stopped || changes.length === 0) return 0;

    this.lastApplyIncomplete = false;
    this.reviewCancelled = false;

    if (!(await this.ensureVersionCompatible("apply incoming changes"))) {
      this.lastApplyIncomplete = true;
      this.finishReviewStatus();
      return 0;
    }

    const needsReview = await this.shouldReviewBatch(changes);
    if (this.stopped) return 0;

    let review: ReviewResult;
    if (needsReview) {
      this.reviewStatusActive = true;
      this.status = "paused";
      this.handler({ type: "status-change", status: "paused" });
      try {
        review = await this.reviewBatch(title, changes);
      } finally {
        this.reviewStatusActive = false;
      }
    } else {
      review = this.acceptAll(changes);
    }

    if (this.stopped || !review.approved) {
      this.lastApplyIncomplete = true;
      this.reviewCancelled = true;
      for (const change of changes) {
        this.heldIncoming.set(change.remoteDoc._id, change.pinnedRev ?? change.remoteDoc._rev ?? "");
        this.saveDeferredReviewMarker(change);
      }
      this.finishReviewStatus();
      return 0;
    }

    const decisionByPath = new Map(review.decisions.map((decision) => [decision.path, decision]));
    for (const change of changes) {
      const decision = decisionByPath.get(change.path);
      if (!decision?.selected || decision.decision === "skip") {
        this.lastApplyIncomplete = true;
        this.saveDeferredReviewMarker(change);
      }
    }

    const selected: PreparedChange[] = [];
    for (const change of changes) {
      const selectedDecision = decisionByPath.get(change.path);
      if (!selectedDecision?.selected || selectedDecision.decision === "skip") continue;
      if (await this.isChangeStillCurrent(change)) {
        selected.push(change);
      } else {
        this.lastApplyIncomplete = true;
        this.handler({ type: "error", message: `Skipped ${change.path}: local or remote content changed during sync review; pull again to review it.` });
      }
    }

    if (selected.length === 0) {
      this.lastApplyIncomplete = true;
      this.finishReviewStatus();
      return 0;
    }

    const willPublish = selected.some((change) => {
      const decision = decisionByPath.get(change.path)?.decision ?? change.suggested;
      return change.hasUnresolvedConflicts || decision === "keep-local" || decision === "merge";
    });
    if (willPublish && !(await this.ensurePushAllowed(`publish ${selected.length} selected file${selected.length === 1 ? "" : "s"}`))) {
      // Permission is checked before any snapshot or vault mutation. Denial changes nothing.
      this.lastApplyIncomplete = true;
      this.reviewCancelled = true;
      for (const change of changes) {
        this.heldIncoming.set(change.remoteDoc._id, change.pinnedRev ?? change.remoteDoc._rev ?? "");
        this.saveDeferredReviewMarker(change);
      }
      this.finishReviewStatus();
      return 0;
    }

    if (this.stopped) return 0;
    const shouldSnapshot = needsReview || selected.length > 1 || selected.some((change) => change.remoteDeleted);
    if (shouldSnapshot) {
      // Preflight and save every backup before applying any decision. The user sees
      // one review, while each backup respects the existing memory budget.
      try {
        const groups: PreparedChange[][] = [];
        let group: PreparedChange[] = [];
        let bytes = 0;
        for (const change of selected) {
          const file = this.vault.getAbstractFileByPath(change.path);
          const estimate = file instanceof TFile ? file.stat.size * 3 : 0;
          if (estimate > MAX_SNAPSHOT_BYTES) {
            throw new Error(`Cannot safely back up ${change.path}: exceeds the snapshot budget; no selected changes were applied`);
          }
          if (group.length > 0 && bytes + estimate > MAX_SNAPSHOT_BYTES) {
            groups.push(group);
            group = [];
            bytes = 0;
          }
          group.push(change);
          bytes += estimate;
        }
        if (group.length > 0) groups.push(group);
        for (let index = 0; index < groups.length; index++) {
          if (this.stopped) throw new Error("Sync stopped before backups completed");
          await this.createSnapshot(
            `${title} (${selected.length} files; backup ${index + 1}/${groups.length})`,
            groups[index].map((change) => change.path),
            groups[index][0].sourceDevice
          );
        }
      } catch (error) {
        this.lastApplyIncomplete = true;
        this.remoteHeadState = "behind";
        for (const change of selected) this.saveDeferredReviewMarker(change);
        this.finishReviewStatus();
        throw error;
      }
    }

    let applied = 0;
    for (const selectedChange of selected) {
      if (this.stopped) {
        this.lastApplyIncomplete = true;
        break;
      }
      let change = selectedChange;
      const decisionEntry = decisionByPath.get(change.path);
      if (change.hasUnresolvedConflicts) {
        if (!this.isPathAllowed(change.path) || !(await this.isChangeStillCurrent(change))) {
          this.lastApplyIncomplete = true;
          this.handler({ type: "error", message: `Skipped ${change.path}: local or remote content changed before the conflict could be resolved.` });
          continue;
        }
        try {
          const didApply = await this.resolveConflictChange(change, decisionEntry);
          if (didApply) {
            applied += 1;
            this.heldIncoming.delete(change.remoteDoc._id);
            this.clearDeferredReviewMarker(change.path);
            this.reportedConflictPaths.delete(change.path);
            onApplied?.();
          } else {
            this.lastApplyIncomplete = true;
            this.saveDeferredReviewMarker(change);
          }
        } catch (e: any) {
          this.lastApplyIncomplete = true;
          this.saveDeferredReviewMarker(change);
          this.handler({ type: "error", message: `Conflict resolution failed for ${change.path}: ${e.message}. Sink remains behind and no resolution was recorded.` });
        }
        continue;
      }
      if (change.needsHydration) {
        try {
          change = await this.hydratePreparedChange(change);
        } catch (e: any) {
          this.lastApplyIncomplete = true;
          this.handler({ type: "error", message: `Skipped ${change.path}: ${e.message}` });
          continue;
        }
      }
      if (!this.isPathAllowed(change.path) || !(await this.isChangeStillCurrent(change))) {
        this.lastApplyIncomplete = true;
        this.handler({ type: "error", message: `Skipped ${change.path}: local or remote content changed before it could be applied.` });
        continue;
      }
      const decision = decisionEntry?.decision ?? change.suggested;
      try {
        let didApply = false;
        switch (decision) {
          case "keep-remote":
            didApply = await this.applyRemoteChange(change);
            break;
          case "keep-local":
            didApply = await this.applyKeepLocal(change);
            break;
          case "merge":
            didApply = await this.applyMerge(change);
            break;
          case "skip":
            continue;
        }
        if (didApply) {
          applied += 1;
          this.heldIncoming.delete(change.remoteDoc._id);
          this.clearDeferredReviewMarker(change.path);
          onApplied?.();
        } else {
          this.lastApplyIncomplete = true;
          this.saveDeferredReviewMarker(change);
        }
      } catch (e: any) {
        this.lastApplyIncomplete = true;
        this.handler({ type: "error", message: `Apply failed for ${change.path}: ${e.message}` });
      }
    }

    if (applied < selected.length) this.lastApplyIncomplete = true;
    this.finishReviewStatus();
    return applied;
  }

  private async isChangeStillCurrent(change: PreparedChange): Promise<boolean> {
    if (this.stopped || !this.isPathAllowed(change.path)) return false;
    if (change.remoteExists === false) {
      // A local-only publication is only valid while the database still has no
      // document for this path.
      const existing = await this.localDB.getByPath(change.path);
      if (existing) return false;
    }
    const current = this.vault.getAbstractFileByPath(change.path);
    if (change.localExists) {
      if (!(current instanceof TFile)) return false;
      if (change.localMtime !== undefined && current.stat.mtime !== change.localMtime) return false;
      if (!change.isBinary) {
        const needsContent = change.localFingerprint != null || change.localContent !== undefined;
        if (needsContent) {
          const content = await this.vault.read(current);
          if (change.localFingerprint != null && await this.contentFingerprint(content) !== change.localFingerprint) return false;
          if (change.localContent !== undefined && content !== change.localContent) return false;
        }
      }
    } else if (current) {
      return false;
    }

    const expectedRev = change.pinnedRev ?? change.remoteDoc._rev;
    const expectedConflicts = change.pinnedConflicts
      ?? this.conflictSet(change.remoteDoc as SinkDoc & { _conflicts?: string[] });
    if (expectedRev !== undefined || expectedConflicts.length > 0) {
      try {
        const fresh = await this.localDB.instance.get(change.remoteDoc._id, { conflicts: true } as PouchDB.Core.GetOptions) as SinkDoc & { _rev?: string; _conflicts?: string[] };
        if (expectedRev !== undefined && fresh._rev !== expectedRev) return false;
        if (!this.sameConflictSet(expectedConflicts, this.conflictSet(fresh))) return false;
      } catch (error: any) {
        if (error?.status !== 404) throw error;
        return false;
      }
    }
    return true;
  }

  private async shouldReviewBatch(changes: PreparedChange[]): Promise<boolean> {
    // Startup reconciliation and explicit startup classifications force review
    // before any publication, deletion, or uncertain divergence.
    if (changes.some((change) => change.requiresReview)) return true;
    // Session permission never bypasses deletions, retained branches, or divergent edits.
    if (changes.some((change) => change.remoteDeleted || change.hasUnresolvedConflicts || change.hasDeferredReview)) return true;
    if (changes.some((change) => this.isDivergentChange(change))) return true;
    if (!this.settings.autoResolveConflicts && changes.some((change) => change.localExists)) return true;
    if (this.sessionMergeAllowed) return false;

    const activeDevices = await this.getKnownDevices();
    const activeCount = activeDevices.filter((device) => device.isActive).length;

    if (changes.length <= 2 && activeCount >= 2) {
      return false;
    }

    if (changes.length >= SyncEngine.RISKY_CHANGE_COUNT) return true;

    const deviceDoc = await this.localDB.getDeviceDoc(this.settings.deviceId);
    const lastPullAt = deviceDoc?.lastPullAt ?? 0;
    if (!lastPullAt) return true;

    return Date.now() - lastPullAt > SyncEngine.STALE_PULL_WINDOW_MS;
  }

  private acceptAll(changes: PreparedChange[]): ReviewResult {
    return {
      approved: true,
      decisions: changes.map((change) => ({
        path: change.path,
        selected: true,
        decision: change.suggested,
        conflictRevision: change.conflictRevision,
      })),
    };
  }

  private async reviewBatch(title: string, changes: PreparedChange[]): Promise<ReviewResult> {
    if (!this.reviewPromise) {
      this.reviewPromise = new Promise<ReviewResult>((resolve) => {
        this.reviewModal = new BatchReviewModal(this.app, title, changes, resolve);
        this.reviewModal.open();
      })
        .finally(() => {
          this.reviewPromise = null;
          this.reviewModal = null;
        });
    }

    return await this.reviewPromise;
  }

  private finishReviewStatus(): void {
    if (this.stopped) return;
    const status: SyncStatus = this.lastApplyIncomplete ? "paused" : "connected";
    this.status = status;
    this.handler({ type: "status-change", status });
  }

  private configureSnapshotCrypto(): void {
    this.localDB.configureSnapshotCrypto(this.crypto);
  }

  private appliedFingerprintKey(path: string): string {
    return `sink:${this.vaultName}:applied:${path}`;
  }

  private deferredReviewKey(path: string): string {
    return `sink:${this.vaultName}:deferred-review:${path}`;
  }

  private readDeferredReviewMarker(path: string): string | null {
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        const raw = window.localStorage.getItem(this.deferredReviewKey(path));
        if (raw) return raw;
      }
    } catch {
      // Fall through to the in-memory copy.
    }
    return this.deferredReviewMarkers.get(path) ?? null;
  }

  private hasDeferredReviewMarker(path: string): boolean {
    return this.readDeferredReviewMarker(path) !== null;
  }

  private saveDeferredReviewMarker(change: PreparedChange): void {
    const marker = JSON.stringify({
      rev: change.pinnedRev ?? change.remoteDoc._rev,
      fingerprint: change.remoteFingerprint,
      at: Date.now(),
    });
    this.deferredReviewMarkers.set(change.path, marker);
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.setItem(this.deferredReviewKey(change.path), marker);
      }
    } catch {
      // In-memory state still forces review for this session.
    }
  }

  private clearDeferredReviewMarker(path: string): void {
    this.deferredReviewMarkers.delete(path);
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.removeItem(this.deferredReviewKey(path));
      }
    } catch {
      // Ignore local storage failures.
    }
  }

  private async contentFingerprint(content: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  private readLastAppliedFingerprint(path: string): string | null {
    const key = this.appliedFingerprintKey(path);
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        const raw = window.localStorage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw) as { signature?: string };
          if (typeof parsed.signature === "string") return parsed.signature;
        }
      }
    } catch {
      // Fall through to the in-memory copy.
    }
    return this.appliedFingerprints.get(path) ?? null;
  }

  private async saveLastAppliedFingerprint(path: string, content: string): Promise<void> {
    const signature = await this.contentFingerprint(content);
    this.appliedFingerprints.set(path, signature);
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.setItem(this.appliedFingerprintKey(path), JSON.stringify({ signature, at: Date.now() }));
      }
    } catch {
      // In-memory state still prevents a stale fast-forward decision in this session.
    }
  }

  private clearLastAppliedFingerprint(path: string): void {
    this.appliedFingerprints.delete(path);
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.removeItem(this.appliedFingerprintKey(path));
      }
    } catch {
      // Ignore local storage failures.
    }
  }

  private async createSnapshot(reason: string, paths: string[], sourceDevice: string): Promise<string> {
    this.configureSnapshotCrypto();
    const uniq = Array.from(new Set(paths));
    const files: SnapshotFileEntry[] = [];
    let bytes = 0;

    for (const path of uniq) {
      if (this.stopped) throw new Error("Sync stopped before snapshot");
      const existing = this.vault.getAbstractFileByPath(path);
      // Account conservatively for UTF-16/base64 strings before allocating them.
      bytes += existing instanceof TFile ? existing.stat.size * 3 : 0;
      if (bytes > MAX_SNAPSHOT_BYTES) throw new Error("Snapshot exceeds 32 MiB safety budget; incoming batch was not applied");
      const local = await this.readLocalFileState(path, true);
      files.push({
        path,
        existed: local.exists,
        isBinary: local.isBinary,
        content: local.content,
        mtime: local.mtime,
        ctime: local.ctime,
      });
    }

    const snapshotId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const snapshot: SnapshotMetaDoc = {
      _id: this.localDB.snapshotMetaId(snapshotId),
      type: "meta",
      metaType: "snapshot",
      createdAt: Date.now(),
      reason,
      sourceDevice,
      files,
    };

    await this.localDB.putSnapshotDoc(snapshot);
    return snapshotId;
  }

  private async applyRemoteChange(change: PreparedChange): Promise<boolean> {
    if (this.stopped || !this.isPathAllowed(change.path)) return false;
    if (change.remoteExists === false) {
      // There is no server document to adopt. Do not delete the local file as a
      // consequence of a metadata-only local publication candidate.
      return true;
    }
    this.processing.set(change.path, Infinity);
    try {
      // Decrypt chunks when the source doc was encrypted before preparation.
      const decryptChunk = this.crypto && change.remoteEncrypted
        ? async (ciphertext: string, iv: string) => {
            return await this.crypto!.decrypt(ciphertext, iv);
          }
        : undefined;
      await this.serializer.docToFile(change.remoteDoc, decryptChunk, () => !this.stopped && this.isPathAllowed(change.path));
      if (change.remoteDoc.deleted) {
        this.clearLastAppliedFingerprint(change.path);
      } else {
        await this.saveLastAppliedFingerprint(change.path, change.remoteDoc.content);
      }
      await this.upsertDeviceRecord({ lastPullAt: Date.now() });
      this.handler({
        type: "doc-pulled",
        path: change.path,
        sourceDevice: change.sourceDevice,
        sourceDeviceId: change.sourceDeviceId,
      });
      return true;
    } finally {
      this.processing.set(change.path, Date.now());
    }
  }

  private async applyKeepLocal(change: PreparedChange): Promise<boolean> {
    const existing = this.vault.getAbstractFileByPath(change.path);
    if (!(existing instanceof TFile)) {
      if (change.remoteExists === false) {
        // Both the local file and the database document are absent: nothing to do.
        return true;
      }
      return await this.pushDeletion(change.path, { pinnedRev: change.pinnedRev ?? change.remoteDoc._rev });
    }

    if (change.remoteExists === false) {
      return await this.pushFile(existing, { expectMissing: true });
    }
    return await this.pushFile(existing, { pinnedRev: change.pinnedRev ?? change.remoteDoc._rev });
  }

  private observedConflictLeafRevisions(change: PreparedChange): string[] {
    const revisions = new Set<string>();
    if (change.pinnedRev) revisions.add(change.pinnedRev);
    if (change.remoteDoc._rev) revisions.add(change.remoteDoc._rev);
    for (const revision of change.conflictRevisions ?? []) revisions.add(revision.rev);
    for (const revision of change.pinnedConflicts ?? []) revisions.add(revision);
    return Array.from(revisions).sort();
  }

  private async publishChosenConflictContent(path: string, chosenDeleted: boolean, pinnedRev: string): Promise<boolean> {
    if (chosenDeleted) return await this.pushDeletion(path, { pinnedRev });
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      throw new Error("The local file needed to publish the chosen conflict version is missing");
    }
    return await this.pushFile(file, { pinnedRev });
  }

  private async winnerMatchesChosen(
    doc: SinkDoc & { _conflicts?: string[] },
    chosenDeleted: boolean,
    expectedContent: string | null
  ): Promise<boolean> {
    if (!!doc.deleted !== chosenDeleted) return false;
    if (chosenDeleted) return true;
    if (expectedContent === null) return false;
    return await this.readDecodedDocContent(doc) === expectedContent;
  }

  /**
   * Publish the explicitly chosen side as a new winning revision, then delete every
   * other enumerated leaf. A final read must show one winner with the chosen content.
   */
  private async retireConflictLeaves(
    change: PreparedChange,
    chosenDeleted: boolean,
    expectedContent: string | null,
    knownLeaves: Set<string>
  ): Promise<boolean> {
    const id = change.remoteDoc._id;
    for (let attempt = 0; attempt < 6; attempt++) {
      const current = await this.loadPinnedIncomingDoc(id);
      const leaves = await this.loadAllLeafDocs(id);
      const currentRev = current._rev;
      if (!currentRev) throw new Error("The retained conflict winner has no revision");
      for (const leaf of leaves) {
        if (leaf._rev && !knownLeaves.has(leaf._rev)) {
          throw new Error("An unreviewed database revision arrived during conflict resolution; nothing further was retired");
        }
      }

      if (!(await this.winnerMatchesChosen(current, chosenDeleted, expectedContent))) {
        if (!(await this.publishChosenConflictContent(change.path, chosenDeleted, currentRev))) {
          throw new Error("The chosen conflict version could not be republished");
        }
        const republished = await this.loadPinnedIncomingDoc(id);
        if (republished._rev) knownLeaves.add(republished._rev);
        continue;
      }

      const conflictRevs = new Set(this.conflictSet(current));
      const removals = leaves
        .filter((leaf) => leaf._rev && leaf._rev !== currentRev)
        .filter((leaf) => !leaf.deleted || conflictRevs.has(leaf._rev!))
        .map((leaf) => leaf._rev!)
        .sort();
      for (const rev of removals) {
        try {
          await this.localDB.instance.remove(id, rev);
        } catch (error: any) {
          if (error?.status !== 404) throw error;
        }
      }

      const verified = await this.loadPinnedIncomingDoc(id);
      const verifiedLeaves = await this.loadAllLeafDocs(id);
      const noConflicts = this.conflictSet(verified).length === 0;
      const liveLeaves = verifiedLeaves.filter((leaf) => !leaf.deleted);
      // Removed losing revisions can remain as deleted tombstone leaves. They do
      // not represent unresolved conflicts and must not block verification.
      const liveLeavesMatch = chosenDeleted
        ? liveLeaves.length === 0
        : liveLeaves.length === 1 && liveLeaves[0]._rev === verified._rev;
      if (noConflicts && liveLeavesMatch && await this.winnerMatchesChosen(verified, chosenDeleted, expectedContent)) {
        return true;
      }
    }
    throw new Error("Retained conflict revisions could not be retired and verified");
  }

  private async resolveConflictChange(change: PreparedChange, decision: ReviewedChange | undefined): Promise<boolean> {
    const chosenDecision = decision?.decision ?? change.suggested;
    if (chosenDecision === "skip") return false;
    if (chosenDecision !== "keep-local" && chosenDecision !== "keep-remote") {
      throw new Error("Merge is unavailable for retained database conflict revisions");
    }

    const id = change.remoteDoc._id;
    const winnerRev = change.pinnedRev ?? change.remoteDoc._rev;
    const selectedRev = decision?.conflictRevision ?? change.conflictRevision ?? winnerRev;
    if (!selectedRev) throw new Error("No database revision was selected");

    const observed = this.observedConflictLeafRevisions(change);
    if (!observed.includes(selectedRev)) {
      throw new Error("The selected revision is not part of the reviewed conflict set");
    }

    const current = await (async () => {
      try {
        return await this.loadPinnedIncomingDoc(id);
      } catch (error: any) {
        if (error?.status === 404) return null;
        throw error;
      }
    })();
    if (!current) return false;
    if (!current._rev) throw new Error("The database conflict winner has no revision");
    const freshConflicts = this.conflictSet(current);
    if (winnerRev && current._rev !== winnerRev) {
      throw new Error("The database conflict winner changed during review");
    }
    if (!this.sameConflictSet(change.pinnedConflicts, freshConflicts)) {
      throw new Error("The database conflict revisions changed during review");
    }
    if (change.conflictRevisions?.length) {
      const expected = change.conflictRevisions.map((revision) => revision.rev).sort();
      const actual = Array.from(new Set([
        ...(current._rev ? [current._rev] : []),
        ...freshConflicts,
      ])).sort();
      if (expected.length !== actual.length || !expected.every((rev, index) => rev === actual[index])) {
        throw new Error("The database conflict leaves changed during review");
      }
    }

    const beforeLeaves = await this.loadAllLeafDocs(id);
    const selectedLeaf = beforeLeaves.find((leaf) => leaf._rev === selectedRev);
    if (!selectedLeaf) {
      throw new Error("The selected database revision is no longer a retained leaf");
    }

    let chosenDeleted = !!selectedLeaf.deleted;
    let expectedContent: string | null = null;
    if (chosenDecision === "keep-local") {
      const local = await this.readLocalFileState(change.path, true);
      // An absent local file means the explicit local choice is a deletion of
      // every remote version, not an error. This matches the local side state.
      chosenDeleted = !local.exists;
      expectedContent = local.exists ? local.content : null;
    } else if (!chosenDeleted) {
      expectedContent = await this.readDecodedDocContent(selectedLeaf);
    }

    if (chosenDecision === "keep-remote") {
      const decryptChunk = this.crypto && selectedLeaf.iv
        ? (data: string, iv: string) => this.crypto!.decrypt(data, iv)
        : undefined;
      this.processing.set(change.path, Infinity);
      try {
        await this.serializer.docToFile(selectedLeaf, decryptChunk, () => !this.stopped && this.isPathAllowed(change.path));
      } finally {
        this.processing.set(change.path, Date.now());
      }
    }

    const knownLeaves = new Set(observed);
    for (const leaf of beforeLeaves) {
      if (leaf._rev && !knownLeaves.has(leaf._rev)) {
        throw new Error("An unreviewed database revision arrived before conflict resolution started; nothing was retired");
      }
    }
    if (!(await this.publishChosenConflictContent(change.path, chosenDeleted, current._rev))) {
      throw new Error("The chosen conflict version could not be published");
    }
    const published = await this.loadPinnedIncomingDoc(id);
    if (published._rev) knownLeaves.add(published._rev);
    if (!(await this.retireConflictLeaves(change, chosenDeleted, expectedContent, knownLeaves))) {
      throw new Error("Retained conflict revisions could not be retired");
    }

    if (chosenDeleted) {
      this.clearLastAppliedFingerprint(change.path);
    } else if (expectedContent !== null) {
      await this.saveLastAppliedFingerprint(change.path, expectedContent);
    }
    if (chosenDecision === "keep-remote") {
      this.handler({
        type: "doc-pulled",
        path: change.path,
        sourceDevice: change.sourceDevice,
        sourceDeviceId: change.sourceDeviceId,
      });
    }
    return true;
  }

  private async applyMerge(change: PreparedChange): Promise<boolean> {
    if (this.stopped || !this.isPathAllowed(change.path)) return false;
    if (!change.localExists) {
      return await this.applyRemoteChange(change);
    }

    // There is no common ancestor identity for this prepared change. Refuse to
    // replace local content with a guessed merge; the review must choose a side.
    this.handler({
      type: "error",
      message: `Cannot merge ${change.path}: no common ancestor is available. Choose Local or Remote in the batch review.`,
    });
    return false;
  }

  private async readLocalFileState(path: string, includeBinaryContent = false): Promise<LocalFileState> {
    const existing = this.vault.getAbstractFileByPath(path);
    const isBinary = this.isBinaryPath(path);
    if (!(existing instanceof TFile)) {
      return {
        exists: false,
        isBinary,
        content: "",
      };
    }

    if (isBinary) {
      return {
        exists: true,
        isBinary,
        content: includeBinaryContent ? arrayBufferToBase64(await this.readBoundedBinary(existing)) : "",
        mtime: existing.stat.mtime,
        ctime: existing.stat.ctime,
      };
    }

    assertFileSize(existing.stat.size, path);
    const content = await this.vault.read(existing);
    return {
      exists: true,
      isBinary,
      content,
      mtime: existing.stat.mtime,
      ctime: existing.stat.ctime,
    };
  }

  private async restoreSnapshotEntry(entry: SnapshotFileEntry): Promise<void> {
    if (this.stopped || !this.isPathAllowed(entry.path)) return;
    const existing = this.vault.getAbstractFileByPath(entry.path);
    if (!entry.existed) {
      if (existing) {
        this.processing.set(entry.path, Infinity);
        try {
          await this.vault.delete(existing);
        } finally {
          this.processing.set(entry.path, Date.now());
        }
      }
      return;
    }

    const doc: SinkDoc = {
      _id: this.localDB.pathToId(entry.path),
      path: entry.path,
      content: entry.content,
      mtime: entry.mtime ?? Date.now(),
      ctime: entry.ctime ?? Date.now(),
      size: entry.content.length,
      type: "file",
    };

    this.processing.set(entry.path, Infinity);
    try {
      await this.serializer.docToFile(doc, undefined, () => !this.stopped && this.isPathAllowed(entry.path));
    } finally {
      this.processing.set(entry.path, Date.now());
    }
  }

  private isBinaryPath(path: string): boolean {
    return /\.(png|jpg|jpeg|gif|bmp|ico|svg|webp|pdf|mp3|mp4|ogg|webm|wav|flac|zip|tar|gz|7z|rar|woff|woff2|ttf|otf|eot|doc|docx|xls|xlsx|ppt|pptx)$/i.test(path);
  }

  private async readBoundedBinary(file: TFile): Promise<ArrayBuffer> {
    assertFileSize(file.stat.size, file.path);
    return this.vault.readBinary(file);
  }

  private async ensureParentDirectory(filePath: string): Promise<void> {
    const parts = filePath.split("/");
    parts.pop();
    if (parts.length === 0) return;
    const dirPath = parts.join("/");
    const existing = this.vault.getAbstractFileByPath(dirPath);
    if (!existing) {
      await this.vault.createFolder(dirPath);
    }
  }

  private async persistChunks(chunkData?: string[], chunkIds?: string[]): Promise<void> {
    if (!chunkData || !chunkIds) return;
    for (let i = 0; i < chunkData.length; i++) {
      if (this.stopped) return;
      const chunkId = chunkIds[i];
      try {
        await this.localDB.get(chunkId);
        continue; // Content-addressed chunks are immutable, including encrypted chunks.
      } catch (error: any) {
        if (error?.status !== 404) throw error;
      }
      const encrypted = this.crypto ? await this.crypto.encrypt(chunkData[i]) : null;
      try {
        await this.localDB.put({ _id: chunkId, type: "chunk", data: encrypted?.ciphertext ?? chunkData[i], ...(encrypted ? { iv: encrypted.iv } : {}) });
      } catch (error: any) {
        if (error?.status !== 409) throw error; // Another replication may have installed this same chunk.
      }
    }
  }

  private async upsertDeviceRecord(overrides: Partial<DeviceMetaDoc> = {}): Promise<void> {
    if (!this.settings.deviceId) return;

    const existing = await this.localDB.getDeviceDoc(this.settings.deviceId);
    const now = Date.now();
    const doc: DeviceMetaDoc = {
      _id: this.localDB.deviceMetaId(this.settings.deviceId),
      _rev: existing?._rev,
      type: "meta",
      metaType: "device",
      deviceId: this.settings.deviceId,
      deviceName: this.settings.deviceName || this.settings.deviceId,
      pluginVersion: this.pluginVersion,
      role: overrides.role ?? existing?.role ?? "primary",
      vaultName: this.vaultName,
      lastSeen: overrides.lastSeen ?? now,
      lastPushAt: overrides.lastPushAt ?? existing?.lastPushAt,
      lastPullAt: overrides.lastPullAt ?? existing?.lastPullAt,
    };

    try {
      await this.localDB.put(doc);
    } catch (error: any) {
      if (error?.status === 409) {
        const retryExisting = await this.localDB.getDeviceDoc(this.settings.deviceId);
        if (retryExisting) {
          doc._rev = retryExisting._rev;
          await this.localDB.put(doc);
          this.saveIdentity(this.settings.deviceId, this.settings.deviceName);
          return;
        }
      }

      throw error;
    }
    this.saveIdentity(this.settings.deviceId, this.settings.deviceName);
  }

  getSyncHeadState(): "head" | "behind" {
    return this.remoteHeadState;
  }

  private identityStorageKey(): string {
    return `sink:${this.vaultName}:identity`;
  }

  private readSavedIdentity(): { deviceId?: string; deviceName?: string } | null {
    try {
      const raw = window.localStorage.getItem(this.identityStorageKey());
      if (!raw) return null;
      return JSON.parse(raw) as { deviceId?: string; deviceName?: string };
    } catch {
      return null;
    }
  }

  private saveIdentity(deviceId: string, deviceName: string): void {
    try {
      window.localStorage.setItem(this.identityStorageKey(), JSON.stringify({ deviceId, deviceName }));
    } catch {
      // Ignore storage failures; settings persistence still keeps the current identity.
    }
  }

  private async ensureVersionCompatible(action: string): Promise<boolean> {
    const role = await this.getCurrentDeviceRole();
    if (role === "primary") {
      return true;
    }

    const devices = await this.getKnownDevices();
    const primary = devices.find((device) => device.role === "primary");
    if (!primary) {
      return true;
    }

    if (!primary.pluginVersion) {
      this.handler({
        type: "error",
        message: `Version gate blocked ${action}: primary device (${primary.deviceName}) is on an older Sink that does not report version. Update primary first.`,
      });
      return false;
    }

    if (primary.pluginVersion !== this.pluginVersion) {
      this.handler({
        type: "error",
        message: `Version gate blocked ${action}: this device is ${this.pluginVersion}, primary (${primary.deviceName}) is ${primary.pluginVersion}.`,
      });
      return false;
    }

    return true;
  }
}
