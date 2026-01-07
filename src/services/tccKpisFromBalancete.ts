// src/services/tccKpisFromBalancete.ts
import type { ParsedBalancete } from "@/lib/balanceteParser";
import { computeFromBalancetes } from "@/lib/analyzeEngine";

/**
 * Service opcional: devolve só os KPIs do TCC (DRE) já calculados.
 * Não muda nada no resto do sistema.
 */
export function tccKpisFromBalancete(parsed: ParsedBalancete[]) {
  const result = computeFromBalancetes(parsed);
  return {
    tccKpis: result.tccKpis,
    periodos: result.periodos ?? [],
    kpisPorPeriodo: result.kpisPorPeriodo ?? {},
    topGastos: result.topGastos ?? [],
    distribuicaoGrupos: result.distribuicaoGrupos ?? {},

    // ✅ mantém compat e passa evidência quando existir (PDF TCC-like)
    kpiEvidence: result.kpiEvidence ?? undefined,
  };
}
