/**
 * Capacidades de COMÉRCIO e PRIVACIDADE — o que o cliente comprou, o que existe
 * à venda, e quem pediu para sair.
 *
 * Ver `docs/handoffs/BRIEFING-ia-360.md` §4 para o contrato dos campos.
 */
import { declararTools } from "./tipos";

export const TOOLS_COMERCIO = declararTools([
  {
    name: "crm_list_contact_orders",
    category: "read",
    rotulo: "Ver as compras do cliente",
    explicacao:
      "Mostra o que este cliente já comprou, quanto pagou e como está a entrega, para o assistente não prometer prazo no escuro nem repetir uma oferta já aceita.",
    oQueToca: "Compras do cliente",
    risco: "seguro",
    pacotes: ["vender", "atender"],
  },
  {
    name: "crm_search_products",
    category: "read",
    rotulo: "Procurar produto na loja",
    explicacao:
      "Procura um produto no catálogo da loja e devolve o preço exato e o que está disponível, para o assistente responder com o valor cadastrado em vez de estimar.",
    oQueToca: "Catálogo da loja",
    risco: "seguro",
    pacotes: ["vender", "atender"],
  },
  {
    name: "crm_draft_proposal",
    category: "write",
    rotulo: "Rascunhar proposta comercial",
    explicacao:
      "Cria um rascunho de proposta a partir do que foi combinado na conversa — uma pessoa sempre revisa e envia depois, e pode editar antes de despachar.",
    oQueToca: "Propostas comerciais",
    risco: "atencao",
    pacotes: ["vender"],
    capacidade: "propostas",
  },
  {
    name: "crm_preparar_proposta",
    category: "read",
    rotulo: "Preparar a proposta com o cliente",
    explicacao:
      "Mostra os modelos de proposta da empresa, diz o que perguntar ao cliente antes de rascunhar e lista os campos que o modelo escolhido pede, para a proposta nascer completa.",
    oQueToca: "Propostas comerciais",
    risco: "seguro",
    pacotes: ["vender"],
    capacidade: "propostas",
  },
  {
    name: "crm_list_privacy_requests",
    category: "read",
    rotulo: "Ver pedidos de privacidade",
    explicacao:
      "Mostra quem pediu para exportar ou apagar os próprios dados e qual o prazo, para o assistente parar de insistir com quem pediu para sair.",
    oQueToca: "Privacidade e dados do cliente",
    risco: "seguro",
    pacotes: ["organizar", "atender"],
  },
  {
    name: "crm_create_pix_charge",
    category: "write",
    rotulo: "Gerar a cobrança Pix para o cliente",
    explicacao:
      "Cria a cobrança Pix no valor combinado e envia o código copia e cola direto para o cliente, numa mensagem separada. Não pede CPF nem nenhum dado do cliente. O assistente não escreve o código por conta própria: um código reescrito deixa de pagar.",
    oQueToca: "Cobrança e pagamento do cliente",
    risco: "critico",
    pacotes: ["vender"],
  },
  {
    name: "crm_check_pix_payment",
    category: "read",
    rotulo: "Conferir se o Pix foi pago",
    explicacao:
      "Consulta no banco se o pagamento da cobrança Pix caiu. O assistente só confirma o pagamento ao cliente depois que esta consulta responde que sim.",
    oQueToca: "Cobrança e pagamento do cliente",
    risco: "seguro",
    pacotes: ["vender"],
  },
  {
    name: "crm_send_voice_message",
    category: "write",
    rotulo: "Falar com o cliente por áudio",
    explicacao:
      "Manda um áudio na voz configurada para o assistente, para quando o cliente preferir ouvir. Se não houver áudio configurado, o assistente avisa e responde por texto — nunca inventa uma voz.",
    oQueToca: "Conversa com o cliente",
    risco: "atencao",
    pacotes: ["atender", "vender"],
  },
]);
