// src/lib/normalizeBase.ts
import type { ContabilParseResult, ContabilRow } from "@/lib/contabilParser";

export type NormalizedBaseRow = {
  // contexto
  period: string;
  year?: number | null;

  // classificação do plano (ex.: 1, 1.01, 2.01.03, 3.1.1.01 etc.)
  classification?: string | null;

  // código/conta (se existir)
  code?: string | null;

  // descrição da conta
  description?: string | null;

  // grupo macro (não “força” DRE, só usa o que dá pra inferir)
  group?: "ATIVO" | "PASSIVO" | "DRE" | "OUTROS";

  // colunas numéricas (podem vir como {raw,value} do contabilParser)
  saldoAtual?: any;
  saldoAnterior?: any;
  debito?: any;
  credito?: any;

  // linha original (pra debug)
  rawLine?: string | null;
};

function normalizeText(input: unknown): string {
  return String(input ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** ✅ normaliza classificação sem “inventar DRE” */
function normalizeClassification(input: unknown): string {
  const raw = String(input ?? "").trim();
  if (!raw) return "";

  // já está no formato 1.2...
  if (/^[1-3]\.\d/.test(raw)) return raw;

  // 3xx.xxx -> 3.x.x.xxx
  if (/^[1-3]\d\d\.\d+$/.test(raw)) {
    const m = raw.match(/^([1-3])(\d)(\d)\.(\d+)$/);
    if (m) return `${m[1]}.${m[2]}.${m[3]}.${m[4]}`;
  }

  // 3xxxx -> 3.x.x.x
  if (/^[1-3]\d\d\d$/.test(raw)) {
    const m2 = raw.match(/^([1-3])(\d)(\d)(\d)$/);
    if (m2) return `${m2[1]}.${m2[2]}.${m2[3]}.${m2[4]}`;
  }

  // 1 / 2 / 3 puro
  if (/^[1-3]$/.test(raw)) return raw;

  return raw;
}

/** ✅ tenta inferir grupo pela classificação (se existir) */
function groupFromClassification(clsRaw: unknown): "ATIVO" | "PASSIVO" | "DRE" | "OUTROS" {
  const cls = normalizeClassification(clsRaw);
  if (cls === "1" || cls.startsWith("1.")) return "ATIVO";
  if (cls === "2" || cls.startsWith("2.")) return "PASSIVO";
  if (cls === "3" || cls.startsWith("3.")) return "DRE";
  return "OUTROS";
}

/**
 * ✅ Função principal: transforma as ContabilRow em NormalizedBaseRow
 * - Não “cria” linhas
 * - Não muda valores
 * - Só padroniza texto/campos e injeta period/year
 */
export function normalizeBase(
  parsed: ContabilParseResult,
  ctx: { period: string; year?: number | null }
): NormalizedBaseRow[] {
  const rows: ContabilRow[] = (parsed?.rows ?? []) as any;
  const out: NormalizedBaseRow[] = [];

  for (const r of rows) {
    const classification = normalizeClassification((r as any).classification ?? (r as any).classificacao);
    const description = String((r as any).description ?? "").trim() || null;

    out.push({
      period: String(ctx?.period ?? "").trim(),
      year: typeof ctx?.year === "number" ? ctx.year : ctx?.year ?? null,

      classification: classification || null,
      code: (r as any).code ?? null,
      description: description,

      // se o parser já setou group, mantém; senão tenta inferir por classificação
      group: ((r as any).group as any) ?? groupFromClassification(classification),

      saldoAtual: (r as any).saldoAtual ?? null,
      saldoAnterior: (r as any).saldoAnterior ?? null,
      debito: (r as any).debito ?? null,
      credito: (r as any).credito ?? null,

      rawLine: (r as any).rawLine ?? null,
    });
  }

  // ✅ fallback extra: se description existir e for “ATIVO/PASSIVO/DRE”, não muda valores,
  // apenas ajuda o group quando classification está vazia.
  for (const rr of out) {
    if (rr.group && rr.group !== "OUTROS") continue;

    const d = normalizeText(rr.description ?? "");
    if (d === "ATIVO" || d === "TOTAL ATIVO" || d === "ATIVO TOTAL") rr.group = "ATIVO";
    else if (d === "PASSIVO" || d === "TOTAL PASSIVO" || d === "PASSIVO TOTAL") rr.group = "PASSIVO";
    else if (d === "DRE" || d.includes("RESULTADO") || d.includes("DEMONSTRACAO")) rr.group = "DRE";
  }

  return out;
}

/**
 * ✅ alias obrigatório para compatibilidade com analyzeEngine.ts
 * (é isso que evita 500)
 */
export const buildNormalizedBase = normalizeBase;
export default normalizeBase;
