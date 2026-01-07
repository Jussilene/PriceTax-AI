// src/lib/contabilParser.ts
export type MoneyBR = {
  raw: string;
  value: number; // em número normal
};

export type ContabilRow = {
  rawLine: string;

  // contexto
  group?: "ATIVO" | "PASSIVO" | "DRE" | "OUTROS";

  // campos
  code?: string | null;
  description?: string | null;
  classification?: string | null;

  saldoAtual?: MoneyBR | null;
  saldoAnterior?: MoneyBR | null;
  debito?: MoneyBR | null;
  credito?: MoneyBR | null;
};

export type ContabilParseResult = {
  rows: ContabilRow[];
  warnings: string[];
};

/**
 * Aceita:
 *  - 1.234,56
 *  - -1.234,56
 *  - (1.234,56)
 *  - 1.234,56-
 */
const moneyTokenRe = /\(?-?\d{1,3}(?:\.\d{3})*,\d{2}\)?-?/g;

function cleanSpaces(s: string) {
  return String(s ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * ✅ Separa tokens monetários quando o PDF “cola” números:
 * Ex: "15.196.986,855.511.188,33" => "15.196.986,85 5.511.188,33"
 */
function unglueMoneyTokens(line: string) {
  return String(line ?? "")
    .replace(/(,\d{2})(?=\d)/g, "$1 ")
    .replace(/(\))(?=\d)/g, "$1 ")
    .replace(/\s+/g, " ");
}

function parseMoneyBR(token: string): MoneyBR | null {
  const raw = cleanSpaces(token);
  if (!raw) return null;

  let sign = 1;

  // (1.234,56)
  if (raw.startsWith("(") && raw.endsWith(")")) sign = -1;

  // 1.234,56-
  if (raw.endsWith("-")) sign = -1;

  // -1.234,56
  if (raw.startsWith("-")) sign = -1;

  // remove parênteses e sinais (mantém só dígitos . ,)
  const normalized = raw
    .replace(/[()]/g, "")
    .replace(/-/g, "")
    .trim();

  const value = Number(normalized.replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(value)) return null;

  return { raw, value: value * sign };
}

// detecta se a linha é “título de seção” (ATIVO, PASSIVO, DRE etc)
function detectSectionHeader(line: string): ContabilRow["group"] | null {
  const up = cleanSpaces(line).toUpperCase();

  // casos comuns em balancetes
  if (up === "ATIVO" || up.startsWith("ATIVO ")) return "ATIVO";
  if (up === "PASSIVO" || up.startsWith("PASSIVO ")) return "PASSIVO";

  // ✅ DRE/Resultado: aqui tem que ser rígido (evita contaminar o arquivo todo)
  // aceita somente quando for realmente o título da seção
  if (
    up === "DRE" ||
    up.startsWith("DRE ") ||
    up.includes("DEMONSTRACAO DO RESULTADO") ||
    up.includes("DEMONSTRAÇÃO DO RESULTADO") ||
    up.includes("D.R.E") ||
    up.includes("DEMONSTRATIVO DO RESULTADO")
  ) {
    return "DRE";
  }

  return null;
}

/**
 * Ex:
 *  "263 3.1 Receita ..." -> code=263, rest="3.1 Receita ..."
 *  "11 Caixa ..." -> code=11
 */
function extractLeadingCode(s: string): { code: string | null; rest: string } {
  const m = s.match(/^\s*(\d{1,6})\s+(.*)$/);
  if (!m) return { code: null, rest: s.trim() };
  return { code: m[1], rest: m[2].trim() };
}

/**
 * ✅ NOVO: quando o PDF “gruda” código + classificação:
 * Ex: "371.1.3.02"  => code="371" e classification="1.3.02"
 * Ex: "1778.1.1.3.02.03 ..." => code="1778" e classification="1.1.3.02.03"
 *
 * A regra é: começa com dígitos (código), depois um ".", e logo em seguida começa com 1/2/3 (classificação).
 */
function splitFusedCodeClassification(s: string): { code: string | null; rest: string } {
  const txt = cleanSpaces(s);

  // pega "COD.CLASSIF" no começo, onde CLASSIF começa com 1/2/3
  const m = txt.match(/^(\d{1,6})\.(?=([123])(?:\.\d{1,3})+)(.*)$/);
  if (!m) return { code: null, rest: txt };

  const code = m[1];
  const rest = m[3]?.trim() ? m[3].trim() : "";
  return { code, rest: rest ? rest : txt.slice(code.length).trim() };
}

/**
 * Tenta capturar uma "classificação" contábil (tipo 1.1 / 2.1.01 / 3.1.1.01 etc)
 * em qualquer lugar do início do texto (após o code).
 */
function extractFirstClassification(s: string): { classification: string | null; rest: string } {
  const txt = cleanSpaces(s);

  // procura no início (primeiro token)
  const mStart = txt.match(/^(\d{1,3}(?:\.\d{1,3})+)\s+(.*)$/);
  if (mStart) return { classification: mStart[1], rest: mStart[2].trim() };

  // procura "solta"
  const mAny = txt.match(/\b(\d{1,3}(?:\.\d{1,3})+)\b/);
  if (!mAny) return { classification: null, rest: txt };

  const cls = mAny[1];
  const rest = cleanSpaces(txt.replace(cls, ""));
  return { classification: cls, rest };
}

// tenta inferir grupo pela classificação (fallback quando não teve cabeçalho)
function inferGroupByClassification(classification?: string | null): ContabilRow["group"] | null {
  if (!classification) return null;

  const cls = String(classification).trim();

  // ✅ AJUSTE: só considera plano “real” se começar com 1/2/3 seguido de "." (ou for só "1"/"2"/"3")
  // Isso evita classificar "371.1.3.02" como DRE (isso é código+classif grudado)
  if (!/^[123](?:\.|$)/.test(cls)) return null;

  const first = cls[0];
  if (first === "1") return "ATIVO";
  if (first === "2") return "PASSIVO";
  if (first === "3") return "DRE";
  return null;
}

function isHeaderLine(line: string) {
  const up = cleanSpaces(line).toUpperCase();

  // ignora cabeçalhos comuns
  if (up.includes("CÓDIGO") && up.includes("DESCRI") && up.includes("SALDO")) return true;
  if (up.includes("CODIGO") && up.includes("DESCRI") && up.includes("SALDO")) return true;

  // outros
  if (up.startsWith("EMPRESA") || up.startsWith("BALANCETE") || up.includes("PÁGINA")) return true;
  if (up.startsWith("C.N.P.J") || up.startsWith("CNPJ")) return true;
  if (up.startsWith("PERÍODO") || up.startsWith("PERIODO")) return true;
  if (up.startsWith("CONSOLIDADO")) return true;

  return false;
}

/**
 * ✅ detecta ordem das colunas pelo header do balancete.
 * Existem 2 padrões comuns:
 *  A) Saldo Atual | Saldo Anterior | Débito | Crédito
 *  B) Saldo Anterior | Débito | Crédito | Saldo Atual
 */
type ColumnOrder = "SA_SANT_DEB_CRED" | "SANT_DEB_CRED_SA";

function detectColumnOrderFromHeader(line: string): ColumnOrder | null {
  const up = cleanSpaces(line).toUpperCase();

  if (!(up.includes("SALDO") && (up.includes("ANTERIOR") || up.includes("ATUAL")))) return null;

  const iAtual = up.indexOf("ATUAL");
  const iAnt = up.indexOf("ANTERIOR");
  const iDeb = up.indexOf("DÉBITO") >= 0 ? up.indexOf("DÉBITO") : up.indexOf("DEBITO");
  const iCred = up.indexOf("CRÉDITO") >= 0 ? up.indexOf("CRÉDITO") : up.indexOf("CREDITO");

  if (iAnt >= 0 && iDeb >= 0 && iCred >= 0 && iAtual >= 0) {
    if (iAnt < iDeb && iDeb < iCred && iCred < iAtual) return "SANT_DEB_CRED_SA";
    if (iAtual < iAnt && iAnt < iDeb && iDeb < iCred) return "SA_SANT_DEB_CRED";
  }

  return null;
}

function mapMoneyTokens(tokens: string[], order: ColumnOrder) {
  const parsed = tokens.map(parseMoneyBR).filter(Boolean) as MoneyBR[];
  if (!parsed.length) {
    return { saldoAtual: null, saldoAnterior: null, debito: null, credito: null };
  }

  const tail = parsed.slice(-4);

  if (tail.length === 4) {
    const [m1, m2, m3, m4] = tail;

    if (order === "SANT_DEB_CRED_SA") {
      return { saldoAnterior: m1, debito: m2, credito: m3, saldoAtual: m4 };
    }

    return { saldoAtual: m1, saldoAnterior: m2, debito: m3, credito: m4 };
  }

  if (tail.length === 3) {
    const [m1, m2, m3] = tail;
    if (order === "SANT_DEB_CRED_SA") {
      return { saldoAnterior: m1, debito: m2, credito: m3, saldoAtual: null };
    }
    return { saldoAtual: m1, saldoAnterior: m2, debito: m3, credito: null };
  }

  if (tail.length === 2) {
    const [m1, m2] = tail;
    if (order === "SANT_DEB_CRED_SA") {
      return { saldoAnterior: m1, debito: null, credito: null, saldoAtual: m2 };
    }
    return { saldoAtual: m1, saldoAnterior: m2, debito: null, credito: null };
  }

  return { saldoAtual: tail[0] ?? null, saldoAnterior: null, debito: null, credito: null };
}

export function parseContabilRowsFromText(text: string): ContabilParseResult {
  const warnings: string[] = [];
  if (!text || !text.trim()) {
    return { rows: [], warnings: ["Texto vazio extraído do PDF."] };
  }

  const lines = text
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter(Boolean);

  const rows: ContabilRow[] = [];

  let currentGroup: ContabilRow["group"] = "OUTROS";
  let columnOrder: ColumnOrder = "SA_SANT_DEB_CRED";

  // ✅ guarda uma possível linha "TOTAL" que vem ANTES do cabeçalho (ATIVO/PASSIVO/DRE)
  let pendingTotalLine: {
    line: string;
    code: string | null;
    saldoAtual: MoneyBR | null;
    saldoAnterior: MoneyBR | null;
    debito: MoneyBR | null;
    credito: MoneyBR | null;
  } | null = null;

  for (const raw of lines) {
    let line = cleanSpaces(raw);
    line = unglueMoneyTokens(line);

    const maybeOrder = detectColumnOrderFromHeader(line);
    if (maybeOrder) {
      columnOrder = maybeOrder;
      continue;
    }

    const section = detectSectionHeader(line);
    if (section) {
      // ✅ se a linha anterior era "TOTAL" sem descrição, cola ela no grupo certo
      if (pendingTotalLine) {
        rows.push({
          rawLine: pendingTotalLine.line,
          group: section,
          code: pendingTotalLine.code,
          classification: null,
          description: `TOTAL ${section}`,
          saldoAtual: pendingTotalLine.saldoAtual,
          saldoAnterior: pendingTotalLine.saldoAnterior,
          debito: pendingTotalLine.debito,
          credito: pendingTotalLine.credito,
        });
        pendingTotalLine = null;
      }

      currentGroup = section;
      continue;
    }

    if (isHeaderLine(line)) continue;

    const moneyMatches = line.match(moneyTokenRe) ?? [];
    if (moneyMatches.length < 2) continue;

    const { saldoAtual, saldoAnterior, debito, credito } = mapMoneyTokens(moneyMatches, columnOrder);

    /**
     * Sempre corta o "pre" antes do PRIMEIRO valor monetário da linha.
     */
    const firstMoneyToken = moneyMatches[0];
    const idxFirst = firstMoneyToken ? line.indexOf(firstMoneyToken) : -1;
    const pre = idxFirst >= 0 ? line.slice(0, idxFirst) : line;
    let preClean = cleanSpaces(pre);

    // ✅ NOVO: tenta corrigir quando vier "COD.CLASSIF" grudado no começo
    // Transformamos em "COD  CLASSIF ..." para o pipeline extrair certo.
    const fused = splitFusedCodeClassification(preClean);
    if (fused.code && fused.rest) {
      preClean = `${fused.code} ${fused.rest}`;
    }

    const { code, rest } = extractLeadingCode(preClean);
    const { classification, rest: descRest } = extractFirstClassification(rest);

    const description = cleanSpaces(descRest);

    // ✅ CASO CRÍTICO DO TEU PDF:
    // a linha "1  15.196.986,85 ..." vem sozinha, e o "ATIVO" vem na linha seguinte.
    // Então, se estamos em OUTROS, e a linha tem apenas o código e números, guarda como pending.
    if (
      (currentGroup === "OUTROS" || !currentGroup) &&
      code &&
      !classification &&
      (!description || description === code) &&
      moneyMatches.length >= 4
    ) {
      pendingTotalLine = { line, code, saldoAtual, saldoAnterior, debito, credito };
      continue;
    }

    const inferred = inferGroupByClassification(classification);
    const group =
      currentGroup && currentGroup !== "OUTROS"
        ? currentGroup
        : inferred ?? currentGroup ?? "OUTROS";

    rows.push({
      rawLine: line,
      group,
      code,
      classification,
      description: description || null,
      saldoAtual,
      saldoAnterior,
      debito,
      credito,
    });
  }

  // se sobrar pending no final, joga como OUTROS mesmo
  if (pendingTotalLine) {
    rows.push({
      rawLine: pendingTotalLine.line,
      group: "OUTROS",
      code: pendingTotalLine.code,
      classification: null,
      description: null,
      saldoAtual: pendingTotalLine.saldoAtual,
      saldoAnterior: pendingTotalLine.saldoAnterior,
      debito: pendingTotalLine.debito,
      credito: pendingTotalLine.credito,
    });
  }

  if (!rows.length) warnings.push("Nenhuma linha contábil com valores foi detectada no texto.");

  return { rows, warnings };
}
