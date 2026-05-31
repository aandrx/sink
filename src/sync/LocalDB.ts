import { PouchDB } from "./pouchdb";
import type { SinkDoc, SinkChunkDoc } from "../settings";

export class LocalDB {
  private db: PouchDB.Database<SinkDoc | SinkChunkDoc>;
  private dbName: string;

  constructor(vaultName: string) {
    this.dbName = `sink-${vaultName.replace(/[^a-zA-Z0-9]/g, "_")}`;
    this.db = new PouchDB(this.dbName, { adapter: "idb" });
  }

  get instance(): PouchDB.Database<SinkDoc | SinkChunkDoc> {
    return this.db;
  }

  async get(id: string): Promise<(SinkDoc | SinkChunkDoc) & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta> {
    return await this.db.get(id);
  }

  async put(doc: SinkDoc | SinkChunkDoc): Promise<PouchDB.Core.Response> {
    return await this.db.put(doc);
  }

  async remove(doc: SinkDoc & PouchDB.Core.IdMeta & PouchDB.Core.RevisionIdMeta): Promise<PouchDB.Core.Response> {
    return await this.db.remove(doc);
  }

  async allDocs(options?: PouchDB.Core.AllDocsOptions): Promise<PouchDB.Core.AllDocsResponse<SinkDoc | SinkChunkDoc>> {
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
}
