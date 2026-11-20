# Controle da Vez

*Read in [English](README.md)*

Uma "sala de amigos" privada de **PS5 Remote Play**: um PC hospedeiro roda a sessão do console, os amigos abrem uma página web, assistem ao gameplay ao vivo, entram na fila e assumem o controle na sua vez — enviando os comandos do controle de volta pelo navegador.

Inspirado em sites de comunidade onde pessoas assistem a um console compartilhado e se revezam jogando. A motivação foi simples: *meu PS5 já está conectado via Chiaki no meu PC — por que não deixar amigos aprovados assistirem e jogarem de qualquer lugar?*

## O que ele faz

- **App web live-first** — abre direto na transmissão, cara de aplicativo, sem rolagem, otimizado pra celular (retrato e paisagem).
- **Contas só com apelido** — sem senha pros amigos. O navegador gera uma impressão digital do dispositivo (SHA-256 de características do aparelho) que vira uma identidade persistente — só pergunta o apelido uma vez.
- **Aprovação pelo admin** — dispositivos novos nascem *pendentes*. O dono aprova cada um antes de liberar chat e jogo. O admin tem um sino 🔔 na barra superior listando pendentes com aprovação em um clique; o aprovado é notificado na hora via SSE.
- **Vez e fila** — um jogador por vez controla o console. Os demais podem pedir a vez ou aguardar; quem está no controle pode passar adiante, e espectadores só assistem.
- **Chat** — liberado só pra aprovados, persistido entre reinícios, com balão de não-lidas, gaveta lateral no desktop/paisagem e bottom sheet no celular.
- **Duas formas de jogar** — controles touch estilo DualSense na tela (layout configurável, transparência, presets, some sozinho quando um controle físico conecta) ou gamepad real via Gamepad API do navegador.
- **Estado honesto** — quando o console/agente está offline a página mostra "PS5 dormindo" com botão explícito *Ligar o PS5* e a opção *assistir última live* — nunca exibe gravação como se fosse ao vivo.
- **Wake-on-LAN** — o site acorda o PS5 e abre o `chiaki stream` remotamente pelo agente.

## Arquitetura

```
                 ┌─────────────┐        Remote Play         ┌────────────────┐
                 │    PS5      │◄──────────────────────────►│  chiaki-ng      │
                 └─────────────┘                            │ (PC Windows)    │
                        ▲                                   └───────┬────────┘
                        │ ViGEm (X360 virtual)                      │ WGC + WASAPI
                        │                                           ▼
┌───────────┐  WebRTC   │                                   ┌────────────────┐
│  Jogador  │◄──────────┼────────────── 60fps + DataChannel │   agent.py     │
│ (browser) │   input   │                                   │ (aiohttp/aiortc)│
└───────────┘           │                                   └───────┬────────┘
                        │                                           │ WHIP
┌───────────┐   WHEP    │                                           ▼
│Espectadores│◄───────────────────────┐                     ┌────────────────┐
│ (browser) │    relay 720p30         │                     │    MediaMTX    │
└───────────┘                         │                     └────────────────┘
                        │                                           ▲
                        ▼                                           │
                ┌────────────────┐  HTTP/SSE  ┌────────────────┐    │
                │   App web      │───────────►│  API do agente │────┘
                │ (Node.js, SPA) │  controle  │  (porta 3001)  │
                └────────────────┘            └────────────────┘
```

- **`agent.py`** (Python, no PC do jogo) — captura a janela do chiaki-ng com **Windows Graphics Capture** (por handle de janela, arbitragem por produção real de frames), encoda H.264 via **NVENC** (`bf=0`, `tune=ull` pra baixa latência), captura o áudio do chiaki por **WASAPI process loopback**, e serve dois caminhos WebRTC:
  - um stream **direto a 60 fps** pra quem está jogando, com DataChannel levando os inputs do controle até um controle **ViGEm** X360 virtual que o chiaki repassa ao console;
  - uma publicação **WHIP** pro MediaMTX em 720p30 — um único stream público compartilhado por todos os espectadores, lido via proxy WHEP do servidor.
- **`server.js`** (Node.js, sem framework) — serve a SPA, o canal de estado via SSE, persistência de sessões/usuários/chat (JSON em `data/`), lógica de vez/fila, rota admin oculta e proxy WHEP pro MediaMTX. Única dependência: `qrcode` (doação via Pix).
- **`app.js` + `index.html` + `style.css`** — SPA sem dependências: cliente WebRTC de jogador/espectador, overlay de gamepad touch, gaveta de chat, login por fingerprint, CTA de vez, HUD de stats.
- **`admin.html`/`admin.js`** — página admin separada servida só num caminho secreto configurável (`ADMIN_PATH`), atrás de credenciais. Aprovar/bloquear/remover usuários, gerar senhas, diagnósticos. Nunca linkada na página pública.
- **`mediamtx.yml`** — config do MediaMTX: ingest WHIP restrito ao IP do agente na LAN, leitura WHEP restrita a LAN/interna (a borda pública é o proxy do Node).
- **`docker-compose.yml` + `Dockerfile`** — app web + MediaMTX em containers, estado persistido em `./data`.

### Engenharia de latência

O projeto passou por uma rodada de profiling com análise do código do chiaki e da stack WebRTC — pontos relevantes:

- O caminho de input do chiaki já é ótimo (poll de 4 ms, envio de pacote orientado a evento); o lag percebido estava todo no vidro do vídeo, então:
- `h264_nvenc` com `bf=0` + `tune=ull` (só a reordenação de B-frames custava ~66–100 ms);
- track do jogador publica a **60 fps** (o chiaki produz ~55 fps nativo; a 30 fps cada frame já nascia com o dobro de idade);
- `jitterBufferTarget`/`playoutDelayHint` reduzidos no receiver, com degradação automática de perfil quando `framesDropped` cresce;
- granularidade de timer do Windows corrigida com `timeBeginPeriod(1)` + pacing via `time.sleep` em thread (um `asyncio.sleep(33ms)` na verdade dormia ~45 ms);
- o pts da captura usa o instante real da captura — latência não acumula silenciosamente;
- o agente abre o chiaki com `--exit-app-on-stream-exit`, então uma sessão morta nunca vira janela estática enganando a arbitragem de captura.

## Requisitos

**PC do jogo (host):**
- Windows, GPU NVIDIA (usa NVENC; o encoder é trocável no `agent.py`)
- [chiaki-ng](https://streetpea.github.io/chiaki-ng/) instalado e pareado com o PS5
- Driver [ViGEm Bus](https://github.com/nefarius/ViGEmBus) pro controle X360 virtual
- Python 3.10+ com `aiohttp aiortc windows_capture numpy` (+ bindings do `vigem`)

**Servidor (qualquer Linux, ex.: LXC):**
- Docker + Docker Compose
- Opcional: coturn ou qualquer TURN pra jogadores atrás de NAT restritivo
  - `wan-watch.sh` (cron, 1×/min) mantém o `--external-ip` do coturn e o TURN entregue aos navegadores no IP público atual do host (IP dinâmico / failover de 2 WANs). A WAN precisa aceitar conexões de entrada — CGNAT não aceita.
- Opcional: proxy reverso/tunnel pra expor o site publicamente

## Como reproduzir

1. **Pareie o chiaki-ng com seu PS5** no PC host — registre o console e anote o apelido usado (`chiaki list`).
2. **MediaMTX + app web** — clone este repo no servidor, copie `.env.example` pra `.env` e preencha (credenciais admin, `AGENT_TOKEN`, `AGENT_URL`, seu canal do YouTube pro fallback "última live" se quiser). Substitua os placeholders `<…>` de `docker-compose.yml`/`mediamtx.yml` pelos valores da sua LAN e rode `docker compose up -d --build`.
3. **Agente** — no PC Windows: `python -m venv .venv && .venv\Scripts\pip install aiohttp aiortc windows_capture numpy vigem`, edite o `start-agent.ps1` (o token precisa ser o mesmo `AGENT_TOKEN` do servidor), execute. O agente escuta em `0.0.0.0:3001`.
4. **Publique o site** — aponte seu proxy reverso/tunnel pra porta do app (`3100`). Ajuste `ALLOWED_HOSTS`. Escolha um `ADMIN_PATH` não-óbvio — não existe link público pra ele, de propósito.
5. **Aprove os amigos** — a pessoa abre a página, digita um apelido e aparece como *pendente*. Você aprova pelo menu 🔔 (ou pela página admin) e ela já pode conversar e jogar.

## Notas de segurança

- Nenhum amigo vê senha — dispositivos são identificados por fingerprint e cada um é aprovado explicitamente pelo dono.
- A UI admin existe só num caminho de URL secreto e ainda exige credenciais.
- Todos os segredos (tokens, credenciais TURN, IPs de LAN, caminho admin) são variáveis de ambiente ou placeholders — mantenha assim.
- A leitura de espectadores passa pelo proxy WHEP do Node; o MediaMTX nunca precisa ser exposto publicamente.

## Status / ideias de roadmap

- Ranking persistente de tempo de jogo, lista de presença e diagnósticos já implementados.
- Próximos passos naturais: sessões agendadas, limite de tempo por usuário, gravação de sessões, overlays estilo OBS.
