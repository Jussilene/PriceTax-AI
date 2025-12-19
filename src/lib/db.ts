import "server-only";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const dataDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, "pricetax.sqlite");
export const db = new Database(dbPath);

// Performance / segurança
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

function colExists(table: string, col: string) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
  return rows.some((r) => String(r.name) === col);
}

function tableExists(table: string) {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table);
  return !!row;
}

function ensureSchema() {
  // -----------------------------
  // analysis_runs
  // -----------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS analysis_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userEmail TEXT,
      jobId TEXT,
      createdAt TEXT NOT NULL,
      payloadJson TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_analysis_runs_jobId ON analysis_runs(jobId);
    CREATE INDEX IF NOT EXISTS idx_analysis_runs_userEmail ON analysis_runs(userEmail);
  `);

  // -----------------------------
  // docs
  // -----------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      docKey TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      originalFileName TEXT,
      savedPath TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `);

  // 🔥 MIGRAÇÃO CRÍTICA — garante docKey
  if (tableExists("docs") && !colExists("docs", "docKey")) {
    db.exec(`ALTER TABLE docs ADD COLUMN docKey TEXT;`);
    db.exec(`
      UPDATE docs
      SET docKey = 'legacy-' || id
      WHERE docKey IS NULL;
    `);
  }

  // -----------------------------
  // doc_chunks
  // -----------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS doc_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      docId INTEGER NOT NULL,
      chunkIndex INTEGER NOT NULL,
      content TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      FOREIGN KEY(docId) REFERENCES docs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_doc_chunks_docId ON doc_chunks(docId);
  `);

  // -----------------------------
  // FTS
  // -----------------------------
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunks_fts
    USING fts5(content, docKey, chunkIndex, content='');

    CREATE TRIGGER IF NOT EXISTS doc_chunks_ai AFTER INSERT ON doc_chunks BEGIN
      INSERT INTO doc_chunks_fts(rowid, content, docKey, chunkIndex)
      VALUES (
        new.id,
        new.content,
        (SELECT docKey FROM docs WHERE id = new.docId),
        new.chunkIndex
      );
    END;

    CREATE TRIGGER IF NOT EXISTS doc_chunks_ad AFTER DELETE ON doc_chunks BEGIN
      INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, content, docKey, chunkIndex)
      VALUES(
        'delete',
        old.id,
        old.content,
        (SELECT docKey FROM docs WHERE id = old.docId),
        old.chunkIndex
      );
    END;

    CREATE TRIGGER IF NOT EXISTS doc_chunks_au AFTER UPDATE ON doc_chunks BEGIN
      INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, content, docKey, chunkIndex)
      VALUES(
        'delete',
        old.id,
        old.content,
        (SELECT docKey FROM docs WHERE id = old.docId),
        old.chunkIndex
      );
      INSERT INTO doc_chunks_fts(rowid, content, docKey, chunkIndex)
      VALUES(
        new.id,
        new.content,
        (SELECT docKey FROM docs WHERE id = new.docId),
        new.chunkIndex
      );
    END;
  `);

  // -----------------------------
  // MIGRAÇÃO updatedAt
  // -----------------------------
  if (tableExists("docs") && !colExists("docs", "updatedAt")) {
    db.exec(`ALTER TABLE docs ADD COLUMN updatedAt TEXT;`);
    db.exec(`UPDATE docs SET updatedAt = createdAt WHERE updatedAt IS NULL;`);
  }
}

ensureSchema();
