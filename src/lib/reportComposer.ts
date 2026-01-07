// src/lib/reportComposer.ts
import { runLlm } from "@/lib/llm";
import { searchSeededDocs } from "@/lib/docsRuntime";

export type ReportSection = {
  title: string;
  insight: string;
  whyItMatters: string;
  recommendation: string;
  chartKey?: "pareto" | "adminVsReceita" | "grupos" | "serie";
};

export type ReportModel = {
  executiveSummary: string[];
  sections: ReportSection[];
  actionPlan: { d30: string[]; d60: string[]; d90: string[] };
  benchmarks: { items: string[]; sources: Array<{ title: string; url: string }> };
  methodologyNotes?: string[];
};

export type ReportComposerInput = {
  pack: any;
  market: { items: string[]; sources: Array<{ title: string; url: string }> };
  sector?: string | null;
};

function safeText(s: any) {
  const t = String(s ?? "").trim();
  return t || "—";
}
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
function safeJson(x: any) {
  try {
    return JSON.stringify(x ?? null);
  } catch {
    return "null";
  }
}

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
      insight: `No período mais recente (${safeText(latest?.period)}), a Receita Líquida foi R$ ${safeMoney(
        receita
      )} e o Lucro Líquido R$ ${safeMoney(lucro)}.`,
      whyItMatters:
        `Esse retrato define capacidade de caixa e margem. Se a margem está pressionada, cortes precisam ser focados e mensuráveis.`,
      recommendation:
        `Atacar custos do Pareto, revisar despesas administrativas recorrentes e criar rotina de KPI por período.`,
      chartKey: "serie",
    },
    {
      title: "2) Pareto de Gastos (Foco de Corte)",
      insight:
        `O ranking de gastos mostra concentração. Redução no Top 3 costuma gerar o maior impacto com menos dispersão.`,
      whyItMatters:
        `Cortes pulverizados geram pouco efeito. Pareto aumenta eficiência da intervenção.`,
      recommendation:
        `Renegociar contratos, reduzir recorrências duplicadas e atacar desperdícios de maior peso.`,
      chartKey: "pareto",
    },
    {
      title: "3) Eficiência Administrativa",
      insight:
        `A eficiência é medida pela proporção de despesas administrativas sobre a receita do período.`,
      whyItMatters:
        `Estrutura administrativa alta reduz margem mesmo com crescimento de faturamento.`,
      recommendation:
        `Definir teto (% da receita) e automatizar processos para reduzir custo recorrente.`,
      chartKey: "adminVsReceita",
    },
    {
      title: "4) Estrutura do Balanço (Ativo/Passivo/DRE)",
      insight:
        `A distribuição por grupos auxilia no diagnóstico de equilíbrio e risco.`,
      whyItMatters:
        `Desequilíbrios podem indicar pressão de curto prazo, alavancagem ou baixa liquidez.`,
      recommendation:
        `Acompanhar capital de giro e revisar prazos/obrigações de curto prazo.`,
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
        "Mapear Top 10 custos (Pareto) e definir responsáveis por item",
        "Renegociar 3 contratos de maior impacto",
        "Criar rotina semanal de KPI (Receita, Admin, Lucro, Margens)",
        "Validar se houve eventos não recorrentes no período",
      ],
      d60: [
        "Padronizar processo de compras e aprovações",
        "Implantar automações (relatórios, aprovações, alertas)",
        "Revisar CMV/CPV e precificação com foco em margem",
        "Criar metas por centro de custo",
      ],
      d90: [
        "Orçamento base zero (Opex) e centros de custo formalizados",
        "Revisar mix de produtos/serviços por contribuição",
        "Metas trimestrais com revisão mensal",
        "Benchmarking com comparáveis diretos do setor",
      ],
    },
    benchmarks: { items, sources },
    methodologyNotes: [
      "Este relatório usa exclusivamente os KPIs e rankings calculados a partir do balancete processado no painel.",
      "Trechos de TCC/livro/fórmula (quando disponíveis) são usados apenas para embasar metodologia e recomendações, nunca para inventar números.",
    ],
  };
}

async function buildAiReport(args: {
  pack: any;
  market: { items: string[]; sources: any[] };
  theorySnippets: string[];
}): Promise<ReportModel> {
  const hasKey = !!process.env.OPENAI_API_KEY;
  if (!hasKey) return buildFallbackReport(args.pack, args.market);

  const instructions = [
    "Você é a IA do PriceTax, especialista em análise financeira e diagnóstico por balancetes.",
    "Retorne APENAS JSON válido (sem markdown).",
    "",
    "REGRAS:",
    "1) NÚMEROS: use EXCLUSIVAMENTE o Context Pack (painel do MVP). Não invente valores.",
    "2) TRECHOS TEÓRICOS (TCC/livro/fórmula): use apenas para explicar metodologia, conceitos e recomendações. Nunca use para criar números.",
    "3) Benchmarks são referência (faixas/mercado) e devem ser tratados como 'contexto'.",
    "",
    "Saída deve seguir o tipo ReportModel e ser bem detalhada.",
  ].join("\n");

  const input = [
    {
      role: "user" as const,
      content: [
        "RETORNE APENAS JSON VÁLIDO.",
        "",
        "CONTEXT_PACK_JSON (fonte única para números):",
        safeJson(args.pack),
        "",
        "TRECHOS_TEORICOS (TCC/LIVRO/FÓRMULA — base conceitual):",
        args.theorySnippets.length ? args.theorySnippets.join("\n") : "(sem trechos relevantes disponíveis)",
        "",
        "MARKET_ITEMS:",
        safeJson(args.market?.items ?? []),
        "",
        "MARKET_SOURCES:",
        safeJson(args.market?.sources ?? []),
        "",
        "FORMATO (TypeScript):",
        `type ReportModel = {
  executiveSummary: string[];
  sections: { title: string; insight: string; whyItMatters: string; recommendation: string; chartKey?: "pareto"|"adminVsReceita"|"grupos"|"serie" }[];
  actionPlan: { d30: string[]; d60: string[]; d90: string[] };
  benchmarks: { items: string[]; sources: { title: string; url: string }[] };
  methodologyNotes?: string[];
};`,
      ].join("\n"),
    },
  ];

  const raw = await runLlm({ instructions, input, maxTokens: 1100 });

  try {
    const parsed = JSON.parse(String(raw || "{}"));
    if (!parsed || !Array.isArray(parsed.executiveSummary) || !Array.isArray(parsed.sections)) {
      return buildFallbackReport(args.pack, args.market);
    }
    return parsed as ReportModel;
  } catch {
    return buildFallbackReport(args.pack, args.market);
  }
}

export async function composeReportModel(input: ReportComposerInput) {
  const theoryQuery =
    "balancete dre margem bruta margem liquida despesas administrativas pareto redução de custos metodologia indicadores";
  const theoryHits = searchSeededDocs(theoryQuery, { limit: 12 });
  const theorySnippets = theoryHits.map((h: any, i: number) => `(${i + 1}) ${String(h.preview || "").trim()}`);

  const report = await buildAiReport({
    pack: input.pack,
    market: input.market,
    theorySnippets,
  });

  return {
    report,
    theorySnippets,
  };
}
