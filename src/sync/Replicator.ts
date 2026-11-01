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

type Direction = "push" | "pull";
type DirectionState = "idle" | "active" | "paused" | "error";

export class Replicator {
  private static readonly INITIAL_RETRY_DELAY = 3000;
  private static readonly MAX_RETRY_DELAY = 30000;

  private localDB: LocalDB;
  private remoteDB: RemoteDB;
  private pushReplication: PouchDB.Replication.Replication<any> | null = null;
  private pullReplication: PouchDB.Replication.Replication<any> | null = null;
  private handler: ReplicatorEventHandler;
  private retryTimeout: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = Replicator.INITIAL_RETRY_DELAY;
  private maxRetryDelay = Replicator.MAX_RETRY_DELAY;
  private active = false;
  private generation = 0;
  private oneShots = new Set<PouchDB.Replication.Replication<any>>();
  private pushState: DirectionState = "idle";
  private pullState: DirectionState = "idle";
  private lastStatus: SyncStatus | null = null;

  constructor(localDB: LocalDB, remoteDB: RemoteDB, handler: ReplicatorEventHandler) {
    this.localDB = localDB;
    this.remoteDB = remoteDB;
    this.handler = handler;
  }

  /** Start continuous bidirectional replication */
  start(): void {
    this.startInternal(true);
  }

  private startInternal(resetBackoff: boolean): void {
    if (this.active) return;
    this.active = true;
    if (resetBackoff) this.retryDelay = Replicator.INITIAL_RETRY_DELAY;
    this.pushState = "idle";
    this.pullState = "idle";
    this.lastStatus = null;
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
    this.pushReplication = local.replicate.to(remote, this.replicationOptions("push", generation)) as unknown as PouchDB.Replication.Replication<any>;
    this.attachHandlers(this.pushReplication, "push", emit, generation);

    // Pull: remote → local (continuous)
    this.pullReplication = local.replicate.from(remote, this.replicationOptions("pull", generation)) as unknown as PouchDB.Replication.Replication<any>;
    this.attachHandlers(this.pullReplication, "pull", emit, generation);
  }

  private replicationOptions(direction: Direction, generation: number): PouchDB.Replication.ReplicateOptions {
    return {
      live: true,
      retry: true,
      batch_size: 10,
      batches_limit: 1,
      ...(direction === "pull" ? { selector: this.inboundSelector() } : {
        filter: (doc: any) => {
          if (!this.active || generation !== this.generation) return false;
          return this.shouldReplicate(doc);
        },
      }),
    } as PouchDB.Replication.ReplicateOptions;
  }

  /** CouchDB's built-in selector excludes legacy snapshots before sending their bodies. */
  private inboundSelector() {
    return { $or: [
      { _id: { $regex: "^file:" }, type: "file" },
      { _id: { $regex: "^chunk:" }, type: "chunk" },
      { _id: { $regex: "^meta:device:" }, type: "meta", metaType: "device" },
      { _id: { $regex: "^(file:|chunk:|meta:device:)" }, _deleted: true },
    ] };
  }

  private attachHandlers(
    replication: PouchDB.Replication.Replication<any>,
    direction: Direction,
    emit: ReplicatorEventHandler,
    generation: number
  ): void {
    const current = () => this.active && generation === this.generation;

    replication.on("change", (info: any) => {
      if (!current()) return;
      this.retryDelay = Replicator.INITIAL_RETRY_DELAY;
      if (direction === "pull") emit({ type: "change", docs: info?.docs || [] });
      this.setState(direction, "active", emit);
    });
    replication.on("active", () => {
      if (!current()) return;
      this.retryDelay = Replicator.INITIAL_RETRY_DELAY;
      emit({ type: "active" });
      this.setState(direction, "active", emit);
    });
    replication.on("paused", (err?: any) => {
      if (!current()) return;
      if (err) {
        this.handleReplicationError(err, emit);
        return;
      }
      this.retryDelay = Replicator.INITIAL_RETRY_DELAY;
      emit({ type: "paused" });
      this.setState(direction, "paused", emit);
    });
    replication.on("error", (err: any) => {
      if (!current()) return;
      this.handleReplicationError(err, emit);
    });
  }

  private setState(direction: Direction, state: DirectionState, emit: ReplicatorEventHandler): void {
    if (direction === "push") this.pushState = state;
    else this.pullState = state;

    const status = this.aggregateStatus();
    if (status === this.lastStatus) return;
    this.lastStatus = status;
    emit({ type: "status", status });
  }

  private aggregateStatus(): SyncStatus {
    if (this.pushState === "error" || this.pullState === "error") return "error";
    if (this.pushState === "active" || this.pullState === "active") return "syncing";
    if (this.pushState === "paused" || this.pullState === "paused") return "connected";
    return "disconnected";
  }

  private handleReplicationError(err: any, emit: ReplicatorEventHandler): void {
    const authError = this.isAuthError(err);
    emit({ type: "error", error: authError ? this.structuredAuthError(err) : err });
    this.handleDisconnect(emit);
    if (authError) this.stop();
  }

  private structuredAuthError(err: any): Error {
    const status = err?.status;
    const detail = err?.message ? `: ${err.message}` : "";
    const error = new Error(`Authentication failed (${status})${detail}`);
    (error as any).status = status;
    (error as any).cause = err;
    return error;
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
    this.pushState = "idle";
    this.pullState = "idle";
    this.retryDelay = Replicator.INITIAL_RETRY_DELAY;
    this.lastStatus = "disconnected";
    this.handler({ type: "status", status: "disconnected" });
  }

  /** Check if error is an auth failure (don't retry these) */
  private isAuthError(err: any): boolean {
    return err?.status === 401 || err?.status === 403;
  }

  /** Handle disconnect with exponential backoff retry */
  private handleDisconnect(emit: ReplicatorEventHandler): void {
    if (!this.active) return;
    if (this.retryTimeout) clearTimeout(this.retryTimeout);

    this.pushState = "error";
    this.pullState = "error";
    const status = this.aggregateStatus();
    if (status !== this.lastStatus) {
      this.lastStatus = status;
      emit({ type: "status", status });
    }

    // Ignore callbacks from the cancelled replications below.
    this.generation++;

    // Cancel existing replications
    if (this.pushReplication) {
      this.pushReplication.cancel();
      this.pushReplication = null;
    }
    if (this.pullReplication) {
      this.pullReplication.cancel();
      this.pullReplication = null;
    }

    // Retry with exponential backoff, without resetting the delay on every retry.
    this.retryTimeout = setTimeout(() => {
      this.retryTimeout = null;
      if (this.active) {
        this.active = false; // Reset so startInternal() works
        this.startInternal(false);
      }
    }, this.retryDelay);

    this.retryDelay = Math.min(this.retryDelay * 2, this.maxRetryDelay);
  }

  /** Explicit outbound and inbound allowlist. Local docs and legacy snapshots are never replicated. */
  private shouldReplicate(doc: any): boolean {
    const id = doc?._id;
    if (typeof id !== "string") return false;
    if (id.startsWith("_local/")) return false;
    if (id.startsWith("meta:snapshot:")) return false;

    // Deletion tombstones may arrive without a type; keep them for supported ID families.
    if (doc._deleted === true) {
      return id.startsWith("file:") || id.startsWith("chunk:") || id.startsWith("meta:device:");
    }

    if (doc.type === "file") return id.startsWith("file:");
    if (doc.type === "chunk") return id.startsWith("chunk:");
    if (doc.type === "meta" && doc.metaType === "device") return id.startsWith("meta:device:");
    return false;
  }

  /** Perform a one-shot push (local → remote) */
  async pushOnce(): Promise<void> {
    const remote = this.remoteDB.instance;
    if (!remote) throw new Error("Remote DB not connected");
    const local = this.localDB.instance;
    await this.trackOneShot(local.replicate.to(remote, {
      batch_size: 10,
      batches_limit: 1,
      filter: (doc: any) => this.shouldReplicate(doc),
    } as PouchDB.Replication.ReplicateOptions) as unknown as PouchDB.Replication.Replication<any>);
  }

  /** Perform a one-shot pull (remote → local) */
  async pullOnce(): Promise<void> {
    const remote = this.remoteDB.instance;
    if (!remote) throw new Error("Remote DB not connected");
    const local = this.localDB.instance;
    await this.trackOneShot(local.replicate.from(remote, {
      batch_size: 10,
      batches_limit: 1,
      selector: this.inboundSelector(),
    } as PouchDB.Replication.ReplicateOptions) as unknown as PouchDB.Replication.Replication<any>);
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
