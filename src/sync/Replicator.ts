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
  private generation = 0;
  private oneShots = new Set<PouchDB.Replication.Replication<any>>();

  constructor(localDB: LocalDB, remoteDB: RemoteDB, handler: ReplicatorEventHandler) {
    this.localDB = localDB;
    this.remoteDB = remoteDB;
    this.handler = handler;
  }

  /** Start continuous bidirectional replication */
  start(): void {
    if (this.active) return;
    this.active = true;
    const generation = ++this.generation;
    const emit: ReplicatorEventHandler = (event) => {
      if (this.active && generation === this.generation) this.handler(event);
    };

    const remote = this.remoteDB.instance;
    if (!remote) {
      this.active = false;
      this.handler({ type: "error", error: "Remote DB not connected" });
      return;
    }

    const local = this.localDB.instance;

    // Push: local → remote (continuous)
    this.pushReplication = local.replicate.to(remote, {
      live: true,
      retry: true,
      batch_size: 10,
      batches_limit: 1,
    }) as unknown as PouchDB.Replication.Replication<any>;

    this.pushReplication.on("change", (info: any) => {
      // Push confirmations are not incoming remote edits.
      emit({ type: "status", status: "syncing" });
    });
    this.pushReplication.on("paused", () => {
      emit({ type: "paused" });
      emit({ type: "status", status: "connected" });
    });
    this.pushReplication.on("active", () => {
      emit({ type: "active" });
      emit({ type: "status", status: "syncing" });
    });
    this.pushReplication.on("error", (err: any) => {
      if (!this.active || generation !== this.generation) return;
      emit({ type: "error", error: err });
      if (this.isAuthError(err)) {
        this.stop();
      } else {
        this.handleDisconnect();
      }
    });

    // Pull: remote → local (continuous)
    this.pullReplication = local.replicate.from(remote, {
      live: true,
      retry: true,
      batch_size: 10,
      batches_limit: 1,
    }) as unknown as PouchDB.Replication.Replication<any>;

    this.pullReplication.on("change", (info: any) => {
      emit({ type: "change", docs: info.docs || [] });
      emit({ type: "status", status: "syncing" });
    });
    this.pullReplication.on("paused", () => {
      emit({ type: "paused" });
      emit({ type: "status", status: "connected" });
    });
    this.pullReplication.on("active", () => {
      emit({ type: "active" });
      emit({ type: "status", status: "syncing" });
    });
    this.pullReplication.on("error", (err: any) => {
      if (!this.active || generation !== this.generation) return;
      emit({ type: "error", error: err });
      if (this.isAuthError(err)) {
        this.stop();
      } else {
        this.handleDisconnect();
      }
    });

    this.handler({ type: "status", status: "connected" });
  }

  /** Stop replication */
  stop(): void {
    this.active = false;
    this.generation++;
    for (const replication of this.oneShots) replication.cancel();
    this.oneShots.clear();
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

  /** Check if error is an auth failure (don't retry these) */
  private isAuthError(err: any): boolean {
    return err?.status === 401 || err?.status === 403;
  }

  /** Handle disconnect with exponential backoff retry */
  private handleDisconnect(): void {
    if (!this.active) return;
    this.generation++;
    if (this.retryTimeout) clearTimeout(this.retryTimeout);

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
      this.retryTimeout = null;
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
    await this.trackOneShot(local.replicate.to(remote, { batch_size: 10, batches_limit: 1 }) as unknown as PouchDB.Replication.Replication<any>);
  }

  /** Perform a one-shot pull (remote → local) */
  async pullOnce(): Promise<void> {
    const remote = this.remoteDB.instance;
    if (!remote) throw new Error("Remote DB not connected");
    const local = this.localDB.instance;
    await this.trackOneShot(local.replicate.from(remote, { batch_size: 10, batches_limit: 1 }) as unknown as PouchDB.Replication.Replication<any>);
  }

  private async trackOneShot(replication: PouchDB.Replication.Replication<any>): Promise<void> {
    this.oneShots.add(replication);
    try {
      await replication;
    } finally {
      this.oneShots.delete(replication);
    }
  }

  get isActive(): boolean {
    return this.active;
  }
}
