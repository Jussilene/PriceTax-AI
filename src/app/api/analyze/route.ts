import { NextResponse } from "next/server";
import { parseBalancetePDF } from "@/lib/balanceteParser";
import { computeFromBalancetes } from "@/lib/analyzeEngine";
import { saveAnalysisRun } from "@/lib/analysisStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      message: "Use POST em /api/analyze com formData (files/pdfs).",
    },
    { status: 200 }
  );
}

export async function OPTIONS() {
  return NextResponse.json({ ok: true }, { status: 200 });
}

export async function POST(req: Request) {
  const jobId = globalThis.crypto?.randomUUID?.() ?? String(Date.now());

  try {
    const formData = await req.formData();

    // ✅ modo selecionado no front
    const periodModeRaw = formData.get("periodMode");
    const periodMode =
      typeof periodModeRaw === "string" && periodModeRaw.trim()
        ? (periodModeRaw.trim() as "mensal" | "trimestral" | "anual")
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

    // 1) parse dos PDFs
    const parsed = [];
    for (const f of pdfFiles) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      parsed.push(await parseBalancetePDF(bytes, f.name));
    }

    // 2) cálculo (100% derivado do que foi extraído dos PDFs)
    const result = computeFromBalancetes(parsed, periodMode);

    // 3) salva no SQLite (MVP)
    saveAnalysisRun({
      userEmail: null,
      jobId,
      payload: {
        meta: { periodMode },
        result,
        baseNormalizada: result.baseNormalizada,
      },
    });

    // 4) meta para o front
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

    // ✅ Retorno "compatível": mantém `result` e também expõe campos no topo
    return NextResponse.json(
      {
        ok: true,
        stage: "analysis",
        meta,
        message: "Análise gerada com sucesso.",
        result,

        // atalhos (pra debug e/ou PDF)
        baseNormalizada: result.baseNormalizada,

        // campos flat (mesma info do result, só pra facilitar o front)
        tccKpis: result.tccKpis,
        kpisByPeriod: result.kpis?.byPeriod ?? [],
        series: result.series,
        rankings: result.rankings,
        alerts: result.alerts,
        periodos: result.periodos ?? [],
        kpisPorPeriodo: result.kpisPorPeriodo ?? {},
        distribuicaoGrupos: result.distribuicaoGrupos ?? {},
        topGastos: result.topGastos ?? [],
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("[/api/analyze] ERROR:", err);
    const message = typeof err?.message === "string" ? err.message : "Erro ao processar PDFs.";
    return NextResponse.json({ ok: false, jobId, error: message }, { status: 500 });
  }
}
