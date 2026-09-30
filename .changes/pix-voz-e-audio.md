---
impacto: exige_acao
secao: adicionado
titulo: Cobrança Pix, voz do dono e áudio do cliente
---

O agente passou a poder cobrar por Pix, responder em áudio com a voz do dono e
entender o áudio que o cliente manda.

- **Cobrar Pix** — o assistente gera a cobrança e envia o código copia e cola
  direto para o cliente, em mensagem separada. Nenhum dado do cliente é pedido:
  o documento do pagador é o do titular da conta. Ele também confere se o
  pagamento caiu, e só confirma ao cliente depois que a consulta responde que
  sim.
- **Responder em áudio** — com a voz clonada no ElevenLabs, no mesmo tom do
  atendimento por texto.
- **Entender áudio do cliente** — a transcrição deixa de depender de uma chave
  da OpenAI e passa a usar o serviço de transcrição configurado na instalação.

### ⚠️ Requer atenção

Configure estas chaves no `.env` da instalação, senão as novas capacidades ficam
desligadas (a cobrança e a voz **recusam** em vez de cair num serviço errado):

```
MISTICPAY_CLIENT_ID=          # painel MisticPay → API → Chaves de Acesso
MISTICPAY_CLIENT_SECRET=
MISTICPAY_PAYER_DOCUMENT=     # CPF/CNPJ do TITULAR da conta (o recebedor)
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=          # a voz CLONADA (category "cloned" em /v1/voices)
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
```

Para a transcrição, `TRANSCRIPTION_BASE_URL` + `TRANSCRIPTION_MODEL` +
`TRANSCRIPTION_API_KEY` pointando para um endpoint `/audio/transcriptions`
compatível com o da OpenAI. Sem isso, a transcrição segue com o padrão de antes.

Para a visão, ligue o ponto "Ver foto" a um modelo com suporte a imagem — a
instalação deste CRM já está assim.

**Depois de configurar, ligue as ferramentas novas aos agentes** (tela do agente →
ferramentas): `crm_create_pix_charge`, `crm_check_pix_payment` e
`crm_send_voice_message`. Sem isso o agente não as enxerga, mesmo com o código
publicado.

**Sobre a cobrança:** a cobrança só é liberada quando o valor gravado no código
Pix bate com o valor combinado. Se o provedor devolver um código com outro
valor, a ferramenta **recusa** de enviar e registra o motivo — enviar um código
com valor errado faria o cliente pagar fora do combinado. Se isso começar a
aparecer, é o provedor, e vale abrir chamado com ele.
