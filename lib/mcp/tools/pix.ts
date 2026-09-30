/**
 * Tools de PIX — cobrar o cliente e conferir se o pagamento caiu.
 *
 * O agente chama `crm_create_pix_charge` quando o cliente fecha a compra e
 * `crm_check_pix_payment` depois. Os nomes são contrato de wire: o prompt do
 * agente os chama textualmente, e trocar a string quebra a conversa.
 *
 * ⚠️ NADA DE DOCUMENTO DO CLIENTE É PEDIDO
 *
 * A MisticPay exige `payerDocument` e recusa a cobrança sem ele (medido: campo
 * ausente, string vazia e sem `payerName` dão `400 TRANSACTION_FIELDS_REQUIRED`).
 * Ele é preenchido com `MISTICPAY_PAYER_DOCUMENT`, o documento do TITULAR da
 * conta — o recebedor. O cliente nunca é perguntado, o que numa venda por
 * WhatsApp é o correto: pedir CPF do motorista no meio do fechamento é pedir
 * dado pessoal que ele não tem motivo para entregar.
 *
 * ⚠️ POR QUE ESTA TOOL ENVIA O CÓDIGO, E NÃO DEVOLVE PARA O MODELO
 *
 * Devolver o copia-e-cola ao modelo para ele "mandar ao cliente" punha a string
 * PIX no caminho de um reescritor de linguagem: um espaço a mais, uma quebra de
 * linha, um chunk truncado — e o código deixa de pagar. O código é enviado
 * AQUI, direto pelo mesmo caminho de `crm_send_whatsapp_message`, como mensagem
 * isolada e byte a byte. O modelo recebe a confirmação, nunca o código.
 *
 * A CREDENCIAL da MisticPay vive no `.env` da instalação e nunca entra aqui.
 */
import { z } from "zod";

import { logger } from "@/lib/logger";
import { criarCobrancaPix, consultarPagamento, pagamentoConfirmado } from "@/lib/mcp/pix/misticpay";
import { crmSendWhatsappMessage } from "./messages";
import type { McpToolDefinition } from "../types";

const inputCriar = {
  conversation_id: z.string().uuid(),
  /** Valor em REAIS: 380, 380.5. O modelo deve mandar o valor que combinou. */
  valor_reais: z.number().positive().max(100000),
  /** Nome do pagador como aparece na cobrança. É o do cliente. */
  nome_pagador: z.string().trim().min(1).max(120),
  descricao: z.string().trim().min(1).max(200).default("Pagamento da conta"),
  /**
   * Referência da transação. Vazio = gerada aqui, do id da conversa. Repetir a
   * mesma referência é o que impede cobrança duplicada quando o modelo repete a
   * chamada depois de um timeout.
   */
  referencia: z.string().trim().max(64).optional(),
  /**
   * Manda o código Pix para o cliente nesta mesma chamada. Padrão true: é o que
   * garante que o código chegue intacto. Só desligue se você mesmo for enviar
   * por outro caminho — o agente NÃO deve reescrever o código para isso.
   */
  enviar_ao_cliente: z.boolean().default(true),
};

export const crmCreatePixCharge: McpToolDefinition<typeof inputCriar> = {
  name: "crm_create_pix_charge",
  description:
    "Gera a cobrança PIX no valor combinado e ENVIA o código copia-e-cola para o cliente " +
    "nesta mesma chamada. Chame quando o cliente confirmar que quer fechar e você já " +
    "tiver o valor exato. Não precisa pedir CPF, endereço nem nenhum dado do cliente. " +
    "Depois que o cliente disser que pagou, confira com crm_check_pix_payment — nunca " +
    "confirme o pagamento antes disso. NÃO escreva o código Pix por conta própria: ele já " +
    "foi enviado por esta ferramenta, e reescrever o código faz ele deixar de funcionar.",
  inputSchema: inputCriar,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  motivoDoVazio: (r) => (r && (r as { ok?: boolean }).ok === false ? String((r as { motivo?: string }).motivo ?? "") : null),
  redigirParaAuditoria: (args) => ({
    conversation_id: args.conversation_id,
    valor_reais: args.valor_reais,
    descricao: args.descricao,
    referencia: args.referencia,
    // nome_pagador e dado pessoal: a auditoria guarda METADADO, nunca conteúdo.
  }),
  handler: async (input, ctx) => {
    // ── A CONVERSA, quando o handler sabe qual é ───────────────────────────
    //
    // `conversation_id` chega do modelo, e o modelo não tem como saber o id da
    // conversa atual: ele inventa a sentinela `00000000-…`. O runtime já
    // substitui esse valor na fronteira (`lib/ai/runtime/tools.ts`), e esta
    // linha é a rede debaixo dele — o código do Pix é entregue na conversa que
    // este id aponta, e mandá-lo para a errada é cobrar a pessoa errada sem que
    // ela perceba. Fora do turno do agente (rota HTTP, automações) não há
    // conversa do turno, e o id do argumento segue sendo o único disponível.
    const conversationId = ctx.conversationId ?? input.conversation_id;
    const referencia =
      input.referencia?.trim() || `crm-${conversationId}-${Date.now().toString(36)}`;

    try {
      const tx = await criarCobrancaPix({
        valorReais: input.valor_reais,
        nomePagador: input.nome_pagador,
        referencia,
        descricao: input.descricao,
        ...(process.env.MISTICPAY_WEBHOOK_URL
          ? { webhook: process.env.MISTICPAY_WEBHOOK_URL }
          : {}),
      });

      if (!tx.copyPaste) {
        logger.error("[pix] cobrança criada sem copia-e-cola", { referencia });
        return {
          ok: false,
          motivo: "sem_codigo_pix",
          mensagem:
            "A cobrança foi criada mas o código PIX não veio na resposta. Gere uma nova cobrança.",
        };
      }

      // O código é enviado AQUI, não devolvido ao modelo. A string vem byte a byte
      // da MisticPay e vai como mensagem isolada: é o que garante que não haja
      // espaço, quebra ou corte — um código alterado não paga.
      let envio: unknown = null;
      let enviada = false;
      if (input.enviar_ao_cliente) {
        // A conversa RESOLVIDA, não a do argumento: com a sentinela do modelo o
        // envio vai para a conversa `00000000-…` e o código some. É a cobrança
        // criada sem o código entregue, que é o defeito medido.
        const destino = conversationId !== input.conversation_id ? conversationId : input.conversation_id;
        if (conversationId !== input.conversation_id) {
          logger.warn("[pix] conversa do modelo substituída pela do turno", {
            modelo: input.conversation_id,
            turno: conversationId,
          });
        }
        try {
          envio = await crmSendWhatsappMessage.handler(
            {
              conversation_id: destino,
              body: tx.copyPaste,
              type: "text" as const,
              idempotency_key: `pix-codigo-${referencia}`,
            },
            ctx,
          );
          enviada = true;
        } catch (err) {
          const motivo = err instanceof Error ? err.message : String(err);
          logger.error("[pix] cobrança criada mas o código não foi enviado", { referencia, motivo });
          return {
            ok: false,
            motivo: "falha_no_envio_do_codigo",
            referencia,
            transaction_id: tx.transactionId,
            mensagem:
              "A cobrança foi criada e o código NÃO foi enviado ao cliente. Não escreva o código " +
              "por conta própria — peça para um humano enviar, ou chame de novo só para reenviar.",
          };
        }
      }

      return {
        ok: true,
        referencia,
        transaction_id: tx.transactionId,
        estado: tx.transactionState,
        valor_reais: input.valor_reais,
        codigo_enviado: enviada,
        qrcode_base64: tx.qrCodeBase64 ?? null,
        // O código NÃO volta aqui de propósito: devolvê-lo ao modelo colocaria a
        // string no caminho de um reescritor de texto.
        proximo_passo:
          "Código enviado. Diga ao cliente que a cobrança está no valor, para ele copiar, colar e pagar. " +
          "Quando ele disser que pagou, chame crm_check_pix_payment.",
        resultado_envio: envio,
      };
    } catch (err) {
      const motivo = err instanceof Error ? err.message : String(err);
      logger.error("[pix] falha ao criar cobrança", { referencia, motivo });
      // A mensagem da MisticPay volta para o modelo: sem ela ele tentaria
      // combinações no escuro (valor menor, outro CPF) e acabaria gerando
      // cobranças duplicadas ou erradas.
      return {
        ok: false,
        motivo,
        mensagem: `Não consegui gerar a cobrança: ${motivo}. Não invente um código PIX — tente de novo ou chame um humano.`,
      };
    }
  },
};

const inputChecar = {
  conversation_id: z.string().uuid(),
  /** Vazio = procura a última cobrança desta conversa. */
  referencia: z.string().trim().max(64).optional(),
  transaction_id: z.string().trim().max(64).optional(),
};

export const crmCheckPixPayment: McpToolDefinition<typeof inputChecar> = {
  name: "crm_check_pix_payment",
  description:
    "Confere se a cobrança PIX foi paga. Use APÓS o cliente dizer que pagou ou " +
    "enviar o comprovante. Retorna COMPLETO quando o dinheiro caiu e PENDENTE " +
    "enquanto o banco não confirmou. Nunca confirme ao cliente antes deste retorno.",
  inputSchema: inputChecar,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  redigirParaAuditoria: (args) => ({
    conversation_id: args.conversation_id,
    referencia: args.referencia,
    transaction_id: args.transaction_id,
  }),
  handler: async (input, ctx) => {
    const transacao = input.transaction_id ?? input.referencia;
    if (!transacao) {
      return {
        ok: false,
        motivo: "sem_referencia",
        estado: "DESCONHECIDO",
        mensagem:
          "Não sei qual cobrança checar. Gere a cobrança primeiro com crm_create_pix_charge e guarde a referência.",
      };
    }

    try {
      const tx = await consultarPagamento(transacao);
      const completo = pagamentoConfirmado(tx.transactionState);
      // `/check` devolve `value`/`fee` em REAIS (o `create` usa centavos em
      // `transactionAmount`); pegamos os dois para não exibir R$ 0,38 de R$ 380.
      const valor = tx.value ?? (tx.transactionAmount != null ? tx.transactionAmount / 100 : null);
      const taxa = tx.fee ?? (tx.transactionFee != null ? tx.transactionFee / 100 : null);
      return {
        ok: true,
        estado: completo ? "COMPLETO" : "PENDENTE",
        pago: completo,
        transaction_id: tx.transactionId,
        valor_reais: valor,
        taxa,
        mensagem: completo
          ? "Pagamento confirmado."
          : "Ainda não caiu. Diga ao cliente que está processando e para enviar o comprovante.",
      };
    } catch (err) {
      const motivo = err instanceof Error ? err.message : String(err);
      logger.error("[pix] falha ao consultar pagamento", { transacao, motivo });
      return {
        ok: false,
        estado: "ERRO",
        pago: false,
        mensagem: `Não consegui consultar o pagamento (${motivo}). Não diga ao cliente que foi pago.`,
      };
    }
  },
};
