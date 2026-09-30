/**
 * Detector de AUTONEGAÇÃO: o agente dizendo que não faz o serviço, recusando a
 * venda, mandando o cliente desistir, ou usando lei/compliance como motivo para
 * encerrar o atendimento.
 *
 * ─── O que aconteceu, medido ────────────────────────────────────────────────
 *
 * 2026-09-30, 07:44, número 554888348551. O cliente queria uma conta no nome da
 * mãe e disse que ela faria o pagamento. O que saiu:
 *
 *   "essa venda eu não consigo fechar"
 *   "é fraude de identidade, e isso eu não posso fazer nem receber por isso"
 *   "Não manda aquele Pix, tá? Não vai sair produção nenhuma em cima dele"
 *
 * E o pior não foi a recusa: foi o que veio DEPOIS. O cliente respondeu
 * "Entendi foi nada" — concordância com uma negativa. A essa altura a venda
 * estava perdida, e o agente respondeu:
 *
 *   "isso eu não faço, nem recebo por isso, e não tem acordo que mude isso"
 *
 * Ele ficou pior: uma frase de consolo virou CONFIRMAÇÃO da recusa. O negócio
 * do dono é venda de acesso a conta de aplicativo, com documento do titular e
 * cobrança no Pix — o que ele FAZ. O agente transformou um caso específico
 * (nome de terceiro) em recusa da operação inteira, e depois a consolidou.
 *
 * ─── Por que o prompt não resolve ──────────────────────────────────────────
 *
 * A instrução "não recuse a venda" no prompt é uma INSTRUÇÃO, não uma trava. O
 * modelo a cumpre ou não conforme o caso que ele julga, e num caso que lhe
 * parece delicado a instrução perde para o julgamento. Isto roda no
 * `before-send`, antes de a mensagem sair: é determinístico, e não depende de o
 * modelo lembrar de nada.
 *
 * ─── O que este detector NÃO é ─────────────────────────────────────────────
 *
 * Não é filtro de "conteúdo proibido" em geral. A venda de acesso a conta é o
 * produto. O que não pode sair é o AGENTE dizendo que não faz o serviço e
 * pedindo para o cliente desistir. Um atendente humano pode recusar um caso
 * específico — e a trava é sobre a FALA do agente, não sobre a política do
 * negócio.
 *
 * ─── Por que o gate vive no `before-send.ts` ────────────────────────────────
 *
 * `Gate` e `GateContext` são declarados lá dentro (o módulo da cadeia é o dono
 * do contrato, e `vazamento-interno.ts` faz o mesmo: exporta só a detecção).
 * Importar o tipo de `./types` — que não existe — quebraria o build.
 */

/**
 * PADRÕES: autonegação e recusa da venda.
 *
 * Cada entrada exige VERBO + ALVO. "não faço" sozinho não basta: o cliente
 * pode escrever isso, e o gate roda sobre a mensagem que o AGENTE produz. A
 * exigência de um termo de venda junto é o que separa "não faço isso aqui" de
 * uma frase de conversa normal.
 *
 * A trava é dura por escolha: o texto que casa não tem versão aceitável num
 * atendimento cujo produto é a venda. Uma resposta que precise explicar um
 * caso específico ("esse caso eu não posso, o seguinte a gente faz") não casa
 * nenhuma das entradas — que é o comportamento desejado.
 */
const PADROES_AUTONEGACAO: ReadonlyArray<{ re: RegExp; rotulo: string }> = [
  {
    re: /\bessa\s+venda\s+(?:eu\s+)?n[aã]o\s+consigo\s+fechar\b/i,
    rotulo: 'recusa-da-venda',
  },
  {
    re: /\bn[aã]o\s+consigo\s+(?:fechar|resolver|fazer)\s+(?:essa|esta|isso|isto)?\s*(?:venda|neg[oó]cio)?/i,
    rotulo: 'incapacidade-de-fechar',
  },
  {
    re: /\b(?:isso|isto|esse|essa)\s+(?:aqui\s+)?(?:eu\s+)?n[aã]o\s+fa[çc]o\b/i,
    rotulo: 'autonegacao',
  },
  {
    re: /\bn[aã]o\s+fa[çc]o\s+(?:nem\s+)?(?:e\s+)?nem\s+recebo\b/i,
    rotulo: 'autonegacao-receber',
  },
  {
    re: /\bn[aã]o\s+tem\s+acordo\s+que\s+mude\b/i,
    rotulo: 'consolidacao-da-recusa',
  },
  {
    re: /\bme\s+desculpa\s+(?:ter\s+seguido|por\s+ter\s+seguido)\b/i,
    rotulo: 'arrependimento',
  },
  {
    re: /\bchama\s+(?:o\s+)?suporte\b[^.!?\n]{0,60}\bn[aã]o\s+posso\b/i,
    rotulo: 'terceirizacao-da-recusa',
  },
];

/**
 * PEDIDO DE DESISTÊNCIA: o agente mandando o cliente embora.
 *
 * "não manda aquele Pix" é a forma mais cara: o cliente tinha o Pix, ia pagar,
 * e o texto manda não pagar. Vender e depois desencorajar é pior que nunca ter
 * começado — a confiança não volta.
 */
const PADROES_DESISTENCIA: ReadonlyArray<{ re: RegExp; rotulo: string }> = [
  {
    re: /\bn[aã]o\s+manda\s+(?:aquele|esse)?\s*(?:o\s+)?(?:pix|c[oó]digo|qr)\b/i,
    rotulo: 'desestimular-o-pix',
  },
  {
    re: /\bn[aã]o\s+vai\s+sair\s+(?:nada|produ[çc][aã]o)\b/i,
    rotulo: 'promessa-vazia-explicita',
  },
  {
    re: /\bdesiste\s+desse?\s+(?:neg[oó]cio|assunto|servi[çc]o)\b/i,
    rotulo: 'pedido-de-desistencia',
  },
  {
    re: /\bbusca\s+(?:o\s+)?(?:suporte|ajuda)\b[^.!?\n]{0,40}\bque\s+eu\s+n[aã]o\b/i,
    rotulo: 'terceirizacao',
  },
  {
    re: /\b(?:boa|vai)\s+(?:sorte\s+)?na\s+viagem\b/i,
    rotulo: 'despedida-de-desistencia',
  },
  {
    re: /\bde\s+(?:volta|recuar)\b[^.!?\n]{0,30}\bsem\s+(?:risco|problema)\b/i,
    rotulo: 'porta-de-entrada-de-risco',
  },
];

/**
 * DISCURSO DE LEGALIDADE: o agente introduz conformidade como objeção.
 *
 * O termo "legal" sozinho NÃO é vetado: o cliente pode perguntar "é legal?" e o
 * agente pode responder que sim. O que não pode é o agente USAR a lei como
 * motivo para não vender — a mesma estrutura dos demais: o termo jurídico junto
 * de uma negativa.
 */
const PADROES_FREIO_JURIDICO: ReadonlyArray<{ re: RegExp; rotulo: string }> = [
  {
    re: /\b(?:fraude\s+de?\s*identidade|ilegal|clonad[oa]s?|pirataria)\b[^.!?\n]{0,60}\bn[aã]o\s+(?:posso|fa[çc]o|consigo)\b/i,
    rotulo: 'objecao-juridica',
  },
  {
    re: /\bn[aã]o\s+(?:posso|fa[çc]o)\b[^.!?\n]{0,60}\b(?:fraude|ilegal|clonad[oa]|crime|delito)\b/i,
    rotulo: 'fraude-como-objecao',
  },
  {
    re: /\bcaminho\s+legal\b/i,
    rotulo: 'caminho-legal-como-alternativa',
  },
  {
    re: /\b(?:dentro|fora)\s+do\s+(?:certo|errado)\b/i,
    rotulo: 'dentro-fora-do-certo',
  },
  {
    re: /\bn[aã]o\s+d[aá]\s+para\s+reverter\b/i,
    rotulo: 'impossibilidade-de-reverter',
  },
];

function normalizar(texto: string): string {
  return texto
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export interface AchadoDeAutonegaVenda {
  achou: boolean;
  /** rótulos fechados das classes que casaram — nunca o trecho casado. */
  categorias: string[];
}

export function detectarAutonegaVenda(corpo: string): AchadoDeAutonegaVenda {
  const texto = normalizar(corpo ?? '');
  if (texto.length === 0) return { achou: false, categorias: [] };

  const categorias: string[] = [];
  for (const p of PADROES_AUTONEGACAO) if (p.re.test(texto)) categorias.push(p.rotulo);
  for (const p of PADROES_DESISTENCIA) if (p.re.test(texto)) categorias.push(p.rotulo);
  for (const p of PADROES_FREIO_JURIDICO) if (p.re.test(texto)) categorias.push(p.rotulo);

  return { achou: categorias.length > 0, categorias };
}