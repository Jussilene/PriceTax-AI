"use client";

import { useMemo, useState, useEffect } from "react";
import Script from "next/script";
import Topbar from "@/components/Topbar";
import UploadCard from "@/components/UploadCard";
import type { AnalyzeResponse } from "@/lib/types";
import ChatFab from "@/components/ChatFab";

export default function DashboardPage() {
  const [result, setResult] = useState<AnalyzeResponse | null>(null);

  // ✅ NOVO: toggle para rankings
  const [showAllRankings, setShowAllRankings] = useState(false);

  // ✅ controle de carregamento dos scripts de gráfico
  const [chartsReady, setChartsReady] = useState(false);

  // ✅ NOVO: estado da narrativa
  const [narrativa, setNarrativa] = useState<null | {
    resumoExecutivo: string;
    alertas: string[];
    checklist: string[];
  }>(null);
  const [narrativaLoading, setNarrativaLoading] = useState(false);
  const [narrativaError, setNarrativaError] = useState<string | null>(null);

  // ✅ NOVO: loading do PDF
  const [pdfLoading, setPdfLoading] = useState(false);

  // Helpers seguros (não quebram se algum campo não existir)
  const ok = !!result?.ok;

  const jobId = (result as any)?.jobId ?? (result as any)?.meta?.jobId ?? "—";
  const periodMode = (result as any)?.meta?.periodMode ?? "—";
  const detectedYears: number[] = (result as any)?.meta?.detectedYears ?? [];

  const metaFiles: Array<{ name: string; size: number; year?: number | null }> =
    (result as any)?.meta?.files ?? [];

  // “novo resultado” (summary + files com pages/sample)
  const summary =
    (result as any)?.result?.summary ?? (result as any)?.data?.summary ?? null;

  const parsedFiles: Array<{
    fileName: string;
    pages: number;
    detectedYear?: number | null;
    sample: string;
  }> = (result as any)?.result?.files ?? (result as any)?.data?.files ?? [];

  const warnings: string[] = summary?.warnings ?? [];
  const totalFiles = summary?.totalFiles ?? parsedFiles?.length ?? 0;
  const yearsDetected: number[] = summary?.yearsDetected ?? detectedYears ?? [];

  // ✅ blocos de análise (KPIs / séries / rankings / alerts)
  const analysisRoot = (result as any)?.result ?? (result as any)?.data ?? null;

  // ✅ base normalizada (tabela limpa)
  const baseNormalizada:
    | Array<{
        period?: string | null;
        year?: number | null;
        group?: string;
        code?: string | null;
        classification?: string | null;
        description?: string | null;
        saldoAtual?: number | null;
        saldoAnterior?: number | null;
        debito?: number | null;
        credito?: number | null;
      }>
    | [] =
    (result as any)?.baseNormalizada ??
    analysisRoot?.baseNormalizada ??
    (result as any)?.data?.baseNormalizada ??
    [];

  const rowsDetected: number =
    analysisRoot?.summary?.rowsDetected ?? summary?.rowsDetected ?? 0;

  /**
   * ✅ AJUSTE MÍNIMO:
   * Agora o /api/analyze devolve:
   * - result.kpis.byPeriod (dentro de result)
   * - e também kpisByPeriod no topo
   *
   * Então aqui a gente pega do lugar antigo (result.kpis.byPeriod)
   * e se não existir, pega do topo (result.kpisByPeriod).
   */
  const kpisByPeriod: Array<{
    period: string;
    kpis: {
      ativoTotal: number;
      passivoTotal: number;
      dreTotal?: number;
      linhasDetectadas: number;
    };
  }> = analysisRoot?.kpis?.byPeriod ?? ((result as any)?.kpisByPeriod ?? []);

  /**
   * ✅ AJUSTE MÍNIMO:
   * séries podem vir em result.series ou no topo series
   */
  const seriesAtivo: Array<{ period: string; value: number }> =
    analysisRoot?.series?.ativoTotal ?? ((result as any)?.series?.ativoTotal ?? []);

  const seriesPassivo: Array<{ period: string; value: number }> =
    analysisRoot?.series?.passivoTotal ?? ((result as any)?.series?.passivoTotal ?? []);

  const seriesDre: Array<{ period: string; value: number }> =
    analysisRoot?.series?.dreTotal ?? ((result as any)?.series?.dreTotal ?? []);

  /**
   * ✅ AJUSTE MÍNIMO:
   * rankings podem vir em result.rankings ou no topo rankings
   */
  const topSaldosAtivo: Array<{
    code?: string | null;
    description?: string | null;
    value: number;
    period: string;
  }> =
    analysisRoot?.rankings?.topSaldosAtivo ??
    ((result as any)?.rankings?.topSaldosAtivo ?? []);

  const topSaldosPassivo: Array<{
    code?: string | null;
    description?: string | null;
    value: number;
    period: string;
  }> =
    analysisRoot?.rankings?.topSaldosPassivo ??
    ((result as any)?.rankings?.topSaldosPassivo ?? []);

  const topVariacoes: Array<{
    key: string;
    code?: string | null;
    description?: string | null;
    from: string;
    to: string;
    delta: number;
    deltaPct: number | null;
  }> =
    analysisRoot?.rankings?.topVariacoes ??
    ((result as any)?.rankings?.topVariacoes ?? []);

  /**
   * ✅ AJUSTE MÍNIMO:
   * alerts podem vir em result.alerts ou no topo alerts
   */
  const alerts: Array<{ level: "info" | "warning"; message: string }> =
    analysisRoot?.alerts ?? ((result as any)?.alerts ?? []);

  // ✅ NOVO: KPIs (DRE)
  /**
   * ✅ AJUSTE MÍNIMO:
   * tccKpis pode vir em result.tccKpis ou no topo tccKpis
   */
  const tccByPeriod: Array<{
    period: string;
    year?: number | null;

    receita_liquida: number;
    receita_bruta: number;
    deducoes: number;

    cmv_cpv: number;
    despesas_admin: number;
    despesas_comerciais: number;
    outras_despesas: number;

    lucro_bruto: number | null;
    resultado_operacional: number | null;
    lucro_liquido: number | null;

    margem_bruta_pct: number | null;
    margem_liquida_pct: number | null;
  }> =
    analysisRoot?.tccKpis?.byPeriod ?? ((result as any)?.tccKpis?.byPeriod ?? []);

  const tccNotes: string[] =
    analysisRoot?.tccKpis?.notes ?? ((result as any)?.tccKpis?.notes ?? []);

  const hasAnyAnalysis =
    (kpisByPeriod?.length ?? 0) > 0 ||
    (seriesAtivo?.length ?? 0) > 0 ||
    (seriesPassivo?.length ?? 0) > 0 ||
    (seriesDre?.length ?? 0) > 0 ||
    (topSaldosAtivo?.length ?? 0) > 0 ||
    (topSaldosPassivo?.length ?? 0) > 0 ||
    (topVariacoes?.length ?? 0) > 0 ||
    (alerts?.length ?? 0) > 0 ||
    !!rowsDetected ||
    (baseNormalizada?.length ?? 0) > 0 ||
    (tccByPeriod?.length ?? 0) > 0;

  const fmtBR = (n: any) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    return v.toLocaleString("pt-BR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  };

  const fmtPct = (n: any) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    return `${v.toLocaleString("pt-BR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}%`;
  };

  const labelConta = (item: { code?: string | null; description?: string | null }) => {
    const code = item.code ? String(item.code).trim() : "";
    const desc = item.description ? String(item.description).trim() : "";
    if (code && desc) return `${code} — ${desc}`;
    if (desc) return desc;
    if (code) return code;
    return "—";
  };

  // ✅ descobrir último e penúltimo período (pra filtrar variações)
  const lastPair = useMemo(() => {
    const periods =
      (kpisByPeriod?.map((p) => p.period).filter(Boolean) as string[]) ??
      (seriesAtivo?.map((s) => s.period).filter(Boolean) as string[]) ??
      [];

    const unique = Array.from(new Set(periods));

    const parseQuarter = (p: string) => {
      const m = String(p).match(/T\s*(\d)\s*\/\s*(\d{4})/i);
      if (!m) return null;
      const q = Number(m[1]);
      const y = Number(m[2]);
      if (!Number.isFinite(q) || !Number.isFinite(y)) return null;
      return { q, y, raw: p };
    };

    const parsed = unique
      .map(parseQuarter)
      .filter(Boolean) as Array<{ q: number; y: number; raw: string }>;

    parsed.sort((a, b) => a.y - b.y || a.q - b.q);

    const last = parsed.at(-1)?.raw ?? null;
    const prev = parsed.at(-2)?.raw ?? null;

    return { last, prev };
  }, [kpisByPeriod, seriesAtivo]);

  // ✅ filtros para Rankings
  const filteredTopSaldosAtivo = useMemo(() => {
    if (showAllRankings) return topSaldosAtivo;
    if (!lastPair.last) return topSaldosAtivo;
    return topSaldosAtivo.filter((x) => x.period === lastPair.last);
  }, [showAllRankings, topSaldosAtivo, lastPair.last]);

  const filteredTopSaldosPassivo = useMemo(() => {
    if (showAllRankings) return topSaldosPassivo;
    if (!lastPair.last) return topSaldosPassivo;
    return topSaldosPassivo.filter((x) => x.period === lastPair.last);
  }, [showAllRankings, topSaldosPassivo, lastPair.last]);

  const filteredTopVariacoes = useMemo(() => {
    if (showAllRankings) return topVariacoes;
    if (!lastPair.last || !lastPair.prev) return topVariacoes;

    return topVariacoes.filter((x) => x.from === lastPair.prev && x.to === lastPair.last);
  }, [showAllRankings, topVariacoes, lastPair.last, lastPair.prev]);

  // ✅ preview da base
  const basePreview = useMemo(() => {
    if (!baseNormalizada?.length) return [];
    return baseNormalizada.slice(0, 25);
  }, [baseNormalizada]);

  // ✅ NOVO: pega o último período do TCC (para cards)
  const tccLast = useMemo(() => {
    if (!tccByPeriod?.length) return null;
    return tccByPeriod[tccByPeriod.length - 1];
  }, [tccByPeriod]);

  // ✅ Payload dos gráficos (baseado no que tu já tem pronto hoje)
  const chartsPayload = useMemo(() => {
    // ✅ topGastos pode vir em result.topGastos ou no topo topGastos
    const topGastos =
      (analysisRoot?.topGastos as Array<{ label: string; value: number }>) ??
      ((result as any)?.topGastos ?? []);

    // ✅ AJUSTE (TOP GASTOS): garante sempre array (mesmo com 1 item)
    const safeTopGastos = Array.isArray(topGastos) ? topGastos : [];

    // ✅ AJUSTE (TOP GASTOS): se tccByPeriod estiver vazio, ainda assim tenta renderizar
    // usando períodos do kpisByPeriod (pra não travar o render dos charts)
    const periodosFromTcc =
      (tccByPeriod?.map((p) => p.period).filter(Boolean) as string[]) ?? [];

    const periodosFromKpis =
      (kpisByPeriod?.map((p) => p.period).filter(Boolean) as string[]) ?? [];

    const periodos = periodosFromTcc.length ? periodosFromTcc : periodosFromKpis;

    const kpisPorPeriodo: Record<
      string,
      { receitaLiquida?: number; despAdmin?: number; lucroLiquido?: number }
    > = {};

    tccByPeriod.forEach((p) => {
      kpisPorPeriodo[p.period] = {
        receitaLiquida: Number(p.receita_liquida ?? 0),
        despAdmin: Number(p.despesas_admin ?? 0),
        lucroLiquido: Number(p.lucro_liquido ?? 0),
      };
    });

    // Distribuição por grupo: usamos último período da tua etapa 3 (kpisByPeriod)
    const last = kpisByPeriod?.length ? kpisByPeriod[kpisByPeriod.length - 1] : null;
    const distribuicaoGrupos = {
      ATIVO: Number(last?.kpis?.ativoTotal ?? 0),
      PASSIVO: Number(last?.kpis?.passivoTotal ?? 0),
      DRE: Number(last?.kpis?.dreTotal ?? 0),
    };

    return { periodos, kpisPorPeriodo, topGastos: safeTopGastos, distribuicaoGrupos };
  }, [tccByPeriod, analysisRoot, kpisByPeriod, result]);

  // ✅ Renderiza os gráficos quando tiver resultado + scripts carregados
  useEffect(() => {
    if (!chartsReady) return;
    if (!ok) return;

    // ✅ AJUSTE (TOP GASTOS): não trava o render só porque não tem periodos do TCC
    // (Pareto pode existir mesmo sem tccByPeriod)
    const hasAnyForCharts =
      (chartsPayload?.periodos?.length ?? 0) > 0 ||
      (chartsPayload?.topGastos?.length ?? 0) > 0;

    if (!hasAnyForCharts) return;

    const w = window as any;
    if (w?.PricetaxCharts?.render) {
      w.PricetaxCharts.render(chartsPayload);
    }
  }, [chartsReady, ok, chartsPayload]);

  // ✅ NOVO: se subir novo resultado, reseta narrativa
  useEffect(() => {
    setNarrativa(null);
    setNarrativaError(null);
    setNarrativaLoading(false);
  }, [jobId]);

  // ✅ NOVO: salva o jobId pro chat puxar (SÓ ISSO FOI ADICIONADO)
  useEffect(() => {
    try {
      if (!ok) return;
      const jid = String(jobId || "").trim();
      if (!jid || jid === "—") return;
      localStorage.setItem("pt_lastJobId", jid);
    } catch {}
  }, [ok, jobId]);

  // ✅ NOVO: gerar narrativa (sem quebrar com HTML)
  const handleGerarNarrativa = async () => {
    try {
      setNarrativaLoading(true);
      setNarrativaError(null);

      // ✅ AJUSTE MÍNIMO: adiciona distribuicaoGrupos + thresholds
      const payload = {
        periodos: chartsPayload?.periodos ?? [],
        kpisPorPeriodo: chartsPayload?.kpisPorPeriodo ?? {},
        topGastos: chartsPayload?.topGastos ?? [],
        distribuicaoGrupos: chartsPayload?.distribuicaoGrupos ?? undefined,
        thresholds: {
          receitaQuedaWarn: 0.10,
          receitaQuedaCrit: 0.25,
          adminAltaWarn: 0.15,
          adminAltaCrit: 0.25,
          concentracaoTop3Warn: 0.45,
          concentracaoTop3Crit: 0.60,
        },
      };

      const res = await fetch("/api/narrativa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("application/json")) {
        const text = await res.text();
        throw new Error(
          `Resposta inesperada (não-JSON). Status ${res.status}. Início: ${text.slice(0, 60)}`
        );
      }

      const data = await res.json();

      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "Falha ao gerar narrativa.");
      }

      setNarrativa({
        resumoExecutivo: String(data?.resumoExecutivo ?? ""),
        alertas: Array.isArray(data?.alertas) ? data.alertas : [],
        checklist: Array.isArray(data?.checklist) ? data.checklist : [],
      });
    } catch (e: any) {
      setNarrativaError(String(e?.message || e));
      setNarrativa(null);
    } finally {
      setNarrativaLoading(false);
    }
  };

  // ✅ NOVO: baixar PDF (opção A) — envia os gráficos como PNG e chama /api/report
  const handleBaixarPDF = async () => {
    try {
      setPdfLoading(true);

      const getCanvasPng = (id: string) => {
        const el = document.getElementById(id) as HTMLCanvasElement | null;
        if (!el) return null;
        try {
          return el.toDataURL("image/png", 1.0);
        } catch {
          return null;
        }
      };

      const charts = {
        pareto: getCanvasPng("chartPareto"),
        adminVsReceita: getCanvasPng("chartAdminVsReceita"),
        grupos: getCanvasPng("chartGrupos"),
        serie: getCanvasPng("chartSerie"),
      };

      const jid = String(jobId || "").trim();
      const safeJobId = jid && jid !== "—" ? jid : null;

      const res = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId: safeJobId,
          charts,
        }),
      });

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(t || `Falha ao gerar PDF (HTTP ${res.status})`);
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = `relatorio_pricetax_${safeJobId ?? "sem_job"}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();

      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert(String(e?.message || e));
    } finally {
      setPdfLoading(false);
    }
  };

  return (
    <main className="pt-bg min-h-screen">
      {/* Chart.js + loader do charts */}
      <Script src="https://cdn.jsdelivr.net/npm/chart.js" strategy="afterInteractive" />
      <Script src="/js/charts.js" strategy="afterInteractive" onLoad={() => setChartsReady(true)} />

      <Topbar variant="dashboard" />

      <section className="mx-auto max-w-6xl px-6 py-10 space-y-6">
        <div className="pt-card w-full rounded-2xl p-6">
          <UploadCard onResult={setResult} />
        </div>

        {/* ✅ NOVO: Gráficos */}
        <div className="pt-card rounded-2xl p-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Gráficos</h2>
              <p className="pt-muted mt-1 text-sm">
                Visualização automática com base nos KPIs já calculados.
              </p>
            </div>

            {/* ✅ BOTÃO PDF (APENAS ADICIONADO) */}
            <button
              type="button"
              onClick={handleBaixarPDF}
              disabled={!ok || pdfLoading}
              className="pt-btn rounded-lg px-4 py-2 text-sm disabled:opacity-60"
              title={!ok ? "Envie um balancete para liberar o PDF." : "Baixar relatório em PDF"}
            >
              {pdfLoading ? "Gerando PDF..." : "Baixar PDF"}
            </button>
          </div>

          {!ok ? (
            <div className="pt-surface mt-4 rounded-xl p-4 text-sm">
              Envie um balancete para gerar os gráficos.
            </div>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mt-4">
              <div className="pt-surface rounded-xl p-4">
                <h3 className="font-semibold mb-2">Top Gastos (Pareto)</h3>
                <canvas id="chartPareto"></canvas>
              </div>

              <div className="pt-surface rounded-xl p-4">
                <h3 className="font-semibold mb-2">Admin vs Receita (por período)</h3>
                <canvas id="chartAdminVsReceita"></canvas>
              </div>

              <div className="pt-surface rounded-xl p-4">
                <h3 className="font-semibold mb-2">
                  Distribuição por Grupo (Ativo/Passivo/DRE)
                </h3>
                <canvas id="chartGrupos"></canvas>
              </div>

              <div className="pt-surface rounded-xl p-4">
                <h3 className="font-semibold mb-2">Receita x Lucro Líquido (série)</h3>
                <canvas id="chartSerie"></canvas>
              </div>
            </div>
          )}
        </div>

        {/* ✅ NOVO: Relatório narrativo (sem tirar nada do resto) */}
        <div className="pt-card rounded-2xl p-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Relatório narrativo</h2>
              <p className="pt-muted mt-1 text-sm">
                Texto executivo automático baseado nos KPIs + Top Gastos.
              </p>
            </div>

            <button
              type="button"
              onClick={handleGerarNarrativa}
              disabled={!ok || narrativaLoading}
              className="pt-btn rounded-lg px-4 py-2 text-sm disabled:opacity-60"
            >
              {narrativaLoading ? "Gerando..." : "Gerar narrativa"}
            </button>
          </div>

          {!ok ? (
            <div className="pt-surface mt-4 rounded-xl p-4 text-sm">
              Envie um balancete para gerar a narrativa.
            </div>
          ) : narrativaError ? (
            <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-sm">
              {narrativaError}
            </div>
          ) : !narrativa ? (
            <div className="pt-surface mt-4 rounded-xl p-4 text-sm">
              Clique em <b>Gerar narrativa</b> para criar o relatório.
            </div>
          ) : (
            <div className="mt-4 space-y-4 text-sm">
              <div className="pt-surface rounded-xl p-4">
                <div className="font-semibold">Resumo executivo</div>
                <pre className="mt-2 whitespace-pre-wrap text-sm">{narrativa.resumoExecutivo}</pre>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="pt-surface rounded-xl p-4">
                  <div className="font-semibold">Alertas</div>
                  {narrativa.alertas?.length ? (
                    <ul className="mt-2 list-disc pl-5">
                      {narrativa.alertas.map((a, i) => (
                        <li key={i}>{a}</li>
                      ))}
                    </ul>
                  ) : (
                    <div className="pt-muted mt-2">Nenhum alerta relevante.</div>
                  )}
                </div>

                <div className="pt-surface rounded-xl p-4">
                  <div className="font-semibold">Checklist</div>
                  {narrativa.checklist?.length ? (
                    <ul className="mt-2 list-disc pl-5">
                      {narrativa.checklist.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  ) : (
                    <div className="pt-muted mt-2">Checklist não disponível.</div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="pt-card rounded-2xl p-6">
          <h2 className="text-lg font-semibold">Status do processamento</h2>
          <p className="pt-muted mt-1 text-sm">
            Após o envio, exibimos metadados detectados e o status do job.
          </p>

          {!result ? (
            <div className="pt-surface mt-4 rounded-xl p-4 text-sm">
              Nenhum upload enviado ainda.
            </div>
          ) : ok ? (
            <div className="mt-4 space-y-4 text-sm">
              <div className="space-y-1">
                <div>
                  <b>JOB:</b> {jobId}
                </div>
                <div>
                  <b>Modo:</b> {periodMode}
                </div>
                <div>
                  <b>Anos detectados:</b>{" "}
                  {detectedYears?.length ? detectedYears.join(", ") : "—"}
                </div>

                <div className="mt-2">
                  <b>Arquivos:</b>
                  <ul className="mt-1 list-disc pl-5">
                    {metaFiles?.length ? (
                      metaFiles.map((f) => (
                        <li key={f.name}>
                          {f.name}
                          {f.year ? ` (${f.year})` : ""} — {(f.size / 1024).toFixed(0)} KB
                        </li>
                      ))
                    ) : (
                      <li>—</li>
                    )}
                  </ul>
                </div>

                <div className="pt-surface mt-4 rounded-xl p-4">
                  {(result as any)?.message ?? "Processamento concluído."}
                </div>
              </div>

              <div className="pt-surface rounded-xl p-4">
                <div className="font-semibold">Resumo</div>
                <div className="mt-2 grid gap-1">
                  <div>
                    <b>Total de arquivos:</b> {totalFiles}
                  </div>
                  <div>
                    <b>Anos detectados (resumo):</b>{" "}
                    {yearsDetected?.length ? yearsDetected.join(", ") : "—"}
                  </div>
                </div>

                {warnings?.length > 0 && (
                  <div className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3">
                    <div className="font-semibold text-amber-200">Avisos</div>
                    <ul className="mt-2 list-disc pl-5 text-amber-100">
                      {warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <div className="pt-surface rounded-xl p-4">
                <div className="font-semibold">Arquivos processados</div>

                {!parsedFiles?.length ? (
                  <div className="pt-muted mt-2">Nenhum conteúdo detalhado retornado ainda.</div>
                ) : (
                  <div className="mt-3 space-y-3">
                    {parsedFiles.map((f, idx) => (
                      <div
                        key={`${f.fileName}-${idx}`}
                        className="rounded-xl border border-line bg-panel p-3"
                      >
                        <div>
                          <b>{f.fileName}</b>
                        </div>

                        <div className="pt-muted mt-1 text-xs">
                          Páginas: {f.pages ?? "—"} • Ano: {f.detectedYear ?? "—"}
                        </div>

                        <div className="pt-muted mt-2 text-xs">
                          <b>Sample:</b>
                        </div>

                        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-panel p-2 text-xs">
                          {f.sample?.trim() ? f.sample : "(sem texto extraído)"}
                        </pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* ✅ Base normalizada */}
              <div className="pt-surface rounded-xl p-4">
                <div className="font-semibold">Base normalizada (tabela limpa)</div>

                {!baseNormalizada?.length ? (
                  <div className="pt-muted mt-2">
                    A base normalizada ainda não veio no response.
                    <br />
                    Dica: confira no DevTools → Network → /api/analyze se existe{" "}
                    <b>baseNormalizada</b> (no topo) ou <b>result.baseNormalizada</b>.
                  </div>
                ) : (
                  <div className="mt-3 space-y-3">
                    <div className="rounded-xl border border-line bg-panel p-3 text-xs">
                      <b>Total de linhas normalizadas:</b>{" "}
                      {baseNormalizada.length.toLocaleString("pt-BR")}
                    </div>

                    <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-panel p-3 text-xs">
                      {JSON.stringify(basePreview, null, 2)}
                    </pre>
                  </div>
                )}
              </div>

              {/* ✅ NOVO: KPIs (DRE) */}
              <div className="pt-surface rounded-xl p-4">
                <div className="font-semibold">KPIs (DRE)</div>

                {!tccByPeriod?.length ? (
                  <div className="pt-muted mt-2">
                    Ainda não veio <b>result.tccKpis.byPeriod</b> no response.
                    <br />
                    Confere no DevTools → Network → POST /api/analyze → Response.
                  </div>
                ) : (
                  <div className="mt-3 space-y-3">
                    <div className="pt-muted text-xs">
                      Períodos detectados: {tccByPeriod.map((p) => p.period).join(" • ")}
                    </div>

                    {tccNotes?.length > 0 && (
                      <div className="rounded-xl border border-line bg-panel p-3 text-xs">
                        <b>Notas:</b>
                        <ul className="mt-2 list-disc pl-5">
                          {tccNotes.map((n, i) => (
                            <li key={i}>{n}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {tccLast && (
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="rounded-xl border border-line bg-panel p-4">
                          <div className="pt-muted text-xs">Último período</div>
                          <div className="text-sm font-semibold">{tccLast.period}</div>

                          <div className="mt-3 grid gap-2 text-xs">
                            <div>
                              <b>Receita Líquida:</b> {fmtBR(tccLast.receita_liquida)}
                            </div>
                            <div>
                              <b>CMV/CPV:</b> {fmtBR(tccLast.cmv_cpv)}
                            </div>
                            <div>
                              <b>Despesas Admin:</b> {fmtBR(tccLast.despesas_admin)}
                            </div>
                            <div>
                              <b>Lucro Bruto:</b>{" "}
                              {tccLast.lucro_bruto === null ? "—" : fmtBR(tccLast.lucro_bruto)}
                            </div>
                            <div>
                              <b>Lucro Líquido:</b>{" "}
                              {tccLast.lucro_liquido === null ? "—" : fmtBR(tccLast.lucro_liquido)}
                            </div>
                          </div>
                        </div>

                        <div className="rounded-xl border border-line bg-panel p-4">
                          <div className="pt-muted text-xs">Margens</div>
                          <div className="mt-3 grid gap-2 text-xs">
                            <div>
                              <b>Margem Bruta:</b>{" "}
                              {tccLast.margem_bruta_pct === null
                                ? "—"
                                : fmtPct(tccLast.margem_bruta_pct)}
                            </div>
                            <div>
                              <b>Margem Líquida:</b>{" "}
                              {tccLast.margem_liquida_pct === null
                                ? "—"
                                : fmtPct(tccLast.margem_liquida_pct)}
                            </div>
                            <div className="pt-muted mt-2">
                              (Se estiver “—”, é porque Receita Líquida não foi detectada com esse nome no balancete. A
                              gente ajusta os matchers.)
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-panel p-3 text-xs">
                      {JSON.stringify(tccByPeriod, null, 2)}
                    </pre>
                  </div>
                )}
              </div>

              <div className="pt-surface rounded-xl p-4">
                <div className="font-semibold">Análises</div>

                {!hasAnyAnalysis ? (
                  <div className="pt-muted mt-2">
                    Ainda não há métricas retornadas no result (kpis/series/rankings/alerts).
                    <br />
                    Dica: abra o DevTools → Network → POST /api/analyze → Response e confirme se existe <b>result.kpis</b>,{" "}
                    <b>result.series</b>, <b>result.rankings</b>, <b>result.alerts</b>.
                  </div>
                ) : (
                  <div className="mt-3 space-y-4">
                    <div className="rounded-xl border border-line bg-panel p-3">
                      <div className="pt-muted text-xs">
                        <b>Linhas detectadas (total):</b> {rowsDetected || "—"}
                      </div>
                    </div>

                    {alerts?.length > 0 && (
                      <div className="rounded-xl border border-line bg-panel p-3">
                        <div className="font-semibold">Alerts</div>
                        <ul className="mt-2 list-disc pl-5">
                          {alerts.map((a, i) => (
                            <li key={i} className="mt-1">
                              <b>{a.level}:</b> {a.message}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {kpisByPeriod?.length > 0 && (
                      <div className="rounded-xl border border-line bg-panel p-3">
                        <div className="font-semibold">KPIs</div>
                        <div className="mt-3 grid gap-3 md:grid-cols-2">
                          {kpisByPeriod.map((p, idx) => (
                            <div
                              key={`${p.period}-${idx}`}
                              className="rounded-xl border border-line bg-panel p-3"
                            >
                              <div className="text-sm">
                                <b>Período:</b> {p.period}
                              </div>
                              <div className="pt-muted mt-2 text-xs grid gap-1">
                                <div>
                                  <b>Ativo Total:</b> {fmtBR(p.kpis.ativoTotal)}
                                </div>
                                <div>
                                  <b>Passivo Total:</b> {fmtBR(p.kpis.passivoTotal)}
                                </div>
                                <div>
                                  <b>DRE Total:</b> {fmtBR(p.kpis.dreTotal ?? 0)}
                                </div>
                                <div>
                                  <b>Linhas detectadas:</b>{" "}
                                  {p.kpis.linhasDetectadas ?? "—"}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {(seriesAtivo?.length > 0 ||
                      seriesPassivo?.length > 0 ||
                      seriesDre?.length > 0) && (
                      <div className="rounded-xl border border-line bg-panel p-3">
                        <div className="font-semibold">Séries (prontas para gráfico)</div>

                        <div className="mt-3 grid gap-3 md:grid-cols-3">
                          <div className="rounded-xl border border-line bg-panel p-3">
                            <div className="text-sm font-semibold">Ativo Total</div>
                            <ul className="mt-2 text-xs space-y-1">
                              {seriesAtivo.map((s, i) => (
                                <li key={i}>
                                  <b>{s.period}:</b> {fmtBR(s.value)}
                                </li>
                              ))}
                            </ul>
                          </div>

                          <div className="rounded-xl border border-line bg-panel p-3">
                            <div className="text-sm font-semibold">Passivo Total</div>
                            <ul className="mt-2 text-xs space-y-1">
                              {seriesPassivo.map((s, i) => (
                                <li key={i}>
                                  <b>{s.period}:</b> {fmtBR(s.value)}
                                </li>
                              ))}
                            </ul>
                          </div>

                          <div className="rounded-xl border border-line bg-panel p-3">
                            <div className="text-sm font-semibold">DRE Total</div>
                            <ul className="mt-2 text-xs space-y-1">
                              {seriesDre.map((s, i) => (
                                <li key={i}>
                                  <b>{s.period}:</b> {fmtBR(s.value)}
                                </li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      </div>
                    )}

                    {(topSaldosAtivo?.length > 0 ||
                      topSaldosPassivo?.length > 0 ||
                      topVariacoes?.length > 0) && (
                      <div className="rounded-xl border border-line bg-panel p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="font-semibold">Rankings</div>

                          <button
                            type="button"
                            onClick={() => setShowAllRankings((v) => !v)}
                            className="pt-btn rounded-lg px-3 py-1 text-xs"
                          >
                            {showAllRankings ? "Ver só último período" : "Mostrar tudo"}
                          </button>
                        </div>

                        <div className="pt-muted mt-2 text-xs">
                          {showAllRankings
                            ? "Exibindo rankings de todos os períodos (modo completo)."
                            : `Exibindo Top Saldos do ${lastPair.last ?? "último período"} e variações ${
                                lastPair.prev ?? "anterior"
                              } → ${lastPair.last ?? "último"}.`}
                        </div>

                        <div className="mt-3 grid gap-3 md:grid-cols-3">
                          <div className="rounded-xl border border-line bg-panel p-3">
                            <div className="text-sm font-semibold">Top Saldos Ativo</div>
                            <ol className="mt-2 list-decimal pl-5 text-xs space-y-1">
                              {filteredTopSaldosAtivo.map((x, i) => (
                                <li key={i}>
                                  {labelConta(x)} — <b>{fmtBR(x.value)}</b>{" "}
                                  <span className="pt-muted">({x.period})</span>
                                </li>
                              ))}
                            </ol>
                          </div>

                          <div className="rounded-xl border border-line bg-panel p-3">
                            <div className="text-sm font-semibold">Top Saldos Passivo</div>
                            <ol className="mt-2 list-decimal pl-5 text-xs space-y-1">
                              {filteredTopSaldosPassivo.map((x, i) => (
                                <li key={i}>
                                  {labelConta(x)} — <b>{fmtBR(x.value)}</b>{" "}
                                  <span className="pt-muted">({x.period})</span>
                                </li>
                              ))}
                            </ol>
                          </div>

                          <div className="rounded-xl border border-line bg-panel p-3">
                            <div className="text-sm font-semibold">Top Variações</div>
                            <ol className="mt-2 list-decimal pl-5 text-xs space-y-2">
                              {filteredTopVariacoes.map((x, i) => (
                                <li key={x.key ?? i}>
                                  <div>
                                    <b>{x.description ?? x.code ?? "Conta"}</b>
                                  </div>
                                  <div className="pt-muted">
                                    {x.from} → {x.to}
                                  </div>
                                  <div>
                                    Δ: <b>{fmtBR(x.delta)}</b>{" "}
                                    {x.deltaPct === null ? (
                                      <span className="pt-muted">(sem base %)</span>
                                    ) : (
                                      <span className="pt-muted">({fmtBR(x.deltaPct)}%)</span>
                                    )}
                                  </div>
                                </li>
                              ))}
                            </ol>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-sm">
              {(result as any)?.error ?? "Erro desconhecido."}
            </div>
          )}
        </div>
      </section>

      {/* ✅ Chat flutuante (não troca rota) */}
      <ChatFab />
    </main>
  );
}
