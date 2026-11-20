#!/bin/sh
# wan-watch — mantém o TURN (coturn) no IP público de SAÍDA atual do host.
# Útil com IP dinâmico ou failover entre duas WANs: o coturn anuncia o relay
# com --external-ip; se o IP público muda, o relay passa a apontar pra um
# endereço morto e quem joga de fora fica "carregando" (ICE failed).
#
# Rode no host do coturn/site via cron, 1×/min, por exemplo:
#   * * * * * /caminho/para/controle-da-vez/wan-watch.sh
#
# Faz: 1) descobre o IP de saída; 2) se difere do --external-ip do compose
# do coturn (COTURN_COMPOSE), reescreve e recria o coturn; 3) grava
# data/net.json, que o server.js lê pra montar o iceServers (turn:<ip>).
# Observação: só funciona se a WAN ativa tiver entrada (IP público + portas
# 3478 tcp/udp e a faixa de relay encaminhadas) — CGNAT não recebe conexões.
set -u
DIR=$(cd "$(dirname "$0")" && pwd)
COTURN=${COTURN_COMPOSE:-$HOME/coturn-docker-compose.yml}
NET="$DIR/data/net.json"
LOG="$DIR/wan-watch.log"
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)

ip=""
for u in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
  cand=$(curl -fsS -m 6 "$u" 2>/dev/null | tr -d ' \r\n')
  if echo "$cand" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; then ip=$cand; break; fi
done

prev_ip=$(sed -n 's/.*"ip":"\([0-9.]*\)".*/\1/p' "$NET" 2>/dev/null)
prev_since=$(sed -n 's/.*"since":"\([^"]*\)".*/\1/p' "$NET" 2>/dev/null)

if [ -z "$ip" ]; then
  # Sem saída: mantém o último IP conhecido, marca o erro.
  printf '{"ip":%s,"checkedAt":"%s","since":"%s","error":"sem-saida"}\n' \
    "$( [ -n "$prev_ip" ] && printf '"%s"' "$prev_ip" || printf null )" "$now" "${prev_since:-$now}" > "$NET.tmp" \
    && mv "$NET.tmp" "$NET"
  exit 0
fi

cur=$(grep -oE 'external-ip=[0-9.]+' "$COTURN" 2>/dev/null | head -1 | cut -d= -f2)
if [ -n "$cur" ] && [ "$ip" != "$cur" ]; then
  sed -i "s/external-ip=[0-9.]*/external-ip=$ip/" "$COTURN"
  if docker compose -f "$COTURN" up -d >/dev/null 2>&1; then
    echo "$now coturn external-ip $cur -> $ip" >> "$LOG"
  else
    echo "$now ERRO recriando coturn ($cur -> $ip)" >> "$LOG"
  fi
fi

since=$prev_since
[ "$ip" != "$prev_ip" ] || [ -z "$since" ] && since=$now
printf '{"ip":"%s","checkedAt":"%s","since":"%s"}\n' "$ip" "$now" "$since" > "$NET.tmp" && mv "$NET.tmp" "$NET"
