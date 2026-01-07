// src/lib/types.ts
import type { NormalizedBaseRow } from "./normalizeBase";
import type { AnalyzeEngineResult } from "./analyzeEngine";

export type PeriodMode = "mensal" | "trimestral" | "anual";

export type UploadMeta = {
  jobId: string;
  periodMode: PeriodMode;
  detectedYears: number[];
  files: { name: string; size: number; year?: number | null }[];
  createdAtISO: string;
};

export type Kpis = {
  receita_liquida: number;
  total_gastos_top10: number;
  concentracao_admin: number;
};

export type RowItem = {
  conta: string;
  debito: number;
  percent_receita: number;
};

/**
 * Resposta do /api/analyze
 * Mantém compatibilidade com:
 * - front que usa `result`
 * - front que lê campos "flat" (kpis/series/rankings/alerts...)
 */
export type AnalyzeResponse =
  | {
      ok: true;
      stage: "upload";
      meta: UploadMeta;
      message: string;
    }
  | {
      ok: true;
      stage: "analysis";
      meta: UploadMeta;

      /**
       * ✅ Compat: resposta completa do motor (recomendado)
       */
      result: AnalyzeEngineResult;

      /**
       * ✅ Compat: atalho (muito usado pra debug/tabela limpa)
       */
      baseNormalizada?: NormalizedBaseRow[];

      /**
       * ✅ Campos "flat" (pra não depender de result.* no front)
       * Obs: são os MESMOS dados de `result`, só expostos também no topo.
       */
      tccKpis?: AnalyzeEngineResult["tccKpis"];
      kpisByPeriod?: AnalyzeEngineResult["kpis"]["byPeriod"];
      series?: AnalyzeEngineResult["series"];
      rankings?: AnalyzeEngineResult["rankings"];
      alerts?: AnalyzeEngineResult["alerts"];
      periodos?: AnalyzeEngineResult["periodos"];
      kpisPorPeriodo?: AnalyzeEngineResult["kpisPorPeriodo"];
      distribuicaoGrupos?: AnalyzeEngineResult["distribuicaoGrupos"];
      topGastos?: AnalyzeEngineResult["topGastos"];

      message: string;
    }
  | {
      ok: false;
      error: string;
      details?: any;
    };
