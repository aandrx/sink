export interface SinkSettings {
  /** CouchDB server URL (e.g., http://100.64.0.1:5984) */
  serverUrl: string;
  /** CouchDB username */
  username: string;
  /** CouchDB password */
  password: string;
  /** Database name on CouchDB */
  dbName: string;
  /** E2E encryption passphrase (empty = no encryption) */
  passphrase: string;
  /** Milliseconds to wait after last edit before pushing */
  syncDelay: number;
  /** Automatically resolve conflicts (true) or prompt user (false) */
  autoResolveConflicts: boolean;
  /** Friendly name for this device */
  deviceName: string;
  /** Whether initial setup has been completed */
  isConfigured: boolean;
  /** Sync .obsidian/ config folder */
  syncConfigFolder: boolean;
}

export const DEFAULT_SETTINGS: SinkSettings = {
  serverUrl: "",
  username: "",
  password: "",
  dbName: "sink",
  passphrase: "",
  syncDelay: 1000,
  autoResolveConflicts: true,
  deviceName: "",
  isConfigured: false,
  syncConfigFolder: true,
};

/** Document stored in CouchDB representing a vault file */
export interface SinkDoc {
  _id: string;
  _rev?: string;
  path: string;
  content: string; // base64 for binary, utf-8 for text
  mtime: number;
  ctime: number;
  size: number;
  deleted?: boolean;
  /** If encrypted, content is ciphertext and this holds the IV */
  iv?: string;
  /** Chunk references for large files */
  chunks?: string[];
  /** Device that last modified this doc */
  deviceName?: string;
  /** Document type marker */
  type: "file" | "chunk" | "meta";
}

/** Chunk document for large files */
export interface SinkChunkDoc {
  _id: string;
  _rev?: string;
  type: "chunk";
  data: string;
}

/** Sync status for the status bar */
export type SyncStatus = "disconnected" | "connected" | "syncing" | "error" | "paused";

/** Events emitted by the sync engine */
export type SyncEvent =
  | { type: "status-change"; status: SyncStatus }
  | { type: "doc-pushed"; path: string }
  | { type: "doc-pulled"; path: string }
  | { type: "conflict"; path: string }
  | { type: "error"; message: string };
