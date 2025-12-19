import "server-only";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const dataDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, "pricetax.sqlite");
export const db = new Database(dbPath);

// Performance/segurança básica
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

function indexExists(indexName: string) {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
    .get(indexName);
  return !!row;
}

function ensureSchema() {
  // -----------------------------
  // analysis_runs (já usa no MVP)
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
  // docs + doc_chunks + FTS
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

    CREATE TABLE IF NOT EXISTS doc_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      docId INTEGER NOT NULL,
      chunkIndex INTEGER NOT NULL,
      content TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      FOREIGN KEY(docId) REFERENCES docs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_doc_chunks_docId ON doc_chunks(docId);

    -- FTS5 para busca rápida
    CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunks_fts
    USING fts5(content, docKey, chunkIndex, content='');

    -- Mantém FTS sincronizado
    CREATE TRIGGER IF NOT EXISTS doc_chunks_ai AFTER INSERT ON doc_chunks BEGIN
      INSERT INTO doc_chunks_fts(rowid, content, docKey, chunkIndex)
      VALUES (new.id, new.content,
        (SELECT docKey FROM docs WHERE id=new.docId),
        new.chunkIndex
      );
    END;

    CREATE TRIGGER IF NOT EXISTS doc_chunks_ad AFTER DELETE ON doc_chunks BEGIN
      INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, content, docKey, chunkIndex)
      VALUES('delete', old.id, old.content,
        (SELECT docKey FROM docs WHERE id=old.docId),
        old.chunkIndex
      );
    END;

    CREATE TRIGGER IF NOT EXISTS doc_chunks_au AFTER UPDATE ON doc_chunks BEGIN
      INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, content, docKey, chunkIndex)
      VALUES('delete', old.id, old.content,
        (SELECT docKey FROM docs WHERE id=old.docId),
        old.chunkIndex
      );
      INSERT INTO doc_chunks_fts(rowid, content, docKey, chunkIndex)
      VALUES (new.id, new.content,
        (SELECT docKey FROM docs WHERE id=new.docId),
        new.chunkIndex
      );
    END;
  `);

  // -----------------------------
  // MIGRAÇÕES (DB pode já existir)
  // -----------------------------

  // 1) MIGRAÇÃO: se teu DB já existia sem docKey
  if (tableExists("docs") && !colExists("docs", "docKey")) {
    // adiciona coluna (não dá pra adicionar NOT NULL/UNIQUE via ALTER simples)
    db.exec(`ALTER TABLE docs ADD COLUMN docKey TEXT;`);

    // preenche docKey em linhas antigas para não ficar null
    // (garante unicidade simples)
    db.exec(`
      UPDATE docs
      SET docKey = 'doc_' || id
      WHERE docKey IS NULL OR docKey = '';
    `);
  }

  // garante índice único no docKey (equivalente ao UNIQUE)
  if (tableExists("docs") && colExists("docs", "docKey") && !indexExists("idx_docs_docKey")) {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_docs_docKey ON docs(docKey);`);
  }

  // 2) MIGRAÇÃO: se teu DB já existia sem updatedAt
  if (tableExists("docs") && !colExists("docs", "updatedAt")) {
    db.exec(`ALTER TABLE docs ADD COLUMN updatedAt TEXT;`);
    // preenche nulls antigos
    db.exec(`UPDATE docs SET updatedAt = createdAt WHERE updatedAt IS NULL;`);
  }
}

ensureSchema();
