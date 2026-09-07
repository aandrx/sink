import { App, Notice, TAbstractFile, TFile, Vault } from "obsidian";
import type {
  ChangeDecision,
  DeviceMetaDoc,
  DeviceRole,
  KnownDevice,
  PendingChange,
  ReviewResult,
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
import { ConflictResolver } from "./ConflictResolver";
import { CryptoHelper } from "../utils/crypto";
import { BatchReviewModal } from "../ui/BatchReviewModal";

export type SyncEventHandler = (event: SyncEvent) => void;
export type SyncProgressCallback = (path: string, done: number, total: number) => void;

interface PreparedChange extends PendingChange {
  remoteDoc: SinkDoc;
}

interface LocalFileState {
  exists: boolean;
  isBinary: boolean;
  content: string;
  mtime?: number;
  ctime?: number;
}

export class SyncEngine {
  private static readonly ACTIVE_DEVICE_WINDOW_MS = 2 * 60 * 1000;
  private static readonly DEVICE_HEARTBEAT_MS = 60 * 1000;
  private static readonly STALE_PULL_WINDOW_MS = 30 * 60 * 1000;
  private static readonly RISKY_CHANGE_COUNT = 2;

  private app: App;
  private vault: Vault;
  private settings: SinkSettings;
  private vaultName: string;
  private localDB: LocalDB;
  private remoteDB: RemoteDB;
  private replicator: Replicator | null = null;
  private serializer: FileSerializer;
  private conflictResolver: ConflictResolver;
  private crypto: CryptoHelper | null = null;
  private handler: SyncEventHandler;
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private processing: Set<string> = new Set(); // Paths currently being written by sync
  private status: SyncStatus = "disconnected";
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private secondaryPushApproved = false;
  private approvalPromise: Promise<boolean> | null = null;
  private reviewPromise: Promise<ReviewResult> | null = null;

  constructor(app: App, vault: Vault, settings: SinkSettings, vaultName: string, handler: SyncEventHandler) {
    this.app = app;
    this.vault = vault;
    this.settings = settings;
    this.vaultName = vaultName;
    this.handler = handler;
    this.localDB = new LocalDB(vaultName);
    this.remoteDB = new RemoteDB(settings);
    this.serializer = new FileSerializer(vault, this.localDB);
    this.conflictResolver = new ConflictResolver();
  }

  /** Initialize and start syncing */
  async start(): Promise<void> {
    // Initialize encryption if passphrase is set
    if (this.settings.passphrase) {
      this.crypto = new CryptoHelper(this.settings.passphrase);
    }

    // Connect to remote
    this.remoteDB.connect();

    // Set up replicator with change handling
    this.replicator = new Replicator(this.localDB, this.remoteDB, (event) => {
      switch (event.type) {
        case "change":
          this.handleIncomingChanges(event.docs as SinkDoc[]);
          break;
        case "status":
          this.status = event.status;
          this.handler({ type: "status-change", status: event.status });
          break;
        case "error":
          this.handler({ type: "error", message: String(event.error) });
          break;
      }
    });

    // Start continuous replication
    this.replicator.start();
    await this.upsertDeviceRecord();
    this.startHeartbeat();
  }

  /** Recover or create a stable device identity before syncing starts */
  async initializeDeviceIdentity(): Promise<boolean> {
    if (this.settings.deviceId) return false;

    const docs = await this.localDB.getAllDeviceDocs();
    const matches = docs.filter((doc) => doc.deviceName === this.settings.deviceName && doc.vaultName === this.vaultName);
    const existing = matches.sort((left, right) => right.lastSeen - left.lastSeen)[0];

    if (existing) {
      this.settings.deviceId = existing.deviceId;
      this.settings.deviceName = existing.deviceName || this.settings.deviceName;
    } else {
      this.settings.deviceId = crypto.randomUUID();
    }

    return true;
  }

  /** Stop syncing and clean up */
  async stop(): Promise<void> {
    // Cancel all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.stopHeartbeat();
    this.secondaryPushApproved = false;

    // Stop replication
    if (this.replicator) {
      this.replicator.stop();
      this.replicator = null;
    }

    // Disconnect remote
    await this.remoteDB.disconnect();
  }

  /** Handle a file being created or modified in the vault */
  async onFileChange(file: TFile): Promise<void> {
    // Skip if this change was caused by us writing from sync
    if (this.processing.has(file.path)) return;

    // Skip config folder if disabled
    if (!this.settings.syncConfigFolder && file.path.startsWith(".obsidian/")) return;

    // Skip our own plugin data
    if (file.path === ".obsidian/plugins/sink/data.json") return;

    // Debounce: wait for syncDelay ms of inactivity before pushing
    const existingTimer = this.debounceTimers.get(file.path);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    this.debounceTimers.set(
      file.path,
      setTimeout(() => {
        this.debounceTimers.delete(file.path);
        this.pushFile(file);
      }, this.settings.syncDelay)
    );
  }

  /** Handle a file being deleted in the vault */
  async onFileDelete(file: TAbstractFile): Promise<void> {
    if (this.processing.has(file.path)) return;
    if (!this.settings.syncConfigFolder && file.path.startsWith(".obsidian/")) return;
    if (file.path === ".obsidian/plugins/sink/data.json") return;

    await this.pushDeletion(file.path);
  }

  /** Handle a file being renamed in the vault */
  async onFileRename(file: TAbstractFile, oldPath: string): Promise<void> {
    if (this.processing.has(file.path) || this.processing.has(oldPath)) return;
    if (!this.settings.syncConfigFolder && file.path.startsWith(".obsidian/")) return;

    // Rename = delete old + create new
    await this.pushDeletion(oldPath);
    if (file instanceof Object && "stat" in file) {
      await this.pushFile(file as TFile);
    }
  }

  /** Push a local file to the database */
  private async pushFile(file: TFile): Promise<void> {
    try {
      if (!(await this.ensurePushAllowed(`upload ${file.path}`))) return;

      let doc = await this.serializer.fileToDoc(file);
      doc.deviceName = this.settings.deviceName;

      // Encrypt if needed
      if (this.crypto) {
        doc = await this.encryptDoc(doc);
      }

      // Check for existing doc (to get _rev)
      const existing = await this.localDB.getByPath(file.path);
      if (existing) {
        doc._rev = existing._rev;
      }

      await this.localDB.put(doc);
      await this.upsertDeviceRecord({ lastPushAt: Date.now() });
      this.handler({ type: "doc-pushed", path: file.path });
    } catch (e: any) {
      // Handle conflict: fetch latest and retry
      if (e.status === 409) {
        const latest = await this.localDB.getByPath(file.path);
        if (latest) {
          const doc = await this.serializer.fileToDoc(file);
          doc._rev = latest._rev;
          doc.deviceName = this.settings.deviceName;
          if (this.crypto) {
            await this.localDB.put(await this.encryptDoc(doc));
          } else {
            await this.localDB.put(doc);
          }
          await this.upsertDeviceRecord({ lastPushAt: Date.now() });
        }
      } else {
        this.handler({ type: "error", message: `Push failed for ${file.path}: ${e.message}` });
      }
    }
  }

  /** Push a deletion to the database */
  private async pushDeletion(path: string): Promise<void> {
    try {
      if (!(await this.ensurePushAllowed(`delete ${path}`))) return;

      const existing = await this.localDB.getByPath(path);
      if (existing) {
        const doc = this.serializer.createDeletionDoc(path);
        doc._rev = existing._rev;
        doc.deviceName = this.settings.deviceName;
        await this.localDB.put(doc);
        await this.upsertDeviceRecord({ lastPushAt: Date.now() });
        this.handler({ type: "doc-pushed", path });
      }
    } catch (e: any) {
      this.handler({ type: "error", message: `Delete push failed for ${path}: ${e.message}` });
    }
  }

  /** Handle documents coming in from replication */
  private async handleIncomingChanges(docs: SinkDoc[]): Promise<void> {
    const prepared = await this.prepareIncomingChanges(docs);
    if (prepared.length === 0) return;
    await this.applyIncomingChangesWithReview(prepared, "Review incoming changes");
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
    if (!(await this.ensurePushAllowed("push the local vault to the server"))) {
      return 0;
    }

    const files = this.vault.getFiles().filter((f) => {
      if (!this.settings.syncConfigFolder && f.path.startsWith(".obsidian/")) return false;
      if (f.path === ".obsidian/plugins/sink/data.json") return false;
      return true;
    });
    const total = files.length;
    let count = 0;
    for (const file of files) {
      await this.pushFile(file);
      count++;
      onProgress?.(file.path, count, total);
    }
    return count;
  }

  /** Pull all docs from remote and write to vault */
  async pullServerToVault(onProgress?: SyncProgressCallback): Promise<number> {
    // First do a one-shot pull (remote → local DB)
    if (this.replicator) {
      await this.replicator.pullOnce();
    }

    await this.upsertDeviceRecord({ lastPullAt: Date.now() });

    // Then read all file docs from local DB and write them to the vault
    const result = await this.localDB.allDocs();
    const rows = result.rows.filter((row) => {
      const doc = row.doc as SinkDoc;
      return doc && doc.type === "file";
    });
    const docs = rows.map((row) => row.doc as SinkDoc);
    const prepared = await this.prepareIncomingChanges(docs);
    const total = prepared.length;
    let index = 0;

    const applied = await this.applyIncomingChangesWithReview(prepared, "Review pull changes", () => {
      index += 1;
      const current = prepared[Math.min(index - 1, prepared.length - 1)];
      if (current) {
        onProgress?.(current.path, index, total);
      }
    });

    return applied;
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
    const docs = await this.localDB.getSnapshotDocs(limit);
    return docs.map((doc) => ({
      id: doc._id.replace(/^meta:snapshot:/, ""),
      createdAt: doc.createdAt,
      reason: doc.reason,
      fileCount: doc.files.length,
    }));
  }

  async restoreSnapshot(snapshotId: string): Promise<number> {
    const snapshot = await this.localDB.getSnapshotDoc(snapshotId);
    if (!snapshot) {
      throw new Error("Snapshot not found");
    }

    let restored = 0;
    for (const entry of snapshot.files) {
      await this.restoreSnapshotEntry(entry);
      restored += 1;
    }

    new Notice(`Sink: Restored snapshot ${snapshotId} (${restored} files)`);
    return restored;
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

    void this.upsertDeviceRecord();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.upsertDeviceRecord();
    }, SyncEngine.DEVICE_HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async getCurrentDeviceRole(): Promise<DeviceRole> {
    const doc = await this.localDB.getDeviceDoc(this.settings.deviceId);
    return doc?.role ?? "primary";
  }

  private async ensurePushAllowed(action: string): Promise<boolean> {
    const role = await this.getCurrentDeviceRole();
    if (role === "primary") {
      this.secondaryPushApproved = true;
      return true;
    }

    if (this.secondaryPushApproved) {
      return true;
    }

    if (!this.approvalPromise) {
      this.approvalPromise = Promise.resolve(
        window.confirm(`Sink: ${this.settings.deviceName || "This device"} is marked secondary. Confirm before it can ${action}.`)
      )
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

  private async prepareIncomingChanges(docs: SinkDoc[]): Promise<PreparedChange[]> {
    const prepared: PreparedChange[] = [];

    for (const doc of docs) {
      if (!doc.type || doc.type !== "file") continue;
      if (!doc.path) continue;
      if (doc.deviceName === this.settings.deviceName) continue;

      let remoteDoc = doc;
      if (this.crypto && doc.iv) {
        remoteDoc = await this.decryptDoc(doc);
      }

      const local = await this.readLocalFileState(doc.path);
      const suggested = this.suggestDecision(local, remoteDoc);

      prepared.push({
        path: remoteDoc.path,
        sourceDevice: remoteDoc.deviceName ?? "unknown",
        remoteMtime: remoteDoc.mtime,
        localMtime: local.mtime,
        remoteDeleted: !!remoteDoc.deleted,
        localExists: local.exists,
        localContent: local.isBinary ? "" : local.content,
        remoteContent: local.isBinary ? "" : (remoteDoc.deleted ? "" : remoteDoc.content),
        isBinary: local.isBinary || this.isBinaryPath(remoteDoc.path),
        suggested,
        remoteDoc,
      });
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

  private suggestDecision(local: LocalFileState, remote: SinkDoc): ChangeDecision {
    if (!local.exists) return "keep-remote";
    if (remote.deleted) return "keep-local";
    if (local.isBinary || this.isBinaryPath(remote.path)) {
      return (local.mtime ?? 0) > remote.mtime ? "keep-local" : "keep-remote";
    }
    if (local.content === remote.content) return "keep-remote";
    if ((local.mtime ?? 0) > remote.mtime) return "keep-local";
    return "merge";
  }

  private async applyIncomingChangesWithReview(
    changes: PreparedChange[],
    title: string,
    onApplied?: () => void
  ): Promise<number> {
    if (changes.length === 0) return 0;

    const needsReview = await this.shouldReviewBatch(changes);
    const review = needsReview
      ? await this.reviewBatch(title, changes)
      : this.acceptAll(changes);

    if (!review.approved) {
      return 0;
    }

    const decisionByPath = new Map(review.decisions.map((decision) => [decision.path, decision]));
    const selected = changes.filter((change) => {
      const selectedDecision = decisionByPath.get(change.path);
      return !!selectedDecision?.selected && selectedDecision.decision !== "skip";
    });

    if (selected.length === 0) return 0;

    const shouldSnapshot = needsReview || selected.length > 1 || selected.some((change) => change.remoteDeleted);
    if (shouldSnapshot) {
      await this.createSnapshot(
        `${title} (${selected.length} files)`,
        selected.map((change) => change.path),
        selected[0].sourceDevice
      );
    }

    let applied = 0;
    for (const change of selected) {
      const decision = decisionByPath.get(change.path)?.decision ?? change.suggested;
      try {
        switch (decision) {
          case "keep-remote":
            await this.applyRemoteChange(change);
            break;
          case "keep-local":
            await this.applyKeepLocal(change);
            break;
          case "merge":
            await this.applyMerge(change);
            break;
          case "skip":
            continue;
        }
        applied += 1;
        onApplied?.();
      } catch (e: any) {
        this.handler({ type: "error", message: `Apply failed for ${change.path}: ${e.message}` });
      }
    }

    return applied;
  }

  private async shouldReviewBatch(changes: PreparedChange[]): Promise<boolean> {
    if (changes.some((change) => change.remoteDeleted)) return true;

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
      })),
    };
  }

  private async reviewBatch(title: string, changes: PreparedChange[]): Promise<ReviewResult> {
    if (!this.reviewPromise) {
      this.reviewPromise = BatchReviewModal.review(this.app, title, changes)
        .finally(() => {
          this.reviewPromise = null;
        });
    }

    return await this.reviewPromise;
  }

  private async createSnapshot(reason: string, paths: string[], sourceDevice: string): Promise<string> {
    const uniq = Array.from(new Set(paths));
    const files: SnapshotFileEntry[] = [];

    for (const path of uniq) {
      const local = await this.readLocalFileState(path);
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

  private async applyRemoteChange(change: PreparedChange): Promise<void> {
    this.processing.add(change.path);
    try {
      await this.serializer.docToFile(change.remoteDoc);
      await this.upsertDeviceRecord({ lastPullAt: Date.now() });
      this.handler({ type: "doc-pulled", path: change.path });
    } finally {
      setTimeout(() => this.processing.delete(change.path), 500);
    }
  }

  private async applyKeepLocal(change: PreparedChange): Promise<void> {
    const existing = this.vault.getAbstractFileByPath(change.path);
    if (!(existing instanceof TFile)) {
      this.handler({
        type: "error",
        message: `Cannot keep local for ${change.path}: local file not found.`,
      });
      return;
    }

    await this.pushFile(existing);
  }

  private async applyMerge(change: PreparedChange): Promise<void> {
    if (change.isBinary || change.remoteDeleted || !change.localExists) {
      await this.applyRemoteChange(change);
      return;
    }

    const mine: SinkDoc = {
      _id: this.localDB.pathToId(change.path),
      path: change.path,
      content: change.localContent ?? "",
      mtime: change.localMtime ?? 0,
      ctime: 0,
      size: (change.localContent ?? "").length,
      type: "file",
    };

    const theirs: SinkDoc = {
      ...change.remoteDoc,
      content: change.remoteContent ?? change.remoteDoc.content,
      deleted: false,
    };

    const merged = this.conflictResolver.resolve(mine, theirs, true);
    if (!merged.resolved) {
      this.handler({ type: "conflict", path: change.path });
      return;
    }

    this.processing.add(change.path);
    try {
      const existing = this.vault.getAbstractFileByPath(change.path);
      if (existing instanceof TFile) {
        await this.vault.modify(existing, merged.content, { mtime: Date.now(), ctime: existing.stat.ctime });
      } else {
        await this.ensureParentDirectory(change.path);
        await this.vault.create(change.path, merged.content);
      }

      const updated = this.vault.getAbstractFileByPath(change.path);
      if (updated instanceof TFile) {
        await this.pushFile(updated);
      }
    } finally {
      setTimeout(() => this.processing.delete(change.path), 500);
    }
  }

  private async readLocalFileState(path: string): Promise<LocalFileState> {
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
      const buffer = await this.vault.readBinary(existing);
      return {
        exists: true,
        isBinary,
        content: this.arrayBufferToBase64(buffer),
        mtime: existing.stat.mtime,
        ctime: existing.stat.ctime,
      };
    }

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
    const existing = this.vault.getAbstractFileByPath(entry.path);
    if (!entry.existed) {
      if (existing) {
        this.processing.add(entry.path);
        try {
          await this.vault.delete(existing);
        } finally {
          setTimeout(() => this.processing.delete(entry.path), 500);
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

    this.processing.add(entry.path);
    try {
      await this.serializer.docToFile(doc);
    } finally {
      setTimeout(() => this.processing.delete(entry.path), 500);
    }
  }

  private isBinaryPath(path: string): boolean {
    return /\.(png|jpg|jpeg|gif|bmp|ico|svg|webp|pdf|mp3|mp4|ogg|webm|wav|flac|zip|tar|gz|7z|rar|woff|woff2|ttf|otf|eot|doc|docx|xls|xlsx|ppt|pptx)$/i.test(path);
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
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
      role: overrides.role ?? existing?.role ?? "primary",
      vaultName: this.vaultName,
      lastSeen: overrides.lastSeen ?? now,
      lastPushAt: overrides.lastPushAt ?? existing?.lastPushAt,
      lastPullAt: overrides.lastPullAt ?? existing?.lastPullAt,
    };

    await this.localDB.put(doc);
  }
}
