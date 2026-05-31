import type { Vault, TFile, TAbstractFile } from "obsidian";
import type { SinkSettings, SinkDoc, SyncStatus, SyncEvent } from "../settings";
import { LocalDB } from "./LocalDB";
import { RemoteDB } from "./RemoteDB";
import { Replicator } from "./Replicator";
import { FileSerializer } from "./FileSerializer";
import { ConflictResolver } from "./ConflictResolver";
import { CryptoHelper } from "../utils/crypto";

export type SyncEventHandler = (event: SyncEvent) => void;

export class SyncEngine {
  private vault: Vault;
  private settings: SinkSettings;
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

  constructor(vault: Vault, settings: SinkSettings, vaultName: string, handler: SyncEventHandler) {
    this.vault = vault;
    this.settings = settings;
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
  }

  /** Stop syncing and clean up */
  async stop(): Promise<void> {
    // Cancel all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

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
        }
      } else {
        this.handler({ type: "error", message: `Push failed for ${file.path}: ${e.message}` });
      }
    }
  }

  /** Push a deletion to the database */
  private async pushDeletion(path: string): Promise<void> {
    try {
      const existing = await this.localDB.getByPath(path);
      if (existing) {
        const doc = this.serializer.createDeletionDoc(path);
        doc._rev = existing._rev;
        doc.deviceName = this.settings.deviceName;
        await this.localDB.put(doc);
        this.handler({ type: "doc-pushed", path });
      }
    } catch (e: any) {
      this.handler({ type: "error", message: `Delete push failed for ${path}: ${e.message}` });
    }
  }

  /** Handle documents coming in from replication */
  private async handleIncomingChanges(docs: SinkDoc[]): Promise<void> {
    for (const doc of docs) {
      // Skip non-file documents (chunks, design docs, etc.)
      if (!doc.type || doc.type !== "file") continue;
      if (!doc.path) continue;

      // Skip if it's from this device
      if (doc.deviceName === this.settings.deviceName) continue;

      try {
        let processedDoc = doc;

        // Decrypt if needed
        if (this.crypto && doc.iv) {
          processedDoc = await this.decryptDoc(doc);
        }

        // Mark as processing to avoid re-syncing our own writes
        this.processing.add(processedDoc.path);

        await this.serializer.docToFile(processedDoc);
        this.handler({ type: "doc-pulled", path: processedDoc.path });

        // Remove processing flag after a short delay (let Obsidian events settle)
        setTimeout(() => {
          this.processing.delete(processedDoc.path);
        }, 500);
      } catch (e: any) {
        this.processing.delete(doc.path);
        this.handler({ type: "error", message: `Pull failed for ${doc.path}: ${e.message}` });
      }
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
  async pushVaultToServer(): Promise<number> {
    const files = this.vault.getFiles();
    let count = 0;
    for (const file of files) {
      if (!this.settings.syncConfigFolder && file.path.startsWith(".obsidian/")) continue;
      if (file.path === ".obsidian/plugins/sink/data.json") continue;

      await this.pushFile(file);
      count++;
    }
    return count;
  }

  /** Pull all docs from remote and write to vault */
  async pullServerToVault(): Promise<number> {
    // First do a one-shot pull
    if (this.replicator) {
      await this.replicator.pullOnce();
    }

    // Then read all file docs from local DB and write them
    const result = await this.localDB.allDocs();
    let count = 0;

    for (const row of result.rows) {
      const doc = row.doc as SinkDoc;
      if (!doc || doc.type !== "file" || doc.deleted) continue;

      let processedDoc = doc;
      if (this.crypto && doc.iv) {
        processedDoc = await this.decryptDoc(doc);
      }

      this.processing.add(processedDoc.path);
      await this.serializer.docToFile(processedDoc);
      this.processing.delete(processedDoc.path);
      count++;
    }
    return count;
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

  /** Update settings reference */
  updateSettings(settings: SinkSettings): void {
    this.settings = settings;
    this.remoteDB.updateSettings(settings);
    if (settings.passphrase) {
      this.crypto = new CryptoHelper(settings.passphrase);
    } else {
      this.crypto = null;
    }
  }
}
