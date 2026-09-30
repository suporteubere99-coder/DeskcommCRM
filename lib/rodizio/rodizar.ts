/**
 * Rodízio diário de retorno: inscreve 20 contatos por número, um por slot de 45
 * minutos entre 7h e 22h, com uma das 10 frases em rotação.
 *
 * POR QUE EXISTE UM JOB E NÃO SÓ A INSCRIÇÃO
 *
 * A inscrição do follow-up é UMA mensagem: o fluxo `Rodizio frase N` é
 * `trigger -> action -> end`. Ela entrega a frase e morre — não há como a mesma
 * inscrição mandar amanhã, e o `repeat` (que repetiria) consome a inscrição
 * inteira para o mesmo contato no mesmo dia, que é o oposto do desejado.
 *
 * Então o que se repete é a INSCRIÇÃO, uma vez por dia, às 7h. Este módulo é
 * essa etapa. Sem ele o rodízio entrega um dia e cala — que é o defeito que
 * o dono reportou.
 *
 * A ROTAÇÃO
 *
 * Não é aqui: dentro do fluxo `Rodizio 45min` as 10 frases já estão em
 * sequência, separadas por 45 min, e quem escolhe qual o cliente recebe é o
 * ciclo do grafo. A ordem das inscrições não muda o texto — muda QUEM recebe.
 *
 * A BASE INTEIRA, SEM REPETIR
 *
 * O corte é por `not exists`: um contato que já recebeu hoje não entra de novo.
 * A base inteira é coberta em rodadas de 80 (20 × 4 números) e o ciclo segue
 * para quem ainda não recebeu, indefinidamente — que é o "não pode parar até
 * terminar a base" do dono.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { instanteDe } from "@/lib/agenda/fuso";
import { logger } from "@/lib/logger";

/** Minutos entre um envio e o próximo no mesmo número. */
export const INTERVALO_MIN = 45;
/** Clientes por número por dia. 20 × 45min = 15h, que é a janela 7h–22h. */
export const CLIENTES_POR_NUMERO = 20;
/** Abertura do dia, HORA DE PAREDE no fuso do dono. */
const HORA_ABERTURA = 7;
/**
 * O fuso do dono. O container roda em UTC (`TZ: UTC` no compose) e `setHours(7)`
 * escrevia 7h UTC — 4h da manhã em Brasília, e o slot caía fora da janela que a
 * própria função calculava. A conversão de hora de parede é a de
 * `lib/agenda/fuso.ts`, que já trata horário de verão.
 */
const FUSO = "America/Sao_Paulo";

export interface ResultadoDoRodizio {
  /** Inscrições criadas nesta rodada. */
  inscritas: number;
  /** Contatos que já receberam hoje e foram pulados. */
  jaReceberam: number;
  /** Números sem base elegível. */
  numerosSemBase: number;
  /** Erro por número, se houve. */
  erros: string[];
}

/**
 * 7h do dia de `agora`, no fuso do dono, como INSTANTE.
 *
 * Não é `setHours`: o container é UTC, e as 7h dele são 4h em Brasília. O dia
 * também não pode vir de `getDate()` (UTC) — no fim do dia em São Paulo a data
 * local já é a seguinte, e a abertura cairia no dia errado.
 */
function inicioDoDiaEm(agora: Date): Date {
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: FUSO,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(agora);
  const [ano, mes, dia] = local.split("-").map(Number) as [number, number, number];
  return instanteDe({ ano, mes, dia, hora: HORA_ABERTURA, minuto: 0 }, FUSO);
}

/**
 * Inscreve a rodada do dia. Idempotente por dia: rodar duas vezes no mesmo dia
 * não duplica ninguém, porque o corte é sobre a inscrição viva.
 */
export async function rodarRodizioDiario(admin: SupabaseClient): Promise<ResultadoDoRodizio> {
  const agora = new Date();
  const abertura = inicioDoDiaEm(agora);

  // Só inscreve antes de a janela fechar. Depois das 22h não há slot honesto
  // e a inscrição seria uma mentira: o follow-up cairia fora da janela e o
  // motor adiaria para o dia seguinte, TODOS no mesmo minuto.
  const fimDaJanela = new Date(abertura.getTime() + 15 * 60 * 60_000);
  if (agora >= fimDaJanela) {
    return { inscritas: 0, jaReceberam: 0, numerosSemBase: 0, erros: [] };
  }

  const { data: org } = await admin
    .from("organizations")
    .select("id, settings")
    .limit(1)
    .maybeSingle();
  if (!org) {
    return { inscritas: 0, jaReceberam: 0, numerosSemBase: 0, erros: ["organizacao ausente"] };
  }
  const orgId = org.id as string;

  // O fluxo ÚNICO. Ausente ou inativo = o dono mexeu na tela; a rodada não
  // inscreve ninguém em vez de recriar o fluxo por baixo, que é decisão dele.
  const { data: fluxo, error: erroFluxo } = await admin
    .from("followup_flow_pointers")
    .select("id, active_version_id, status")
    .eq("organization_id", orgId)
    .eq("name", "Rodizio 45min")
    .maybeSingle();
  if (erroFluxo || !fluxo) {
    return { inscritas: 0, jaReceberam: 0, numerosSemBase: 0, erros: ["fluxo do rodizio ausente"] };
  }
  if (fluxo.status !== "active") {
    return { inscritas: 0, jaReceberam: 0, numerosSemBase: 0, erros: [`fluxo ${fluxo.status}`] };
  }

  const { data: numeros, error: erroNumeros } = await admin
    .from("channel_sessions")
    .select("id, phone_number")
    .eq("organization_id", orgId)
    .eq("status", "WORKING")
    .order("created_at", { ascending: true })
    .limit(4);
  if (erroNumeros || !numeros || numeros.length === 0) {
    return { inscritas: 0, jaReceberam: 0, numerosSemBase: 0, erros: ["nenhum numero WORKING"] };
  }

  // IDEMPOTÊNCIA DO DIA. Rodar a rota duas vezes (retry do cron, deploy no
  // meio da manhã, clique duplo) não pode dobrar o volume: 72 inscrições viram
  // 144 e o número leva duas mensagens para o mesmo cliente no mesmo slot.
  // `rodizio_candidatos_do_dia` já exclui quem tem inscrição VIVA, mas as 72
  // do dia anterior estão `completed` — mortas para o índice único e vivas para
  // o propósito. O corte é por `started_at` no DIA, que é a unidade real do
  // rodízio.
  const inicioDoDia = abertura.toISOString();
  const fimDoDia = new Date(abertura.getTime() + 15 * 60 * 60_000).toISOString();

  // Quem tem slot HOJE fica de fora. O corte é por `next_eval_at` — o horário em
  // que a mensagem SAI. Filtrar por `started_at` não serve: ele é o MESMO
  // campo que grava o slot, não o momento da inscrição, então não distingue
  // "inscrito hoje" de "inscrito ontem para o slot de hoje" — e a segunda
  // rodada do dia mandava a mesma pessoa duas vezes.
  const { data: jaHoje } = await admin
    .from("followup_enrollments")
    .select("contact_id")
    .eq("organization_id", orgId)
    .gte("next_eval_at", inicioDoDia)
    .lt("next_eval_at", fimDoDia);
  const jaReceberamHoje = new Set((jaHoje ?? []).map((r) => r.contact_id as string));

  const resultado: ResultadoDoRodizio = {
    inscritas: 0,
    jaReceberam: 0,
    numerosSemBase: 0,
    erros: [],
  };

  for (const num of numeros) {
    // Candidatos elegíveis que NÃO têm inscrição viva hoje. O índice único
    // `idx_followup_enrollments_one_live` é por contato na organização inteira:
    // é o slot único anti-spam, e inscribed-lo por fluxo burlaria a proteção.
    const { data: candidatos, error: erroCand } = await admin.rpc("rodizio_candidatos_do_dia", {
      p_org: orgId,
      p_sessao: num.id,
      p_limite: CLIENTES_POR_NUMERO,
    });
    if (erroCand) {
      resultado.erros.push(`numero ${num.phone_number}: ${erroCand.message}`);
      continue;
    }
    const lista = (candidatos ?? []) as Array<{ id: string; conversation_id: string }>;
    if (lista.length === 0) {
      resultado.numerosSemBase++;
      continue;
    }

    // Quem JÁ recebeu hoje sai da lista, com a contagem à parte: um contato
    // que voltou para a base não pode receber duas vezes no mesmo dia.
    const elegiveis = lista.filter((c) => !jaReceberamHoje.has(c.id));
    resultado.jaReceberam += lista.length - elegiveis.length;
    if (elegiveis.length === 0) {
      resultado.numerosSemBase++;
      continue;
    }

    // O corte do dia (acima, `jaReceberamHoje`) e o do slot são DIFERENTES
    // defeitos e os dois são necessários:
    //
    // · o do dia impede que a MESMA pessoa receba duas vezes na mesma janela;
    // · o do slot impede que DOIS contatos diferentes levem mensagem no mesmo
    //   minuto do mesmo número — que é a rajada que queima o número. Medido:
    //   a segunda rodada do dia reescreveu os mesmos 20 slots e cada um ficou
    //   com duas mensagens, e a última vazou para 00:15 do dia seguinte.
    //
    // Por isso os slots são contados do que JÁ EXISTE, não do zero: a rodada da
    // manhã ocupa 0..19, a da tarde continua em 20..39, e assim por diante até
    // a janela fechar. Quando os 20 slots do dia estão tomados, a rodada devolve
    // zero e o próximo dia recomeça em 7h.
    // Os slots JÁ OCUPADOS neste número hoje. É o que impede duas mensagens no
    // mesmo minuto: sem isto a segunda rodada do dia reescreve a mesma grade e
    // cada slot vira duas mensagens — a rajada que queima o número.
    //
    // A consulta é por NÚMERO (`p_sessao`), não global: os quatro números têm
    // a mesma grade de horários, e um filtro global faria o número das 7h achar
    // que o slot das 7h já foi tomado por outro número — que é o caso, e não
    // pode ser o critério.
    const { data: ocupadas } = await admin.rpc("rodizio_slots_ocupados", {
      p_org: orgId,
      p_sessao: num.id,
      p_inicio: inicioDoDia,
      p_fim: fimDoDia,
    });
    const slotsOcupados = new Set<number>(
      ((ocupadas ?? []) as Array<{ next_eval_at: string }>).map((o) =>
        new Date(o.next_eval_at).getTime(),
      ),
    );

    const slotsLivres: number[] = [];
    for (let s = 0; s < CLIENTES_POR_NUMERO; s++) {
      const instante = abertura.getTime() + s * INTERVALO_MIN * 60_000;
      if (instante <= agora.getTime()) continue;
      if (instante >= fimDaJanela.getTime()) break;
      if (slotsOcupados.has(instante)) continue;
      slotsLivres.push(s);
    }
    if (slotsLivres.length === 0) {
      resultado.numerosSemBase++;
      continue;
    }

    let SLOT = 0;
    for (const cand of elegiveis) {
      if (SLOT >= slotsLivres.length) break;
      const slot = slotsLivres[SLOT++]!;
      const quando = new Date(abertura.getTime() + slot * INTERVALO_MIN * 60_000);
      slotsOcupados.add(quando.getTime());

      const { error } = await admin.from("followup_enrollments").insert({
        organization_id: orgId,
        pointer_id: fluxo.id,
        version_id: fluxo.active_version_id,
        contact_id: cand.id,
        conversation_id: cand.conversation_id,
        current_node_id: "inicio",
        status: "active",
        next_eval_at: quando.toISOString(),
        started_at: quando.toISOString(),
        updated_at: new Date().toISOString(),
      });
      if (error) {
        resultado.erros.push(`numero ${num.phone_number} slot ${slot}: ${error.message}`);
        continue;
      }
      resultado.inscritas++;
    }
  }

  logger.info("rodizio diario rodada", {
    organization_id: orgId,
    inscritas: resultado.inscritas,
    numeros_sem_base: resultado.numerosSemBase,
    erros: resultado.erros.length,
  });

  return resultado;
}