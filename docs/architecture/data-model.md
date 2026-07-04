# Data Model

All persisted state lives in one SQLite file (`.semctx/semctx.db`). JSON blobs are used
for flexible sub-structures (evidence arrays, metadata); indexed columns are used for the
fields we query on.

## Tables

### `nodes`
| column           | type | notes                                  |
| ---------------- | ---- | -------------------------------------- |
| id               | TEXT PRIMARY KEY | deterministic (`sym:function:...`) |
| kind             | TEXT | `NodeKind`                             |
| name             | TEXT | human-readable                        |
| file_path        | TEXT NULL | primary location                 |
| bounded_context  | TEXT NULL | inferred bounded context id      |
| exported         | INTEGER | 0/1                                |
| tags             | TEXT | JSON string[]                          |
| evidence         | TEXT | JSON EvidenceRef[]                     |
| metadata         | TEXT | JSON Record                            |

### `edges`
| column   | type | notes                    |
| -------- | ---- | ------------------------ |
| id       | TEXT PRIMARY KEY | deterministic |
| kind     | TEXT | `EdgeKind`               |
| from_id  | TEXT | FK nodes.id (logical)    |
| to_id    | TEXT | FK nodes.id (logical)    |
| evidence | TEXT | JSON EvidenceRef[]       |
| metadata | TEXT | JSON Record              |

Indexes on `from_id`, `to_id`, `kind` for traversal.

### `claims`
| column              | type | notes                       |
| ------------------- | ---- | --------------------------- |
| id                  | TEXT PRIMARY KEY | deterministic   |
| kind                | TEXT | `ClaimKind`                 |
| statement           | TEXT |                             |
| subject_node_ids    | TEXT | JSON string[]               |
| evidence_ids        | TEXT | JSON string[]               |
| authority           | REAL | [0,1]                       |
| freshness           | REAL | [0,1]                       |
| confidence          | REAL | [0,1]                       |
| verification_status | TEXT | `VerificationStatus`        |
| valid_from          | TEXT NULL |                        |
| valid_until         | TEXT NULL |                        |
| tags                | TEXT | JSON string[]               |

### `evidence`
`id` (deterministic), `file_path`, `start_line`, `end_line`, `source_kind`, `excerpt`.

### `task_frames`
`id`, `raw_task`, `payload` (JSON of the full `TaskFrame`), `created_at`.

### `context_packs`
`id` (= task id), `task_id`, `payload` (JSON of the full `ContextPack`), `generated_at`.

### `meta`
key/value: `schema_version`, `indexed_at`, `config_hash`.

## Why JSON columns for evidence/metadata

Evidence and metadata are read as whole objects with the node/claim; we never filter on
their inner fields in SQL. Storing them as JSON keeps the schema small and the code
honest (no premature normalisation). The fields we *do* query (kind, name, from/to,
bounded_context, verification_status) are real columns with indexes.

## Node kinds vs claim kinds

Nodes are *things in the repo* (a function, a test, a doc, a migration, an invariant
marker). Claims are *assertions about nodes* with a verification status and authority
(the exported signature IS a statically-verified contract; a passing test PROVES a
behaviour; an ADR DOCUMENTS a decision). The engine ranks claims; nodes are selected via
the claims and edges that reference them.
