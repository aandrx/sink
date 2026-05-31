import PouchDB from "pouchdb-core";
import httpAdapter from "pouchdb-adapter-http";
import replication from "pouchdb-replication";

PouchDB.plugin(httpAdapter);
PouchDB.plugin(replication);

import type { SinkSettings, SinkDoc, SinkChunkDoc } from "../settings";

export interface ConnectionTestResult {
  success: boolean;
  message: string;
}

export class RemoteDB {
  private db: PouchDB.Database<SinkDoc | SinkChunkDoc> | null = null;
  private settings: SinkSettings;

  constructor(settings: SinkSettings) {
    this.settings = settings;
  }

  get instance(): PouchDB.Database<SinkDoc | SinkChunkDoc> | null {
    return this.db;
  }

  /** Build the full database URL */
  private getDbUrl(): string {
    const base = this.settings.serverUrl.replace(/\/$/, "");
    return `${base}/${this.settings.dbName}`;
  }

  /** Connect to remote CouchDB */
  connect(): PouchDB.Database<SinkDoc | SinkChunkDoc> {
    const url = this.getDbUrl();
    this.db = new PouchDB(url, {
      adapter: "http",
      auth: {
        username: this.settings.username,
        password: this.settings.password,
      },
      skip_setup: true,
    } as any);
    return this.db;
  }

  /** Test the connection and optionally create the database */
  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const url = this.getDbUrl();
      const db = new PouchDB(url, {
        adapter: "http",
        auth: {
          username: this.settings.username,
          password: this.settings.password,
        },
        skip_setup: true,
      } as any);

      const info = await db.info();
      if (info.db_name) {
        return { success: true, message: `Connected to "${info.db_name}" (${info.doc_count} docs)` };
      }
      return { success: false, message: "Unexpected response from server" };
    } catch (e: any) {
      if (e.status === 404) {
        // Database doesn't exist — try to create it
        try {
          const base = this.settings.serverUrl.replace(/\/$/, "");
          const response = await fetch(`${base}/${this.settings.dbName}`, {
            method: "PUT",
            headers: {
              Authorization: "Basic " + btoa(`${this.settings.username}:${this.settings.password}`),
              "Content-Type": "application/json",
            },
          });
          if (response.ok) {
            return { success: true, message: `Database "${this.settings.dbName}" created successfully` };
          }
          const body = await response.text();
          return { success: false, message: `Failed to create database: ${body}` };
        } catch (createErr: any) {
          return { success: false, message: `Database not found and creation failed: ${createErr.message}` };
        }
      }
      if (e.status === 401) {
        return { success: false, message: "Authentication failed — check username and password" };
      }
      return { success: false, message: e.message || "Connection failed" };
    }
  }

  /** Disconnect and clean up */
  async disconnect(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }

  /** Update settings (e.g., after setup URI import) */
  updateSettings(settings: SinkSettings): void {
    this.settings = settings;
  }
}
