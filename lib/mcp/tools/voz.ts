/**
 * `crm_send_voice_message` — falar com o cliente na voz do agente.
 *
 * O caminho é: texto -> ElevenLabs (voz configurada na instalação) -> storage
 * `whatsapp-media` -> `crm_send_whatsapp_message` com `type: "audio"`. O envio
 * NÃO é reimplementado aqui: a tool existente já sabe enviar áudio pelo WAHA
 * (com `convert: true`), e duplicar esse caminho criaria dois lugares onde o
 * número pode ser queimado por excesso de mensagens.
 *
 * ⚠️ POR QUE A TOOL DEVOLVE "não consegui" EM VEZ DE FALAR COM OUTRA VOZ
 *
 * Sem chave ou sem `ELEVENLABS_VOICE_ID`, gerar com uma voz genérica mandaria
 * um áudio que não é o salesperson ao cliente que negociou com ele. O texto
 * honesto é sempre melhor que a voz errada.
 */
import { z } from "zod";

import { gerarVoz, VozNaoConfiguradaError } from "@/lib/messaging/media/voz-elevenlabs";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { crmSendWhatsappMessage } from "./messages";
import type { McpToolDefinition } from "../types";

const inputShape = {
  conversation_id: z.string().uuid(),
  /**
   * O que será FALADO, na voz do agente. Escreva como fala, não como e-mail:
   * o modelo tem as regras de tamanho de mensagem e de não repetir o que já
   * disse — o áudio obedece às mesmas.
   */
  texto: z.string().trim().min(1).max(3000),
  idempotency_key: z.string().min(1).max(200).optional(),
};

export const crmSendVoiceMessage: McpToolDefinition<typeof inputShape> = {
  name: "crm_send_voice_message",
  description:
    "Manda um ÁUDIO para o cliente na voz do agente. Use quando o cliente preferir " +
    "ouvir, quando ele mandou áudio, ou quando a resposta é curta e a voz deixa " +
    "mais natural que texto. Escreva o texto do áudio de forma falada. Se a voz " +
    "não estiver disponível, a ferramenta avisa — nesse caso responda por texto, " +
    "nunca diga que enviou áudio. Não repita em áudio o que acabou de mandar por texto.",
  inputSchema: inputShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  redigirParaAuditoria: (args) => ({
    conversation_id: args.conversation_id,
    // O texto falado é PII do cliente (o que ele combinou, endereço, valor).
    // A auditoria guarda metadado, nunca o conteúdo.
    caracteres: String(args.texto ?? "").length,
  }),
  handler: async (input, ctx) => {
    let voz;
    try {
      voz = await gerarVoz(input.texto);
    } catch (err) {
      const motivo = err instanceof Error ? err.message : String(err);
      if (err instanceof VozNaoConfiguradaError) {
        logger.warn("[voz] voz não configurada na instalação", { motivo });
        return {
          ok: false,
          enviado: false,
          motivo,
          mensagem: "Não tenho áudio configurado nesta instalação. Responda por texto.",
        };
      }
      logger.error("[voz] falha ao gerar áudio", { motivo });
      return {
        ok: false,
        enviado: false,
        motivo,
        mensagem: `Não consegui gerar o áudio (${motivo}). Responda por texto e não diga que mandou áudio.`,
      };
    }

    // Storage: o WAHA precisa de uma URL alcançável, e o bucket é o mesmo que
    // recebe a mídia do cliente. O caminho inclui a organização e a conversa
    // para duas organizações nunca colidirem no mesmo objeto.
    const caminho = `${ctx.organizationId}/voz/${input.conversation_id}/${Date.now()}.mp3`;
    const admin = createAdminClient();
    const up = await admin.storage
      .from("whatsapp-media")
      .upload(caminho, voz.audio, { contentType: voz.mime, upsert: false });
    if (up.error) {
      logger.error("[voz] falha ao subir o áudio", { erro: up.error.message });
      return {
        ok: false,
        enviado: false,
        motivo: "falha_no_storage",
        mensagem: "Consegui gerar o áudio mas não consegui anexá-lo. Responda por texto.",
      };
    }

    // URL assinada: a mídia é do cliente e o bucket é privado. A URL assinada
    // expira, e é isso que o WAHA precisa — ele baixa imediatamente.
    const { data: assinada, error: erroAssinatura } = await admin.storage
      .from("whatsapp-media")
      .createSignedUrl(caminho, 600);
    if (erroAssinatura || !assinada?.signedUrl) {
      logger.error("[voz] falha ao assinar a URL do áudio", { erro: erroAssinatura?.message });
      return {
        ok: false,
        enviado: false,
        motivo: "falha_na_url",
        mensagem: "Não consegui preparar o áudio para envio. Responda por texto.",
      };
    }

    // Reusa a tool de envio: ela tem o freio anti-ban do número, a
    // deduplicação e o caminho do WAHA já testados.
    const enviado = await crmSendWhatsappMessage.handler(
      {
        conversation_id: input.conversation_id,
        type: "audio" as const,
        media_url: assinada.signedUrl,
        media_mime: voz.mime,
        ...(input.idempotency_key ? { idempotency_key: input.idempotency_key } : {}),
      },
      ctx,
    );

    return {
      ok: true,
      enviado: true,
      bytes: voz.audio.length,
      storage_path: caminho,
      resultado: enviado,
    };
  },
};
