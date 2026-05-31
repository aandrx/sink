/**
 * Single point of PouchDB initialization.
 * Import this before using PouchDB anywhere to ensure plugins are only registered once.
 */
import PouchDB from "pouchdb-core";
import idbAdapter from "pouchdb-adapter-idb";
import httpAdapter from "pouchdb-adapter-http";
import replication from "pouchdb-replication";
import mapreduce from "pouchdb-mapreduce";

PouchDB.plugin(idbAdapter);
PouchDB.plugin(httpAdapter);
PouchDB.plugin(replication);
PouchDB.plugin(mapreduce);

export { PouchDB };
