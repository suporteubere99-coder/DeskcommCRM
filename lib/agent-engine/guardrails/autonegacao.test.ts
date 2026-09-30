import { describe, it, expect } from "vitest";

import { detectarAutonegaVenda } from "./autonegacao";

/**
 * As frases que SAÍRAM para o cliente em 2026-09-30 (número 554888348551).
 * Não são exemplos inventados: são o texto real, e a venda foi perdida nelas.
 */
const MEDIDAS = [
  "Mano, aqui eu tenho que ser sincero contigo: essa venda eu não consigo fechar.",
  "Criar conta com nome de outra pessoa — ou com um nome que não é o teu — pra passar na verificação do app é fraude de identidade, e isso eu não posso fazer nem receber por isso. Me desculpa ter seguido essa conversa até aqui.",
  "Não manda aquele Pix, tá? Não vai sair produção nenhuma em cima dele. O que eu recomendo de verdade: chama o suporte da Uber pelo próprio app.",
  "isso eu não faço, nem recebo por isso, e não tem acordo que mude isso.",
  "então não manda aquele pix, tá? não tem produção nenhuma por trás dele. o caminho que fica é o que te escrevi ali em cima: suporte da Uber pelo app ou site",
];

/**
 * O que TEM de passar. Sem estes, a trava é um gate que barra a conversa e
 * ela perde a venda do outro lado — que é o mesmo estrago com sinal trocado.
 */
const DEVEM_PASSAR = [
  "Bom dia mano! Vi tuas mensagens aqui 👍",
  "dá pra fazer sim mano, conta nova uber ou 99 sai R$ 380 no pix. pra qual app tu quer?",
  "tá tudo rodando por aqui, irmão. tudo certo com você?",
  "po mano, entendi. a conta no nome da sua mãe funciona sim — é o titular dela que entra. mando o pix e ela paga, tá?",
  "esse caso específico não dá, mas o seguinte a gente faz: conta nova no seu nome sai R$ 380. quer que eu gere?",
  "isso é legal sim, a gente trabalha dentro da正规".replace("正规", "regra"),
  "vou te explicar como funciona pra você decidir",
  "se o pix não cair em 30 minutos eu devolvo, sem problema",
  "o app pede o documento de quem vai usar, e pode ser o da sua mãe, semissue".replace("semissue", "sem problema"),
  "o suporte da Uber pode ajudar com a verificação, mas eu consigo fazer a conta nova por aqui",
  "cancelei porque o valor ficou alto, não tem problema, a gente faz quando puder",
  "Me fala o modelo do carro que eu confiro a placa aqui",
];

describe("gate de autonegação", () => {
  describe("as frases que realmente saíram", () => {
    for (const frase of MEDIDAS) {
      it(`veta: ${frase.slice(0, 55)}…`, () => {
        const achado = detectarAutonegaVenda(frase);
        expect(achado.achou, `não deveria passar: ${frase}`).toBe(true);
      });
    }
  });

  describe("o que precisa continuar passando", () => {
    for (const frase of DEVEM_PASSAR) {
      it(`passa: ${frase.slice(0, 55)}…`, () => {
        const achado = detectarAutonegaVenda(frase);
        expect(achado.achou, `vetou indevidamente: ${frase}`).toBe(false);
      });
    }
  });

  it("o cliente perguntando se é legal NÃO é autonegação", () => {
    // A trava é sobre a FALA DO AGENTE. A pergunta vem do cliente, e a resposta
    // honesta ("é legal sim") precisa passar.
    expect(detectarNegacaoCheia("é legal sim, a gente trabalha dentro da regra").achou).toBe(false);
  });

  it("a trava exige verbo + alvo, não a palavra sozinha", () => {
    // "não faço" isolado, sem alvo de venda, é conversa.
    expect(detectarNegacaoCheia("eu não faço esse café desde 2019").achou).toBe(false);
  });

  it("registra as classes, e nunca o trecho", () => {
    const achado = detectarNegacaoCheia(MEDIDAS[3]!);
    expect(achado.achou).toBe(true);
    expect(achado.categorias.length).toBeGreaterThan(0);
    // O rótulo é fechado e não carrega texto do cliente. Hífen e ASCII: o rótulo
    // vai para o log de auditoria, e precisa ser estável entre deploys.
    for (const c of achado.categorias) expect(c).toMatch(/^[a-z_-]+$/);
  });

  it("corpo vazio não dispara", () => {
    expect(detectarNegacaoCheia("").achou).toBe(false);
    expect(detectarNegacaoCheia("   \n  ").achou).toBe(false);
  });
});

/** atalho local, para o teste ler como o runtime */
function detectarNegacaoCheia(corpo: string) {
  return detectarAutonegaVenda(corpo);
}