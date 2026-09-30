import { describe, it, expect } from "vitest";

import { INTERVALO_MIN, CLIENTES_POR_NUMERO } from "./rodizar";

/**
 * A grade do rodízio: 20 slots por número, um a cada 45 min, dentro da janela
 * de 15h. Estes números são a PROMESSA que o dono fez ao cliente — mudá-los
 * muda o volume sem ninguém perceber.
 */
describe("a grade do rodízio", () => {
  it("cabe na janela de 7h às 22h", () => {
    const duracaoHoras = (CLIENTES_POR_NUMERO * INTERVALO_MIN) / 60;
    // 20 x 45min = 15h, que é exatamente a janela. Um slot a mais, e o último
    // cairia depois das 22h — o dono foi explícito: 7h às 22h.
    expect(duracaoHoras).toBe(15);
  });

  it("não deixa o último slot passar das 22h", () => {
    const ultimoMinuto = 7 * 60 + (CLIENTES_POR_NUMERO - 1) * INTERVALO_MIN;
    const hora = Math.floor(ultimoMinuto / 60);
    const minuto = ultimoMinuto % 60;
    expect(hora).toBe(21);
    expect(minuto).toBe(15);
  });

  it("mantém 45 minutos entre um envio e o seguinte", () => {
    expect(INTERVALO_MIN).toBe(45);
  });

  it("cobre a base em rodadas de 80 (20 x 4 números)", () => {
    // A base é 1.575 clientes: ~20 dias de rodízio. Este número é o que o
    // dono usa para decidir se aumenta o ritmo.
    expect(CLIENTES_POR_NUMERO * 4).toBe(80);
  });
});
