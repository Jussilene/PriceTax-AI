import { NextResponse } from "next/server";
import { gerarNarrativa } from "@/services/narrativa.service";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const payload = await req.json();

    const periodos = Array.isArray(payload?.periodos) ? payload.periodos : [];
    const kpisPorPeriodo =
      payload?.kpisPorPeriodo && typeof payload.kpisPorPeriodo === "object"
        ? payload.kpisPorPeriodo
        : {};
    const topGastos = Array.isArray(payload?.topGastos) ? payload.topGastos : [];

    // opcionais (se vierem, ajuda muito)
    const distribuicaoGrupos =
      payload?.distribuicaoGrupos && typeof payload.distribuicaoGrupos === "object"
        ? payload.distribuicaoGrupos
        : undefined;

    const thresholds =
      payload?.thresholds && typeof payload.thresholds === "object"
        ? payload.thresholds
        : undefined;

    // (opcional) se quiser impedir request vazio total:
    // se não quiser, pode apagar este bloco sem problema
    if (!periodos.length && !topGastos.length && !Object.keys(kpisPorPeriodo).length) {
      return NextResponse.json(
        { ok: false, error: "Payload vazio para narrativa" },
        { status: 400 }
      );
    }

    if (typeof gerarNarrativa !== "function") {
      return NextResponse.json(
        { ok: false, error: "Serviço de narrativa indisponível" },
        { status: 500 }
      );
    }

    const out = gerarNarrativa({
      periodos,
      kpisPorPeriodo,
      topGastos,
      distribuicaoGrupos,
      thresholds,
    });

    return NextResponse.json({ ok: true, ...out }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      {
        ok: false,
        error: "Falha ao gerar narrativa",
        details: String(err?.message || err),
      },
      { status: 500 }
    );
  }
}
