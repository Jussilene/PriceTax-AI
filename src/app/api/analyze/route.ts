// src/app/api/analyze/route.ts
import { NextResponse } from "next/server";
import { parseBalancetePDF } from "@/lib/balanceteParser";
import { computeFromBalancetes } from "@/lib/analyzeEngine";
import { saveAnalysisRun } from "@/lib/analysisStore";

export const runtime = "nodejs";
// evita cache chato em dev
export const dynamic = "force-dynamic";

// ✅ AJUSTE MÍNIMO: se o front fizer GET (healthcheck/status), devolvemos JSON
export async function GET() {
  return NextResponse.json(
    {
      ok: false,
      error: "Método não permitido. Use POST em /api/analyze com formData (files/pdfs).",
    },
    { status: 405 }
  );
}

// ✅ AJUSTE MÍNIMO: OPTIONS para evitar ruídos em alguns fetches/ambientes
export async function OPTIONS() {
  return NextResponse.json({ ok: true }, { status: 200 });
}

export async function POST(req: Request) {
  const jobId = globalThis.crypto?.randomUUID?.() ?? String(Date.now());

  try {
    const formData = await req.formData();

    // ✅ captura o modo (para o dashboard mostrar "Modo: trimestral/mensal" etc)
    const periodModeRaw = formData.get("periodMode");
    const periodMode =
      typeof periodModeRaw === "string" && periodModeRaw.trim()
        ? periodModeRaw.trim()
        : "trimestral";

    // aceita "files" e "pdfs"
    const files = formData.getAll("files");
    const alt = formData.getAll("pdfs");
    const all = (files?.length ? files : alt) as unknown[];

    const pdfFiles = all.filter((f) => f instanceof File) as File[];

    if (!pdfFiles.length) {
      return NextResponse.json(
        { ok: false, jobId, error: "Nenhum arquivo recebido. Campo esperado: files." },
        { status: 400 }
      );
    }

    if (pdfFiles.length < 2 || pdfFiles.length > 4) {
      return NextResponse.json(
        { ok: false, jobId, error: "Envie entre 2 e 4 PDFs." },
        { status: 400 }
      );
    }

    for (const f of pdfFiles) {
      const isPdf = f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
      if (!isPdf) {
        return NextResponse.json(
          { ok: false, jobId, error: `Arquivo inválido: ${f.name}. Envie apenas PDF.` },
          { status: 400 }
        );
      }
    }

    const parsed = [];
    for (const f of pdfFiles) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      parsed.push(await parseBalancetePDF(bytes, f.name));
    }

    const result = computeFromBalancetes(parsed);

    // ✅ salva o run no SQLite (MVP)
    saveAnalysisRun({
      userEmail: null,
      jobId,
      payload: { meta: { periodMode }, result, baseNormalizada: result.baseNormalizada },
    });

    // ✅ meta (mantém compatibilidade com o dashboard atual)
    const meta = {
      jobId,
      periodMode,
      detectedYears: result.summary.yearsDetected ?? [],
      files: parsed.map((p, idx) => ({
        name: p.fileName,
        size: pdfFiles[idx]?.size ?? 0,
        year: p.detectedYear ?? null,
      })),
      createdAtISO: new Date().toISOString(),
    };

    return NextResponse.json(
      {
        ok: true,
        jobId,
        meta,
        result,
        baseNormalizada: result.baseNormalizada,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("[/api/analyze] ERROR:", err);

    const message = typeof err?.message === "string" ? err.message : "Erro ao processar PDFs.";
    return NextResponse.json({ ok: false, jobId, error: message }, { status: 500 });
  }
}
