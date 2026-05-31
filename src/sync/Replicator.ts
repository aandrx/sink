import type { SinkDoc, SinkChunkDoc, SyncStatus } from "../settings";
import type { LocalDB } from "./LocalDB";
import type { RemoteDB } from "./RemoteDB";

export type ReplicatorEvent =
  | { type: "change"; docs: Array<SinkDoc | SinkChunkDoc> }
  | { type: "status"; status: SyncStatus }
  | { type: "error"; error: any }
  | { type: "paused" }
  | { type: "active" };

export type ReplicatorEventHandler = (event: ReplicatorEvent) => void;

export class Replicator {
  private localDB: LocalDB;
  private remoteDB: RemoteDB;
  private pushReplication: PouchDB.Replication.Replication<any> | null = null;
  private pullReplication: PouchDB.Replication.Replication<any> | null = null;
  private handler: ReplicatorEventHandler;
  private retryTimeout: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 3000;
  private maxRetryDelay = 30000;
  private active = false;

  constructor(localDB: LocalDB, remoteDB: RemoteDB, handler: ReplicatorEventHandler) {
    this.localDB = localDB;
    this.remoteDB = remoteDB;
    this.handler = handler;
  }

  /** Start continuous bidirectional replication */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.retryDelay = 3000;

    const remote = this.remoteDB.instance;
    if (!remote) {
      this.handler({ type: "error", error: "Remote DB not connected" });
      return;
    }

    const local = this.localDB.instance;

    // Push: local → remote (continuous)
    this.pushReplication = local.replicate.to(remote, {
      live: true,
      retry: true,
      batch_size: 50,
      batches_limit: 5,
    }) as unknown as PouchDB.Replication.Replication<any>;

    this.pushReplication.on("change", (info: any) => {
      this.handler({ type: "change", docs: info.docs || [] });
      this.handler({ type: "status", status: "syncing" });
    });
    this.pushReplication.on("paused", () => {
      this.handler({ type: "paused" });
      this.handler({ type: "status", status: "connected" });
    });
    this.pushReplication.on("active", () => {
      this.handler({ type: "active" });
      this.handler({ type: "status", status: "syncing" });
    });
    this.pushReplication.on("error", (err: any) => {
      this.handler({ type: "error", error: err });
      this.handleDisconnect();
    });

    // Pull: remote → local (continuous)
    this.pullReplication = local.replicate.from(remote, {
      live: true,
      retry: true,
      batch_size: 50,
      batches_limit: 5,
    }) as unknown as PouchDB.Replication.Replication<any>;

    this.pullReplication.on("change", (info: any) => {
      this.handler({ type: "change", docs: info.docs || [] });
      this.handler({ type: "status", status: "syncing" });
    });
    this.pullReplication.on("paused", () => {
      this.handler({ type: "paused" });
      this.handler({ type: "status", status: "connected" });
    });
    this.pullReplication.on("active", () => {
      this.handler({ type: "active" });
      this.handler({ type: "status", status: "syncing" });
    });
    this.pullReplication.on("error", (err: any) => {
      this.handler({ type: "error", error: err });
      this.handleDisconnect();
    });

    this.handler({ type: "status", status: "connected" });
  }

  /** Stop replication */
  stop(): void {
    this.active = false;
    if (this.pushReplication) {
      this.pushReplication.cancel();
      this.pushReplication = null;
    }
    if (this.pullReplication) {
      this.pullReplication.cancel();
      this.pullReplication = null;
    }
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = null;
    }
    this.handler({ type: "status", status: "disconnected" });
  }

  /** Handle disconnect with exponential backoff retry */
  private handleDisconnect(): void {
    if (!this.active) return;

    this.handler({ type: "status", status: "error" });

    // Cancel existing replications
    if (this.pushReplication) {
      this.pushReplication.cancel();
      this.pushReplication = null;
    }
    if (this.pullReplication) {
      this.pullReplication.cancel();
      this.pullReplication = null;
    }

    // Retry with exponential backoff
    this.retryTimeout = setTimeout(() => {
      if (this.active) {
        this.active = false; // Reset so start() works
        this.start();
      }
    }, this.retryDelay);

    this.retryDelay = Math.min(this.retryDelay * 2, this.maxRetryDelay);
  }

  /** Perform a one-shot push (local → remote) */
  async pushOnce(): Promise<void> {
    const remote = this.remoteDB.instance;
    if (!remote) throw new Error("Remote DB not connected");
    const local = this.localDB.instance;
    await local.replicate.to(remote);
  }

  /** Perform a one-shot pull (remote → local) */
  async pullOnce(): Promise<void> {
    const remote = this.remoteDB.instance;
    if (!remote) throw new Error("Remote DB not connected");
    const local = this.localDB.instance;
    await local.replicate.from(remote);
  }

  get isActive(): boolean {
    return this.active;
  }
}
