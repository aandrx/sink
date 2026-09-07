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
  /** Stable ID for this device across restarts */
  deviceId: string;
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
  deviceId: "",
  isConfigured: false,
  syncConfigFolder: true,
};

export type DeviceRole = "primary" | "secondary";

export type ChangeDecision = "keep-local" | "keep-remote" | "merge" | "skip";

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
  /** Stable device UUID that last modified this doc */
  deviceId?: string;
  /** Document type marker */
  type: "file" | "chunk" | "meta";
}

export interface DeviceMetaDoc {
  _id: string;
  _rev?: string;
  type: "meta";
  metaType: "device";
  deviceId: string;
  deviceName: string;
  pluginVersion?: string;
  role: DeviceRole;
  vaultName: string;
  lastSeen: number;
  lastPushAt?: number;
  lastPullAt?: number;
}

export interface SnapshotFileEntry {
  path: string;
  existed: boolean;
  isBinary: boolean;
  content: string;
  mtime?: number;
  ctime?: number;
}

export interface SnapshotMetaDoc {
  _id: string;
  _rev?: string;
  type: "meta";
  metaType: "snapshot";
  createdAt: number;
  reason: string;
  sourceDevice: string;
  files: SnapshotFileEntry[];
}

export interface PendingChange {
  path: string;
  sourceDevice: string;
  sourceDeviceId?: string;
  remoteMtime: number;
  localMtime?: number;
  remoteDeleted: boolean;
  localExists: boolean;
  localContent?: string;
  remoteContent?: string;
  isBinary: boolean;
  suggested: ChangeDecision;
}

export interface ReviewedChange {
  path: string;
  selected: boolean;
  decision: ChangeDecision;
}

export interface ReviewResult {
  approved: boolean;
  decisions: ReviewedChange[];
}

export interface SnapshotSummary {
  id: string;
  createdAt: number;
  reason: string;
  fileCount: number;
}

/** Chunk document for large files */
export interface SinkChunkDoc {
  _id: string;
  _rev?: string;
  type: "chunk";
  data: string;
}

export type SinkStoredDoc = SinkDoc | SinkChunkDoc | DeviceMetaDoc | SnapshotMetaDoc;

export interface KnownDevice {
  deviceId: string;
  deviceName: string;
  pluginVersion?: string;
  role: DeviceRole;
  vaultName: string;
  lastSeen: number;
  lastPushAt?: number;
  lastPullAt?: number;
  isActive: boolean;
  isCurrentDevice: boolean;
}

/** Sync status for the status bar */
export type SyncStatus = "disconnected" | "connected" | "syncing" | "error" | "paused";

/** Events emitted by the sync engine */
export type SyncEvent =
  | { type: "status-change"; status: SyncStatus }
  | { type: "doc-pushed"; path: string }
  | { type: "doc-pulled"; path: string; sourceDevice?: string; sourceDeviceId?: string }
  | { type: "conflict"; path: string }
  | { type: "error"; message: string };
