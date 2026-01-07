// src/app/api/market/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function pickString(x: any) {
  const s = String(x ?? "").trim();
  return s;
}

function stripHtml(s: string) {
  return String(s ?? "")
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// extrai resultados do HTML do DuckDuckGo
function extractLinksFromDuckDuckGo(html: string) {
  const out: Array<{ title: string; url: string }> = [];

  const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const url = String(m[1] || "").trim();
    const title = stripHtml(m[2] || "").trim();

    if (!url || !title) continue;
    if (url.startsWith("/")) continue;
    if (url.includes("duckduckgo.com")) continue;

    out.push({ title: title.slice(0, 120), url });
    if (out.length >= 10) break;
  }

  return out;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const q = pickString(searchParams.get("q"));
    if (!q) return NextResponse.json({ ok: true, items: [], sources: [] }, { status: 200 });

    // DuckDuckGo HTML (melhor para trazer fontes reais)
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`;

    const res = await fetch(url, {
      cache: "no-store",
      headers: {
        "User-Agent": "Mozilla/5.0 (PriceTax-MVP)",
        Accept: "text/html",
      },
    });

    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: `Falha ao buscar mercado (HTTP ${res.status})` },
        { status: 200 }
      );
    }

    const html = await res.text();
    const sources = extractLinksFromDuckDuckGo(html);

    const items: string[] = [];
    if (!sources.length) {
      items.push("Não foi possível obter fontes públicas nesta consulta. Tente ajustar o setor/termos do benchmark.");
    } else {
      items.push("Fontes públicas coletadas para referência (valide setor/porte/região).");
    }

    return NextResponse.json(
      {
        ok: true,
        query: q,
        items: items.slice(0, 10),
        sources: sources.slice(0, 10),
      },
      { status: 200 }
    );
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Erro ao buscar mercado." }, { status: 200 });
  }
}
