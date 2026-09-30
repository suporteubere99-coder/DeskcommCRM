import { describe, it, expect } from "vitest";
import { z } from "zod";

import { pickToolsFromMcp } from "./tools";
import { allTools } from "@/lib/mcp/tools";

/**
 * O modelo não sabe o id da conversa em que está, e inventa a sentinela
 * `00000000-…`. Medido em produção: `crm_create_pix_charge` recebeu esse id,
 * a cobrança foi criada e o código não foi enviado — a cliente cobrou duas
 * vezes e ouviu "já te mando em seguida" duas vezes.
 *
 * A conversa do turno é do RUNTIME, nunca do argumento do modelo.
 */
const CONVERSA_DO_TURNO = "3f9a1c22-7b4e-4a1d-9e33-5c8b2a7d0e11";
const SENTINELA = "00000000-0000-0000-0000-000000000000";

function montar(conversationId: string | undefined) {
  const supabase = {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    }),
  };
  return pickToolsFromMcp({
    supabase: supabase as never,
    ctx: {
      organizationId: "org-1",
      role: "ai_operator",
      actor: { type: "ai_agent", id: "a1", agent_id: "a1", role: "ai_operator", api_token_id: "t1" },
      apiTokenId: "t1",
      requestId: "job-1",
      supabase: supabase as never,
      ...(conversationId ? { conversationId } : {}),
    },
    auth: { organizationId: "org-1", role: "ai_operator", scopes: ["mcp:read", "mcp:write", "actor:ai_agent"], actor: { type: "ai_agent", id: "a1", agent_id: "a1", role: "ai_operator", api_token_id: "t1" }, apiTokenId: "t1" },
    toolIds: ["crm_create_pix_charge"],
    handoffToolEnabled: false,
    handoffSignal: { triggered: false },
    modulosLigados: [],
    capacidadesLigadas: [],
    pipelineIds: ['00000000-0000-4000-8000-00000000cafe'],
    ...(conversationId ? { conversationId } : {}),
  } as never);
}

describe("conversa do turno na fronteira da tool", () => {
  it("substitui a sentinela do modelo pela conversa do turno", async () => {
    const tools = montar(CONVERSA_DO_TURNO);
    const tool = tools.crm_create_pix_charge as unknown as {
      execute?: (a: unknown) => Promise<unknown>;
    };
    expect(tool.execute).toBeTypeOf("function");

    // O que o handler RECEBE — capturado sem chamar a MisticPay.
    let recebido: Record<string, unknown> | undefined;
    const def = allTools.find((t) => t.name === "crm_create_pix_charge")!;
    const handlerOriginal = def.handler;
    def.handler = (async (input: unknown) => {
      recebido = input as Record<string, unknown>;
      return { ok: true, codigo_enviado: true };
    }) as typeof def.handler;

    try {
      const saida = (await tool.execute!({
        conversation_id: SENTINELA,
        valor_reais: 380,
        nome_pagador: "Andrieli",
        enviar_ao_cliente: false,
      })) as unknown;
      if (recebido === undefined) {
        throw new Error("handler nao foi chamado; o execute devolveu: " + JSON.stringify(saida));
      }
    } finally {
      def.handler = handlerOriginal;
    }

    // A hygiene tira a sentinela; a injeção preenche com o id do turno.
    expect(recebido).toBeDefined();
    expect(recebido!.conversation_id).toBe(CONVERSA_DO_TURNO);
  });

  it("preenche o campo quando o modelo simplesmente omite", async () => {
    const tools = montar(CONVERSA_DO_TURNO);
    const tool = tools.crm_create_pix_charge as unknown as {
      execute?: (a: unknown) => Promise<unknown>;
    };
    let recebido: Record<string, unknown> | null = null;
    const def = allTools.find((t) => t.name === "crm_create_pix_charge")!;
    const handlerOriginal = def.handler;
    def.handler = (async (input: unknown) => {
      recebido = input as Record<string, unknown>;
      return { ok: true, codigo_enviado: true };
    }) as typeof def.handler;
    try {
      await tool.execute!({ valor_reais: 380, nome_pagador: "Andrieli", enviar_ao_cliente: false });
    } finally {
      def.handler = handlerOriginal;
    }
    expect(recebido!.conversation_id).toBe(CONVERSA_DO_TURNO);
  });

  it("NÃO troca a conversa quando não há turno de conversa (rota HTTP, automações)", async () => {
    const tools = montar(undefined);
    const tool = tools.crm_create_pix_charge as unknown as {
      execute?: (a: unknown) => Promise<unknown>;
    };
    let recebido: Record<string, unknown> | null = null;
    const def = allTools.find((t) => t.name === "crm_create_pix_charge")!;
    const handlerOriginal = def.handler;
    def.handler = (async (input: unknown) => {
      recebido = input as Record<string, unknown>;
      return { ok: true, codigo_enviado: true };
    }) as typeof def.handler;
    const minha = "8c2f5a10-1b3d-4e77-9a55-2d0e6f4b8c93";
    try {
      await tool.execute!({ conversation_id: minha, valor_reais: 380, nome_pagador: "Ana" });
    } finally {
      def.handler = handlerOriginal;
    }
    // Sem conversa do turno, o id do chamador é o certo e precisa passar intacto.
    expect(recebido!.conversation_id).toBe(minha);
  });

  it("a tool de Pix declara conversation_id no schema (a precondição da injeção)", () => {
    const def = allTools.find((t) => t.name === "crm_create_pix_charge")!;
    expect(Object.keys(def.inputSchema)).toContain("conversation_id");
  });
});