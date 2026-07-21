import { constants, Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SemctxError } from "@semantic-context/core";
import type {
  RepositoryGraph,
  RepositoryNode,
  RepositoryEdge,
  EvidenceRecord,
  Claim,
  TaskFrame,
  ContextPack,
} from "@semantic-context/core";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  file_path: string | null;
  bounded_context: string | null;
  exported: number | null;
  tags: string;
  evidence: string;
  metadata: string;
}

interface EdgeRow {
  id: string;
  kind: string;
  from_id: string;
  to_id: string;
  evidence: string;
  metadata: string;
}

interface EvidenceRow {
  id: string;
  file_path: string;
  start_line: number | null;
  end_line: number | null;
  source_kind: string;
  excerpt: string | null;
}

interface ClaimRow {
  id: string;
  kind: string;
  statement: string;
  subject_node_ids: string;
  evidence_ids: string;
  authority: number;
  freshness: number;
  confidence: number;
  verification_status: string;
  valid_from: string | null;
  valid_until: string | null;
  tags: string;
}

interface PayloadRow {
  payload: string;
}

export interface RepositoryIndexSnapshot {
  graph: RepositoryGraph;
  evidence: EvidenceRecord[];
  claims: Claim[];
  metadata: Readonly<Record<string, string>>;
}

/** Storage port. The engine and CLI depend on this, never on SQLite directly. */
export interface RepositoryStore {
  saveGraph(graph: RepositoryGraph, evidence: EvidenceRecord[]): void;
  /** Replace graph, evidence, claims and index metadata in one SQLite transaction. */
  replaceIndex(snapshot: RepositoryIndexSnapshot): void;
  loadGraph(): RepositoryGraph;
  loadEvidence(): EvidenceRecord[];
  replaceClaims(claims: Claim[]): void;
  loadClaims(): Claim[];
  saveTaskFrame(taskFrame: TaskFrame): void;
  getTaskFrame(id: string): TaskFrame | undefined;
  listTaskFrames(): TaskFrame[];
  saveContextPack(pack: ContextPack): void;
  getContextPack(taskId: string): ContextPack | undefined;
  setMeta(key: string, value: string): void;
  getMeta(key: string): string | undefined;
  isIndexed(): boolean;
  close(): void;
}

/** Narrow read-only storage port for consumers that must never mutate repository state. */
export interface ReadonlyRepositoryStore {
  loadGraph(): RepositoryGraph;
  loadEvidence(): EvidenceRecord[];
  loadClaims(): Claim[];
  getMeta(key: string): string | undefined;
  isIndexed(): boolean;
  close(): void;
}

/**
 * Existing-database reader. Opening this class never creates or migrates a store,
 * changes its journal mode, or writes metadata.
 */
export class SqliteRepositoryReader implements ReadonlyRepositoryStore {
  readonly #db: Database;

  private constructor(db: Database) {
    this.#db = db;
  }

  static openExisting(dbPath: string): SqliteRepositoryReader {
    if (!existsSync(dbPath)) {
      throw new SemctxError("STORE_ERROR", `repository store does not exist at ${dbPath}`, { dbPath });
    }
    if (existsSync(`${dbPath}-wal`) || existsSync(`${dbPath}-shm`)) {
      throw new SemctxError("STORE_ERROR", `repository store has active WAL sidecars at ${dbPath}`, {
        dbPath,
        reason: "close the writer and checkpoint the database before opening an immutable reader",
      });
    }

    // Bun's DatabaseOptions cannot combine `strict: true` with SQLITE_OPEN_URI.
    // The immutable URI is stricter for this port: SQLite cannot write, create
    // journals, or acquire locks, while the narrow methods bind every parameter.
    const immutableUri = `${pathToFileURL(dbPath).href}?immutable=1`;
    const flags = constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI;
    const db = new Database(immutableUri, flags);
    return new SqliteRepositoryReader(db);
  }

  loadGraph(): RepositoryGraph {
    return loadGraph(this.#db);
  }

  loadEvidence(): EvidenceRecord[] {
    return loadEvidence(this.#db);
  }

  loadClaims(): Claim[] {
    return loadClaims(this.#db);
  }

  getMeta(key: string): string | undefined {
    return getMeta(this.#db, key);
  }

  isIndexed(): boolean {
    return isIndexed(this.#db);
  }

  close(): void {
    this.#db.close();
  }
}

export class SqliteRepositoryStore implements RepositoryStore {
  private readonly db: Database;

  private constructor(db: Database) {
    this.db = db;
  }

  static open(dbPath: string): SqliteRepositoryStore {
    const db = new Database(dbPath, { create: true });
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;");
    db.exec(SCHEMA_SQL);
    const store = new SqliteRepositoryStore(db);
    store.setMeta("schema_version", String(SCHEMA_VERSION));
    return store;
  }

  saveGraph(graph: RepositoryGraph, evidence: EvidenceRecord[]): void {
    const tx = this.db.transaction(() => {
      replaceGraphRows(this.db, graph, evidence);
      setMetaValue(this.db, "node_count", String(graph.nodes.length));
      setMetaValue(this.db, "edge_count", String(graph.edges.length));
    });
    tx();
  }

  replaceIndex(snapshot: RepositoryIndexSnapshot): void {
    const tx = this.db.transaction(() => {
      replaceGraphRows(this.db, snapshot.graph, snapshot.evidence);
      replaceClaimRows(this.db, snapshot.claims);
      setMetaValue(this.db, "node_count", String(snapshot.graph.nodes.length));
      setMetaValue(this.db, "edge_count", String(snapshot.graph.edges.length));
      for (const [key, value] of Object.entries(snapshot.metadata)) setMetaValue(this.db, key, value);
    });
    tx();
  }

  loadGraph(): RepositoryGraph {
    return loadGraph(this.db);
  }

  loadEvidence(): EvidenceRecord[] {
    return loadEvidence(this.db);
  }

  replaceClaims(claims: Claim[]): void {
    const tx = this.db.transaction(() => {
      replaceClaimRows(this.db, claims);
    });
    tx();
  }

  loadClaims(): Claim[] {
    return loadClaims(this.db);
  }

  saveTaskFrame(taskFrame: TaskFrame): void {
    this.db
      .query(`INSERT OR REPLACE INTO task_frames (id, raw_task, payload, created_at) VALUES (?, ?, ?, ?)`)
      .run(taskFrame.id, taskFrame.rawTask, JSON.stringify(taskFrame), taskFrame.createdAt);
  }

  getTaskFrame(id: string): TaskFrame | undefined {
    const row = this.db.query(`SELECT payload FROM task_frames WHERE id = ?`).get(id) as PayloadRow | null;
    return row === null ? undefined : (JSON.parse(row.payload) as TaskFrame);
  }

  listTaskFrames(): TaskFrame[] {
    const rows = this.db.query(`SELECT payload FROM task_frames ORDER BY created_at DESC`).all() as PayloadRow[];
    return rows.map((r) => JSON.parse(r.payload) as TaskFrame);
  }

  saveContextPack(pack: ContextPack): void {
    this.db
      .query(`INSERT OR REPLACE INTO context_packs (id, task_id, payload, generated_at) VALUES (?, ?, ?, ?)`)
      .run(pack.taskFrame.id, pack.taskFrame.id, JSON.stringify(pack), pack.generatedAt);
  }

  getContextPack(taskId: string): ContextPack | undefined {
    const row = this.db.query(`SELECT payload FROM context_packs WHERE task_id = ?`).get(taskId) as PayloadRow | null;
    return row === null ? undefined : (JSON.parse(row.payload) as ContextPack);
  }

  setMeta(key: string, value: string): void {
    setMetaValue(this.db, key, value);
  }

  getMeta(key: string): string | undefined {
    return getMeta(this.db, key);
  }

  isIndexed(): boolean {
    return isIndexed(this.db);
  }

  close(): void {
    this.db.close();
  }
}

function replaceGraphRows(db: Database, graph: RepositoryGraph, evidence: EvidenceRecord[]): void {
  db.exec("DELETE FROM nodes; DELETE FROM edges; DELETE FROM evidence;");
  const insNode = db.query(
    `INSERT OR REPLACE INTO nodes (id, kind, name, file_path, bounded_context, exported, tags, evidence, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const node of graph.nodes) {
    insNode.run(
      node.id,
      node.kind,
      node.name,
      node.filePath ?? null,
      node.boundedContext ?? null,
      node.exported === undefined ? null : node.exported ? 1 : 0,
      JSON.stringify(node.tags),
      JSON.stringify(node.evidence),
      JSON.stringify(node.metadata),
    );
  }
  const insEdge = db.query(
    `INSERT OR REPLACE INTO edges (id, kind, from_id, to_id, evidence, metadata) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const edge of graph.edges) {
    insEdge.run(edge.id, edge.kind, edge.from, edge.to, JSON.stringify(edge.evidence), JSON.stringify(edge.metadata));
  }
  const insEvidence = db.query(
    `INSERT OR REPLACE INTO evidence (id, file_path, start_line, end_line, source_kind, excerpt) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const item of evidence) {
    insEvidence.run(item.id, item.filePath, item.startLine ?? null, item.endLine ?? null, item.sourceKind, item.excerpt ?? null);
  }
}

function replaceClaimRows(db: Database, claims: Claim[]): void {
  db.exec("DELETE FROM claims;");
  const insert = db.query(
    `INSERT OR REPLACE INTO claims
     (id, kind, statement, subject_node_ids, evidence_ids, authority, freshness, confidence, verification_status, valid_from, valid_until, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const claim of claims) {
    insert.run(
      claim.id,
      claim.kind,
      claim.statement,
      JSON.stringify(claim.subjectNodeIds),
      JSON.stringify(claim.evidenceIds),
      claim.authority,
      claim.freshness,
      claim.confidence,
      claim.verificationStatus,
      claim.validFrom ?? null,
      claim.validUntil ?? null,
      JSON.stringify(claim.tags),
    );
  }
}

function setMetaValue(db: Database, key: string, value: string): void {
  db.query(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run(key, value);
}

function loadGraph(db: Database): RepositoryGraph {
  const nodeRows = db.query(`SELECT * FROM nodes ORDER BY id`).all() as NodeRow[];
  const edgeRows = db.query(`SELECT * FROM edges ORDER BY id`).all() as EdgeRow[];
  return {
    nodes: nodeRows.map(rowToNode),
    edges: edgeRows.map(rowToEdge),
  };
}

function loadEvidence(db: Database): EvidenceRecord[] {
  const rows = db.query(`SELECT * FROM evidence ORDER BY id`).all() as EvidenceRow[];
  return rows.map(rowToEvidence);
}

function loadClaims(db: Database): Claim[] {
  const rows = db.query(`SELECT * FROM claims ORDER BY id`).all() as ClaimRow[];
  return rows.map(rowToClaim);
}

function getMeta(db: Database, key: string): string | undefined {
  const row = db.query(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | null;
  return row === null ? undefined : row.value;
}

function isIndexed(db: Database): boolean {
  const row = db.query(`SELECT COUNT(*) AS c FROM nodes`).get() as { c: number } | null;
  return row !== null && row.c > 0;
}

function parseJsonArray(text: string): unknown[] {
  const value = JSON.parse(text);
  if (!Array.isArray(value)) throw new SemctxError("STORE_ERROR", "expected JSON array", { text });
  return value;
}

function rowToNode(row: NodeRow): RepositoryNode {
  return {
    id: row.id,
    kind: row.kind as RepositoryNode["kind"],
    name: row.name,
    ...(row.file_path !== null ? { filePath: row.file_path } : {}),
    ...(row.bounded_context !== null ? { boundedContext: row.bounded_context } : {}),
    ...(row.exported !== null ? { exported: row.exported === 1 } : {}),
    evidence: parseJsonArray(row.evidence) as RepositoryNode["evidence"],
    tags: parseJsonArray(row.tags) as string[],
    metadata: JSON.parse(row.metadata) as RepositoryNode["metadata"],
  };
}

function rowToEdge(row: EdgeRow): RepositoryEdge {
  return {
    id: row.id,
    kind: row.kind as RepositoryEdge["kind"],
    from: row.from_id,
    to: row.to_id,
    evidence: parseJsonArray(row.evidence) as RepositoryEdge["evidence"],
    metadata: JSON.parse(row.metadata) as RepositoryEdge["metadata"],
  };
}

function rowToEvidence(row: EvidenceRow): EvidenceRecord {
  return {
    id: row.id,
    filePath: row.file_path,
    ...(row.start_line !== null ? { startLine: row.start_line } : {}),
    ...(row.end_line !== null ? { endLine: row.end_line } : {}),
    sourceKind: row.source_kind as EvidenceRecord["sourceKind"],
    ...(row.excerpt !== null ? { excerpt: row.excerpt } : {}),
  };
}

function rowToClaim(row: ClaimRow): Claim {
  return {
    id: row.id,
    kind: row.kind as Claim["kind"],
    statement: row.statement,
    subjectNodeIds: parseJsonArray(row.subject_node_ids) as string[],
    evidenceIds: parseJsonArray(row.evidence_ids) as string[],
    authority: row.authority,
    freshness: row.freshness,
    confidence: row.confidence,
    verificationStatus: row.verification_status as Claim["verificationStatus"],
    ...(row.valid_from !== null ? { validFrom: row.valid_from } : {}),
    ...(row.valid_until !== null ? { validUntil: row.valid_until } : {}),
    tags: parseJsonArray(row.tags) as string[],
  };
}
