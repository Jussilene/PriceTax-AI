// src/app/api/report/route.ts
import { NextResponse } from "next/server";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { getLatestAnalysisRun } from "@/lib/analysisStore";
import { searchSeededDocs } from "@/lib/docsRuntime";
import { composeReportModel, type ReportModel } from "@/lib/reportComposer";

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

function safeNum(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function brRound(n: number, digits = 2) {
  const p = Math.pow(10, digits);
  return Math.round(n * p) / p;
}
function deltaPct(curr: number, prev: number): number | null {
  if (!prev) return null;
  return brRound(((curr - prev) / Math.abs(prev)) * 100, 2);
}

// ✅ sanitiza texto para WinAnsi (Helvetica do pdf-lib)
function sanitizePdfText(input: any) {
  return String(input ?? "")
    // setas
    .replace(/\u2192/g, "->")
    .replace(/\u2190/g, "<-")
    .replace(/\u21d2/g, "=>")
    .replace(/\u21d0/g, "<=")

    // bullets e marcadores
    .replace(/\u2022/g, "*") // •
    .replace(/\u25CF/g, "*") // ●
    .replace(/\u25AA/g, "-") // ▪

    // travessões
    .replace(/\u2014/g, "-") // —
    .replace(/\u2013/g, "-") // –

    // aspas “inteligentes”
    .replace(/\u201C|\u201D/g, '"') // “ ”
    .replace(/\u2018|\u2019/g, "'") // ‘ ’

    // espaços especiais
    .replace(/\u00A0/g, " "); // nbsp
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
    distribuicaoGrupos: result?.distribuicaoGrupos ?? null,
    periodos: result?.periodos ?? [],
    kpisPorPeriodo: result?.kpisPorPeriodo ?? {},

    // ✅ enriquece PDF (sem mexer em números)
    summary: result?.summary ?? null,
    files: Array.isArray(result?.files) ? result.files : [],

    // ✅ NOVO: evidências para apêndice TCC
    kpiEvidence: result?.kpiEvidence ?? null,
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

    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "";
    const res = await fetch(`${baseUrl}/api/market?q=${encodeURIComponent(q)}`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
    }).catch(() => null);

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
// Narrativa (chama /api/analyze/narrativa)
// -----------------------
async function fetchNarrativa(args: {
  periodos: string[];
  kpisPorPeriodo: any;
  topGastos: any[];
  distribuicaoGrupos?: any;
}) {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "";
    const res = await fetch(`${baseUrl}/api/analyze/narrativa`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        periodos: args.periodos,
        kpisPorPeriodo: args.kpisPorPeriodo,
        topGastos: args.topGastos,
        distribuicaoGrupos: args.distribuicaoGrupos,
      }),
    }).catch(() => null);

    if (!res || !res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data?.ok) return null;

    return {
      resumoExecutivo: String(data.resumoExecutivo ?? "").trim(),
      alertas: Array.isArray(data.alertas) ? data.alertas.map(String) : [],
      checklist: Array.isArray(data.checklist) ? data.checklist.map(String) : [],
    };
  } catch {
    return null;
  }
}

// -----------------------
// PDF Layout helpers
// -----------------------
type PdfFonts = { regular: any; bold: any };

const A4: [number, number] = [595.28, 841.89];
const PAGE_TOP = 790;
const PAGE_BOTTOM = 70;
const PAGE_X = 50;
const PAGE_W = 495;

function wrapText(text: string, maxChars: number) {
  const cleaned = sanitizePdfText(text);
  const words = String(cleaned || "").split(/\s+/).filter(Boolean);
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
  page.drawText(sanitizePdfText(text), { x, y, size: 14, font: fonts.bold, color: rgb(0.05, 0.05, 0.05) });
}

function addNewPage(pdfDoc: any, fonts: PdfFonts, title?: string) {
  const page = pdfDoc.addPage(A4);
  let y = PAGE_TOP;

  // header discreto
  page.drawRectangle({ x: 0, y: A4[1] - 36, width: A4[0], height: 36, color: rgb(0.97, 0.97, 0.98) });
  page.drawText("PriceTax — Relatório de Análise (MVP)", {
    x: PAGE_X,
    y: A4[1] - 24,
    size: 9,
    font: fonts.bold,
    color: rgb(0.2, 0.2, 0.22),
  });

  if (title) {
    drawSectionTitle(page, fonts, title, PAGE_X, y);
    y -= 24;
  }

  return { page, y };
}

function ensureSpace(pdfDoc: any, fonts: PdfFonts, state: { page: any; y: number; title?: string }, need: number) {
  if (state.y - need >= PAGE_BOTTOM) return state;
  // cria nova página mantendo o título da seção
  const next = addNewPage(pdfDoc, fonts, state.title);
  return { ...state, page: next.page, y: next.y };
}

function drawParagraph(
  pdfDoc: any,
  fonts: PdfFonts,
  state: { page: any; y: number; title?: string },
  text: string,
  x: number,
  maxWidthChars = 95,
  size = 10
) {
  const lines = wrapText(text, maxWidthChars);
  let st = { ...state };

  for (const ln of lines) {
    st = ensureSpace(pdfDoc, fonts, st, size + 8);
    st.page.drawText(sanitizePdfText(ln), { x, y: st.y, size, font: fonts.regular, color: rgb(0.1, 0.1, 0.1) });
    st.y -= size + 4;
  }

  return st;
}

function drawBulletList(
  pdfDoc: any,
  fonts: PdfFonts,
  state: { page: any; y: number; title?: string },
  items: string[],
  x: number,
  maxWidthChars = 95,
  size = 10
) {
  let st = { ...state };

  for (const it of items) {
    const lines = wrapText(it, maxWidthChars - 4);
    if (!lines.length) continue;

    st = ensureSpace(pdfDoc, fonts, st, size + 10);
    st.page.drawText(sanitizePdfText(`• ${lines[0]}`), { x, y: st.y, size, font: fonts.regular, color: rgb(0.1, 0.1, 0.1) });
    st.y -= size + 4;

    for (const ln of lines.slice(1)) {
      st = ensureSpace(pdfDoc, fonts, st, size + 10);
      st.page.drawText(sanitizePdfText(`  ${ln}`), { x, y: st.y, size, font: fonts.regular, color: rgb(0.1, 0.1, 0.1) });
      st.y -= size + 4;
    }

    st.y -= 2;
  }

  return st;
}

function drawCallout(
  pdfDoc: any,
  fonts: PdfFonts,
  state: { page: any; y: number; title?: string },
  title: string,
  text: string,
  x: number,
  w: number
) {
  // ✅ garante que o conteúdo abaixo não "invada" o callout
  let st = ensureSpace(pdfDoc, fonts, state, 92);

  const baseTopY = st.y; // topo do bloco (antes de desenhar)
  const h = 74;

  st.page.drawRectangle({
    x,
    y: baseTopY - h,
    width: w,
    height: h,
    color: rgb(1, 0.96, 0.78),
    borderColor: rgb(0.85, 0.7, 0.2),
    borderWidth: 1,
  });

  st.page.drawText(sanitizePdfText(title), {
    x: x + 10,
    y: baseTopY - 18,
    size: 10,
    font: fonts.bold,
    color: rgb(0.2, 0.15, 0.05),
  });

  // texto interno (mantém o mesmo layout que você já tinha)
  drawParagraph(pdfDoc, fonts, { ...st, y: baseTopY - 34 }, text, x + 10, 88, 9);

  // ✅ posiciona o cursor DEPOIS do bloco amarelo (com padding)
  st.y = baseTopY - h - 14;
  return st;
}

// ✅ Ajuste de alinhamento (sem remover info): colunas numéricas agora alinham à direita
function drawTable(
  pdfDoc: any,
  fonts: PdfFonts,
  state: { page: any; y: number; title?: string },
  args: {
    x: number;
    w: number;
    colPercents: number[];
    header: string[];
    rows: string[][];
    rowHeight?: number;
    headerHeight?: number;
    fontSize?: number;
  }
) {
  const fontSize = args.fontSize ?? 9;
  const rowHeight = args.rowHeight ?? 18;
  const headerHeight = args.headerHeight ?? 20;

  const cols = args.colPercents.map((p) => (args.w * p) / 100);
  const xs: number[] = [args.x];
  for (let i = 0; i < cols.length; i++) xs.push(xs[i] + cols[i]);

  // heurística: detectar colunas numéricas pra alinhar à direita
  const isLikelyNumeric = (s: string) => {
    const t = String(s ?? "").trim();
    if (!t || t === "—") return false;
    if (t.includes("R$")) return true;
    if (/%\s*$/.test(t)) return true;
    // contém dígitos com separadores comuns
    return /[\d][\d\.\,]*$/.test(t);
  };
  const headerHints = (h: string) => {
    const t = String(h ?? "").toLowerCase();
    return (
      t.includes("valor") ||
      t.includes("total") ||
      t.includes("delta") ||
      t.includes("score") ||
      t.includes("m.") ||
      t.includes("margem")
    );
  };

  const colAlign: ("left" | "right" | "center")[] = args.header.map((h, i) => {
    if (headerHints(h)) return "right";
    // se a maioria das células da coluna parece numérica, alinhar à direita
    const sample = args.rows.slice(0, 12).map((r) => String(r?.[i] ?? ""));
    const numericCount = sample.filter(isLikelyNumeric).length;
    if (sample.length && numericCount / sample.length >= 0.6) return "right";
    // períodos geralmente ficam melhores centralizados
    const ht = String(h ?? "").toLowerCase();
    if (ht.includes("período") || ht.includes("periodo")) return "center";
    return "left";
  });

  const clampTx = (tx: number, colX: number, colW: number, pad: number) =>
    Math.max(colX + pad, Math.min(tx, colX + colW - pad));

  // ✅ garante que texto nunca "vaze" a célula: reduz fonte ou recorta com reticências
  const fitTextToCell = (
    font: any,
    txtRaw: string,
    baseSize: number,
    maxW: number,
    preferRight = false
  ): { txt: string; size: number } => {
    const t0 = sanitizePdfText(txtRaw ?? "");
    const w0 = font.widthOfTextAtSize(t0, baseSize);
    if (w0 <= maxW) return { txt: t0, size: baseSize };

    // tenta reduzir fonte até um mínimo aceitável
    const minSize = 6.6;
    const scaled = (baseSize * maxW) / Math.max(1, w0);
    const newSize = Math.max(minSize, Math.min(baseSize, scaled));
    const w1 = font.widthOfTextAtSize(t0, newSize);
    if (w1 <= maxW) return { txt: t0, size: newSize };

    // ainda não coube: corta e coloca "…"
    const ell = "…";
    const ellW = font.widthOfTextAtSize(ell, newSize);
    const allowed = Math.max(0, maxW - ellW);

    const s = t0;
    if (!s) return { txt: s, size: newSize };

    // preferRight = mantém o final (melhor p/ valores grandes)
    let lo = 0;
    let hi = s.length;

    const measure = (candidate: string) => font.widthOfTextAtSize(candidate, newSize);

    if (preferRight) {
      // pega sufixo que caiba
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const cand = ell + s.slice(s.length - mid);
        if (measure(cand) <= maxW) lo = mid;
        else hi = mid - 1;
      }
      const suffix = s.slice(s.length - lo);
      return { txt: ell + suffix, size: newSize };
    } else {
      // pega prefixo que caiba
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const cand = s.slice(0, mid) + ell;
        if (measure(cand) <= maxW) lo = mid;
        else hi = mid - 1;
      }
      const prefix = s.slice(0, lo);
      return { txt: prefix + ell, size: newSize };
    }
  };

  let st = { ...state };

  // header
  st = ensureSpace(pdfDoc, fonts, st, headerHeight + 8);
  st.page.drawRectangle({
    x: args.x,
    y: st.y - headerHeight,
    width: args.w,
    height: headerHeight,
    color: rgb(0.93, 0.93, 0.95),
    borderColor: rgb(0.85, 0.85, 0.88),
    borderWidth: 1,
  });

  for (let i = 0; i < args.header.length; i++) {
    const colX = xs[i];
    const colW = cols[i];
    const pad = 6;
    const maxCellW = Math.max(1, colW - pad * 2);

    const raw = sanitizePdfText(args.header[i] ?? "");
    const fitted = fitTextToCell(fonts.bold, raw, fontSize, maxCellW, false);

    const wTxt = fonts.bold.widthOfTextAtSize(fitted.txt, fitted.size);

    let tx = colX + pad;
    if (colAlign[i] === "right") tx = colX + colW - pad - wTxt;
    else if (colAlign[i] === "center") tx = colX + (colW - wTxt) / 2;

    tx = clampTx(tx, colX, colW, pad);

    st.page.drawText(fitted.txt, {
      x: tx,
      y: st.y - 14,
      size: fitted.size,
      font: fonts.bold,
      color: rgb(0.12, 0.12, 0.12),
    });
  }

  st.y -= headerHeight;

  // rows (com quebra)
  for (let r = 0; r < args.rows.length; r++) {
    st = ensureSpace(pdfDoc, fonts, st, rowHeight + 8);

    const row = args.rows[r];
    const bg = r % 2 === 0 ? rgb(0.985, 0.985, 0.99) : rgb(1, 1, 1);

    st.page.drawRectangle({
      x: args.x,
      y: st.y - rowHeight,
      width: args.w,
      height: rowHeight,
      color: bg,
      borderColor: rgb(0.9, 0.9, 0.92),
      borderWidth: 1,
    });

    for (let c = 0; c < cols.length; c++) {
      const colX = xs[c];
      const colW = cols[c];
      const pad = 6;
      const maxCellW = Math.max(1, colW - pad * 2);

      const raw = row[c] ?? "";
      const clipped = String(raw).length > 120 ? String(raw).slice(0, 118) + "…" : String(raw);
      const txt0 = sanitizePdfText(clipped);

      const preferRight = colAlign[c] === "right"; // valores: preserva final
      const fitted = fitTextToCell(fonts.regular, txt0, fontSize, maxCellW, preferRight);

      const wTxt = fonts.regular.widthOfTextAtSize(fitted.txt, fitted.size);

      let tx = colX + pad;
      if (colAlign[c] === "right") tx = colX + colW - pad - wTxt;
      else if (colAlign[c] === "center") tx = colX + (colW - wTxt) / 2;

      tx = clampTx(tx, colX, colW, pad);

      st.page.drawText(fitted.txt, {
        x: tx,
        y: st.y - 13,
        size: fitted.size,
        font: fonts.regular,
        color: rgb(0.12, 0.12, 0.12),
      });
    }

    st.y -= rowHeight;
  }

  st.y -= 8;
  return st;
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

type BuildOk = { bytes: Uint8Array; filename: string };
type BuildErr = { error: string; status: number };
type BuildRes = BuildOk | BuildErr;

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

  // ✅ Trechos teóricos (mostrados no PDF)
  const theoryQuery =
    "balancete dre margem bruta margem liquida despesas administrativas pareto redução de custos metodologia";
  const theoryHits = searchSeededDocs(theoryQuery, { limit: 12 });
  const theorySnippets = theoryHits.map((h: any, i: number) => `(${i + 1}) ${String(h.preview || "").trim()}`);

  const market = await fetchMarket(params.sector ?? null);

  // ✅ Report organizado (IA ou fallback), sem mexer nos números
  const composed = await composeReportModel({ pack, market, sector: params.sector ?? null });
  const report: ReportModel = composed.report;

  // ✅ Narrativa determinística (bem humana) com base nos KPIs do MVP
  const narrativa = await fetchNarrativa({
    periodos: Array.isArray(pack?.periodos) ? pack.periodos : [],
    kpisPorPeriodo: pack?.kpisPorPeriodo ?? {},
    topGastos: Array.isArray(pack?.top) ? pack.top : [],
    distribuicaoGrupos: pack?.distribuicaoGrupos ?? undefined,
  });

  const pdfDoc = await PDFDocument.create();
  const fonts: PdfFonts = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
  };

  // ---------- Capa ----------
  {
    const page = pdfDoc.addPage(A4);
    page.drawRectangle({ x: 0, y: 0, width: A4[0], height: A4[1], color: rgb(0.05, 0.05, 0.06) });

    page.drawText("PriceTax", { x: 50, y: 770, size: 26, font: fonts.bold, color: rgb(1, 0.83, 0.2) });
    page.drawText("Relatório Técnico — Análise de Balancete (TCC-like)", {
      x: 50,
      y: 735,
      size: 16,
      font: fonts.bold,
      color: rgb(1, 1, 1),
    });

    const latest = pack?.latest ?? {};
    const period = safeText(latest?.period ?? "—");
    const years = Array.isArray(pack?.years) && pack.years.length ? pack.years.join(", ") : "—";

    page.drawText(sanitizePdfText(`Período base: ${period}`), { x: 50, y: 700, size: 11, font: fonts.regular, color: rgb(0.9, 0.9, 0.9) });
    page.drawText(sanitizePdfText(`Anos detectados: ${years}`), { x: 50, y: 682, size: 11, font: fonts.regular, color: rgb(0.9, 0.9, 0.9) });
    page.drawText(sanitizePdfText(`JobId: ${run.jobId}`), { x: 50, y: 664, size: 10, font: fonts.regular, color: rgb(0.7, 0.7, 0.7) });

    page.drawText(sanitizePdfText(`Gerado em: ${new Date().toLocaleString("pt-BR")}`), {
      x: 50,
      y: 90,
      size: 10,
      font: fonts.regular,
      color: rgb(0.7, 0.7, 0.7),
    });

    page.drawText(
      sanitizePdfText(
        "Regras: números = balancete do MVP. Texto = organização TCC + trechos seed docs + recomendações sem inventar dados."
      ),
      {
        x: 50,
        y: 70,
        size: 9,
        font: fonts.regular,
        color: rgb(0.6, 0.6, 0.6),
      }
    );
  }

  // ---------- 1) Dados de Entrada & Qualidade ----------
  {
    const title = "1. Dados de Entrada & Qualidade";
    let st = addNewPage(pdfDoc, fonts, title);
    st.title = title;

    const summary = pack?.summary ?? {};
    const totalFiles = safeText(summary?.totalFiles ?? pack?.files?.length ?? "—");
    const rowsDetected = safeText(summary?.rowsDetected ?? "—");
    const warnings = Array.isArray(summary?.warnings) ? summary.warnings : [];
    const periodos = Array.isArray(pack?.periodos) ? pack.periodos : [];

    st = drawParagraph(
      pdfDoc,
      fonts,
      st,
      "Este relatório foi gerado a partir dos PDFs enviados no painel. A qualidade do texto extraído e o padrão do balancete impactam diretamente a precisão dos KPIs, rankings e evidências.",
      PAGE_X,
      95,
      10
    );
    st.y -= 6;

    st = drawBulletList(
      pdfDoc,
      fonts,
      st,
      [
        `Arquivos processados: ${totalFiles}`,
        `Linhas contábeis detectadas (aprox.): ${rowsDetected}`,
        `Períodos reconhecidos: ${periodos.length ? periodos.join(", ") : "—"}`,
      ],
      PAGE_X,
      95,
      10
    );

    st.y -= 8;
    st = drawParagraph(pdfDoc, fonts, st, "Lista de arquivos (amostra)", PAGE_X, 95, 10);
    st.y -= 8;

    const files = Array.isArray(pack?.files) ? pack.files : [];
    const fileRows = files.map((f: any) => [safeText(f?.fileName), safeText(f?.pages), safeText(f?.detectedYear ?? "—")]);

    if (!fileRows.length) {
      st = drawParagraph(pdfDoc, fonts, st, "— (Sem lista de arquivos nesta execução.)", PAGE_X, 95, 10);
    } else {
      st = drawTable(pdfDoc, fonts, st, {
        x: PAGE_X,
        w: PAGE_W,
        colPercents: [62, 18, 20],
        header: ["Arquivo", "Páginas", "Ano"],
        rows: fileRows.slice(0, 20),
        fontSize: 9,
      });
    }

    if (warnings.length) {
      st.y -= 6;
      st = drawCallout(
        pdfDoc,
        fonts,
        st,
        "Avisos de extração / leitura",
        `Foram encontrados ${warnings.length} avisos. Se houver divergência, revise o PDF do balancete (formato/colunas) e envie novamente.`,
        PAGE_X,
        PAGE_W
      );

      st = drawBulletList(pdfDoc, fonts, st, warnings.slice(0, 18).map((w: any) => String(w)), PAGE_X, 95, 9);
    }
  }

  // ---------- 2) Sumário Executivo ----------
  {
    const title = "2. Sumário Executivo";
    let st = addNewPage(pdfDoc, fonts, title);
    st.title = title;

    const latest = pack?.latest ?? {};
    const prev = pack?.prev ?? {};

    const receita = safeNum(latest?.receita_liquida ?? latest?.receitaLiquida);
    const receitaPrev = safeNum(prev?.receita_liquida ?? prev?.receitaLiquida);

    const lucro = safeNum(latest?.lucro_liquido ?? latest?.lucroLiquido);
    const lucroPrev = safeNum(prev?.lucro_liquido ?? prev?.lucroLiquido);

    const adm = safeNum(latest?.despesas_admin ?? latest?.despAdmin);
    const admPrev = safeNum(prev?.despesas_admin ?? prev?.despAdmin);

    const mbru = latest?.margem_bruta_pct ?? latest?.margemBrutaPct ?? null;
    const mliq = latest?.margem_liquida_pct ?? latest?.margemLiquidaPct ?? null;

    const dReceita = receitaPrev ? receita - receitaPrev : 0;
    const dLucro = lucroPrev ? lucro - lucroPrev : 0;
    const dAdm = admPrev ? adm - admPrev : 0;

    st = drawParagraph(
      pdfDoc,
      fonts,
      st,
      `Período base: ${safeText(latest?.period)}. A seguir, os indicadores principais do painel do MVP e a leitura executiva.`,
      PAGE_X,
      95,
      10
    );
    st.y -= 8;

    st = drawTable(pdfDoc, fonts, st, {
      x: PAGE_X,
      w: PAGE_W,
      colPercents: [22, 26, 26, 26],
      header: ["Indicador", "Período Atual", "Período Anterior", "Variação"],
      rows: [
        [
          "Receita Líquida",
          `R$ ${safeMoney(receita)}`,
          `R$ ${safeMoney(receitaPrev || null)}`,
          receitaPrev ? `${safeMoney(dReceita)} (${safePct(deltaPct(receita, receitaPrev))})` : "—",
        ],
        [
          "Desp. Administrativas",
          `R$ ${safeMoney(adm)}`,
          `R$ ${safeMoney(admPrev || null)}`,
          admPrev ? `${safeMoney(dAdm)} (${safePct(deltaPct(adm, admPrev))})` : "—",
        ],
        [
          "Lucro Líquido (proxy)",
          `R$ ${safeMoney(lucro)}`,
          `R$ ${safeMoney(lucroPrev || null)}`,
          lucroPrev ? `${safeMoney(dLucro)} (${safePct(deltaPct(lucro, lucroPrev))})` : "—",
        ],
        ["Margem Bruta", safePct(mbru), "—", "—"],
        ["Margem Líquida", safePct(mliq), "—", "—"],
      ],
      fontSize: 9,
      rowHeight: 18,
    });

    st.y -= 6;
    st = drawCallout(
      pdfDoc,
      fonts,
      st,
      "Regra de verdade",
      "Este relatório não inventa números: os valores financeiros vêm do painel do MVP (balancete processado). As recomendações são orientadas por evidências e rankings.",
      PAGE_X,
      PAGE_W
    );

    st.y -= 6;
    st = drawParagraph(pdfDoc, fonts, st, "Principais pontos (relatório organizado):", PAGE_X, 95, 10);
    st.y -= 4;
    st = drawBulletList(pdfDoc, fonts, st, report.executiveSummary.slice(0, 14), PAGE_X, 95, 10);

    const alerts = Array.isArray(pack?.alerts) ? pack.alerts : [];
    if (alerts.length) {
      st.y -= 4;
      st = drawParagraph(pdfDoc, fonts, st, "Observações automáticas do sistema:", PAGE_X, 95, 10);
      st.y -= 4;
      st = drawBulletList(
        pdfDoc,
        fonts,
        st,
        alerts.slice(0, 12).map((a: any) => `[${safeText(a.level)}] ${safeText(a.message)}`),
        PAGE_X,
        95,
        9
      );
    }
  }

  // ---------- 3) Metodologia & Base Teórica ----------
  {
    const title = "3. Metodologia & Base Teórica (seed docs)";
    let st = addNewPage(pdfDoc, fonts, title);
    st.title = title;

    st = drawParagraph(
      pdfDoc,
      fonts,
      st,
      "A metodologia aplicada segue a lógica: (1) extração das linhas do balancete, (2) normalização (código/descrição/classificação), (3) apuração de KPIs (DRE sintética) e (4) rankings (Pareto / variações / concentração).",
      PAGE_X,
      95,
      10
    );
    st.y -= 6;

    const notes = Array.isArray(report.methodologyNotes) ? report.methodologyNotes : [];
    if (notes.length) {
      st = drawParagraph(pdfDoc, fonts, st, "Notas de metodologia:", PAGE_X, 95, 10);
      st.y -= 4;
      st = drawBulletList(pdfDoc, fonts, st, notes.slice(0, 12), PAGE_X, 95, 10);
      st.y -= 6;
    }

    st = drawParagraph(pdfDoc, fonts, st, "Trechos relevantes (TCC/livro/fórmula já semeados no MVP):", PAGE_X, 95, 10);
    st.y -= 6;

    const snippets = (composed.theorySnippets?.length ? composed.theorySnippets : theorySnippets).slice(0, 10);
    if (!snippets.length) {
      st = drawParagraph(pdfDoc, fonts, st, "— Sem trechos relevantes disponíveis nesta execução.", PAGE_X, 95, 10);
    } else {
      for (const s of snippets) {
        st = drawParagraph(pdfDoc, fonts, st, s, PAGE_X, 95, 9);
        st.y -= 3;
      }
    }

    st.y -= 6;
    st = drawCallout(
      pdfDoc,
      fonts,
      st,
      "Importante",
      "Trechos seed docs servem para embasar explicações e recomendações. Eles NÃO substituem dados contábeis e NÃO geram números do cliente.",
      PAGE_X,
      PAGE_W
    );
  }

  // ---------- 4) DRE Sintética por Período (TCC-like) ----------
  {
    const title = "4. DRE Sintética por Período (KPIs do MVP)";
    let st = addNewPage(pdfDoc, fonts, title);
    st.title = title;

    st = drawParagraph(
      pdfDoc,
      fonts,
      st,
      "A tabela abaixo consolida a DRE sintética por período usando as regras do MVP (preferindo crédito para receita e débito para custos/despesas).",
      PAGE_X,
      95,
      10
    );
    st.y -= 8;

    const by = Array.isArray(pack?.tccByPeriod) ? pack.tccByPeriod : [];
    if (!by.length) {
      st = drawParagraph(pdfDoc, fonts, st, "— (Sem KPIs por período nesta execução.)", PAGE_X, 95, 10);
    } else {
      const rows = by.map((p: any) => [
        safeText(p?.period),
        `R$ ${safeMoney(p?.receita_liquida)}`,
        `R$ ${safeMoney(p?.deducoes)}`,
        `R$ ${safeMoney(p?.cmv_cpv)}`,
        `R$ ${safeMoney(p?.despesas_admin)}`,
        `R$ ${safeMoney(p?.lucro_liquido)}`,
        safePct(p?.margem_liquida_pct),
      ]);

      st = drawTable(pdfDoc, fonts, st, {
        x: PAGE_X,
        w: PAGE_W,
        colPercents: [14, 18, 14, 14, 16, 14, 10],
        header: ["Período", "Receita Líq.", "Deduções", "CMV/CPV", "Desp. Admin", "Lucro", "M. Líq."],
        rows: rows.slice(0, 12),
        fontSize: 8.2,
        rowHeight: 18,
      });
    }

    st.y -= 6;
    st = drawCallout(
      pdfDoc,
      fonts,
      st,
      "Leitura TCC",
      "A comparação entre períodos permite avaliar tendência (crescimento, queda, pressão de despesas e erosão de margem).",
      PAGE_X,
      PAGE_W
    );
  }

  // ---------- 5) Análise Horizontal (Evolução entre períodos) ----------
  {
    const title = "5. Análise Horizontal (Evolução)";
    let st = addNewPage(pdfDoc, fonts, title);
    st.title = title;

    const by = Array.isArray(pack?.tccByPeriod) ? pack.tccByPeriod : [];
    if (by.length >= 2) {
      const prev = by[by.length - 2];
      const cur = by[by.length - 1];

      const linhas = [
        { k: "Receita Líquida", a: safeNum(prev?.receita_liquida), b: safeNum(cur?.receita_liquida) },
        { k: "CMV/CPV", a: safeNum(prev?.cmv_cpv), b: safeNum(cur?.cmv_cpv) },
        { k: "Desp. Admin", a: safeNum(prev?.despesas_admin), b: safeNum(cur?.despesas_admin) },
        { k: "Lucro Líquido (proxy)", a: safeNum(prev?.lucro_liquido), b: safeNum(cur?.lucro_liquido) },
      ];

      const rows = linhas.map((x) => {
        const d = x.b - x.a;
        const p = deltaPct(x.b, x.a);
        return [x.k, `R$ ${safeMoney(x.a)}`, `R$ ${safeMoney(x.b)}`, `R$ ${safeMoney(d)}`, p === null ? "—" : safePct(p)];
      });

      st = drawParagraph(
        pdfDoc,
        fonts,
        st,
        `Comparação direta: ${safeText(prev?.period)} -> ${safeText(cur?.period)}.`,
        PAGE_X,
        95,
        10
      );
      st.y -= 8;

      st = drawTable(pdfDoc, fonts, st, {
        x: PAGE_X,
        w: PAGE_W,
        colPercents: [28, 18, 18, 18, 18],
        header: ["Indicador", "Anterior", "Atual", "Delta", "Delta %"],
        rows,
        fontSize: 9,
        rowHeight: 18,
      });

      st.y -= 6;
      st = drawCallout(
        pdfDoc,
        fonts,
        st,
        "Interpretação",
        "Se despesas crescem mais rápido que a receita, a margem tende a cair. A priorização deve seguir Pareto (top gastos) + ranking de variações.",
        PAGE_X,
        PAGE_W
      );
    } else {
      st = drawParagraph(
        pdfDoc,
        fonts,
        st,
        "— Para análise horizontal é necessário pelo menos 2 períodos (ex.: T1 e T2).",
        PAGE_X,
        95,
        10
      );
    }
  }

  // ---------- 6) Rankings (Ativo/Passivo/Variações) ----------
  {
    const title = "6. Rankings & Concentração";
    let st = addNewPage(pdfDoc, fonts, title);
    st.title = title;

    const rankings = pack?.rankings ?? null;

    const topAtivo = Array.isArray(rankings?.topSaldosAtivo) ? rankings.topSaldosAtivo : [];
    const topPassivo = Array.isArray(rankings?.topSaldosPassivo) ? rankings.topSaldosPassivo : [];
    const topVar = Array.isArray(rankings?.topVariacoes) ? rankings.topVariacoes : [];

    st = drawParagraph(
      pdfDoc,
      fonts,
      st,
      "Os rankings abaixo ajudam a identificar: (a) concentração do Ativo/Passivo e (b) contas que mais mudaram entre o primeiro e o último período.",
      PAGE_X,
      95,
      10
    );
    st.y -= 8;

    st = drawParagraph(pdfDoc, fonts, st, "Top 10 — Ativo (saldo)", PAGE_X, 95, 10);
    st.y -= 6;
    if (topAtivo.length) {
      st = drawTable(pdfDoc, fonts, st, {
        x: PAGE_X,
        w: PAGE_W,
        colPercents: [12, 58, 15, 15],
        header: ["Código", "Descrição", "Período", "Valor"],
        rows: topAtivo.slice(0, 10).map((x: any) => [
          safeText(x?.code ?? "—"),
          safeText(x?.description ?? "—"),
          safeText(x?.period ?? "—"),
          `R$ ${safeMoney(x?.value)}`,
        ]),
        fontSize: 8.6,
        rowHeight: 18,
      });
    } else {
      st = drawParagraph(pdfDoc, fonts, st, "— (Sem ranking de Ativo nesta execução.)", PAGE_X, 95, 10);
    }

    st.y -= 8;
    st = drawParagraph(pdfDoc, fonts, st, "Top 10 — Passivo (saldo)", PAGE_X, 95, 10);
    st.y -= 6;
    if (topPassivo.length) {
      st = drawTable(pdfDoc, fonts, st, {
        x: PAGE_X,
        w: PAGE_W,
        colPercents: [12, 58, 15, 15],
        header: ["Código", "Descrição", "Período", "Valor"],
        rows: topPassivo.slice(0, 10).map((x: any) => [
          safeText(x?.code ?? "—"),
          safeText(x?.description ?? "—"),
          safeText(x?.period ?? "—"),
          `R$ ${safeMoney(x?.value)}`,
        ]),
        fontSize: 8.6,
        rowHeight: 18,
      });
    } else {
      st = drawParagraph(pdfDoc, fonts, st, "— (Sem ranking de Passivo nesta execução.)", PAGE_X, 95, 10);
    }

    st.y -= 8;
    st = drawParagraph(pdfDoc, fonts, st, "Top 15 — Maiores variações (primeiro -> último período)", PAGE_X, 95, 10);
    st.y -= 6;
    if (topVar.length) {
      st = drawTable(pdfDoc, fonts, st, {
        x: PAGE_X,
        w: PAGE_W,
        colPercents: [45, 15, 15, 12, 13],
        header: ["Conta", "De", "Para", "Delta", "Delta %"],
        rows: topVar.slice(0, 15).map((x: any) => [
          safeText(x?.description ?? x?.code ?? "—"),
          safeText(x?.from ?? "—"),
          safeText(x?.to ?? "—"),
          `R$ ${safeMoney(x?.delta)}`,
          x?.deltaPct === null || x?.deltaPct === undefined ? "—" : safePct(x?.deltaPct),
        ]),
        fontSize: 8.4,
        rowHeight: 18,
      });
    } else {
      st = drawParagraph(pdfDoc, fonts, st, "— (Sem variações disponíveis nesta execução.)", PAGE_X, 95, 10);
    }

    st.y -= 6;
    st = drawCallout(
      pdfDoc,
      fonts,
      st,
      "Como usar na redução de custos",
      "1) Olhe o Pareto (Top Gastos), 2) valide se as contas também aparecem no ranking de variações, 3) priorize as de maior impacto e maior crescimento.",
      PAGE_X,
      PAGE_W
    );
  }

  // ---------- 7) Distribuição (Ativo/Passivo/DRE) ----------
  {
    const title = "7. Distribuição por Grupo (foto do período mais recente)";
    let st = addNewPage(pdfDoc, fonts, title);
    st.title = title;

    const dist = pack?.distribuicaoGrupos ?? null;

    if (!dist) {
      st = drawParagraph(pdfDoc, fonts, st, "— (Sem distribuição de grupos disponível.)", PAGE_X, 95, 10);
    } else {
      st = drawParagraph(
        pdfDoc,
        fonts,
        st,
        "Esta seção mostra os totais por grupo (Ativo, Passivo, DRE) calculados a partir do último período processado.",
        PAGE_X,
        95,
        10
      );
      st.y -= 8;

      st = drawTable(pdfDoc, fonts, st, {
        x: PAGE_X,
        w: PAGE_W,
        colPercents: [40, 60],
        header: ["Grupo", "Total (R$)"],
        rows: [
          ["ATIVO", `R$ ${safeMoney(dist?.ATIVO)}`],
          ["PASSIVO", `R$ ${safeMoney(dist?.PASSIVO)}`],
          ["DRE", `R$ ${safeMoney(dist?.DRE)}`],
        ],
        fontSize: 10,
        rowHeight: 20,
      });

      st.y -= 6;
      st = drawCallout(
        pdfDoc,
        fonts,
        st,
        "Nota",
        "A interpretação contábil detalhada depende da estrutura do plano de contas e do método de apresentação do balancete. Use esta seção como visão de consistência.",
        PAGE_X,
        PAGE_W
      );
    }
  }

  // ---------- 8) Narrativa (mais humano) ----------
  if (narrativa?.resumoExecutivo || (narrativa?.alertas?.length ?? 0) || (narrativa?.checklist?.length ?? 0)) {
    const title = "8. Diagnóstico Narrativo (baseado no MVP)";
    let st = addNewPage(pdfDoc, fonts, title);
    st.title = title;

    if (narrativa?.resumoExecutivo) {
      st = drawParagraph(pdfDoc, fonts, st, "Resumo executivo:", PAGE_X, 95, 10);
      st.y -= 4;
      st = drawParagraph(pdfDoc, fonts, st, narrativa.resumoExecutivo, PAGE_X, 95, 10);
      st.y -= 8;
    }

    const alertas = Array.isArray(narrativa?.alertas) ? narrativa.alertas : [];
    if (alertas.length) {
      st = drawParagraph(pdfDoc, fonts, st, "Alertas (prioridade):", PAGE_X, 95, 10);
      st.y -= 4;
      st = drawBulletList(pdfDoc, fonts, st, alertas.slice(0, 20), PAGE_X, 95, 10);
      st.y -= 6;
    }

    const checklist = Array.isArray(narrativa?.checklist) ? narrativa.checklist : [];
    if (checklist.length) {
      st = drawParagraph(pdfDoc, fonts, st, "Checklist acionável:", PAGE_X, 95, 10);
      st.y -= 4;
      st = drawBulletList(pdfDoc, fonts, st, checklist.slice(0, 24), PAGE_X, 95, 10);
    }

    st.y -= 6;
    st = drawCallout(
      pdfDoc,
      fonts,
      st,
      "Nota",
      "A narrativa é gerada com base nos KPIs, rankings e Pareto do período mais recente (sem inventar números).",
      PAGE_X,
      PAGE_W
    );
  }

  // ---------- 9) Seções (do composer + com gráficos) ----------
  const chartMap = params.charts ?? {};
  for (const sec of report.sections.slice(0, 10)) {
    const title = `9. ${sec.title || "Seção"}`;
    let st = addNewPage(pdfDoc, fonts, title);
    st.title = title;

    st = drawParagraph(pdfDoc, fonts, st, "Insight (baseado no painel):", PAGE_X, 95, 10);
    st.y -= 4;
    st = drawParagraph(pdfDoc, fonts, st, sec.insight, PAGE_X, 95, 10);
    st.y -= 8;

    st = drawParagraph(pdfDoc, fonts, st, "Por que isso importa:", PAGE_X, 95, 10);
    st.y -= 4;
    st = drawParagraph(pdfDoc, fonts, st, sec.whyItMatters, PAGE_X, 95, 10);
    st.y -= 10;

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
      st = drawParagraph(pdfDoc, fonts, st, "Gráfico:", PAGE_X, 95, 10);
      st.y -= 6;

      // garante espaço para o gráfico
      st = ensureSpace(pdfDoc, fonts, st, 260);

      const maxW = PAGE_W;
      const maxH = 220;

      const dims = img.scale(1);
      const scale = Math.min(maxW / dims.width, maxH / dims.height);

      const w = dims.width * scale;
      const h = dims.height * scale;

      st.page.drawRectangle({
        x: PAGE_X,
        y: st.y - h - 10,
        width: maxW,
        height: h + 18,
        color: rgb(0.97, 0.97, 0.97),
        borderColor: rgb(0.85, 0.85, 0.85),
        borderWidth: 1,
      });
      st.page.drawImage(img, { x: PAGE_X + (maxW - w) / 2, y: st.y - h, width: w, height: h });

      st.y = st.y - h - 22;
    }

    st = drawCallout(pdfDoc, fonts, st, "Recomendação", sec.recommendation, PAGE_X, PAGE_W);
  }

  // ---------- 10) Benchmarks ----------
  {
    const title = "10. Benchmarks & Contexto de Mercado (fontes públicas)";
    let st = addNewPage(pdfDoc, fonts, title);
    st.title = title;

    const items = Array.isArray(report.benchmarks?.items) ? report.benchmarks.items : [];
    st = drawParagraph(pdfDoc, fonts, st, "Benchmarks sugeridos (comparativos):", PAGE_X, 95, 10);
    st.y -= 4;
    st = drawBulletList(pdfDoc, fonts, st, items.slice(0, 14), PAGE_X, 95, 10);

    st.y -= 8;
    st = drawParagraph(pdfDoc, fonts, st, "Fontes:", PAGE_X, 95, 10);
    st.y -= 4;

    const sources = Array.isArray(report.benchmarks?.sources) ? report.benchmarks.sources : [];
    const listed = sources.slice(0, 14);

    if (!listed.length) {
      st = drawParagraph(pdfDoc, fonts, st, "— (Sem fontes retornadas nesta execução.)", PAGE_X, 95, 10);
    } else {
      for (const s of listed) {
        const line = `${safeText(s.title)} — ${safeText(s.url)}`;
        st = drawParagraph(pdfDoc, fonts, st, line, PAGE_X, 95, 9);
        st.y -= 2;
      }
    }

    st.y -= 6;
    st = drawCallout(
      pdfDoc,
      fonts,
      st,
      "Nota importante",
      "Benchmarks variam por setor, porte e região. Use como referência inicial e valide com comparáveis diretos.",
      PAGE_X,
      PAGE_W
    );
  }

  // ---------- 11) Plano 30/60/90 ----------
  {
    const title = "11. Plano de Ação — 30 / 60 / 90 dias";
    let st = addNewPage(pdfDoc, fonts, title);
    st.title = title;

    st = drawParagraph(pdfDoc, fonts, st, "30 dias (impacto rápido):", PAGE_X, 95, 11);
    st.y -= 4;
    st = drawBulletList(pdfDoc, fonts, st, report.actionPlan?.d30 ?? [], PAGE_X, 95, 10);
    st.y -= 6;

    st = drawParagraph(pdfDoc, fonts, st, "60 dias (consolidação):", PAGE_X, 95, 11);
    st.y -= 4;
    st = drawBulletList(pdfDoc, fonts, st, report.actionPlan?.d60 ?? [], PAGE_X, 95, 10);
    st.y -= 6;

    st = drawParagraph(pdfDoc, fonts, st, "90 dias (estrutura):", PAGE_X, 95, 11);
    st.y -= 4;
    st = drawBulletList(pdfDoc, fonts, st, report.actionPlan?.d90 ?? [], PAGE_X, 95, 10);

    st.y -= 6;
    st = drawCallout(
      pdfDoc,
      fonts,
      st,
      "Como executar",
      "Operação semanal: medir -> agir -> revisar. Priorize Top 3 do Pareto + itens que mais variaram no período.",
      PAGE_X,
      PAGE_W
    );
  }

  // ---------- 12) Apêndice — Pareto ----------
  {
    const title = "Apêndice A — Pareto (Top Gastos)";
    let st = addNewPage(pdfDoc, fonts, title);
    st.title = title;

    const top = Array.isArray(pack?.top) ? pack.top : [];
    const top20 = top.slice(0, 20);

    if (!top20.length) {
      st = drawParagraph(pdfDoc, fonts, st, "— (Sem Pareto/topGastos disponível neste job)", PAGE_X, 95, 10);
    } else {
      st = drawTable(pdfDoc, fonts, st, {
        x: PAGE_X,
        w: PAGE_W,
        colPercents: [10, 65, 25],
        header: ["#", "Conta / Item", "Valor (abs)"],
        rows: top20.map((it: any, i: number) => {
          const label = safeText(it?.label ?? it?.description ?? it?.key ?? `Item ${i + 1}`);
          const val = it?.value ?? it?.valor ?? it?.total ?? null;
          return [`${i + 1}`, label, `R$ ${safeMoney(val)}`];
        }),
        fontSize: 9,
        rowHeight: 18,
      });
    }

    st.y -= 6;
    st = drawCallout(
      pdfDoc,
      fonts,
      st,
      "Dica prática",
      "Use o Pareto para priorizar ações: reduzir custo total focando nos itens de maior impacto.",
      PAGE_X,
      PAGE_W
    );
  }

  // ---------- ✅ Apêndice — Reconciliação (Evidências do Balancete) ----------
  {
    const evidence = pack?.kpiEvidence?.reconciliacao;
    if (Array.isArray(evidence) && evidence.length) {
      for (const bloco of evidence.slice(0, 8)) {
        const title = `Apêndice B — Reconciliação: ${safeText(bloco?.indicador)}`;
        let st = addNewPage(pdfDoc, fonts, title);
        st.title = title;

        st = drawParagraph(pdfDoc, fonts, st, safeText(bloco?.regra), PAGE_X, 95, 10);
        st.y -= 8;

        const linhas = Array.isArray(bloco?.linhas) ? bloco.linhas : [];
        if (!linhas.length) {
          st = drawParagraph(pdfDoc, fonts, st, "— (Sem linhas de evidência neste período.)", PAGE_X, 95, 10);
        } else {
          st = drawTable(pdfDoc, fonts, st, {
            x: PAGE_X,
            w: PAGE_W,
            colPercents: [18, 52, 12, 18],
            header: ["Classif.", "Descrição", "Col.", "Valor"],
            rows: linhas.slice(0, 24).map((ln: any) => [
              safeText(ln?.classification ?? "—"),
              safeText(ln?.description ?? "—"),
              safeText(ln?.col ?? "—"),
              `R$ ${safeMoney(ln?.value ?? null)}`,
            ]),
            fontSize: 8.4,
            rowHeight: 18,
          });
        }

        st.y -= 6;
        st = drawCallout(
          pdfDoc,
          fonts,
          st,
          "Nota de integridade",
          "Este apêndice existe para auditoria: as linhas acima são o 'de onde veio' do indicador, para o relatório ficar nível TCC.",
          PAGE_X,
          PAGE_W
        );
      }
    }
  }

  // ---------- Apêndice final — Referências (seed docs + market fontes) ----------
  {
    const title = "Apêndice C — Referências (seed docs / mercado)";
    let st = addNewPage(pdfDoc, fonts, title);
    st.title = title;

    st = drawParagraph(pdfDoc, fonts, st, "Seed docs (trechos usados como base conceitual):", PAGE_X, 95, 10);
    st.y -= 4;

    const hits = Array.isArray(theoryHits) ? theoryHits : [];
    if (!hits.length) {
      st = drawParagraph(pdfDoc, fonts, st, "— (Sem hits seed docs nesta execução.)", PAGE_X, 95, 10);
    } else {
      const rows = hits.slice(0, 12).map((h: any) => [
        safeText(h?.docKey ?? "—"),
        safeText(h?.title ?? "—"),
        safeText(h?.score ?? "—"),
        safeText(h?.preview ?? "—"),
      ]);

      st = drawTable(pdfDoc, fonts, st, {
        x: PAGE_X,
        w: PAGE_W,
        colPercents: [18, 18, 10, 54],
        header: ["DocKey", "Título", "Score", "Preview"],
        rows,
        fontSize: 7.6,
        rowHeight: 18,
      });
    }

    st.y -= 6;
    st = drawParagraph(pdfDoc, fonts, st, "Fontes de mercado (quando retornadas pelo /api/market):", PAGE_X, 95, 10);
    st.y -= 4;

    const srcs = Array.isArray(report.benchmarks?.sources) ? report.benchmarks.sources : [];
    if (!srcs.length) {
      st = drawParagraph(pdfDoc, fonts, st, "— (Sem fontes de mercado nesta execução.)", PAGE_X, 95, 10);
    } else {
      for (const s of srcs.slice(0, 18)) {
        st = drawParagraph(pdfDoc, fonts, st, `${safeText(s.title)} — ${safeText(s.url)}`, PAGE_X, 95, 9);
        st.y -= 2;
      }
    }

    st.y -= 6;
    st = drawCallout(
      pdfDoc,
      fonts,
      st,
      "Observação",
      "As referências ajudam a contextualizar conceitos e benchmarks. Os números do relatório continuam sendo apenas os do balancete processado.",
      PAGE_X,
      PAGE_W
    );
  }

  const bytes = await pdfDoc.save();
  const filename = `relatorio_pricetax_${run.jobId}.pdf`;
  return { bytes, filename };
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const jobId = searchParams.get("jobId");

    const built = await buildPdfBytes({ jobId });

    if ((built as any)?.error) {
      const e = built as any;
      return NextResponse.json({ ok: false, error: e.error }, { status: e.status });
    }

    const ok = built as any;
    return new NextResponse(Buffer.from(ok.bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${ok.filename}"`,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Falha ao gerar PDF." }, { status: 500 });
  }
}

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

    if ((built as any)?.error) {
      const e = built as any;
      return NextResponse.json({ ok: false, error: e.error }, { status: e.status });
    }

    const ok = built as any;
    return new NextResponse(Buffer.from(ok.bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${ok.filename}"`,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Falha ao gerar PDF." }, { status: 500 });
  }
}
