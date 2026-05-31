import type { Vault, TFile } from "obsidian";
import type { SinkDoc } from "../settings";
import type { LocalDB } from "./LocalDB";

const CHUNK_SIZE = 64 * 1024; // 64KB threshold

/** Binary file extensions that need base64 encoding */
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "svg", "webp",
  "pdf", "mp3", "mp4", "ogg", "webm", "wav", "flac",
  "zip", "tar", "gz", "7z", "rar",
  "woff", "woff2", "ttf", "otf", "eot",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx",
]);

export class FileSerializer {
  private vault: Vault;
  private localDB: LocalDB;

  constructor(vault: Vault, localDB: LocalDB) {
    this.vault = vault;
    this.localDB = localDB;
  }

  /** Convert a vault file to a SinkDoc for storage in the database */
  async fileToDoc(file: TFile): Promise<SinkDoc> {
    const isBinary = this.isBinaryFile(file.path);
    let content: string;

    if (isBinary) {
      const buffer = await this.vault.readBinary(file);
      content = this.arrayBufferToBase64(buffer);
    } else {
      content = await this.vault.read(file);
    }

    const doc: SinkDoc = {
      _id: this.localDB.pathToId(file.path),
      path: file.path,
      content: content,
      mtime: file.stat.mtime,
      ctime: file.stat.ctime,
      size: file.stat.size,
      type: "file",
    };

    // Check if we need chunking (file > 64KB)
    if (content.length > CHUNK_SIZE) {
      const chunks = this.splitIntoChunks(content);
      const chunkIds: string[] = [];

      for (const chunk of chunks) {
        const chunkHash = await this.hashContent(chunk);
        const chunkId = this.localDB.chunkId(chunkHash);
        chunkIds.push(chunkId);

        // Store chunk (skip if it already exists — content-addressed)
        try {
          await this.localDB.get(chunkId);
        } catch {
          await this.localDB.put({
            _id: chunkId,
            type: "chunk",
            data: chunk,
          });
        }
      }

      doc.chunks = chunkIds;
      doc.content = ""; // Content stored in chunks
    }

    return doc;
  }

  /** Convert a SinkDoc back to file content and write to vault */
  async docToFile(doc: SinkDoc): Promise<void> {
    if (doc.deleted) {
      const existing = this.vault.getAbstractFileByPath(doc.path);
      if (existing) {
        await this.vault.delete(existing);
      }
      return;
    }

    let content: string;

    // Reassemble from chunks if needed
    if (doc.chunks && doc.chunks.length > 0) {
      const chunkContents: string[] = [];
      for (const chunkId of doc.chunks) {
        const chunk = await this.localDB.get(chunkId) as any;
        chunkContents.push(chunk.data);
      }
      content = chunkContents.join("");
    } else {
      content = doc.content;
    }

    const isBinary = this.isBinaryFile(doc.path);

    // Ensure parent directories exist
    await this.ensureDirectory(doc.path);

    const existing = this.vault.getAbstractFileByPath(doc.path);
    if (isBinary) {
      const buffer = this.base64ToArrayBuffer(content);
      if (existing) {
        await this.vault.modifyBinary(existing as TFile, buffer, { mtime: doc.mtime, ctime: doc.ctime });
      } else {
        await this.vault.createBinary(doc.path, buffer);
      }
    } else {
      if (existing) {
        await this.vault.modify(existing as TFile, content, { mtime: doc.mtime, ctime: doc.ctime });
      } else {
        await this.vault.create(doc.path, content);
      }
    }
  }

  /** Check if the file has changed compared to the stored doc */
  async hasFileChanged(file: TFile): Promise<boolean> {
    const existingDoc = await this.localDB.getByPath(file.path);
    if (!existingDoc) return true;
    // Quick check: mtime difference means changed
    return file.stat.mtime !== existingDoc.mtime;
  }

  /** Create a deletion doc */
  createDeletionDoc(path: string): SinkDoc {
    return {
      _id: this.localDB.pathToId(path),
      path: path,
      content: "",
      mtime: Date.now(),
      ctime: 0,
      size: 0,
      deleted: true,
      type: "file",
    };
  }

  /** Create a rename: delete old + create new */
  createRenameDoc(oldPath: string): SinkDoc {
    return this.createDeletionDoc(oldPath);
  }

  // --- Utility methods ---

  private isBinaryFile(path: string): boolean {
    const ext = path.split(".").pop()?.toLowerCase() || "";
    return BINARY_EXTENSIONS.has(ext);
  }

  private splitIntoChunks(content: string): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < content.length; i += CHUNK_SIZE) {
      chunks.push(content.slice(i, i + CHUNK_SIZE));
    }
    return chunks;
  }

  private async hashContent(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  private async ensureDirectory(filePath: string): Promise<void> {
    const parts = filePath.split("/");
    parts.pop(); // Remove filename
    if (parts.length === 0) return;

    const dirPath = parts.join("/");
    const existing = this.vault.getAbstractFileByPath(dirPath);
    if (!existing) {
      await this.vault.createFolder(dirPath);
    }
  }
}
