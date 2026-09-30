/**
 * Cliente da MisticPay — recebimento via PIX (cash-in).
 *
 * ⚠️ A CREDENCIAL NUNCA VEM DO AGENTE NEM DA CONVERSA.
 *
 * O par `pk_`/`sk_` vive no `.env` da instalação, como toda credencial de
 * terceiro. Uma tool que aceitasse chave do modelo ensinaria a chave num prompt
 * e a jogaria no log de auditoria em texto puro; o valor de `redigirParaAuditoria`
 * existe justamente para o inverso — o que a tool grava é METADADO.
 *
 * ⚠️ POR QUE O PAGADOR É O TITULAR DA CONTA, E NÃO O CLIENTE
 *
 * A MisticPay exige `payerDocument` e RECUSA a cobrança sem ele — medido nas três
 * formas: campo ausente, string vazia, e sem `payerName` (todas
 * `400 TRANSACTION_FIELDS_REQUIRED`, 2026-09-29). Logo, "não pedir CPF ao
 * cliente" não significou "não usar CPF": significou usar o do RECEBEDOR.
 *
 * `MISTICPAY_PAYER_DOCUMENT` é o CPF/CNPJ do titular e é ele que vai como
 * pagador. O cliente nunca é perguntado — o que também é o certo numa venda por
 * WhatsApp, onde pedir documento do motorista no meio do fechamento é pedir dado
 * pessoal que ele não tem motivo para entregar. A cobrança com o CPF do titular
 * foi criada de verdade e passou (`201`, `PENDENTE`).
 *
 * Contrato lido da documentação oficial (docs.misticpay.com, API v1):
 *   POST /api/transactions/create  → data.copyPaste, data.transactionState
 *   POST /api/transactions/check   → transaction.transactionState (NÃO `data`)
 *
 * `amount` é em REAIS com ponto decimal (4.55 = R$ 4,55) e a resposta do
 * `create` devolve `transactionAmount` em CENTAVOS (455). Confundir as duas
 * unidades é o erro que faz o cliente pagar R$ 0,45 em vez de R$ 4,55 — daí a
 * validação dupla abaixo.
 */

/** Resposta de `POST /transactions/create` e de `POST /transactions/check`. */
export interface MisticpayTransacao {
  transactionId: string;
  transactionState: string;
  /**
   * `/transactions/create` devolve o valor em CENTAVOS (`transactionAmount`);
   * `/transactions/check` devolve em REAIS (`value`). Os dois nomes existem
   * porque a API não é simétrica — medido nas duas rotas, 2026-09-29.
   */
  transactionAmount?: number;
  value?: number;
  transactionFee?: number;
  fee?: number;
  transactionMethod?: string;
  copyPaste?: string;
  qrCodeBase64?: string;
  qrcodeUrl?: string;
}

export interface MisticpayEnvelope<T> {
  message?: string;
  data?: T;
  transaction?: T;
  code?: string;
  error?: string;
  requestId?: string;
}

const BASE = "https://api.misticpay.com/api";

/** Estados que a MisticPay devolve. Só `COMPLETO` é pagamento recebido. */
export function pagamentoConfirmado(state: string | null | undefined): boolean {
  return (state ?? "").trim().toUpperCase() === "COMPLETO";
}

/**
 * O valor que o BANCO vai cobrar NÃO está no campo `53` deste BR Code.
 *
 * ⚠️ CORREÇÃO: EU TINHA LIDO ISSO ERRADO
 *
 * A primeira leitura mediu `53` = `986` em cobranças de 1,50 / 5 / 9,86 / 12,34
 * / 47,90 / 380 / 999,99 e concluiu que o provedor entregava valor fixo. Concluir
 * disso seria cobrar errado do cliente: o código precisa sair igual ao que veio.
 *
 * O que o `986` é, medido: o campo `53` é **decorativo** nesse provedor. O código
 * é um QRDINÂMICO — o payload `26` traz
 * `qrcode.somossimpay.com.br/v2/qr/cob/<token>`, e esse token devolve um **JWT
 * assinado (PS512)** cujo corpo é a cobrança:
 *
 *   {"valor":{"original":"380.00","modalidadeAlteracao":0},
 *    "txid":"fa0cff82…","chave":"44985279-…","status":"ATIVA", …}
 *
 * Conferido em três valores: 1,50 → `"1.50"`, 380 → `"380.00"`, 999,99 →
 * `"999.99"`. O valor enviado é o valor cobrado. `modalidadeAlteracao: 0` é o
 * que o manual do Pix chama de valor fixo, então o banco do pagador lê o
 * original — e o `986` é ruído de campo, não o preço.
 *
 * Por isso `criarCobrancaPix` NÃO barra a divergência: `986` é o estado normal
 * e esperado deste provedor, e tratá-lo como erro deixaria toda cobrança
 * recusada. A checagem de que o valor é o que foi pedido continua existindo, mas
 * no lugar certo — no `transactionAmount` que o PROVEDOR devolve, que é o mesmo
 * registro que a consulta de pagamento vai ler.
 */
export function valorCodigoPix(copyPaste: string): number | null {
  // A tag `53` é procurada pela ESTRUTURA, não pelo texto: 2 dígitos de
  // identificador + 2 dígitos de tamanho + o valor. Casar só com /53(\d{2})/
  // pegava o "53" que aparece DENTRO de outro campo e lia lixo como valor.
  for (let p = 0; p + 4 <= copyPaste.length; ) {
    const tamanho = Number(copyPaste.slice(p + 2, p + 4));
    if (!Number.isFinite(tamanho) || p + 4 + tamanho > copyPaste.length) return null;
    if (copyPaste.slice(p, p + 2) === "53") {
      const centavos = Number(copyPaste.slice(p + 4, p + 4 + tamanho));
      return Number.isFinite(centavos) ? centavos / 100 : null;
    }
    p += 4 + tamanho;
  }
  return null;
}

function credencial(): string {
  const auth = (process.env.MISTICPAY_API_KEY ?? "").trim();
  if (auth) return auth.startsWith("Basic ") ? auth : `Basic ${auth}`;
  // Aceita o par separado, para o .env poder guardar as duas metades.
  const id = (process.env.MISTICPAY_CLIENT_ID ?? "").trim();
  const secret = (process.env.MISTICPAY_CLIENT_SECRET ?? "").trim();
  if (!id || !secret) {
    throw new Error("misticpay_sem_credencial");
  }
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
}

async function chamar<T>(caminho: string, corpo: unknown): Promise<T> {
  const res = await fetch(`${BASE}${caminho}`, {
    method: "POST",
    headers: { Authorization: credencial(), "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });
  const texto = await res.text();
  let envelope: MisticpayEnvelope<T>;
  try {
    envelope = texto ? (JSON.parse(texto) as MisticpayEnvelope<T>) : {};
  } catch {
    throw new Error(`misticpay_resposta_ilegivel_${res.status}`);
  }
  if (!res.ok) {
    // A mensagem da MisticPay é a ÚNICA fonte do motivo real (ex.:
    // TRANSACTION_FIELDS_REQUIRED, saldo insuficiente, CPF inválido). Devolver
    // "erro 400" ao modelo o deixaria tentando combinações no escuro.
    const motivo = envelope.message ?? envelope.error ?? envelope.code ?? `http_${res.status}`;
    throw new Error(`misticpay_${motivo}`);
  }
  if (!envelope.data) throw new Error("misticpay_resposta_sem_data");
  return envelope.data;
}

/** Documento do pagador: SEMPRE o titular da conta (CPF ou CNPJ, só dígitos). */
function documentoDoTitular(): string {
  return (process.env.MISTICPAY_PAYER_DOCUMENT ?? "").replace(/\D/g, "");
}

export interface CriarCobrancaArgs {
  /** Valor em REAIS, com ponto decimal: 380, 380.5, 380.55. */
  valorReais: number;
  /** Nome do pagador como aparece na cobrança. É o do cliente. */
  nomePagador: string;
  /** Identificador da transação na NOSSA aplicação. */
  referencia: string;
  descricao: string;
  /** URL que a MisticPay chama quando o pagamento muda de estado. */
  webhook?: string;
}

export async function criarCobrancaPix(args: CriarCobrancaArgs): Promise<MisticpayTransacao> {
  // Validação ANTES da chamada: a MisticPay arredonda e a divergência silenciosa
  // (mandar 380.555 e cobrar 380.55) é o tipo de erro que só se descobre no
  // extrato do cliente, dias depois.
  if (!Number.isFinite(args.valorReais) || args.valorReais <= 0) {
    throw new Error("misticpay_valor_invalido");
  }
  if (Math.round(args.valorReais * 100) !== Number((args.valorReais * 100).toFixed(0))) {
    throw new Error("misticpay_valor_com_centavos");
  }
  const documento = documentoDoTitular();
  if (documento.length !== 11 && documento.length !== 14) {
    throw new Error("misticpay_titular_nao_configurado");
  }

  return chamar<MisticpayTransacao>("/transactions/create", {
    amount: Number(args.valorReais.toFixed(2)),
    payerName: args.nomePagador,
    payerDocument: documento,
    transactionId: args.referencia,
    description: args.descricao,
    ...(args.webhook ? { projectWebhook: args.webhook } : {}),
  }).then((tx) => {
    // O código é enviado byte a byte, como veio — mexer nele quebra a
    // assinatura. A conferência é sobre o VALOR, lido onde ele de fato mora:
    // o registro que o provedor devolve, que é o mesmo que a consulta de
    // pagamento vai ler mais tarde.
    const devolvido = Number(tx.transactionAmount ?? tx.value);
    if (Number.isFinite(devolvido) && Math.abs(devolvido - args.valorReais) > 0.001) {
      throw new Error("misticpay_valor_divergente_no_codigo");
    }
    return tx;
  });
}

/**
 * ⚠️ `POST /transactions/check` NÃO embrulha em `data` como o `create`.
 *
 * A documentação mostra a mesma forma para as duas rotas, mas a resposta real é
 * `{ message, transaction: {...}, metadata: {...} }` (medido 2026-09-29). Ler
 * `data` aqui devolvia `undefined` em TODOS os campos, e o agente recebia
 * "pagamento não encontrado" para uma cobrança que existia — o pior desfecho
 * possível numa venda: o cliente pagava e o assistente dizia que não pagou.
 */
export async function consultarPagamento(transactionId: string): Promise<MisticpayTransacao> {
  if (!transactionId.trim()) throw new Error("misticpay_referencia_vazia");
  const res = await fetch(`${BASE}/transactions/check`, {
    method: "POST",
    headers: { Authorization: credencial(), "Content-Type": "application/json" },
    body: JSON.stringify({ transactionId }),
  });
  const texto = await res.text();
  if (!res.ok) {
    let motivo = `http_${res.status}`;
    try {
      const env = JSON.parse(texto) as MisticpayEnvelope<unknown>;
      motivo = env.message ?? env.error ?? env.code ?? motivo;
    } catch {
      /* resposta não-JSON: fica o código HTTP */
    }
    throw new Error(`misticpay_${motivo}`);
  }
  let env: MisticpayEnvelope<MisticpayTransacao> & { transaction?: MisticpayTransacao };
  try {
    env = JSON.parse(texto) as typeof env;
  } catch {
    throw new Error("misticpay_resposta_ilegivel");
  }
  const tx = env.transaction ?? env.data;
  if (!tx) throw new Error("misticpay_transacao_nao_encontrada");
  return tx;
}
