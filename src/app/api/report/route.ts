// src/app/api/report/route.ts
import { NextResponse } from "next/server";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { getLatestAnalysisRun } from "@/lib/analysisStore";
import { runLlm } from "@/lib/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// -----------------------
// Helpers (format/guard)
// -----------------------
function safeMoney(n: any) {
  if (n === null || n === undefined || n === "") return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function safePct(n: any) {
  if (n === null || n === undefined || n === "") return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return `${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}
function safeText(s: any) {
  const t = String(s ?? "").trim();
  return t || "—";
}
function safeJson(x: any) {
  try {
    return JSON.stringify(x ?? null);
  } catch {
    return "null";
  }
}

// -----------------------
// Context pack do MVP
// -----------------------
function buildContextPack(result: any) {
  const summary = result?.summary ?? {};
  const years = summary?.yearsDetected?.length ? summary.yearsDetected : [];

  const latest =
    (Array.isArray(result?.tccKpis?.byPeriod) && result.tccKpis.byPeriod.length
      ? result.tccKpis.byPeriod[result.tccKpis.byPeriod.length - 1]
      : null) ||
    (Array.isArray(result?.kpis?.byPeriod) && result.kpis.byPeriod.length
      ? result.kpis.byPeriod[result.kpis.byPeriod.length - 1]
      : null) ||
    null;

  const prev =
    (Array.isArray(result?.tccKpis?.byPeriod) && result.tccKpis.byPeriod.length >= 2
      ? result.tccKpis.byPeriod[result.tccKpis.byPeriod.length - 2]
      : null) ||
    (Array.isArray(result?.kpis?.byPeriod) && result.kpis.byPeriod.length >= 2
      ? result.kpis.byPeriod[result.kpis.byPeriod.length - 2]
      : null) ||
    null;

  const top = result?.topGastos ?? result?.pareto ?? [];

  return {
    years,
    latest,
    prev,
    top,
    tccByPeriod: result?.tccKpis?.byPeriod ?? [],
    kpisByPeriod: result?.kpis?.byPeriod ?? [],
    series: result?.series ?? null,
    rankings: result?.rankings ?? null,
    alerts: result?.alerts ?? [],
  };
}

// -----------------------
// Mercado (chama /api/market)
// -----------------------
async function fetchMarket(sector?: string | null) {
  try {
    const q = sector
      ? `benchmarks financeiros ${sector} margem liquida margem bruta despesas administrativas`
      : `benchmarks financeiros margem liquida margem bruta despesas administrativas Brasil`;

    const res = await fetch(
      `${process.env.NEXT_PUBLIC_BASE_URL || ""}/api/market?q=${encodeURIComponent(q)}`,
      {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
      }
    ).catch(() => null);

    if (!res || !res.ok) return { items: [], sources: [] };
    const data = await res.json().catch(() => null);
    if (!data?.ok) return { items: [], sources: [] };
    return {
      items: Array.isArray(data.items) ? data.items : [],
      sources: Array.isArray(data.sources) ? data.sources : [],
    };
  } catch {
    return { items: [], sources: [] };
  }
}

// -----------------------
// ReportModel
// -----------------------
type ReportSection = {
  title: string;
  insight: string;
  whyItMatters: string;
  recommendation: string;
  chartKey?: "pareto" | "adminVsReceita" | "grupos" | "serie";
};

type ReportModel = {
  executiveSummary: string[];
  sections: ReportSection[];
  actionPlan: { d30: string[]; d60: string[]; d90: string[] };
  benchmarks: { items: string[]; sources: Array<{ title: string; url: string }> };
};

// fallback (sem IA) — ainda fica estruturado
function buildFallbackReport(pack: any, market: { items: string[]; sources: any[] }): ReportModel {
  const latest = pack?.latest ?? {};
  const exec: string[] = [];

  const receita = latest?.receita_liquida ?? latest?.receitaLiquida ?? null;
  const lucro = latest?.lucro_liquido ?? latest?.lucroLiquido ?? null;
  const mliq = latest?.margem_liquida_pct ?? latest?.margemLiquidaPct ?? null;
  const mbru = latest?.margem_bruta_pct ?? latest?.margemBrutaPct ?? null;

  exec.push(`Período analisado: ${safeText(latest?.period ?? "—")}`);
  exec.push(`Receita líquida: R$ ${safeMoney(receita)} | Lucro líquido: R$ ${safeMoney(lucro)}`);
  exec.push(`Margem bruta: ${safePct(mbru)} | Margem líquida: ${safePct(mliq)}`);
  exec.push(`Principais drivers de custo estão concentrados no Pareto (Top Gastos).`);
  exec.push(`Recomendação: priorizar ações de redução com maior impacto e baixo risco operacional.`);

  const sections: ReportSection[] = [
    {
      title: "1) Visão Geral do Resultado",
      insight: `O período mais recente (${safeText(latest?.period)}) apresenta Receita Líquida de R$ ${safeMoney(receita)} e Lucro Líquido de R$ ${safeMoney(lucro)}.`,
      whyItMatters: `Isso define a capacidade da operação sustentar custos, investir e manter liquidez. Margens negativas sinalizam risco de caixa e pressão operacional.`,
      recommendation: `Atacar custos de maior peso (Pareto) e revisar formação de preço/CMV/CPV. Criar rotina semanal de acompanhamento de KPIs e metas por centro de custo.`,
      chartKey: "serie",
    },
    {
      title: "2) Pareto de Gastos (Foco de Corte)",
      insight: `O Pareto mostra onde está a maior concentração de gastos. Atuar no Top 3 costuma gerar o maior retorno com menor esforço.`,
      whyItMatters: `Cortes pulverizados geram pouco efeito. Prioridade e foco aumentam a chance de impacto real em 30 dias.`,
      recommendation: `Negociar contratos, buscar fornecedores alternativos, revisar custos recorrentes e eliminar despesas sem ROI.`,
      chartKey: "pareto",
    },
    {
      title: "3) Admin vs Receita (Eficiência)",
      insight: `Comparar Despesas Administrativas com Receita Líquida ajuda a medir eficiência da estrutura.`,
      whyItMatters: `Estruturas inchadas reduzem margem mesmo com crescimento de faturamento.`,
      recommendation: `Criar teto de despesas admin (% da receita), renegociar contratos e otimizar processos com automação.`,
      chartKey: "adminVsReceita",
    },
    {
      title: "4) Distribuição Ativo/Passivo/DRE",
      insight: `A distribuição por grupo ajuda a entender a “cara” do balanço no último período.`,
      whyItMatters: `Desequilíbrios podem sinalizar alavancagem, dependência de passivos e risco de liquidez.`,
      recommendation: `Monitorar capital de giro, prazos médios e reduzir passivos de curto prazo quando possível.`,
      chartKey: "grupos",
    },
  ];

  const items = market?.items?.length
    ? market.items
    : ["Benchmarks variam por setor; use como referência inicial e ajuste com comparáveis diretos."];

  const sources = Array.isArray(market.sources) ? market.sources : [];

  return {
    executiveSummary: exec,
    sections,
    actionPlan: {
      d30: [
        "Mapear Top 10 custos (Pareto) e definir donos por item",
        "Renegociar 3 contratos de maior impacto",
        "Criar rotina semanal de KPI (Receita, CMV/CPV, Desp. Admin, Lucro)",
      ],
      d60: [
        "Padronizar processo de compras e aprovações",
        "Implementar automações (pagamentos, aprovações, relatórios)",
        "Revisar política comercial/preço com base em margem",
      ],
      d90: [
        "Reestruturar centros de custo e orçamento base zero (Opex)",
        "Revisar mix de produtos/serviços com foco em margem",
        "Definir metas trimestrais e revisões mensais de performance",
      ],
    },
    benchmarks: { items, sources },
  };
}

// IA gera o ReportModel (JSON) — se tiver OPENAI_API_KEY
async function buildAiReport(pack: any, market: { items: string[]; sources: any[] }): Promise<ReportModel> {
  const hasKey = !!process.env.OPENAI_API_KEY;
  if (!hasKey) return buildFallbackReport(pack, market);

  const instructions = [
    "Você é a IA do PriceTax, especialista em análise financeira e diagnóstico por balancetes.",
    "Sua tarefa é gerar um JSON estrito (sem markdown) no formato ReportModel.",
    "Use EXCLUSIVAMENTE os dados do Context Pack (painel do MVP). Não invente números.",
    "Use os itens de mercado fornecidos como contexto de referência (não como verdade absoluta).",
    "Produza insights objetivos, com linguagem executiva e recomendações acionáveis.",
    "O report deve lembrar um relatório de TCC: título + interpretação + implicação + ação.",
    "Respeite o formato e os campos: executiveSummary (5-7 bullets), sections (4-7), actionPlan (30/60/90 com 4-6 itens cada), benchmarks (items + sources).",
  ].join("\n");

  const input = [
    {
      role: "user" as const,
      content: [
        "RETORNE APENAS JSON VÁLIDO.",
        "",
        "CONTEXT_PACK_JSON:",
        safeJson(pack),
        "",
        "MARKET_ITEMS:",
        safeJson(market?.items ?? []),
        "",
        "MARKET_SOURCES:",
        safeJson(market?.sources ?? []),
        "",
        "FORMATO (TypeScript):",
        `type ReportModel = {
  executiveSummary: string[];
  sections: { title: string; insight: string; whyItMatters: string; recommendation: string; chartKey?: "pareto"|"adminVsReceita"|"grupos"|"serie" }[];
  actionPlan: { d30: string[]; d60: string[]; d90: string[] };
  benchmarks: { items: string[]; sources: { title: string; url: string }[] };
};`,
      ].join("\n"),
    },
  ];

  const raw = await runLlm({ instructions, input });

  try {
    const parsed = JSON.parse(String(raw || "{}"));
    if (!parsed || !Array.isArray(parsed.executiveSummary) || !Array.isArray(parsed.sections)) {
      return buildFallbackReport(pack, market);
    }
    return parsed as ReportModel;
  } catch {
    return buildFallbackReport(pack, market);
  }
}

// -----------------------
// PDF Layout helpers
// -----------------------
type PdfFonts = { regular: any; bold: any };

function wrapText(text: string, maxChars: number) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > maxChars) {
      if (line.trim()) lines.push(line.trim());
      line = w;
    } else {
      line = (line + " " + w).trim();
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

function drawSectionTitle(page: any, fonts: PdfFonts, text: string, x: number, y: number) {
  page.drawText(text, { x, y, size: 14, font: fonts.bold, color: rgb(0.05, 0.05, 0.05) });
}

function drawParagraph(page: any, fonts: PdfFonts, text: string, x: number, y: number, maxWidthChars = 95, size = 10) {
  const lines = wrapText(text, maxWidthChars);
  let yy = y;
  for (const ln of lines) {
    page.drawText(ln, { x, y: yy, size, font: fonts.regular, color: rgb(0.1, 0.1, 0.1) });
    yy -= size + 4;
  }
  return yy;
}

function drawBulletList(page: any, fonts: PdfFonts, items: string[], x: number, y: number, maxWidthChars = 95, size = 10) {
  let yy = y;
  for (const it of items) {
    const lines = wrapText(it, maxWidthChars - 4);
    if (!lines.length) continue;
    page.drawText(`• ${lines[0]}`, { x, y: yy, size, font: fonts.regular, color: rgb(0.1, 0.1, 0.1) });
    yy -= size + 4;
    for (const ln of lines.slice(1)) {
      page.drawText(`  ${ln}`, { x, y: yy, size, font: fonts.regular, color: rgb(0.1, 0.1, 0.1) });
      yy -= size + 4;
    }
    yy -= 2;
  }
  return yy;
}

function drawCallout(page: any, fonts: PdfFonts, title: string, text: string, x: number, y: number, w: number) {
  const h = 74;
  page.drawRectangle({
    x,
    y: y - h,
    width: w,
    height: h,
    color: rgb(1, 0.96, 0.78),
    borderColor: rgb(0.85, 0.7, 0.2),
    borderWidth: 1,
  });
  page.drawText(title, { x: x + 10, y: y - 18, size: 10, font: fonts.bold, color: rgb(0.2, 0.15, 0.05) });
  let yy = y - 34;
  yy = drawParagraph(page, fonts, text, x + 10, yy, 88, 9);
  return y - h - 10;
}

async function embedPngIfAny(pdfDoc: any, dataUrl: string | null) {
  try {
    if (!dataUrl) return null;
    const base64 = dataUrl.split(",")[1] || "";
    if (!base64) return null;
    const bytes = Buffer.from(base64, "base64");
    const img = await pdfDoc.embedPng(bytes);
    return img;
  } catch {
    return null;
  }
}

// -----------------------
// Build PDF bytes (retorno com sucesso ou erro)
// -----------------------
type BuildOk = { bytes: Uint8Array; filename: string };
type BuildErr = { error: string; status: number };
type BuildRes = BuildOk | BuildErr;

function isBuildErr(x: BuildRes): x is BuildErr {
  return (x as any)?.error !== undefined;
}

async function buildPdfBytes(params: {
  jobId: string | null;
  transcript?: any[];
  charts?: { pareto?: string | null; adminVsReceita?: string | null; grupos?: string | null; serie?: string | null };
  sector?: string | null;
}): Promise<BuildRes> {
  const run = getLatestAnalysisRun({ jobId: params.jobId });

  if (!run?.payload) {
    return { error: "JobId não encontrado.", status: 404 };
  }

  const payload = run.payload;
  const result = payload?.result || payload?.analysis || payload?.data || null;

  const pack = buildContextPack(result);

  const market = await fetchMarket(params.sector ?? null);
  const report = await buildAiReport(pack, market);

  const pdfDoc = await PDFDocument.create();
  const fonts: PdfFonts = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
  };

  const A4: [number, number] = [595.28, 841.89];

  // ---------- Capa ----------
  {
    const page = pdfDoc.addPage(A4);
    page.drawRectangle({ x: 0, y: 0, width: A4[0], height: A4[1], color: rgb(0.05, 0.05, 0.06) });

    page.drawText("PriceTax", { x: 50, y: 770, size: 26, font: fonts.bold, color: rgb(1, 0.83, 0.2) });
    page.drawText("Relatório Executivo — Análise de Balancete", { x: 50, y: 735, size: 16, font: fonts.bold, color: rgb(1, 1, 1) });

    const latest = pack?.latest ?? {};
    const period = safeText(latest?.period ?? "—");
    const years = Array.isArray(pack?.years) && pack.years.length ? pack.years.join(", ") : "—";

    page.drawText(`Período base: ${period}`, { x: 50, y: 700, size: 11, font: fonts.regular, color: rgb(0.9, 0.9, 0.9) });
    page.drawText(`Anos detectados: ${years}`, { x: 50, y: 682, size: 11, font: fonts.regular, color: rgb(0.9, 0.9, 0.9) });
    page.drawText(`JobId: ${run.jobId}`, { x: 50, y: 664, size: 10, font: fonts.regular, color: rgb(0.7, 0.7, 0.7) });

    page.drawText(`Gerado em: ${new Date().toLocaleString("pt-BR")}`, {
      x: 50,
      y: 90,
      size: 10,
      font: fonts.regular,
      color: rgb(0.7, 0.7, 0.7),
    });

    page.drawText("Conteúdo gerado automaticamente com base no painel do MVP + fontes públicas de mercado.", {
      x: 50,
      y: 70,
      size: 9,
      font: fonts.regular,
      color: rgb(0.6, 0.6, 0.6),
    });
  }

  // ---------- Sumário Executivo ----------
  {
    const page = pdfDoc.addPage(A4);
    let y = 790;

    drawSectionTitle(page, fonts, "Sumário Executivo", 50, y);
    y -= 28;

    const latest = pack?.latest ?? {};
    const receita = latest?.receita_liquida ?? latest?.receitaLiquida ?? null;
    const lucro = latest?.lucro_liquido ?? latest?.lucroLiquido ?? null;
    const mbru = latest?.margem_bruta_pct ?? latest?.margemBrutaPct ?? null;
    const mliq = latest?.margem_liquida_pct ?? latest?.margemLiquidaPct ?? null;

    page.drawText(`Período: ${safeText(latest?.period)}`, { x: 50, y, size: 10, font: fonts.bold, color: rgb(0.1, 0.1, 0.1) });
    y -= 16;

    page.drawText(
      `Receita Líquida: R$ ${safeMoney(receita)}  |  Lucro Líquido: R$ ${safeMoney(lucro)}  |  Margem Bruta: ${safePct(mbru)}  |  Margem Líquida: ${safePct(mliq)}`,
      { x: 50, y, size: 9, font: fonts.regular, color: rgb(0.2, 0.2, 0.2) }
    );
    y -= 22;

    y = drawBulletList(page, fonts, report.executiveSummary.slice(0, 8), 50, y, 95, 10);

    y -= 8;
    y = drawCallout(
      page,
      fonts,
      "Recomendação-chave",
      "Priorize o Top 3 do Pareto + ajuste de eficiência administrativa. Isso tende a gerar o maior impacto em 30 dias com menor fricção operacional.",
      50,
      y,
      495
    );
  }

  // ---------- Seções ----------
  const chartMap = params.charts ?? {};
  for (const sec of report.sections.slice(0, 8)) {
    const page = pdfDoc.addPage(A4);
    let y = 790;

    drawSectionTitle(page, fonts, sec.title || "Seção", 50, y);
    y -= 22;

    page.drawText("Insight", { x: 50, y, size: 10, font: fonts.bold, color: rgb(0.1, 0.1, 0.1) });
    y -= 14;
    y = drawParagraph(page, fonts, sec.insight, 50, y, 95, 10);
    y -= 10;

    page.drawText("Por que isso importa", { x: 50, y, size: 10, font: fonts.bold, color: rgb(0.1, 0.1, 0.1) });
    y -= 14;
    y = drawParagraph(page, fonts, sec.whyItMatters, 50, y, 95, 10);
    y -= 10;

    const key = sec.chartKey || null;
    const dataUrl =
      key === "pareto"
        ? chartMap.pareto ?? null
        : key === "adminVsReceita"
        ? chartMap.adminVsReceita ?? null
        : key === "grupos"
        ? chartMap.grupos ?? null
        : key === "serie"
        ? chartMap.serie ?? null
        : null;

    const img = await embedPngIfAny(pdfDoc, dataUrl);

    if (img) {
      page.drawText("Gráfico", { x: 50, y, size: 10, font: fonts.bold, color: rgb(0.1, 0.1, 0.1) });
      y -= 12;

      const maxW = 495;
      const maxH = 220;

      const dims = img.scale(1);
      const scale = Math.min(maxW / dims.width, maxH / dims.height);

      const w = dims.width * scale;
      const h = dims.height * scale;

      page.drawRectangle({
        x: 50,
        y: y - h - 6,
        width: maxW,
        height: h + 12,
        color: rgb(0.97, 0.97, 0.97),
        borderColor: rgb(0.85, 0.85, 0.85),
        borderWidth: 1,
      });
      page.drawImage(img, { x: 50 + (maxW - w) / 2, y: y - h, width: w, height: h });

      y = y - h - 18;
    }

    y = drawCallout(page, fonts, "Recomendação", sec.recommendation, 50, y, 495);
  }

  // ---------- Benchmarks ----------
  {
    const page = pdfDoc.addPage(A4);
    let y = 790;
    drawSectionTitle(page, fonts, "Benchmarks & Contexto de Mercado (fontes públicas)", 50, y);
    y -= 26;

    const items = Array.isArray(report.benchmarks?.items) ? report.benchmarks.items : [];
    y = drawBulletList(page, fonts, items.slice(0, 10), 50, y, 95, 10);

    y -= 10;
    page.drawText("Fontes", { x: 50, y, size: 10, font: fonts.bold, color: rgb(0.1, 0.1, 0.1) });
    y -= 14;

    const sources = Array.isArray(report.benchmarks?.sources) ? report.benchmarks.sources : [];
    const listed = sources.slice(0, 8);

    if (!listed.length) {
      y = drawParagraph(page, fonts, "— (Sem fontes retornadas nesta execução. Você pode definir o setor/segmento para melhorar.)", 50, y, 95, 10);
    } else {
      for (const s of listed) {
        const line = `${safeText(s.title)} — ${safeText(s.url)}`;
        y = drawParagraph(page, fonts, line, 50, y, 95, 9);
        y -= 4;
      }
    }

    y -= 8;
    drawCallout(
      page,
      fonts,
      "Nota importante",
      "Benchmarks variam por setor, porte e região. Use como referência inicial e valide com comparáveis diretos do seu mercado.",
      50,
      y,
      495
    );
  }

  // ---------- Plano ----------
  {
    const page = pdfDoc.addPage(A4);
    let y = 790;
    drawSectionTitle(page, fonts, "Plano de Ação — 30 / 60 / 90 dias", 50, y);
    y -= 26;

    page.drawText("30 dias (impacto rápido)", { x: 50, y, size: 11, font: fonts.bold, color: rgb(0.1, 0.1, 0.1) });
    y -= 16;
    y = drawBulletList(page, fonts, report.actionPlan?.d30 ?? [], 50, y, 95, 10);
    y -= 10;

    page.drawText("60 dias (consolidação)", { x: 50, y, size: 11, font: fonts.bold, color: rgb(0.1, 0.1, 0.1) });
    y -= 16;
    y = drawBulletList(page, fonts, report.actionPlan?.d60 ?? [], 50, y, 95, 10);
    y -= 10;

    page.drawText("90 dias (estrutura)", { x: 50, y, size: 11, font: fonts.bold, color: rgb(0.1, 0.1, 0.1) });
    y -= 16;
    y = drawBulletList(page, fonts, report.actionPlan?.d90 ?? [], 50, y, 95, 10);

    y -= 8;
    drawCallout(
      page,
      fonts,
      "Como usar",
      "Execute o plano em ciclos semanais: (1) medir, (2) agir, (3) revisar. Foque no Top 3 do Pareto e em eficiência administrativa.",
      50,
      y,
      495
    );
  }

  // ---------- Apêndice ----------
  {
    const page = pdfDoc.addPage(A4);
    let y = 790;
    drawSectionTitle(page, fonts, "Apêndice — Pareto (Top Gastos)", 50, y);
    y -= 24;

    const top = Array.isArray(pack?.top) ? pack.top : [];
    const top10 = top.slice(0, 10);

    if (!top10.length) {
      y = drawParagraph(page, fonts, "— (Sem Pareto/topGastos disponível neste job)", 50, y, 95, 10);
    } else {
      for (let i = 0; i < top10.length; i++) {
        const it = top10[i];
        const label = safeText(it?.label ?? it?.description ?? it?.key ?? `Item ${i + 1}`);
        const val = it?.value ?? it?.valor ?? it?.total ?? null;
        const line = `${i + 1}. ${label} — R$ ${safeMoney(val)}`;
        y = drawParagraph(page, fonts, line, 50, y, 95, 10);
        y -= 2;
        if (y < 80) break;
      }
    }

    y -= 10;
    drawCallout(
      page,
      fonts,
      "Dica prática",
      "Use o Pareto para priorizar ações: o objetivo é reduzir custo total focando nos itens de maior impacto.",
      50,
      y,
      495
    );
  }

  const bytes = await pdfDoc.save();
  const filename = `relatorio_pricetax_${run.jobId}.pdf`;

  return { bytes, filename };
}

// ✅ GET
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const jobId = searchParams.get("jobId");

    const built = await buildPdfBytes({ jobId });

    // ✅ TRATAMENTO do caso sem bytes
    if (isBuildErr(built)) {
      return NextResponse.json({ ok: false, error: built.error }, { status: built.status });
    }

    return new NextResponse(Buffer.from(built.bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${built.filename}"`,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Falha ao gerar PDF." }, { status: 500 });
  }
}

// ✅ POST
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({} as any));
    const jobIdRaw = body?.jobId ? String(body.jobId).trim() : null;
    const jobId = jobIdRaw && jobIdRaw !== "—" ? jobIdRaw : null;

    const charts = body?.charts && typeof body.charts === "object" ? body.charts : null;
    const sector = body?.sector ? String(body.sector).trim() : null;

    const built = await buildPdfBytes({
      jobId,
      transcript: Array.isArray(body?.transcript) ? body.transcript : [],
      charts: charts
        ? {
            pareto: typeof charts.pareto === "string" ? charts.pareto : null,
            adminVsReceita: typeof charts.adminVsReceita === "string" ? charts.adminVsReceita : null,
            grupos: typeof charts.grupos === "string" ? charts.grupos : null,
            serie: typeof charts.serie === "string" ? charts.serie : null,
          }
        : {},
      sector,
    });

    // ✅ TRATAMENTO do caso sem bytes
    if (isBuildErr(built)) {
      return NextResponse.json({ ok: false, error: built.error }, { status: built.status });
    }

    return new NextResponse(Buffer.from(built.bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${built.filename}"`,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Falha ao gerar PDF." }, { status: 500 });
  }
}
