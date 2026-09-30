/**
 * ElevenLabs — texto -> áudio na voz do agente, para enviar ao cliente.
 *
 * ⚠️ A CHAVE E A VOZ NUNCA VÊM DO MODELO.
 *
 * `crm_send_voice_message` recebe o TEXTO a falar e nada mais. A chave fica no
 * `.env` e o voice ID também: a voz é a identidade comercial de quem vende, e
 * um modelo able de trocar a voz por um argumento na conversa trocaria a voz do
 * salesperson por qualquer uma.
 *
 * Sem `ELEVENLABS_VOICE_ID` a tool NÃO gera áudio com uma voz genérica: devolve
 * um motivo explícito e o agente continua em texto. Áudio na voz errada é pior
 * que texto — o cliente ouve alguém que não é quem ele trato.
 */
import { logger } from "@/lib/logger";

export interface VozGerada {
  /** Bytes do MP3, prontos para o storage. */
  audio: Buffer;
  mime: "audio/mpeg";
}

export class VozNaoConfiguradaError extends Error {
  constructor(readonly motivo: "sem_chave" | "sem_voz") {
    super(motivo === "sem_chave" ? "elevenlabs_sem_chave" : "elevenlabs_sem_voz");
    this.name = "VozNaoConfiguradaError";
  }
}

/**
 * Teto de caracteres por chamada.
 *
 * A API do ElevenLabs recusa trecho longo, e o corte no meio de uma frase faria
 * o cliente ouvir uma cobrança pela metade — que é exatamente o tipo de erro em
 * que o cliente paga errado ou entende que o valor é outro.
 */
const MAX_CARACTERES = 3000;

export function audioConfigurado(): boolean {
  return (
    (process.env.ELEVENLABS_API_KEY ?? "").trim() !== "" &&
    (process.env.ELEVENLABS_VOICE_ID ?? "").trim() !== ""
  );
}

export async function gerarVoz(texto: string): Promise<VozGerada> {
  const apiKey = (process.env.ELEVENLABS_API_KEY ?? "").trim();
  if (!apiKey) throw new VozNaoConfiguradaError("sem_chave");
  const voiceId = (process.env.ELEVENLABS_VOICE_ID ?? "").trim();
  if (!voiceId) throw new VozNaoConfiguradaError("sem_voz");

  const limpo = (texto ?? "").replace(/\s+/g, " ").trim();
  if (!limpo) throw new Error("elevenlabs_texto_vazio");

  // Cortar em FRASE, não em caractere: dividimos no último terminador antes do
  // teto. Um áudio que termina no meio da idea é pior que nenhum.
  let fala = limpo;
  if (fala.length > MAX_CARACTERES) {
    const corte = fala.slice(0, MAX_CARACTERES);
    const ultimo = Math.max(
      corte.lastIndexOf("."), corte.lastIndexOf("!"), corte.lastIndexOf("?"), corte.lastIndexOf(","),
    );
    fala = ultimo > MAX_CARACTERES * 0.5 ? corte.slice(0, ultimo + 1) : corte;
  }

  const modelo = (process.env.ELEVENLABS_MODEL_ID ?? "").trim() || "eleven_v4";
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ model_id: modelo, text: fala }),
  });

  if (!res.ok) {
    const corpo = await res.text().catch(() => "");
    logger.error("[voz] ElevenLabs recusou a geração", { status: res.status, corpo: corpo.slice(0, 300) });
    // Voz inexistente NÃO vem como 404: a API responde 400 com
    // `invalid_uid` (medido 2026-09-29). Sem esta checagem, o erro chegava ao
    // modelo como "http_400", que não diz nada — e a voz configurada no `.env`
    // estar errada é a causa mais provável de áudio que nunca sai.
    if (res.status === 400 && /invalid_uid|voice|not found/i.test(corpo)) {
      throw new Error("elevenlabs_voz_nao_encontrada");
    }
    if (res.status === 401 || res.status === 403) throw new Error("elevenlabs_chave_invalida");
    if (res.status === 422) throw new Error("elevenlabs_texto_recusado");
    if (res.status === 429) throw new Error("elevenlabs_limite_de_uso");
    throw new Error(`elevenlabs_http_${res.status}`);
  }

  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length === 0) throw new Error("elevenlabs_audio_vazio");
  return { audio, mime: "audio/mpeg" };
}
