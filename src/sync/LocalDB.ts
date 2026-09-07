import { PouchDB } from "./pouchdb";
import type { DeviceMetaDoc, SinkDoc, SinkStoredDoc, SnapshotMetaDoc } from "../settings";

export class LocalDB {
  private db: PouchDB.Database<SinkStoredDoc>;
  private dbName: string;

  constructor(vaultName: string) {
    this.dbName = `sink-${vaultName.replace(/[^a-zA-Z0-9]/g, "_")}`;
    this.db = new PouchDB(this.dbName, { adapter: "idb" });
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

  async allDocs(options?: PouchDB.Core.AllDocsOptions): Promise<PouchDB.Core.AllDocsResponse<SinkStoredDoc>> {
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
    await this.db.destroy();
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
    const result = await this.db.allDocs({ include_docs: true });
    type DeviceDoc = DeviceMetaDoc & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta;
    return result.rows
      .map((row: { doc?: SinkStoredDoc }) => row.doc)
      .filter((doc: SinkStoredDoc | undefined): doc is DeviceDoc => {
        return !!doc && doc.type === "meta" && (doc as DeviceMetaDoc).metaType === "device";
      });
  }

  async putSnapshotDoc(doc: SnapshotMetaDoc): Promise<PouchDB.Core.Response> {
    return await this.db.put(doc);
  }

  async getSnapshotDoc(snapshotId: string): Promise<(SnapshotMetaDoc & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta) | null> {
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

  async getSnapshotDocs(limit = 20): Promise<Array<SnapshotMetaDoc & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta>> {
    const result = await this.db.allDocs({ include_docs: true });
    type SnapshotDoc = SnapshotMetaDoc & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta;
    const snapshots = result.rows
      .map((row: { doc?: SinkStoredDoc }) => row.doc)
      .filter((doc: SinkStoredDoc | undefined): doc is SnapshotDoc => {
        return !!doc && doc.type === "meta" && (doc as SnapshotMetaDoc).metaType === "snapshot";
      })
      .sort((left: SnapshotDoc, right: SnapshotDoc) => right.createdAt - left.createdAt);

    return snapshots.slice(0, limit);
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
}
