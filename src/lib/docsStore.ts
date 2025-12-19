// src/lib/docsStore.ts
import "server-only";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

type DocMeta = {
  docKey: string;
  title: string;
  originalFileName?: string | null;
  savedPath?: string | null;
};

type ReplaceChunksArgs = {
  docKey: string;
  chunks: string[];
};

// ✅ AJUSTE MÍNIMO: no Vercel, NÃO usa SQLite (evita erro no build)
// - Mantém o app subindo e com link funcionando
// - Local/dev continua exatamente igual
const USE_MEMORY_STORE = Boolean(process.env.VERCEL);

// -----------------------------
// STORE EM MEMÓRIA (Vercel)
// -----------------------------
const memDocs = new Map<string, DocMeta>();
const memChunks = new Map<string, string[]>();

// -----------------------------
// SQLITE (Local/Dev)
// -----------------------------
let db: Database.Database | null = null;

if (!USE_MEMORY_STORE) {
  const dataDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, "pricetax.sqlite");
  db = new Database(dbPath);

  // Performance / segurança
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  function colExists(table: string, col: string) {
    const rows = db!.prepare(`PRAGMA table_info(${table})`).all() as any[];
    return rows.some((r) => String(r.name) === col);
  }

  function tableExists(table: string) {
    const row = db!
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(table);
    return !!row;
  }

  function ensureSchema() {
    // -----------------------------
    // analysis_runs
    // -----------------------------
    db!.exec(`
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
    db!.exec(`
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
      db!.exec(`ALTER TABLE docs ADD COLUMN docKey TEXT;`);
      db!.exec(`
        UPDATE docs
        SET docKey = 'legacy-' || id
        WHERE docKey IS NULL;
      `);
    }

    // -----------------------------
    // doc_chunks
    // -----------------------------
    db!.exec(`
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
    db!.exec(`
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
      db!.exec(`ALTER TABLE docs ADD COLUMN updatedAt TEXT;`);
      db!.exec(`UPDATE docs SET updatedAt = createdAt WHERE updatedAt IS NULL;`);
    }
  }

  ensureSchema();
}

// ✅ Mantém export (se alguém importar db)
// No Vercel será null, mas o MVP sobe sem quebrar build.
export { db };

// ------------------------------------
// API usada pelo route.ts
// ------------------------------------
export function upsertDocMeta(meta: DocMeta) {
  if (USE_MEMORY_STORE) {
    memDocs.set(meta.docKey, {
      docKey: meta.docKey,
      title: meta.title,
      originalFileName: meta.originalFileName ?? null,
      savedPath: meta.savedPath ?? null,
    });
    return;
  }

  const now = new Date().toISOString();

  const existing = db!
    .prepare(`SELECT id FROM docs WHERE docKey = ?`)
    .get(meta.docKey) as any;

  if (!existing) {
    db!.prepare(
      `
      INSERT INTO docs (docKey, title, originalFileName, savedPath, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `
    ).run(
      meta.docKey,
      meta.title,
      meta.originalFileName ?? null,
      meta.savedPath ?? null,
      now,
      now
    );
  } else {
    db!.prepare(
      `
      UPDATE docs
      SET title = ?, originalFileName = ?, savedPath = ?, updatedAt = ?
      WHERE docKey = ?
    `
    ).run(
      meta.title,
      meta.originalFileName ?? null,
      meta.savedPath ?? null,
      now,
      meta.docKey
    );
  }
}

export function replaceDocChunks(args: ReplaceChunksArgs) {
  if (USE_MEMORY_STORE) {
    memChunks.set(args.docKey, args.chunks);
    return;
  }

  const doc = db!
    .prepare(`SELECT id FROM docs WHERE docKey = ?`)
    .get(args.docKey) as any;

  if (!doc?.id) {
    throw new Error(`Doc não encontrado para docKey=${args.docKey}`);
  }

  const now = new Date().toISOString();

  const tx = db!.transaction(() => {
    db!.prepare(`DELETE FROM doc_chunks WHERE docId = ?`).run(doc.id);

    const ins = db!.prepare(`
      INSERT INTO doc_chunks (docId, chunkIndex, content, createdAt)
      VALUES (?, ?, ?, ?)
    `);

    for (let i = 0; i < args.chunks.length; i++) {
      ins.run(doc.id, i, args.chunks[i], now);
    }
  });

  tx();
}
