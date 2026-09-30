-- Candidatos do rodízio: contatos do número que ainda NÃO receberam hoje.
--
-- Por que uma função e não um SELECT na rota: o corte é sobre a inscrição VIVA
-- do contato na organização inteira (`idx_followup_enrollments_one_live` é o slot
-- único anti-spam), e essa é a única janela em que a decisão é consistente —
-- entre "contei" e "inscrevi" outra inscrição pode entrar. Dentro de uma
-- transação a contagem e a inserção não correm separadas.
create or replace function public.rodizio_candidatos_do_dia(
  p_org uuid,
  p_sessao uuid,
  p_limite integer
)
returns table (id uuid, conversation_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, cv.id
    from contacts c
    join conversations cv
      on cv.contact_id = c.id
     and cv.organization_id = c.organization_id
   where c.organization_id = p_org
     and cv.channel_session_id = p_sessao
     and coalesce(c.force_human, false) = false
     and coalesce(c.is_blocked, false) = false
     and not exists (
       select 1
         from followup_enrollments e
        where e.contact_id = c.id
          and e.organization_id = p_org
          and e.status in ('active', 'waiting_reply')
     )
   order by c.created_at
   limit greatest(p_limite, 0);
$$;

comment on function public.rodizio_candidatos_do_dia(uuid, uuid, integer) is
  'Contatos do numero sem inscricao viva: a base inteira coberta em rodadas de 80, '
  'o mesmo contato nao entra duas vezes no mesmo dia.';

-- Slots JA OCUPADOS de um numero, dentro da janela do dia.
--
-- Por que uma segunda função, e não o filtro global: os quatro números têm a
-- MESMA grade de horários. Consultar as inscrições da organização inteira
-- diria ao número das 7h que o slot das 7h está tomado — e está, pelo número
-- ao lado. O que não pode entrar no cálculo é a mensagem de outro número: cada
-- um tem o seu ritmo, e o que queima é a rajada NO MESMO número.
create or replace function public.rodizio_slots_ocupados(
  p_org uuid,
  p_sessao uuid,
  p_inicio timestamptz,
  p_fim timestamptz
)
returns table (next_eval_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select e.next_eval_at
    from followup_enrollments e
    join conversations cv on cv.id = e.conversation_id
   where e.organization_id = p_org
     and cv.channel_session_id = p_sessao
     and e.next_eval_at >= p_inicio
     and e.next_eval_at < p_fim
     and e.status in ('active', 'waiting_reply');
$$;

comment on function public.rodizio_slots_ocupados(uuid, uuid, timestamptz, timestamptz) is
  'Slots ja tomados no MESMO numero: impede duas mensagens no mesmo minuto.';
