// src/app/api/chat/route.ts
import { NextResponse } from "next/server";
import { getLatestAnalysisRun } from "@/lib/analysisStore";
import { searchSeededDocs } from "@/lib/docsRuntime";
import { runLlm } from "@/lib/llm";
import { getBenchmarksText } from "@/lib/benchmarks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type HistoryItem = {
  role?: "user" | "assistant" | string;
  text?: string;
  content?: string;
};

type LlmMsg = {
  role: "user" | "assistant";
  content: string;
};

function safeJson(x: any) {
  try {
    return JSON.stringify(x ?? null);
  } catch {
    return "null";
  }
}

function buildContextPack(result: any) {
  const summary = result?.summary ?? {};
  const years = summary?.yearsDetected?.length ? summary.yearsDetected.join(", ") : "—";

  const latest =
    (Array.isArray(result?.tccKpis?.byPeriod) && result.tccKpis.byPeriod.length
      ? result.tccKpis.byPeriod[result.tccKpis.byPeriod.length - 1]
      : null) ||
    (Array.isArray(result?.kpis?.byPeriod) && result.kpis.byPeriod.length
      ? result.kpis.byPeriod[result.kpis.byPeriod.length - 1]
      : null) ||
    null;

  const top = result?.topGastos ?? result?.pareto ?? [];

  return {
    years,
    latestPeriod: latest?.period ?? null,
    latest,
    top,
    kpisByPeriod: result?.tccKpis?.byPeriod ?? result?.kpis?.byPeriod ?? [],
    series: result?.series ?? null,
    alerts: result?.alerts ?? [],
    rankings: result?.rankings ?? null,
  };
}

function normalizeHistoryItem(m: HistoryItem): LlmMsg | null {
  const role: "user" | "assistant" = m?.role === "assistant" ? "assistant" : "user";
  const text = String(m?.text ?? m?.content ?? "").trim();
  return text ? { role, content: text } : null;
}

export async function GET() {
  return NextResponse.json({ ok: true, message: "Use POST em /api/chat para enviar mensagens." }, { status: 200 });
}

export async function OPTIONS() {
  return NextResponse.json({ ok: true }, { status: 200 });
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({} as any));

    const message = String(body?.message || "").trim();
    const jobId = body?.jobId ? String(body.jobId) : null;
    const history: HistoryItem[] = Array.isArray(body?.history) ? body.history : [];

    if (!message) {
      return NextResponse.json({ ok: false, error: "Envie { message }" }, { status: 400 });
    }

    const run = getLatestAnalysisRun({ jobId });

    // ✅ Anti-alucinação: se não tem análise salva, não inventa
    if (!run?.payload) {
      return NextResponse.json(
        {
          ok: true,
          reply:
            "Eu ainda não tenho um painel de análise carregado para esse jobId. " +
            "Faça a análise (upload de 2 a 4 PDFs) para eu responder com base em dados reais do balancete.",
          meta: { jobId: run?.jobId ?? null, createdAt: run?.createdAt ?? null, action: null },
        },
        { status: 200 }
      );
    }

    const payload = run.payload || null;
    const result = payload?.result || payload?.analysis || payload?.data || null;

    const pack = buildContextPack(result);

    // ✅ busca trechos do livro/TCC/fórmula (seed_docs) — só entra se for relevante
    const docHits = searchSeededDocs(message, { limit: 10 });

    // benchmarks (referência — nunca tratado como dado do cliente)
    const benchmarksText = getBenchmarksText(pack, { maxLines: 10 });

    const instructions = [
      "Você é a IA do PriceTax, especialista em análise de balancetes e redução de custos.",
      "",
      "REGRAS DE VERDADE (obrigatórias):",
      "1) Use APENAS os dados do painel (Context Pack) para números, valores e conclusões financeiras.",
      "2) Se um número não estiver no painel, diga explicitamente: 'não disponível no painel atual'. Não chute.",
      "3) Os trechos do livro/TCC/fórmula servem SOMENTE como base conceitual/metodológica. Nunca use trechos para inventar valores.",
      "4) Quando falar de mercado/benchmarks, deixe claro que são faixas médias/referência, e não dados do cliente.",
      "",
      "ESTILO:",
      "- Responda como analista financeiro: claro, humano, consultivo e objetivo.",
      "- Sempre indique o período base quando citar KPIs.",
      "- Ao recomendar cortes, priorize Pareto (Top Gastos) e explique por quê.",
    ].join("\n");

    const contextText = [
      `JOB: ${run?.jobId ?? "—"}`,
      `Anos detectados: ${pack.years}`,
      pack.latestPeriod ? `Período mais recente: ${pack.latestPeriod}` : "",
      "",
      "DADOS DO PAINEL (JSON) — Fonte ÚNICA para números:",
      safeJson(pack),
      "",
      "BENCHMARKS (referência, não são dados do cliente):",
      benchmarksText || "(sem benchmarks configurados)",
      "",
      "TRECHOS DO LIVRO/TCC/FÓRMULA (base teórica; não usar como números do cliente):",
      docHits.length
        ? docHits
            .map((h: any, i: number) => {
              // preview já vem pronto — evitamos “inventar citação”
              return `(${i + 1}) ${String(h.preview || "").trim()}`;
            })
            .join("\n")
        : "(nenhum trecho relevante encontrado para esta pergunta)",
    ]
      .filter(Boolean)
      .join("\n");

    const input: LlmMsg[] = [];

    // memória (últimas 10)
    const trimmed = history.slice(-10);
    for (const m of trimmed) {
      const norm = normalizeHistoryItem(m);
      if (norm) input.push(norm);
    }

    input.push({
      role: "user",
      content: `${contextText}\n\nPERGUNTA DO USUÁRIO:\n${message}`,
    });

    const hasKey = !!process.env.OPENAI_API_KEY;
    const reply = hasKey
      ? await runLlm({ instructions, input })
      : "Sem OPENAI_API_KEY no servidor. Configure a chave para ativar respostas naturais.";

    const wantsPdf = /pdf|relat(ó|o)rio|exportar|baixar/i.test(message);

    return NextResponse.json(
      {
        ok: true,
        reply: String(reply || "").trim() || "(Sem resposta.)",
        meta: {
          jobId: run?.jobId ?? null,
          createdAt: run?.createdAt ?? null,
          docHits: docHits.map((d: any) => ({ score: d.score })),
          action: wantsPdf ? "GENERATE_PDF" : null,
        },
      },
      { status: 200 }
    );
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || "Erro no chat." }, { status: 500 });
  }
}
