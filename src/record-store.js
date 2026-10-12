import { nowIso, toSerializable } from "./record-utils.js";

const DATABASE_NAME = "anna-agent-session-demo";
const DATABASE_VERSION = 1;
const STORE_NAME = "call-records";
const UNFINISHED_STATUSES = new Set(["running", "waiting_stopped"]);

let databasePromise = null;

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: "record_id" });
        store.createIndex("started_at", "started_at");
        store.createIndex("category", "category");
        store.createIndex("status", "status");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open IndexedDB"));
  });
  return databasePromise;
}

async function runTransaction(mode, action) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    let result;
    try {
      result = action(store);
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(result?.result);
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
  });
}

export async function putCallRecord(record) {
  const snapshot = toSerializable(record);
  await runTransaction("readwrite", (store) => store.put(snapshot));
  return snapshot;
}

export async function listCallRecords() {
  const records = await runTransaction("readonly", (store) => store.getAll());
  return (records || []).sort((left, right) => String(right.started_at).localeCompare(String(left.started_at)));
}

export async function deleteCallRecord(recordId) {
  await runTransaction("readwrite", (store) => store.delete(recordId));
}

export async function clearCallRecords() {
  await runTransaction("readwrite", (store) => store.clear());
}

export async function markUnfinishedRecordsInterrupted() {
  const records = await listCallRecords();
  const endedAt = nowIso();
  const unfinished = records.filter((record) => UNFINISHED_STATUSES.has(record.status));
  for (const record of unfinished) {
    const startedMs = Date.parse(record.started_at);
    record.status = "interrupted";
    record.ended_at = endedAt;
    record.duration_ms = Number.isFinite(startedMs) ? Math.max(0, Date.parse(endedAt) - startedMs) : null;
    record.events = [
      ...(Array.isArray(record.events) ? record.events : []),
      { event: "page.reloaded", at: endedAt, message: "Page reloaded; background capture interrupted" },
    ];
    await putCallRecord(record);
  }
  return unfinished.length;
}
