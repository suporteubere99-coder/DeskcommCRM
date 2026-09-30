/**
 * POST /api/v1/webhooks/misticpay
 *
 * Recebe a notificação de depósito da MisticPay (docs.misticpay.com,
 * "Webhook de Depósito") e abre aviso na Central quando o Pix cai.
 *
 * POR QUE EXISTE
 *
 * A MisticPay avisa por POST quando o status da transação muda. Sem ninguém
 * recebendo, o único jeito de o DONO descobrir que recebeu R$ 380 é o cliente
 * mandar mensagem perguntando — e aí o agente responde "já que caiu, começo a
 * produção" para alguém que ainda não tinha visto o Pix. A venda fecha, a
 * entrega depende de uma pessoa, e a pessoa não foi avisada.
 *
 * O que este arquivo NÃO faz, e é deliberado:
 *
 *  - NÃO marca a conta como paga. O estado de verdade é `/transactions/check`
 *    da MisticPay; aqui só chega a NOTIFICAÇÃO. Um POST é reenviado, chega
 *    duplicado e chega fora de ordem — por isso a transação é reconfirmada
 *    contra a API antes de qualquer escrita.
 *  - NÃO entrega a conta, não promete horário e não chama ninguém. Ele não
 *    tem como. A produção é humana e começa na videochamada.
 *  - NÃO confia no valor do corpo. O corpo diz quanto recebeu; a API diz o que
 *    foi cobrado. O valor vem da API, e o corpo fica fora da decisão.
 *
 * ⚠️ POR QUE NÃO HÁ HMAC AQUI
 *
 * A documentação da MisticPay, inteira, não descreve assinatura de webhook:
 * não há HMAC, não há segredo de webhook, não há header de assinatura. Ela
 * só diz que o POST vai para a URL configurada. Inventar um header que o
 * provedor não manda daria false sense of security: a checagem passaria
 * sempre.
 *
 * A autenticação, então, é o que dá para ter de verdade:
 *
 *  1. O segredo vai na URL (path token), como o projeto já faz nas webhooks de
 *     canal — só quem tem o link chega aqui.
 *  2. O POST é sempre reconfirmado contra a API com a credencial do dono
 *     (`MISTICPAY_CLIENT_ID`/`SECRET`). Um intruso que descubra a URL
 *     consegue FALAR com a central, mas não consegue criar pagamento
 *     fantasma: a transação tem de existir e ter o estado que a API disser.
 *
 * Se a MisticPay um dia passar a assinar, o ponto de entrada é este arquivo —
 * não a tool, nem o banco.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { consultarPagamento, pagamentoConfirmado } from "@/lib/mcp/pix/misticpay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** O corpo da MisticPay. Tudo opcional: é terceiro, e terceiro muda. */
const corpoDaMisticpay = z
  .object({
    transactionId: z.union([z.string(), z.number()]).transform(String).optional(),
    transactionType: z.string().optional(),
    transactionMethod: z.string().optional(),
    clientName: z.string().optional(),
    clientDocument: z.string().optional(),
    status: z.string().optional(),
    value: z.number().optional(),
    fee: z.number().optional(),
    e2e: z.string().optional(),
    ispb: z.string().nullable().optional(),
    bankName: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * A organização dona da integração.
 *
 * NUNCA vem do corpo. Uma webhook chega sem sessão; se a organização fosse lida
 * do payload, qualquer POST criaria aviso na conta de quem mandou. O vínculo é
 * a PRÓPRIA CREDENCIAL: a chave vive nesta instalação, e a instalação tem uma
 * organização. `/users/info` confirma que a credencial responde, mas devolve
 * nome/e-mail do titular — que não é identificador de tenant, e casar por
 * e-mail ou nome seria adivinhar (e o `document` é o CPF do titular, que já
 * gravamos como pagador, não um id de organização).
 *
 * A credencial não é compartilhada entre organizações: uma chave por instalação.
 * Logo, resolver a organização pela instalação é o vínculo exato, e a
 * confirmação pela API é o que prova que a chave é válida.
 */
async function organizacaoDaCredencial(): Promise<string | null> {
  const id = (process.env.MISTICPAY_CLIENT_ID ?? "").trim();
  const secret = (process.env.MISTICPAY_CLIENT_SECRET ?? "").trim();
  const key = (process.env.MISTICPAY_API_KEY ?? "").trim();
  const auth = key
    ? key.startsWith("Basic ")
      ? key
      : `Basic ${key}`
    : id && secret
      ? `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`
      : "";
  if (!auth) return null;

  // Prova que a credencial responde. Sem isto, qualquer string no .env
  // resolveria uma organização e a rota viraria um gravador de avisos livre.
  const res = await fetch("https://api.misticpay.com/api/users/info", {
    headers: { Authorization: auth },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { data?: { email?: string } };
  if (!json.data?.email) return null;

  const org = (process.env.MISTICPAY_ORGANIZATION_ID ?? "").trim();
  if (!org) return null;

  // Confere que a organização existe. `id` não é uuid-formatado aqui de
  // propósito: a coluna é uuid e o cast do Postgres já valida.
  const admin = createAdminClient();
  const { data } = await admin.from("organizations").select("id").eq("id", org).maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

/** Compara o token do path com o do `.env` em tempo constante. */
function tokenConfere(envolvido: string, esperado: string): boolean {
  if (!esperado) return false;
  const a = createHash("sha256").update(envolvido).digest();
  const b = createHash("sha256").update(esperado).digest();
  return timingSafeEqual(a, b);
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await ctx.params;
  const esperado = (process.env.MISTICPAY_WEBHOOK_TOKEN ?? "").trim();
  if (!tokenConfere(token, esperado)) {
    // 404 e não 401: URL errada não confirma que o endpoint existe.
    return NextResponse.json({ ok: false }, { status: 404 });
  }

  let cru: unknown;
  try {
    cru = await req.json();
  } catch {
    return NextResponse.json({ ok: false, motivo: "corpo_ilegivel" }, { status: 400 });
  }
  const parse = corpoDaMisticpay.safeParse(cru);
  if (!parse.success) return NextResponse.json({ ok: false, motivo: "corpo_invalido" }, { status: 400 });
  const corpo = parse.data;

  const transactionId = (corpo.transactionId ?? "").trim();
  if (!transactionId) return NextResponse.json({ ok: false, motivo: "sem_transaction_id" }, { status: 400 });

  const orgId = await organizacaoDaCredencial();
  if (!orgId) {
    logger.error("[misticpay-webhook] organizacao da credencial nao resolvida");
    return NextResponse.json({ ok: false, motivo: "org_desconhecida" }, { status: 200 });
  }

  // 1. RECONFIRMA contra a API. A notificação é pista; a API é o estado.
  let estadoApi: string;
  let valor: number;
  try {
    const tx = await consultarPagamento(transactionId);
    estadoApi = tx.transactionState ?? "";
    // `check` devolve em REAIS (medido) — o corpo manda 455 (centavos), e usar
    // o corpo aqui anunciaria R$ 4,55 quando o cliente pagou R$ 380.
    valor = Number(tx.value ?? 0);
  } catch (erro) {
    logger.warn("[misticpay-webhook] transacao nao reconfirmavel", {
      transaction_id: transactionId,
      motivo: erro instanceof Error ? erro.message : String(erro),
    });
    return NextResponse.json({ ok: false, motivo: "nao_confirmavel" }, { status: 200 });
  }

  if (!pagamentoConfirmado(estadoApi)) {
    // PENDENTE, FALHA, CANCELADO: nada a fazer. A central não recebe ruído.
    return NextResponse.json({ ok: true, aberto: false, estado: estadoApi });
  }

  // 2. Idempotência: a MisticPay reenvia, e o aviso precisa ser UM.
  //
  // `ref_id` é UUID e o `transactionId` do provedor é TEXTO ("wh-mkffjp",
  // "301124932.60430735"). Gravar o id direto no `ref_id` faria o INSERT
  // estourar em runtime — ou seja, a primeira vez que um Pix entrasse DE VERDE,
  // no pior momento, e ninguém veria o aviso. O id vai no texto do aviso, que
  // é onde o humano procura de qualquer forma, e o desempate da repetição usa o
  // hash determinístico abaixo.
  const marca = createHash("sha256")
    .update(`${orgId}:${transactionId}`)
    .digest("hex")
    .slice(0, 32);
  const refUuid = `${marca.slice(0, 8)}-${marca.slice(8, 12)}-${marca.slice(12, 16)}-${marca.slice(16, 20)}-${marca.slice(20, 32)}`;

  const admin = createAdminClient();
  let aberto = false;
  try {
    const { data, error } = await admin
      .from("agent_inbox_items")
      .insert({
        organization_id: orgId,
        kind: "other",
        severity: "critical",
        title: `Pix de R$ ${valor.toFixed(2)} entrou — chamar o cliente`,
        body:
          `O Pix da transação ${transactionId} foi confirmado. ` +
          `A conta só entra em produção depois disso, e a entrega é por VIDEOCHAMADA: ` +
          `o cliente entra com o login, faz a selfie ao vivo e já sai pra trabalhar. ` +
          `Quem chama é a equipe — o agente não agenda nem liga.`,
        ref_kind: "misticpay_transaction",
        ref_id: refUuid,
      })
      .select("id");
    // `error` e não exceção: o cliente do supabase devolve o erro no corpo da
    // resposta, e ler só o throw deixaria um INSERT recusado como "abriu".
    if (error) {
      logger.error("[misticpay-webhook] aviso nao abriu", {
        transaction_id: transactionId,
        motivo: error.message,
      });
    } else {
      aberto = (data?.length ?? 0) > 0;
    }
  } catch (erro) {
    logger.error("[misticpay-webhook] aviso lancou", {
      transaction_id: transactionId,
      motivo: erro instanceof Error ? erro.message : String(erro),
    });
  }

  if (aberto) logger.info("[misticpay-webhook] aviso de Pix aberto", { transaction_id: transactionId, valor });
  return NextResponse.json({ ok: true, aberto, valor });
}
