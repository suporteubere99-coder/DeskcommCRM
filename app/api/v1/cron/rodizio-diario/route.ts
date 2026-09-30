/**
 * GET/POST /api/v1/cron/rodizio-diario — inscreve a rodada do dia do rodízio de
 * retorno (20 clientes por número, um a cada 45 min, das 7h às 22h).
 *
 * Roda por volta das 7h, todo dia. A lógica mora em `lib/rodizio/rodizar.ts`;
 * esta rota só autentica, chama e audita **quando houve efeito** — mesmo
 * critério de `campaign-worker`.
 *
 * Por que cron e não inscrição viva: ver o cabeçalho de `lib/rodizio/rodizar.ts`.
 *
 * NOTA DE DEPLOY: não há `vercel.json` neste repo (self-host). O agendamento
 * vive no serviço `scheduler` do `docker-compose.prod.yml`
 * (`docker/scheduler/entrypoint.sh`).
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { rodarRodizioDiario } from "@/lib/rodizio/rodizar";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const r = await rodarRodizioDiario(createAdminClient());

  // Rodada que não inscreveu ninguém não é mutação e não ocupa auditoria.
  if (r.inscritas > 0 || r.erros.length > 0) {
    void audit({
      action: "cron.rodizio_diario",
      requestId,
      bypassedRls: true,
      metadata: {
        inscritas: r.inscritas,
        ja_receberam: r.jaReceberam,
        numeros_sem_base: r.numerosSemBase,
        erros: r.erros.slice(0, 5),
      },
    });
  }

  return ok({ ...r, requestId });
}

export const GET = handle;
export const POST = handle;
