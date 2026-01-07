// src/lib/exactTruth.ts
import type { NormalizedBaseRow } from "@/lib/normalizeBase";
import { computeBalanceTotalsFromBase } from "@/lib/kpiEngine";

function parseMoneyBR(raw: string): number {
  const s = String(raw ?? "").trim();
  if (!s) return 0;

  const neg = s.includes("(") && s.includes(")");
  const cleaned = s.replace(/[()]/g, "").replace(/\./g, "").replace(",", ".");
  const n = Number(cleaned);

  if (!Number.isFinite(n)) return 0;
  return neg ? -Math.abs(n) : n;
}

const moneyRe = /\(?\d{1,3}(?:\.\d{3})*,\d{2}\)?/g;

function brRound(n: number, digits = 2) {
  const p = Math.pow(10, digits);
  return Math.round(n * p) / p;
}

function applyGluedFixFromText(
  title: "ATIVO" | "PASSIVO",
  raw: number,
  ctx?: { ativoTotal?: number }
): number {
  if (!Number.isFinite(raw) || Math.abs(raw) < 1e-9) return 0;

  const sign = raw < 0 ? -1 : 1;
  const n = Math.abs(raw);

  if (title === "ATIVO") {
    if (n >= 10_000_000 && n < 20_000_000) {
      const fixed = n - 10_000_000;
      if (fixed > 0) return sign * fixed;
    }
    return raw;
  }

  const ativo = Math.abs(ctx?.ativoTotal ?? 0);

  // ✅ novo: caso clássico "31.xxx.xxx,xx" (um dígito colado) => divide por 10
  // Ex.: 31.082.543,78 -> 3.108.254,38
  if (n >= 30_000_000 && n < 40_000_000) {
    const fixed = n / 10;
    if (!ativo || (fixed > ativo * 0.2 && fixed < ativo * 5)) return sign * fixed;
  }

  if (ativo > 0) {
    if (n > Math.max(ativo * 20, 200_000_000)) return 0;
  } else {
    if (n > 1_000_000_000) return 0;
  }

  if (n >= 20_000_000 && n < 30_000_000) {
    const fixed = n - 20_000_000;
    if (fixed > 0) return sign * fixed;
  }

  if (n >= 10_000_000 && n < 20_000_000) {
    const fixed = n - 10_000_000;
    if (fixed > 0) return sign * fixed;
  }

  return raw;
}

function normalizeTxt(s: string) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

function pickBestLine(lines: string[], title: "ATIVO" | "PASSIVO") {
  const cands: Array<{ line: string; nums: string[]; score: number }> = [];

  for (const line of lines) {
    const up = normalizeTxt(line);
    if (!up.includes(title)) continue;

    const nums = line.match(moneyRe) ?? [];
    if (nums.length < 3) continue;

    const hasCirculante = up.includes("CIRCULANTE");
    const hasNao = up.includes("NAO ") || up.includes("NÃO ");
    const hasPL = up.includes("PL") || up.includes("PATRIM");

    let score = 0;

    if (/\b1\b/.test(up) && title === "ATIVO") score += 5;
    if (/\b2\b/.test(up) && title === "PASSIVO") score += 5;

    if (!hasCirculante && !hasNao) score += 3;

    if (title === "PASSIVO" && hasPL) score += 2;

    if (up.includes("TOTAL")) score += 3;

    cands.push({ line, nums, score });
  }

  cands.sort((a, b) => b.score - a.score);
  return cands[0] ?? null;
}

function extractTotalsFromPdfText(
  text: string,
  period: string,
  notes: string[]
): { ativo_total: number; passivo_total: number } | null {
  const lines = String(text ?? "").split(/\r?\n/);

  const ativoPick = pickBestLine(lines, "ATIVO");
  if (!ativoPick) return null;

  const ativoRaw = parseMoneyBR(ativoPick.nums[0]);
  const ativoFixed = brRound(applyGluedFixFromText("ATIVO", ativoRaw));

  const passivoPick = pickBestLine(lines, "PASSIVO");
  if (!passivoPick) return null;

  const passivoRaw = parseMoneyBR(passivoPick.nums[0]);
  const passivoFixed = brRound(
    applyGluedFixFromText("PASSIVO", passivoRaw, { ativoTotal: ativoFixed })
  );

  if (ativoRaw && Math.abs(ativoRaw - ativoFixed) > 0.01) {
    notes.push(
      `Período ${period}: ATIVO corrigido via texto do PDF (raw=${brRound(ativoRaw)} -> fix=${ativoFixed}).`
    );
  }
  if (passivoRaw && Math.abs(passivoRaw - passivoFixed) > 0.01 && passivoFixed > 0) {
    notes.push(
      `Período ${period}: PASSIVO corrigido via texto do PDF (raw=${brRound(passivoRaw)} -> fix=${passivoFixed}).`
    );
  }

  return {
    ativo_total: ativoFixed,
    passivo_total: passivoFixed,
  };
}

export function extractExactTotalsByPeriod(
  base: NormalizedBaseRow[],
  textsByPeriod?: Record<string, string>
) {
  const notes: string[] = [];
  const totals: Array<{ period: string; year?: number | null; ativo_total: number; passivo_total: number }> = [];

  if (textsByPeriod && Object.keys(textsByPeriod).length) {
    for (const period of Object.keys(textsByPeriod)) {
      const text = textsByPeriod[period] ?? "";
      const t = extractTotalsFromPdfText(text, period, notes);
      if (t) {
        const year =
          base?.find((r: any) => String(r?.period ?? "") === String(period) && typeof r?.year === "number")?.year ??
          null;

        totals.push({ period, year, ...t });
      }
    }

    if (totals.length) return { totals, notes };

    notes.push("Falha ao extrair totais via texto do PDF; usando fallback pela base normalizada.");
  }

  const fallback = computeBalanceTotalsFromBase(base);
  return { totals: fallback.byPeriod, notes: [...notes, ...(fallback.notes ?? [])] };
}

export function filterOutliersForRankings(rows: NormalizedBaseRow[], ativoTotal: number): NormalizedBaseRow[] {
  const abs = (n: number) => Math.abs(n);

  const getSaldo = (r: any) => {
    const sa = Number(r?.saldoAtual ?? 0);
    return Number.isFinite(sa) ? sa : 0;
  };

  if (!ativoTotal || !Number.isFinite(ativoTotal) || ativoTotal <= 0) {
    return rows.filter((r: any) => abs(getSaldo(r)) < 1e12);
  }

  const hardCap = ativoTotal * 1.05;
  const billionGuard = ativoTotal < 200_000_000 ? 1_000_000_000 : Infinity;

  return rows.filter((r: any) => {
    const v = abs(getSaldo(r));
    if (v <= 0) return false;
    if (v > hardCap) return false;
    if (v >= billionGuard) return false;
    return true;
  });
}
