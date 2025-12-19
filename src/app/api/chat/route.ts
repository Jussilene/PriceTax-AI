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
  };
}

function normalizeHistoryItem(m: HistoryItem): LlmMsg | null {
  const role: "user" | "assistant" = m?.role === "assistant" ? "assistant" : "user";
  const text = String(m?.text ?? m?.content ?? "").trim(); // ✅ aceita text ou content
  return text ? { role, content: text } : null;
}

// ✅ AJUSTE: GET pra não dar 405 no front (retorna 200 + JSON)
export async function GET() {
  return NextResponse.json(
    { ok: true, message: "Use POST em /api/chat para enviar mensagens." },
    { status: 200 }
  );
}

// ✅ AJUSTE: OPTIONS pra evitar ruídos de preflight
export async function OPTIONS() {
  return NextResponse.json({ ok: true }, { status: 200 });
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({} as any));

    const message = String(body?.message || "").trim();
    const jobId = body?.jobId ? String(body.jobId) : null;

    // ✅ memória da conversa (o ChatDrawer manda)
    const history: HistoryItem[] = Array.isArray(body?.history) ? body.history : [];

    if (!message) {
      return NextResponse.json({ ok: false, error: "Envie { message }" }, { status: 400 });
    }

    const run = getLatestAnalysisRun({ jobId });
    const payload = run?.payload || null;
    const result = payload?.result || payload?.analysis || payload?.data || null;

    const pack = buildContextPack(result);

    // docs seedados: entram só quando forem relevantes
    const docHits = searchSeededDocs(message, { limit: 8 });

    // benchmarks (referência)
    const benchmarksText = getBenchmarksText(pack, { maxLines: 8 });

    const instructions = [
      "Você é a IA do PriceTax, especialista em análise de balancetes, redução de custos e diagnóstico financeiro.",
      "Use EXCLUSIVAMENTE os dados do painel atual (KPIs, Pareto, períodos, alertas) como base da análise.",
      "Nunca peça upload de documentos. O balancete já foi processado e está disponível no painel.",
      "Responda de forma humana, natural e consultiva, como um analista financeiro experiente.",
      "Quando o usuário pedir análise de mercado, use benchmarks de referência e deixe claro que são faixas médias.",
      "Quando o usuário pedir um PDF, confirme brevemente e gere automaticamente o relatório executivo.",
      "Nunca diga que precisa de mais arquivos para gerar o PDF.",
      "Varie as respostas conforme a pergunta; evite repetir textos.",
    ].join("\n");

    const contextText = [
      `JOB: ${run?.jobId ?? "—"}`,
      `Anos detectados: ${pack.years}`,
      pack.latestPeriod ? `Período mais recente: ${pack.latestPeriod}` : "",
      "",
      "DADOS DO PAINEL (JSON):",
      safeJson(pack),
      "",
      "BENCHMARKS (referência):",
      benchmarksText || "(sem benchmarks configurados)",
      "",
      "TRECHOS RELEVANTES (se houver):",
      docHits.length
        ? docHits.map((h: any, i: number) => `(${i + 1}) ${h.preview}`).join("\n")
        : "(nenhum trecho relevante para esta pergunta)",
    ]
      .filter(Boolean)
      .join("\n");

    const input: LlmMsg[] = [];

    // ✅ memória (últimas 10 msgs)
    const trimmed = history.slice(-10);
    for (const m of trimmed) {
      const norm = normalizeHistoryItem(m);
      if (norm) input.push(norm);
    }

    // ✅ injeta contexto + pergunta atual
    input.push({
      role: "user",
      content: `${contextText}\n\nPERGUNTA DO USUÁRIO:\n${message}`,
    });

    const hasKey = !!process.env.OPENAI_API_KEY;

    const reply = hasKey
      ? await runLlm({ instructions, input })
      : "Sem OPENAI_API_KEY no servidor. Configure a chave para ativar respostas naturais.";

    // ✅ sinaliza intenção de PDF para o front (ChatDrawer baixar automaticamente)
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
