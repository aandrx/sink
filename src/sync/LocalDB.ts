import { PouchDB } from "./pouchdb";
import type { DeviceMetaDoc, SinkDoc, SinkStoredDoc, SnapshotFileEntry, SnapshotMetaDoc, SnapshotSummary } from "../settings";
import type { CryptoHelper } from "../utils/crypto";

interface SnapshotIndexDoc {
  _id: string;
  _rev?: string;
  type: "local";
  updatedAt: number;
  entries: SnapshotSummary[];
}

interface StoredSnapshotDoc {
  _id: string;
  _rev?: string;
  type: "meta";
  metaType: "snapshot";
  createdAt: number;
  reason: string;
  sourceDevice: string;
  files?: SnapshotFileEntry[];
  encryptedFiles?: string;
  encryptedFilesIv?: string;
}

export class LocalDB {
  private static readonly SNAPSHOT_INDEX_ID = "_local/sink-snapshot-index";
  private static readonly SNAPSHOT_INDEX_LIMIT = 50;
  private static readonly SNAPSHOT_INDEX_ATTEMPTS = 3;
  private static readonly latestGeneration = new Map<string, number>();
  private static nextGeneration = 0;

  private db: PouchDB.Database<SinkStoredDoc>;
  private dbName: string;
  private snapshotCrypto: CryptoHelper | null = null;
  private snapshotIndexQueue: Promise<void> = Promise.resolve();
  private closed = false;
  private generation: number;

  constructor(vaultName: string) {
    this.dbName = `sink-${vaultName.replace(/[^a-zA-Z0-9]/g, "_")}`;
    this.db = new PouchDB(this.dbName, {
      adapter: "idb",
      // Device heartbeat records would otherwise accumulate an unbounded revision
      // tree until IndexedDB cannot read them.
      auto_compaction: true,
      revs_limit: 100,
    });
    this.generation = ++LocalDB.nextGeneration;
    LocalDB.latestGeneration.set(this.dbName, this.generation);
  }

  get instance(): PouchDB.Database<SinkStoredDoc> {
    return this.db;
  }

  async get(id: string): Promise<SinkStoredDoc & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta> {
    return await this.db.get(id);
  }

  async put(doc: SinkStoredDoc): Promise<PouchDB.Core.Response> {
    return await this.db.put(doc);
  }

  async removeStoredDoc(doc: SinkStoredDoc & PouchDB.Core.IdMeta & PouchDB.Core.RevisionIdMeta): Promise<PouchDB.Core.Response> {
    return await this.db.remove(doc);
  }

  async remove(doc: SinkDoc & PouchDB.Core.IdMeta & PouchDB.Core.RevisionIdMeta): Promise<PouchDB.Core.Response> {
    return await this.db.remove(doc);
  }

  async allDocs(options?: PouchDB.Core.AllDocsOptions | PouchDB.Core.AllDocsWithinRangeOptions): Promise<PouchDB.Core.AllDocsResponse<SinkStoredDoc>> {
    return await this.db.allDocs({ include_docs: true, ...options });
  }

  async getByPath(path: string): Promise<(SinkDoc & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta) | null> {
    const id = this.pathToId(path);
    try {
      return await this.db.get(id) as SinkDoc & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta;
    } catch (e: any) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  async destroy(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    LocalDB.latestGeneration.delete(this.dbName);
    await this.db.destroy();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // PouchDB caches one IDB connection per database name. If a replacement
    // plugin instance has opened it already, closing here would interrupt the
    // replacement's transactions. Only the newest instance owns the close.
    if (LocalDB.latestGeneration.get(this.dbName) !== this.generation) return;
    LocalDB.latestGeneration.delete(this.dbName);
    await this.db.close();
  }

  async getDeviceDoc(deviceId: string): Promise<(DeviceMetaDoc & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta) | null> {
    try {
      const doc = await this.db.get(this.deviceMetaId(deviceId));
      if (doc.type === "meta" && (doc as DeviceMetaDoc).metaType === "device") {
        return doc as DeviceMetaDoc & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta;
      }
      return null;
    } catch (e: any) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  async getAllDeviceDocs(): Promise<Array<DeviceMetaDoc & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta>> {
    const result = await this.db.allDocs({ include_docs: true, startkey: "meta:device:", endkey: "meta:device:\uffff" });
    type DeviceDoc = DeviceMetaDoc & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta;
    return result.rows
      .map((row: { doc?: SinkStoredDoc }) => row.doc)
      .filter((doc: SinkStoredDoc | undefined): doc is DeviceDoc => {
        return !!doc && doc.type === "meta" && (doc as DeviceMetaDoc).metaType === "device";
      });
  }

  async putSnapshotDoc(doc: SnapshotMetaDoc): Promise<PouchDB.Core.Response> {
    const snapshotId = this.snapshotIdFromDocId(doc._id);
    const stored: StoredSnapshotDoc = {
      _id: this.snapshotLocalId(snapshotId),
      type: "meta",
      metaType: "snapshot",
      createdAt: doc.createdAt,
      reason: doc.reason,
      sourceDevice: doc.sourceDevice,
    };

    if (this.snapshotCrypto) {
      // Encrypt before writing anything. A failure here must not leave a plaintext payload behind.
      const encrypted = await this.snapshotCrypto.encrypt(JSON.stringify(doc.files));
      stored.encryptedFiles = encrypted.ciphertext;
      stored.encryptedFilesIv = encrypted.iv;
    } else {
      stored.files = doc.files;
    }

    if (doc._id.startsWith("_local/") && doc._rev) {
      stored._rev = doc._rev;
    }

    const response = await this.db.put(stored as unknown as SinkStoredDoc);
    try {
      await this.updateSnapshotIndex({
        id: snapshotId,
        createdAt: doc.createdAt,
        reason: doc.reason,
        fileCount: doc.files.length,
      });
    } catch (error: any) {
      const detail = error?.message ? `: ${error.message}` : "";
      throw new Error(`Snapshot ${snapshotId} was saved but its index entry could not be written${detail}. Aborting so the snapshot is not applied without a listable restore point.`);
    }
    return response;
  }

  /** Provide the engine's encryption helper after it initializes or its settings change. */
  configureSnapshotCrypto(crypto: CryptoHelper | null): void {
    this.snapshotCrypto = crypto;
  }

  async getSnapshotDoc(snapshotId: string): Promise<(SnapshotMetaDoc & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta) | null> {
    const local = await this.getLocalDoc<StoredSnapshotDoc & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta>(this.snapshotLocalId(snapshotId));
    if (local && local.type === "meta" && local.metaType === "snapshot") {
      if (local.encryptedFiles !== undefined) {
        if (!this.snapshotCrypto) {
          throw new Error("Snapshot is encrypted; a passphrase is required to read it");
        }
        if (!local.encryptedFilesIv) {
          throw new Error("Snapshot is encrypted but its IV is missing");
        }
        const decrypted = await this.snapshotCrypto.decrypt(local.encryptedFiles, local.encryptedFilesIv);
        const files = JSON.parse(decrypted) as SnapshotFileEntry[];
        return { ...local, files } as SnapshotMetaDoc & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta;
      }
      return { ...local, files: local.files ?? [] } as SnapshotMetaDoc & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta;
    }

    // Legacy snapshots remain readable in place; they are never migrated or deleted.
    try {
      const doc = await this.db.get(this.snapshotMetaId(snapshotId));
      if (doc.type === "meta" && (doc as SnapshotMetaDoc).metaType === "snapshot") {
        return doc as SnapshotMetaDoc & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta;
      }
      return null;
    } catch (e: any) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  async getSnapshotSummaries(limit = 20): Promise<SnapshotSummary[]> {
    const index = await this.getLocalDoc<SnapshotIndexDoc>(LocalDB.SNAPSHOT_INDEX_ID);
    const localEntries = Array.isArray(index?.entries) ? index.entries : [];

    // Snapshot IDs are time-prefixed. Fetch only the newest legacy documents.
    const result = await this.db.allDocs({
      include_docs: false,
      descending: true,
      startkey: "meta:snapshot:\uffff",
      endkey: "meta:snapshot:",
      limit,
    });
    const legacyEntries: SnapshotSummary[] = [];
    // Legacy snapshots embed content. Read one at a time from the legacy ID and retain only metadata.
    for (const row of result.rows) {
      try {
        const doc = await this.db.get(row.id);
        if (doc.type !== "meta" || (doc as SnapshotMetaDoc).metaType !== "snapshot") continue;
        const legacy = doc as SnapshotMetaDoc;
        legacyEntries.push({ id: row.id.slice("meta:snapshot:".length), createdAt: legacy.createdAt, reason: legacy.reason, fileCount: legacy.files.length });
      } catch (e: any) {
        if (e.status !== 404) throw e;
      }
    }

    const byId = new Map<string, SnapshotSummary>();
    for (const entry of [...localEntries, ...legacyEntries]) byId.set(entry.id, entry);
    return Array.from(byId.values())
      .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
      .slice(0, limit);
  }

  private async updateSnapshotIndex(entry: SnapshotSummary): Promise<void> {
    const update = async () => {
      for (let attempt = 0; attempt < LocalDB.SNAPSHOT_INDEX_ATTEMPTS; attempt += 1) {
        // Re-read the index on every attempt so a concurrent writer's revision is not overwritten.
        const index = await this.getLocalDoc<SnapshotIndexDoc>(LocalDB.SNAPSHOT_INDEX_ID);
        const entries = (Array.isArray(index?.entries) ? index.entries : []).filter((item) => item.id !== entry.id);
        entries.push(entry);
        entries.sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
        const doc: SnapshotIndexDoc = {
          _id: LocalDB.SNAPSHOT_INDEX_ID,
          _rev: index?._rev,
          type: "local",
          updatedAt: Date.now(),
          entries: entries.slice(0, LocalDB.SNAPSHOT_INDEX_LIMIT),
        };
        try {
          await this.db.put(doc as unknown as SinkStoredDoc);
          return;
        } catch (error: any) {
          if (error?.status !== 409 || attempt === LocalDB.SNAPSHOT_INDEX_ATTEMPTS - 1) throw error;
        }
      }
    };
    const result = this.snapshotIndexQueue.then(update, update);
    this.snapshotIndexQueue = result.catch(() => undefined);
    await result;
  }

  private async getLocalDoc<T extends PouchDB.Core.IdMeta>(id: string): Promise<T | null> {
    try {
      return await this.db.get(id) as unknown as T;
    } catch (e: any) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  async info(): Promise<PouchDB.Core.DatabaseInfo> {
    return await this.db.info();
  }

  /** Convert a file path to a document ID (deterministic) */
  pathToId(path: string): string {
    // Use a simple hash-like approach: prefix + path
    // Keeps it readable for debugging while being unique
    return "file:" + path;
  }

  /** Convert a document ID back to a file path */
  idToPath(id: string): string | null {
    if (id.startsWith("file:")) {
      return id.slice(5);
    }
    return null;
  }

  /** Generate a chunk ID from content hash */
  chunkId(hash: string): string {
    return "chunk:" + hash;
  }

  deviceMetaId(deviceId: string): string {
    return "meta:device:" + deviceId;
  }

  snapshotMetaId(snapshotId: string): string {
    return "meta:snapshot:" + snapshotId;
  }

  private snapshotLocalId(snapshotId: string): string {
    return "_local/sink-snapshot:" + snapshotId;
  }

  private snapshotIdFromDocId(id: string): string {
    if (id.startsWith("_local/sink-snapshot:")) return id.slice("_local/sink-snapshot:".length);
    if (id.startsWith("meta:snapshot:")) return id.slice("meta:snapshot:".length);
    return id;
  }
}
