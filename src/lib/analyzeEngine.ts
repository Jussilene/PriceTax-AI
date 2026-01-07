// src/lib/analyzeEngine.ts
import type { ParsedBalancete } from "@/lib/balanceteParser";
import { parseContabilRowsFromText } from "@/lib/contabilParser";

// ✅ FIX: normalizeBase pode exportar de formas diferentes.
// Importa tudo e resolve em runtime sem depender de "default".
import * as NormalizeBaseMod from "@/lib/normalizeBase";
import type { NormalizedBaseRow } from "@/lib/normalizeBase";

import { computeTccKpisFromBase, type TccKpiResult } from "@/lib/kpiEngine";
import { extractExactTotalsByPeriod, filterOutliersForRankings } from "@/lib/exactTruth";

type PeriodMode = "mensal" | "trimestral" | "anual";
type PeriodLabel = string;

type KPIBlock = {
  ativoTotal: number;
  passivoTotal: number;
  dreTotal?: number;
  linhasDetectadas: number;
};

type SeriesPoint = {
  period: PeriodLabel;
  value: number;
};

type EvidenceLine = {
  period: string;
  classification?: string | null;
  code?: string | null;
  description?: string | null;
  col: "debito" | "credito" | "saldoAtual" | "saldoAnterior";
  value: number;
};

export type AnalyzeEngineResult = {
  summary: {
    totalFiles: number;
    yearsDetected: number[] | number[];
    warnings: string[];
    rowsDetected: number;
  };

  files: Array<{
    fileName: string;
    pages: number;
    detectedYear?: number | null;
    sample: string;
  }>;

  baseNormalizada: NormalizedBaseRow[];
  tccKpis: TccKpiResult;

  kpis: {
    byPeriod: Array<{ period: PeriodLabel; kpis: KPIBlock }>;
  };

  series: {
    ativoTotal: SeriesPoint[];
    passivoTotal: SeriesPoint[];
    dreTotal: SeriesPoint[];
  };

  rankings: {
    topSaldosAtivo: Array<{
      code?: string | null;
      description?: string | null;
      value: number;
      period: PeriodLabel;
    }>;
    topSaldosPassivo: Array<{
      code?: string | null;
      description?: string | null;
      value: number;
      period: PeriodLabel;
    }>;
    topVariacoes: Array<{
      key: string;
      code?: string | null;
      description?: string | null;
      from: PeriodLabel;
      to: PeriodLabel;
      delta: number;
      deltaPct: number | null;
    }>;
  };

  alerts: Array<{
    level: "info" | "warning";
    message: string;
  }>;

  periodos?: PeriodLabel[];
  kpisPorPeriodo?: Record<
    string,
    {
      receitaLiquida?: number;
      despAdmin?: number;
      lucroLiquido?: number;
    }
  >;
  distribuicaoGrupos?: Record<string, number>;
  topGastos?: Array<{ label: string; value: number }>;

  kpiEvidence?: {
    reconciliacao: Array<{
      indicador: string;
      regra: string;
      linhas: EvidenceLine[];
    }>;
  };
};

function safeNumber(n: any): number {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

function brRound(n: number, digits = 2) {
  const p = Math.pow(10, digits);
  return Math.round(n * p) / p;
}

/** ✅ aceita number | string | {value:number} */
function numFromAny(v: any): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof v === "object" && typeof v.value === "number") {
    return Number.isFinite(v.value) ? v.value : 0;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function guessYearFromText(text: string): number | null {
  const m = text.match(/\b(19|20)\d{2}\b/);
  if (!m) return null;
  const y = Number(m[0]);
  return Number.isFinite(y) ? y : null;
}

function guessPeriodFromText(text: string): string | null {
  const m = text.match(
    /PER[IÍ]ODO[:\s]*([0-3]\d\/[01]\d\/\d{4})\s*[-–]\s*([0-3]\d\/[01]\d\/\d{4})/i
  );
  if (!m) return null;
  return `${m[1]}..${m[2]}`;
}

function toMonthlyLabelFromRange(range: string): string | null {
  const m = range.match(/^(\d{2})\/(\d{2})\/(\d{4})\.\.(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;

  const mm1 = m[2];
  const yyyy1 = m[3];
  const mm2 = m[5];
  const yyyy2 = m[6];

  if (mm1 === mm2 && yyyy1 === yyyy2) return `${yyyy1}-${mm1}`;
  return null;
}

function monthFromName(fileName: string): string | null {
  const up = fileName.toUpperCase();

  const map: Record<string, string> = {
    JAN: "01",
    FEV: "02",
    MAR: "03",
    ABR: "04",
    MAI: "05",
    JUN: "06",
    JUL: "07",
    AGO: "08",
    SET: "09",
    OUT: "10",
    NOV: "11",
    DEZ: "12",
  };

  for (const k of Object.keys(map)) {
    if (up.includes(k)) return map[k];
  }

  const m = up.match(/(?:\bM(?:ES)?\s*|[_-])([01]\d)\b/);
  if (m) {
    const mm = m[1];
    if (mm >= "01" && mm <= "12") return mm;
  }

  return null;
}

function detectPeriodLabel(file: ParsedBalancete, mode: PeriodMode): PeriodLabel {
  const name = file.fileName.toUpperCase();
  const y = file.detectedYear ?? guessYearFromText(file.text ?? "") ?? null;

  if (mode === "anual") {
    if (y) return String(y);
    return file.fileName;
  }

  if (mode === "mensal") {
    const range = guessPeriodFromText(file.text ?? "");
    if (range) {
      const monthly = toMonthlyLabelFromRange(range);
      if (monthly) return monthly;
    }

    const mm = monthFromName(name);
    if (mm && y) return `${y}-${mm}`;

    if (y) return String(y);
    return file.fileName;
  }

  const trim = name.match(/(\d)\s*TRIM/);
  if (trim && y) return `T${trim[1]}/${y}`;

  const t = name.match(/\bT([1-4])\b/);
  if (t && y) return `T${t[1]}/${y}`;

  const p = guessPeriodFromText(file.text ?? "");
  if (p) return p;

  if (y) return String(y);
  return file.fileName;
}

/** ✅ normaliza classificação sem inventar */
function normalizeClassification(input: unknown): string {
  const raw = String(input ?? "").trim();
  if (!raw) return "";

  if (/^[1-3]\.\d/.test(raw)) return raw;

  const m = raw.match(/^([1-3])(\d)(\d)\.(\d+)$/);
  if (m) return `${m[1]}.${m[2]}.${m[3]}.${m[4]}`;

  const m2 = raw.match(/^([1-3])(\d)(\d)(\d)$/);
  if (m2) return `${m2[1]}.${m2[2]}.${m2[3]}.${m2[4]}`;

  if (/^[1-3]\.0$/.test(raw)) return raw;

  return raw;
}

/** ✅ parse de período para ordenar corretamente */
function parsePeriod(p: string) {
  const s = String(p ?? "").trim();

  const tq = s.match(/T\s*(\d)\s*\/\s*(\d{4})/i);
  if (tq) return { kind: "q" as const, y: Number(tq[2]), n: Number(tq[1]) };

  const ym = s.match(/^(\d{4})-(\d{2})$/);
  if (ym) return { kind: "m" as const, y: Number(ym[1]), n: Number(ym[2]) };

  const yy = s.match(/^(\d{4})$/);
  if (yy) return { kind: "y" as const, y: Number(yy[1]), n: 0 };

  return { kind: "raw" as const, y: 0, n: 0 };
}

function sortPeriodLabels(labels: string[]) {
  const parsed = labels.map((raw) => ({ raw, p: parsePeriod(raw) }));
  const hasAny = parsed.some((x) => x.p.kind !== "raw");
  if (!hasAny) return labels;

  const orderKind = (k: string) => (k === "y" ? 1 : k === "q" ? 2 : k === "m" ? 3 : 9);

  return parsed
    .slice()
    .sort((a, b) => {
      const ak = orderKind(a.p.kind);
      const bk = orderKind(b.p.kind);
      if (ak !== bk) return ak - bk;
      if (a.p.y !== b.p.y) return a.p.y - b.p.y;
      if (a.p.n !== b.p.n) return a.p.n - b.p.n;
      return String(a.raw).localeCompare(String(b.raw));
    })
    .map((x) => x.raw);
}

function mkKey(code?: string | null, desc?: string | null) {
  const c = (code ?? "").trim();
  const d = (desc ?? "").trim().toUpperCase();
  if (c) return `C:${c}|D:${d}`;
  return `D:${d}`;
}

function topN<T>(arr: T[], n: number, score: (x: T) => number) {
  return [...arr].sort((a, b) => score(b) - score(a)).slice(0, n);
}

function labelFromRow(r: NormalizedBaseRow) {
  const cls = r.classification ? String(r.classification).trim() : "";
  const desc = r.description ? String(r.description).trim() : "";
  if (cls && desc) return `${cls} — ${desc}`;
  if (desc) return desc;
  if (cls) return cls;
  return "Conta";
}

/** ✅ tenta inferir grupo por classificação (não depende do parser textual) */
function groupFromClassification(clsRaw: any): "ATIVO" | "PASSIVO" | "DRE" | "OUTROS" {
  const cls = normalizeClassification(clsRaw);
  if (cls === "1" || cls === "1.0" || cls.startsWith("1.")) return "ATIVO";
  if (cls === "2" || cls === "2.0" || cls.startsWith("2.")) return "PASSIVO";
  if (cls === "3" || cls === "3.0" || cls.startsWith("3.")) return "DRE";
  return "OUTROS";
}

/** ✅ DRE Total travado por classificação 3.* */
function computeDreTotalFromBase(base: NormalizedBaseRow[], period: string) {
  let s = 0;
  for (const r of base) {
    if (String((r as any)?.period ?? "") !== String(period ?? "")) continue;
    const cls = normalizeClassification((r as any).classification);
    if (!(cls === "3" || cls === "3.0" || cls.startsWith("3."))) continue;

    const v =
      Math.abs(numFromAny((r as any).debito)) > 1e-9
        ? Math.abs(numFromAny((r as any).debito))
        : Math.abs(numFromAny((r as any).credito)) > 1e-9
        ? Math.abs(numFromAny((r as any).credito))
        : Math.abs(numFromAny((r as any).saldoAtual));

    if (!Number.isFinite(v) || v < 0.01) continue;
    s += v;
  }
  return brRound(s);
}

/** ✅ Pareto só custos/despesas DRE + remove agregados/totais */
function isExpenseDreRow(r: NormalizedBaseRow) {
  const cls = normalizeClassification((r as any).classification);
  if (!(cls === "3" || cls === "3.0" || cls.startsWith("3."))) return false;

  const desc = String((r as any).description ?? "").toUpperCase();
  if (desc.includes("TOTAL")) return false;

  const dotCount = (cls.match(/\./g) || []).length;
  if (dotCount <= 1) return false;

  // corta receitas e deduções
  if (cls.startsWith("3.1.1") || cls.startsWith("3.1.2")) return false;

  const looksExpenseByText =
    desc.includes("DESP") ||
    desc.includes("CUST") ||
    desc.includes("CMV") ||
    desc.includes("CPV") ||
    desc.includes("SAL") ||
    desc.includes("HONOR") ||
    desc.includes("ALUG") ||
    desc.includes("ENCARG") ||
    desc.includes("TAXA") ||
    desc.includes("IMPOST") ||
    desc.includes("SERV");

  const looksExpenseByPrefix =
    cls.startsWith("3.1.3") ||
    cls.startsWith("3.2") ||
    cls.startsWith("3.3") ||
    cls.startsWith("3.4") ||
    cls.startsWith("3.5") ||
    cls.startsWith("3.6") ||
    cls.startsWith("3.7") ||
    cls.startsWith("3.8") ||
    cls.startsWith("3.9");

  return looksExpenseByPrefix || looksExpenseByText;
}

function pickEvidenceLines(
  base: NormalizedBaseRow[],
  period: string,
  filter: (r: any) => boolean,
  col: EvidenceLine["col"],
  top = 10
): EvidenceLine[] {
  const lines: EvidenceLine[] = [];

  for (const r of base) {
    if (String((r as any)?.period ?? "") !== String(period ?? "")) continue;

    const rr: any = r as any;
    if (!filter(rr)) continue;

    const v = numFromAny(rr[col]);
    if (!Number.isFinite(v) || Math.abs(v) < 0.01) continue;

    lines.push({
      period,
      classification: rr.classification ?? null,
      code: rr.code ?? null,
      description: rr.description ?? null,
      col,
      value: brRound(Math.abs(v)),
    });
  }

  return topN(lines, top, (x) => x.value);
}

export function computeFromBalancetes(
  parsed: ParsedBalancete[],
  periodMode: PeriodMode = "trimestral"
): AnalyzeEngineResult {
  const warnings: string[] = [];
  const alerts: Array<{ level: "info" | "warning"; message: string }> = [];

  const filesOut = parsed.map((p) => ({
    fileName: p.fileName,
    pages: p.pages,
    detectedYear: p.detectedYear ?? null,
    sample: (p.text ?? "").slice(0, 1200) || "(sem texto extraído)",
  }));

  // 1) por arquivo/período
  const perFileRaw = parsed.map((p) => {
    const period = detectPeriodLabel(p, periodMode);

    const parsedRows = parseContabilRowsFromText(p.text ?? "");
    if (parsedRows.warnings?.length) {
      for (const w of parsedRows.warnings) warnings.push(`[${p.fileName}] ${w}`);
    }

    const year = p.detectedYear ?? guessYearFromText(p.text ?? "") ?? null;

    return {
      fileName: p.fileName,
      period,
      year,
      rows: parsedRows.rows,
      warnings: parsedRows.warnings ?? [],
    };
  });

  // ✅ resolve buildNormalizedBase com segurança (SEM default)
  const buildNormalizedBase: any =
    (NormalizeBaseMod as any).buildNormalizedBase ??
    (NormalizeBaseMod as any).buildBase ??
    (NormalizeBaseMod as any).normalizeBase;

  if (typeof buildNormalizedBase !== "function") {
    throw new Error(
      "normalizeBase export incompatível: não foi possível resolver buildNormalizedBase(). Verifique src/lib/normalizeBase.ts exports."
    );
  }

  // 2) base normalizada
  const baseNormalizada: NormalizedBaseRow[] = perFileRaw.flatMap((f) =>
    buildNormalizedBase({ rows: f.rows, warnings: f.warnings }, { period: f.period, year: f.year })
  );

  // ✅ 2.1) “Verdade exata” Ativo/Passivo (robusta)
  const exact = extractExactTotalsByPeriod(baseNormalizada);
  for (const n of exact.notes ?? []) {
    alerts.push({ level: "info", message: n });
  }

  const totalsMap = new Map<string, { ativo_total: number; passivo_total: number }>();
  for (const t of exact.totals ?? []) {
    totalsMap.set(String((t as any).period), {
      ativo_total: safeNumber((t as any).ativo_total),
      passivo_total: safeNumber((t as any).passivo_total),
    });
  }

  // 3) Ordena períodos
  const orderedPeriods = sortPeriodLabels(perFileRaw.map((x) => x.period));
  const perFile = orderedPeriods.map((p) => perFileRaw.find((x) => x.period === p)!).filter(Boolean);

  // 4) KPIs DRE
  const tccKpis = computeTccKpisFromBase(baseNormalizada);

  if (perFile.length < 2) {
    alerts.push({ level: "warning", message: "Envie pelo menos 2 períodos para comparação." });
  }

  // 5) KPIs gerais por período
  const kpisByPeriod = perFile.map((f) => {
    const tt = totalsMap.get(String(f.period));
    const ativoTotal = safeNumber(tt?.ativo_total);
    const passivoTotal = safeNumber(tt?.passivo_total);

    const dreTotal = computeDreTotalFromBase(baseNormalizada, f.period);

    if (!ativoTotal) {
      alerts.push({
        level: "warning",
        message: `Ativo Total não encontrado com segurança em ${f.period}. (PDF pode estar quebrando a linha total em '1' / '1.').`,
      });
    }
    if (!passivoTotal) {
      alerts.push({
        level: "warning",
        message: `Passivo Total não encontrado com segurança em ${f.period}. (PDF pode estar quebrando a linha total em '2' / '2.').`,
      });
    }

    return {
      period: f.period,
      kpis: {
        ativoTotal,
        passivoTotal,
        dreTotal,
        linhasDetectadas: f.rows.length,
      },
    };
  });

  const series = {
    ativoTotal: kpisByPeriod.map((x) => ({ period: x.period, value: x.kpis.ativoTotal })),
    passivoTotal: kpisByPeriod.map((x) => ({ period: x.period, value: x.kpis.passivoTotal })),
    dreTotal: kpisByPeriod.map((x) => ({ period: x.period, value: x.kpis.dreTotal ?? 0 })),
  };

  // Rankings
  const topAtivo: Array<{
    code?: string | null;
    description?: string | null;
    value: number;
    period: PeriodLabel;
  }> = [];

  const topPassivo: Array<{
    code?: string | null;
    description?: string | null;
    value: number;
    period: PeriodLabel;
  }> = [];

  for (const f of perFile) {
    const ativoTotal = kpisByPeriod.find((x) => x.period === f.period)?.kpis.ativoTotal ?? 0;

    const rowsPeriod = baseNormalizada.filter(
      (r) => String((r as any)?.period ?? "") === String(f.period)
    );
    const safeRows = filterOutliersForRankings(rowsPeriod, ativoTotal);

    for (const r of safeRows) {
      const v = safeNumber((r as any).saldoAtual ?? 0);
      if (!v) continue;

      const desc = String((r as any).description ?? "").toUpperCase();
      if (desc.includes("TOTAL")) continue;

      const grp = groupFromClassification((r as any).classification);
      if (grp === "ATIVO") {
        topAtivo.push({
          code: (r as any).code ?? null,
          description: (r as any).description ?? null,
          value: brRound(v),
          period: f.period,
        });
      } else if (grp === "PASSIVO") {
        topPassivo.push({
          code: (r as any).code ?? null,
          description: (r as any).description ?? null,
          value: brRound(v),
          period: f.period,
        });
      }
    }
  }

  const topSaldosAtivo = topN(topAtivo, 10, (x) => Math.abs(x.value));
  const topSaldosPassivo = topN(topPassivo, 10, (x) => Math.abs(x.value));

  // Variações
  const map = new Map<
    string,
    { code?: string | null; description?: string | null; values: Record<string, number> }
  >();

  for (const f of perFile) {
    const ativoTotal = kpisByPeriod.find((x) => x.period === f.period)?.kpis.ativoTotal ?? 0;

    const rowsPeriod = baseNormalizada.filter(
      (r) => String((r as any)?.period ?? "") === String(f.period)
    );
    const safeRows = filterOutliersForRankings(rowsPeriod, ativoTotal);

    for (const r of safeRows) {
      const v = safeNumber((r as any).saldoAtual ?? 0);
      if (!Number.isFinite(v)) continue;

      const key = mkKey((r as any).code, (r as any).description);
      const prev = map.get(key) ?? {
        code: (r as any).code ?? null,
        description: (r as any).description ?? null,
        values: {},
      };
      prev.values[f.period] = brRound(v);
      map.set(key, prev);
    }
  }

  const firstPeriod = perFile[0]?.period;
  const lastPeriod = perFile[perFile.length - 1]?.period;

  const variacoes: AnalyzeEngineResult["rankings"]["topVariacoes"] = [];

  if (firstPeriod && lastPeriod && firstPeriod !== lastPeriod) {
    for (const [key, obj] of map.entries()) {
      const a = safeNumber(obj.values[firstPeriod]);
      const b = safeNumber(obj.values[lastPeriod]);

      if (!a && !b) continue;

      const delta = brRound(b - a);
      const deltaPct = a !== 0 ? brRound(((b - a) / Math.abs(a)) * 100) : null;

      if (Math.abs(delta) < 0.01) continue;

      variacoes.push({
        key,
        code: obj.code ?? null,
        description: obj.description ?? null,
        from: firstPeriod,
        to: lastPeriod,
        delta,
        deltaPct,
      });
    }
  }

  const topVariacoes = topN(variacoes, 15, (x) => Math.abs(x.delta));

  if (topVariacoes.length) {
    const maior = topVariacoes[0];
    if (maior.deltaPct !== null && Math.abs(maior.deltaPct) >= 50) {
      alerts.push({
        level: "warning",
        message: `Variação alta detectada: ${
          maior.description ?? maior.code ?? "Conta"
        } mudou ${maior.deltaPct}% (${maior.from} → ${maior.to}).`,
      });
    } else {
      alerts.push({
        level: "info",
        message: `Maior variação no período: ${maior.description ?? maior.code ?? "Conta"} (${
          maior.from
        } → ${maior.to}).`,
      });
    }
  }

  if (tccKpis.notes?.length) {
    for (const n of tccKpis.notes) {
      alerts.push({ level: "info", message: n });
    }
  }

  const yearsDetected = Array.from(
    new Set(
      perFile
        .map((f) => f.year)
        .filter((x): x is number => typeof x === "number" && Number.isFinite(x))
    )
  ).sort();

  const rowsDetected = perFile.reduce((acc, f) => acc + (f.rows?.length ?? 0), 0);

  const periodos: PeriodLabel[] = perFile.map((f) => f.period);

  const kpisPorPeriodo: AnalyzeEngineResult["kpisPorPeriodo"] = {};
  const tccPeriods = Array.isArray(tccKpis?.byPeriod) ? tccKpis.byPeriod : [];

  for (const p of tccPeriods) {
    const period = String((p as any)?.period ?? "");
    if (!period) continue;

    kpisPorPeriodo[period] = {
      receitaLiquida: safeNumber((p as any)?.receita_liquida),
      despAdmin: safeNumber((p as any)?.despesas_admin),
      lucroLiquido: safeNumber((p as any)?.lucro_liquido),
    };
  }

  const last = String(lastPeriod ?? "");
  const lastKpi = kpisByPeriod.find((x) => x.period === last)?.kpis;

  const distribuicaoGrupos: AnalyzeEngineResult["distribuicaoGrupos"] = {
    ATIVO: safeNumber(lastKpi?.ativoTotal),
    PASSIVO: safeNumber(lastKpi?.passivoTotal),
    DRE: safeNumber(lastKpi?.dreTotal),
  };

  // ✅ Top Gastos (Pareto) — só débito/saldo (limpo)
  const topGastos: Array<{ label: string; value: number }> = [];

  if (lastPeriod) {
    const mapGastos = new Map<string, { label: string; value: number }>();

    for (const r of baseNormalizada) {
      if (String((r as any)?.period ?? "") !== String(lastPeriod ?? "")) continue;
      if (!isExpenseDreRow(r)) continue;

      const deb = Math.abs(numFromAny((r as any).debito));
      const sa = Math.abs(numFromAny((r as any).saldoAtual));
      const v = deb > 1e-9 ? deb : sa;

      if (!Number.isFinite(v) || v < 0.01) continue;

      const label = labelFromRow(r);
      const cls = normalizeClassification((r as any).classification);
      const key = `${cls}|${String((r as any).description ?? "")}`.toUpperCase();

      const prev = mapGastos.get(key) ?? { label, value: 0 };
      prev.value = brRound(prev.value + v);
      mapGastos.set(key, prev);
    }

    const list = Array.from(mapGastos.values());
    const ordered = topN(list, 10, (x) => x.value);
    for (const item of ordered) topGastos.push(item);
  }

  // Evidências
  const kpiEvidence = {
    reconciliacao: [
      {
        indicador: "Receita Bruta",
        regra:
          "DRE: Receita Bruta = somatório do CRÉDITO das contas 3.1.1.* conforme plano de contas do balancete. Fallback por descrição: 'RECEITA/FATURAMENTO'.",
        linhas: pickEvidenceLines(
          baseNormalizada,
          last,
          (r) => {
            const cls = normalizeClassification(r.classification);
            const desc = String(r.description ?? "").toUpperCase();
            return cls.startsWith("3.1.1") || desc.includes("RECEITA") || desc.includes("FATUR");
          },
          "credito",
          10
        ),
      },
      {
        indicador: "Deduções / Impostos sobre vendas",
        regra:
          "DRE: Deduções = somatório do DÉBITO das contas 3.1.2.* (impostos, devoluções e abatimentos). Fallback por descrição: ICMS/ISS/PIS/COFINS/DEDUÇÃO.",
        linhas: pickEvidenceLines(
          baseNormalizada,
          last,
          (r) => {
            const cls = normalizeClassification(r.classification);
            const desc = String(r.description ?? "").toUpperCase();
            return (
              cls.startsWith("3.1.2") ||
              desc.includes("ICMS") ||
              desc.includes("ISS") ||
              desc.includes("PIS") ||
              desc.includes("COFINS") ||
              desc.includes("DEDU")
            );
          },
          "debito",
          10
        ),
      },
      {
        indicador: "CMV/CPV (Custos)",
        regra:
          "DRE: CMV/CPV = somatório do DÉBITO das contas 3.1.3.* (custos das mercadorias/serviços). Fallback por descrição: CMV/CPV/CUSTO.",
        linhas: pickEvidenceLines(
          baseNormalizada,
          last,
          (r) => {
            const cls = normalizeClassification(r.classification);
            const desc = String(r.description ?? "").toUpperCase();
            return (
              cls.startsWith("3.1.3") ||
              desc.includes("CMV") ||
              desc.includes("CPV") ||
              desc.includes("CUST")
            );
          },
          "debito",
          10
        ),
      },
      {
        indicador: "Despesas Administrativas",
        regra:
          "DRE: Despesas Administrativas = somatório do DÉBITO das contas 3.2.1.* conforme balancete. Fallback por descrição: 'ADMIN'.",
        linhas: pickEvidenceLines(
          baseNormalizada,
          last,
          (r) => {
            const cls = normalizeClassification(r.classification);
            const desc = String(r.description ?? "").toUpperCase();
            return cls.startsWith("3.2.1") || desc.includes("ADMIN");
          },
          "debito",
          10
        ),
      },
    ],
  };

  return {
    summary: {
      totalFiles: parsed.length,
      yearsDetected,
      warnings,
      rowsDetected,
    },
    files: filesOut,

    baseNormalizada,
    tccKpis,

    kpis: { byPeriod: kpisByPeriod },
    series,
    rankings: {
      topSaldosAtivo,
      topSaldosPassivo,
      topVariacoes,
    },
    alerts,

    periodos,
    kpisPorPeriodo,
    distribuicaoGrupos,
    topGastos,

    kpiEvidence,
  };
}
