// src/app/api/docs/ingest/route.ts
import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { upsertDocMeta, replaceDocChunks } from "@/lib/docsStore";

export const runtime = "nodejs";

function chunkText(text: string, maxLen = 1200) {
  const clean = (text || "").replace(/\r/g, "");
  const blocks = clean
    .split(/\n{2,}/g)
    .map((b) => b.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let buf = "";

  for (const b of blocks) {
    const next = buf ? `${buf}\n\n${b}` : b;
    if (next.length > maxLen) {
      if (buf.trim()) chunks.push(buf.trim());
      buf = b;
    } else {
      buf = next;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

async function extractTextFromPdf(bytes: Uint8Array) {
  const pdfParse = (await import("pdf-parse")).default as any;
  const data = await pdfParse(Buffer.from(bytes), { max: 0 });
  return (data?.text ?? "").toString();
}

export async function POST(req: Request) {
  try {
    const form = await req.formData();

    const docKey = String(form.get("docKey") || "").trim();
    const title = String(form.get("title") || "").trim();
    const textField = form.get("text");
    const file = form.get("file");

    if (!docKey) {
      return NextResponse.json(
        { ok: false, error: "docKey obrigatório" },
        { status: 400 }
      );
    }
    if (!title) {
      return NextResponse.json(
        { ok: false, error: "title obrigatório" },
        { status: 400 }
      );
    }

    // ✅ AJUSTE MÍNIMO: no Vercel, use /tmp (filesystem permitido)
    const rootDataDir = process.env.VERCEL ? "/tmp" : process.cwd();

    // Pasta fixa dentro do projeto
    const baseDir = path.join(rootDataDir, "data", "docs", docKey);
    fs.mkdirSync(baseDir, { recursive: true });

    let savedPath: string | null = null;
    let originalFileName: string | null = null;

    let extracted = "";
    const extraText = typeof textField === "string" ? textField : "";

    // Se veio PDF
    if (file instanceof File) {
      originalFileName = file.name;
      const bytes = new Uint8Array(await file.arrayBuffer());

      savedPath = path.join(baseDir, "original.pdf");
      fs.writeFileSync(savedPath, Buffer.from(bytes));

      extracted = await extractTextFromPdf(bytes);
    }

    // Se veio só texto, também serve
    const fullText = [extracted, extraText].filter(Boolean).join("\n\n");

    if (!fullText.trim()) {
      return NextResponse.json(
        { ok: false, error: "Envie file (PDF) e/ou text (conteúdo)." },
        { status: 400 }
      );
    }

    upsertDocMeta({
      docKey,
      title,
      originalFileName,
      savedPath,
    });

    const chunks = chunkText(fullText);
    replaceDocChunks({ docKey, chunks });

    return NextResponse.json(
      {
        ok: true,
        docKey,
        title,
        uploaded: Boolean(file instanceof File),
        originalFileName,
        savedPath,
        textIngested: true,
        chunks: chunks.length,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("[/api/docs/ingest] ERROR:", err);
    return NextResponse.json(
      { ok: false, error: err?.message || "Erro ao ingerir documento" },
      { status: 500 }
    );
  }
}
