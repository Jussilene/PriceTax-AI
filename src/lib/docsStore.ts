// src/lib/docsStore.ts
import "server-only";
import { db } from "@/lib/db";

db.exec(`
  CREATE TABLE IF NOT EXISTS docs (
    docKey TEXT PRIMARY KEY,
    title TEXT,
    savedPath TEXT,
    originalFileName TEXT,
    updatedAt TEXT
  );

  CREATE TABLE IF NOT EXISTS doc_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    docKey TEXT NOT NULL,
    chunkIndex INTEGER NOT NULL,
    content TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_doc_chunks_docKey ON doc_chunks(docKey);
`);

export function upsertDocMeta(args: {
  docKey: string;
  title: string;
  savedPath: string | null;
  originalFileName: string | null;
}) {
  db.prepare(`
    INSERT INTO docs (docKey, title, savedPath, originalFileName, updatedAt)
    VALUES (@docKey, @title, @savedPath, @originalFileName, @updatedAt)
    ON CONFLICT(docKey) DO UPDATE SET
      title=excluded.title,
      savedPath=excluded.savedPath,
      originalFileName=excluded.originalFileName,
      updatedAt=excluded.updatedAt
  `).run({
    docKey: args.docKey,
    title: args.title,
    savedPath: args.savedPath,
    originalFileName: args.originalFileName,
    updatedAt: new Date().toISOString(),
  });
}

export function replaceDocChunks(args: { docKey: string; chunks: string[] }) {
  const del = db.prepare(`DELETE FROM doc_chunks WHERE docKey = ?`);
  const ins = db.prepare(
    `INSERT INTO doc_chunks (docKey, chunkIndex, content) VALUES (?, ?, ?)`
  );

  const tx = db.transaction(() => {
    del.run(args.docKey);
    args.chunks.forEach((c, i) => ins.run(args.docKey, i, c));
  });

  tx();
}

export function searchDocChunks(args: {
  query: string;
  limit?: number;
  docKeys?: string[];
}) {
  const q = (args.query ?? "").trim();
  if (!q) return [];

  const limit = args.limit ?? 6;
  const keys = args.docKeys?.length ? args.docKeys : null;

  // MVP simples: LIKE (rápido o suficiente com poucos docs)
  if (!keys) {
    return db
      .prepare(
        `SELECT docKey, chunkIndex, content
         FROM doc_chunks
         WHERE content LIKE ?
         LIMIT ?`
      )
      .all(`%${q}%`, limit) as any[];
  }

  const placeholders = keys.map(() => "?").join(",");
  const stmt = db.prepare(
    `SELECT docKey, chunkIndex, content
     FROM doc_chunks
     WHERE docKey IN (${placeholders}) AND content LIKE ?
     LIMIT ?`
  );

  return stmt.all(...keys, `%${q}%`, limit) as any[];
}

export function listDocs() {
  return db.prepare(`SELECT * FROM docs ORDER BY updatedAt DESC`).all() as any[];
}
