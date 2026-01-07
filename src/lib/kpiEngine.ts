// src/lib/kpiEngine.ts
import type { NormalizedBaseRow } from "@/lib/normalizeBase";

export type TccKpiPeriod = {
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

  buckets: Array<{ key: string; total: number; lines: number }>;
};

export type TccKpiResult = {
  byPeriod: TccKpiPeriod[];
  notes: string[];
};

// ✅ KPIs de Balanço (Ativo/Passivo) por período
export type BalanceKpiPeriod = {
  period: string;
  year?: number | null;
  ativo_total: number;
  passivo_total: number;
};

export type BalanceKpiResult = {
  byPeriod: BalanceKpiPeriod[];
  notes: string[];
};

function brRound(n: number, digits = 2) {
  const p = Math.pow(10, digits);
  return Math.round(n * p) / p;
}

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

function normalizeText(input: unknown): string {
  return String(input ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normaliza classificação, sem forçar DRE em qualquer "3xx".
 */
function normalizeClassification(input: unknown): string {
  const raw = String(input ?? "").trim();
  if (!raw) return "";

  if (/^[1-3]\.\d/.test(raw)) return raw;

  if (/^[1-3]\d\d\.\d+$/.test(raw)) {
    const m = raw.match(/^([1-3])(\d)(\d)\.(\d+)$/);
    if (m) return `${m[1]}.${m[2]}.${m[3]}.${m[4]}`;
  }

  if (/^[1-3]\d\d\d$/.test(raw)) {
    const m2 = raw.match(/^([1-3])(\d)(\d)(\d)$/);
    if (m2) return `${m2[1]}.${m2[2]}.${m2[3]}.${m2[4]}`;
  }

  return raw;
}

const RX = {
  receitaLiquida: [
    "RECEITA LIQUIDA",
    "RECEITA LIQ",
    "RECEITAS LIQUIDAS",
    "RECEITA OPERACIONAL LIQUIDA",
    "ROL",
  ],
  receitaBruta: [
    "RECEITA BRUTA",
    "RECEITA OPERACIONAL BRUTA",
    "VENDAS BRUTAS",
    "FATURAMENTO BRUTO",
  ],
  deducoes: [
    "DEDUCOES",
    "DEDUCAO",
    "DEVOLUCOES",
    "ABATIMENTOS",
    "CANCELAMENTOS",
    "ICMS",
    "ISS",
    "PIS",
    "COFINS",
  ],
  cmvCpv: [
    "CMV",
    "CPV",
    "CUSTO",
    "CUSTOS",
    "CUSTO DAS MERCADORIAS",
    "CUSTO DOS PRODUTOS",
    "CUSTO DOS SERVICOS",
    "CUSTO DOS SERVICOS PRESTADOS",
    "CSP",
  ],
  despesasAdmin: [
    "DESPESAS ADMIN",
    "DESPESAS ADMINISTRATIVAS",
    "DESPESA ADMIN",
    "ADMINISTRATIVAS",
  ],
  despesasComerciais: [
    "DESPESAS COMERC",
    "DESPESAS COMERCIAIS",
    "DESPESAS DE VENDAS",
    "MARKETING",
    "PROPAGANDA",
    "PUBLICIDADE",
  ],
  outrasDespesas: [
    "OUTRAS DESPESAS",
    "DESPESAS GERAIS",
    "DESPESAS OPERACIONAIS",
    "DESPESAS FINANCEIRAS",
    "CUSTOS FINANCEIROS",
    "DESPESAS",
  ],
  lucroBruto: ["LUCRO BRUTO", "RESULTADO BRUTO"],
  resultadoOperacional: ["RESULTADO OPERACIONAL", "LUCRO OPERACIONAL", "EBIT"],
  lucroLiquido: [
    "LUCRO LIQUIDO",
    "RESULTADO LIQUIDO",
    "RESULTADO DO EXERCICIO",
    "LUCRO/PREJUIZO DO EXERCICIO",
    "LUCRO OU PREJUIZO",
  ],
};

function matchAny(desc: string, patterns: string[]) {
  return patterns.some((p) => desc.includes(p));
}

const PLAN_PREFIX = {
  receita_bruta: ["3.1"],
  deducoes: ["3.2"],
  cmv_cpv: ["3.3", "3.4", "3.5"],
  despesas_admin: ["3.7", "3.8"],
} as const;

function dreValue(r: NormalizedBaseRow, prefer: "credito" | "debito"): number {
  const cred = numFromAny((r as any).credito);
  const deb = numFromAny((r as any).debito);

  if (prefer === "credito" && Math.abs(cred) > 1e-9) return cred;
  if (prefer === "debito" && Math.abs(deb) > 1e-9) return deb;

  const sa = numFromAny((r as any).saldoAtual);
  if (Math.abs(sa) > 1e-9) return sa;

  const sb = numFromAny((r as any).saldoAnterior);
  if (Math.abs(sb) > 1e-9) return sb;

  if (Math.abs(deb) > 1e-9 || Math.abs(cred) > 1e-9) return deb - cred;

  return 0;
}

function bucketKey(classification: unknown): string | null {
  const c = normalizeClassification(classification);
  if (!c) return null;

  const m = c.match(/^([123]\.\d{1,3})/);
  return m ? m[1] : null;
}

/**
 * ✅ DRE só quando:
 * - group == DRE
 * - OU classification é "3" / "3.xxx"
 */
function isDreRelevantRow(r: NormalizedBaseRow) {
  const grp = r.group;
  const cls = normalizeClassification(r.classification);

  if (grp === "DRE") return true;
  if (cls === "3" || cls.startsWith("3.")) return true;

  return false;
}

function computeBuckets(rows: NormalizedBaseRow[]) {
  const map = new Map<string, { total: number; lines: number }>();

  for (const r of rows) {
    const k = bucketKey(r.classification);
    if (!k) continue;

    const prev = map.get(k) ?? { total: 0, lines: 0 };

    const sa = numFromAny((r as any).saldoAtual);
    const sb = numFromAny((r as any).saldoAnterior);
    const d = numFromAny((r as any).debito);
    const c = numFromAny((r as any).credito);
    const v = Math.abs(sa) > 1e-9 ? sa : Math.abs(sb) > 1e-9 ? sb : d - c;

    prev.total += v;
    prev.lines += 1;
    map.set(k, prev);
  }

  return Array.from(map.entries())
    .map(([key, v]) => ({ key, total: brRound(v.total), lines: v.lines }))
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
}

function sumByMatchAbs(
  rows: NormalizedBaseRow[],
  patterns: string[],
  prefer: "credito" | "debito"
): number {
  let s = 0;
  for (const r of rows) {
    const desc = normalizeText(r.description ?? "");
    if (desc && matchAny(desc, patterns)) s += Math.abs(dreValue(r, prefer));
  }
  return brRound(s);
}

function sumByBucketAbs(rows: NormalizedBaseRow[], keys: string[]): number {
  let s = 0;
  for (const r of rows) {
    const k = bucketKey(r.classification);
    if (k && keys.includes(k)) {
      const sa = numFromAny((r as any).saldoAtual);
      const sb = numFromAny((r as any).saldoAnterior);
      const d = numFromAny((r as any).debito);
      const c = numFromAny((r as any).credito);
      const v = Math.abs(sa) > 1e-9 ? sa : Math.abs(sb) > 1e-9 ? sb : d - c;
      s += Math.abs(v);
    }
  }
  return brRound(s);
}

function sumByClassificationPrefixAbs(
  rows: NormalizedBaseRow[],
  prefixes: string[],
  prefer: "credito" | "debito"
): number {
  let s = 0;

  for (const r of rows) {
    const raw = String(r.classification ?? "").trim();
    const cls = normalizeClassification(r.classification);

    const hit = prefixes.some((p) => {
      const pp = String(p).trim();
      if (!pp) return false;
      if (!(pp === "3" || pp.startsWith("3."))) return false;
      return raw.startsWith(pp) || cls.startsWith(pp);
    });

    if (hit) s += Math.abs(dreValue(r, prefer));
  }

  return brRound(s);
}

function pct(num: number, den: number): number | null {
  if (!den) return null;
  return brRound((num / den) * 100);
}

// ===========================
// ✅ ATIVO/PASSIVO TOTAL (robusto p/ PDF “quebrado”)
// ===========================

function applyGluedFix(
  title: "ATIVO" | "PASSIVO",
  raw: number,
  ctx?: { ativoTotal?: number }
): number {
  if (!Number.isFinite(raw) || Math.abs(raw) < 1e-9) return 0;

  const sign = raw < 0 ? -1 : 1;
  const n = Math.abs(raw);

  // ✅ Caso real do teu PDF:
  // ATIVO total ~ 4–6M mas vira 14–16M quando "1" cola no início => +10M
  if (title === "ATIVO") {
    if (n >= 10_000_000 && n < 20_000_000) {
      const fixed = n - 10_000_000;
      if (fixed > 0 && fixed < 9_999_999_999) return sign * fixed;
    }
    return raw;
  }

  // PASSIVO total ~ 4–6M
  // às vezes "2" cola no início => 24–26M (+20M)
  if (title === "PASSIVO") {
    const ativo = Math.abs(ctx?.ativoTotal ?? 0);

    // ✅ novo: caso clássico "31.xxx.xxx,xx" (um dígito colado) => divide por 10
    // Ex.: 31.082.543,78 -> 3.108.254,38
    if (n >= 30_000_000 && n < 40_000_000) {
      const fixed = n / 10;
      // valida com contexto do ativo quando possível
      if (!ativo || (fixed > ativo * 0.2 && fixed < ativo * 5)) return sign * fixed;
    }

    if (ativo > 0) {
      // se veio absurdo (ex.: bilhões), invalida
      if (n > Math.max(ativo * 20, 200_000_000)) return 0;
    } else {
      // sem contexto, corta apenas absurdos óbvios
      if (n > 1_000_000_000) return 0;
    }

    if (n >= 20_000_000 && n < 30_000_000) {
      const fixed = n - 20_000_000;
      if (fixed > 0 && fixed < 50_000_000) return sign * fixed;
    }

    // também protege o cenário 14–16M (caso o "1" tenha colado por bagunça)
    if (n >= 10_000_000 && n < 20_000_000) {
      const fixed = n - 10_000_000;
      if (fixed > 0 && fixed < 50_000_000) return sign * fixed;
    }

    return raw;
  }

  return raw;
}

function pickTotal(
  rows: NormalizedBaseRow[],
  title: "ATIVO" | "PASSIVO",
  opts?: { ativoTotal?: number }
) {
  const wantCls = title === "ATIVO" ? "1" : "2";

  const clsStr = (r: NormalizedBaseRow) =>
    String((r as any).classification ?? "")
      .trim()
      .replace(/\.$/, ""); // "1." -> "1"

  const descNorm = (r: NormalizedBaseRow) => normalizeText(r.description ?? "");
  const descIsJustClassToken = (r: NormalizedBaseRow) => {
    // pega o caso do teu PDF: description vira "1" / "1." / "2" / "2."
    const d = String(r.description ?? "").trim();
    return d === wantCls || d === `${wantCls}.`;
  };

  const saldoRaw = (r: NormalizedBaseRow) => numFromAny((r as any).saldoAtual);

  // Preferência 1: linha clara por descrição
  const byTitleDesc = rows.filter((r) => {
    const d = descNorm(r);
    if (!d) return false;

    if (title === "ATIVO") {
      return d === "ATIVO" || d === "TOTAL ATIVO" || d === "ATIVO TOTAL" || d === "TOTAL DO ATIVO";
    }

    // PASSIVO
    if (d === "PASSIVO" || d === "TOTAL PASSIVO" || d === "PASSIVO TOTAL" || d === "TOTAL DO PASSIVO")
      return true;

    // não expandir demais (isso estava puxando Passivo Não Circulante etc. e favorecendo outlier)
    // ainda assim, deixa "PASSIVO E PL" ou "PASSIVO + PL" caso exista
    if (d.includes("PASSIVO") && (d.includes("PL") || d.includes("PATRIM"))) return true;

    return false;
  });

  // Preferência 2: classification 1/2 “bonita” (quando existir)
  const byClass = rows.filter((r) => clsStr(r) === wantCls);

  // Preferência 3: PDF quebrado, e a “classe” cai em description
  const byBrokenPdf = rows.filter((r) => clsStr(r) === "" && descIsJustClassToken(r));

  // Preferência 4 (PASSIVO): se o parser setar group=PASSIVO
  const byGroup =
    title === "PASSIVO"
      ? rows.filter((r) => String((r as any)?.group ?? "").toUpperCase() === "PASSIVO")
      : [];

  // Junta candidatos
  const candidates = [...byTitleDesc, ...byClass, ...byBrokenPdf, ...byGroup]
    .map((r) => {
      const raw = saldoRaw(r);
      const fixed = applyGluedFix(title, raw, { ativoTotal: opts?.ativoTotal });
      return { r, raw, fixed };
    })
    .filter((x) => Number.isFinite(x.fixed) && Math.abs(x.fixed) > 1e-9);

  if (!candidates.length) return null;

  // ✅ Em vez de "maior saldo sempre", escolhe o mais plausível:
  // - se tiver ativoTotal (para PASSIVO), filtra por faixa
  const ativo = Math.abs(opts?.ativoTotal ?? 0);

  let filtered = candidates;
  if (title === "PASSIVO" && ativo > 0) {
    const maxOk = Math.max(ativo * 5, 50_000_000); // bem folgado
    filtered = candidates.filter((x) => Math.abs(x.fixed) <= maxOk);
    if (!filtered.length) filtered = candidates; // fallback
  }

  // Score: prioriza linhas de "TOTAL/ATIVO/PASSIVO" ou classificação raiz,
  // e depois escolhe o MAIOR (já sem outlier) para pegar o total.
  const score = (x: { r: NormalizedBaseRow; fixed: number }) => {
    const d = descNorm(x.r);
    const cls = clsStr(x.r);
    let s = 0;
    if (title === "ATIVO") {
      if (d === "ATIVO" || d === "ATIVO TOTAL" || d === "TOTAL ATIVO" || d === "TOTAL DO ATIVO")
        s += 1000;
    } else {
      if (d === "PASSIVO" || d === "PASSIVO TOTAL" || d === "TOTAL PASSIVO" || d === "TOTAL DO PASSIVO")
        s += 1000;
    }
    if (cls === wantCls) s += 200;
    if (descIsJustClassToken(x.r)) s += 50;
    // favorece valores maiores dentre os "bons" (total costuma ser o maior do grupo raiz)
    s += Math.min(100, Math.log10(Math.abs(x.fixed) + 1) * 10);
    return s;
  };

  // ✅ PASSIVO: se tenho ATIVO, escolho o candidato mais plausível (mais perto do ATIVO)
  if (title === "PASSIVO" && ativo > 0) {
    const best = filtered
      .map((x) => {
        const relErr = Math.abs(Math.abs(x.fixed) - ativo) / ativo;
        return { x, relErr };
      })
      .sort((a, b) => a.relErr - b.relErr)[0];

    if (best && Number.isFinite(best.relErr) && best.relErr < 0.35) {
      return best.x.r;
    }
    // fallback: mantém lógica por score
  }

  filtered.sort((a, b) => score(b) - score(a));
  return filtered[0].r;
}

export function computeBalanceTotalsFromBase(base: NormalizedBaseRow[]): BalanceKpiResult {
  const notes: string[] = [];
  const byPeriodMap = new Map<string, NormalizedBaseRow[]>();

  for (const r of base ?? []) {
    if (!r.period) continue;
    const arr = byPeriodMap.get(r.period) ?? [];
    arr.push(r);
    byPeriodMap.set(r.period, arr);
  }

  const byPeriod = Array.from(byPeriodMap.entries()).map(([period, rows]) => {
    const year = rows.find((x) => typeof x.year === "number")?.year ?? null;

    const ativoRow = pickTotal(rows, "ATIVO");
    const ativo_raw = numFromAny((ativoRow as any)?.saldoAtual);
    const ativo_total = brRound(applyGluedFix("ATIVO", ativo_raw));

    const passivoRow = pickTotal(rows, "PASSIVO", { ativoTotal: ativo_total });
    const passivo_raw = numFromAny((passivoRow as any)?.saldoAtual);
    const passivo_fixed = applyGluedFix("PASSIVO", passivo_raw, { ativoTotal: ativo_total });
    const passivo_total = brRound(passivo_fixed);

    if (!ativoRow) notes.push(`Período ${period}: não encontrou TOTAL ATIVO com segurança.`);
    if (!passivoRow) notes.push(`Período ${period}: não encontrou TOTAL PASSIVO com segurança.`);

    // Transparência de correção (não é erro, é “conserto do PDF colado”)
    if (ativo_raw && Math.abs(ativo_raw - ativo_total) > 0.01) {
      notes.push(
        `Período ${period}: ATIVO corrigido por colagem de dígito (raw=${brRound(
          ativo_raw
        )} -> fix=${ativo_total}).`
      );
    }
    if (passivo_raw && Math.abs(passivo_raw - passivo_total) > 0.01 && passivo_total > 0) {
      notes.push(
        `Período ${period}: PASSIVO corrigido/filtrado por outlier (raw=${brRound(
          passivo_raw
        )} -> fix=${passivo_total}).`
      );
    }

    return { period, year, ativo_total, passivo_total };
  });

  if (!byPeriod.length) notes.push("Não foi possível agrupar períodos para Ativo/Passivo.");

  return { byPeriod, notes };
}

// ===========================
// ✅ DRE (intacto)
// ===========================
export function computeTccKpisFromBase(base: NormalizedBaseRow[]): TccKpiResult {
  const notes: string[] = [];
  const byPeriodMap = new Map<string, NormalizedBaseRow[]>();

  for (const r of base ?? []) {
    if (!r.period || !isDreRelevantRow(r)) continue;
    const arr = byPeriodMap.get(r.period) ?? [];
    arr.push(r);
    byPeriodMap.set(r.period, arr);
  }

  const byPeriod = Array.from(byPeriodMap.entries()).map(([period, rows]) => {
    const year = rows.find((x) => typeof x.year === "number")?.year ?? null;
    const buckets = computeBuckets(rows);

    let receita_bruta =
      sumByClassificationPrefixAbs(rows, [...PLAN_PREFIX.receita_bruta], "credito") || 0;
    let deducoes = sumByClassificationPrefixAbs(rows, [...PLAN_PREFIX.deducoes], "debito") || 0;
    let cmv_cpv = sumByClassificationPrefixAbs(rows, [...PLAN_PREFIX.cmv_cpv], "debito") || 0;
    let despesas_admin =
      sumByClassificationPrefixAbs(rows, [...PLAN_PREFIX.despesas_admin], "debito") || 0;

    let receita_liquida = sumByMatchAbs(rows, RX.receitaLiquida, "credito");

    if (!receita_bruta) receita_bruta = sumByMatchAbs(rows, RX.receitaBruta, "credito");
    if (!deducoes) deducoes = sumByMatchAbs(rows, RX.deducoes, "debito");
    if (!cmv_cpv) cmv_cpv = sumByMatchAbs(rows, RX.cmvCpv, "debito");
    if (!despesas_admin) despesas_admin = sumByMatchAbs(rows, RX.despesasAdmin, "debito");

    if (!receita_bruta) receita_bruta = sumByBucketAbs(rows, ["3.1"]);
    if (!deducoes) deducoes = sumByBucketAbs(rows, ["3.2"]);
    if (!cmv_cpv) cmv_cpv = sumByBucketAbs(rows, ["3.3", "3.4", "3.5"]);
    if (!despesas_admin) despesas_admin = sumByBucketAbs(rows, ["3.7", "3.8"]);

    if (!receita_liquida && receita_bruta) receita_liquida = brRound(receita_bruta - deducoes);

    const despesas_comerciais = sumByMatchAbs(rows, RX.despesasComerciais, "debito");
    const outras_despesas = sumByMatchAbs(rows, RX.outrasDespesas, "debito");

    const lucro_bruto = receita_liquida ? brRound(receita_liquida - cmv_cpv) : null;
    const resultado_operacional =
      lucro_bruto !== null
        ? brRound(lucro_bruto - despesas_admin - despesas_comerciais - outras_despesas)
        : null;

    const confident =
      (receita_bruta > 0 || receita_liquida > 0) &&
      (cmv_cpv > 0 || despesas_admin > 0 || despesas_comerciais > 0 || outras_despesas > 0);

    if (!confident) {
      notes.push(
        `Período ${period}: KPIs de DRE sem validação suficiente no balancete (evitando fallback).`
      );
    }

    const safe = confident;

    return {
      period,
      year,
      receita_liquida: safe ? receita_liquida : 0,
      receita_bruta: safe ? receita_bruta : 0,
      deducoes: safe ? deducoes : 0,
      cmv_cpv: safe ? cmv_cpv : 0,
      despesas_admin: safe ? despesas_admin : 0,
      despesas_comerciais: safe ? despesas_comerciais : 0,
      outras_despesas: safe ? outras_despesas : 0,
      lucro_bruto: safe ? lucro_bruto : null,
      resultado_operacional: safe ? resultado_operacional : null,
      lucro_liquido: safe ? resultado_operacional : null,
      margem_bruta_pct: safe
        ? lucro_bruto !== null
          ? pct(lucro_bruto, receita_liquida)
          : null
        : null,
      margem_liquida_pct: safe
        ? resultado_operacional !== null
          ? pct(resultado_operacional, receita_liquida)
          : null
        : null,
      buckets,
    };
  });

  if (!byPeriod.length) {
    notes.push(
      "Não foram detectadas linhas de DRE (classe 3.x) no balancete. KPIs de Receita/Lucro podem ficar indisponíveis."
    );
  }

  return { byPeriod, notes };
}
