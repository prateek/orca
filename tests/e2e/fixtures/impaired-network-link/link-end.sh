#!/usr/bin/env bash
# One end of an impaired link. Forwards TCP from LISTEN_PORT to FORWARD_TO and shapes only the
# packets it sends to the other end, so the TCP connection between the two ends runs over a lossy,
# slow path under a real kernel TCP stack. Traffic on its other interface is left alone.
set -euo pipefail

listen_port=${LISTEN_PORT:?}
forward_to=${FORWARD_TO:?}
link_subnet=${LINK_SUBNET:?}

link_device=$(ip -o route show "$link_subnet" | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -1)
if [[ -z "$link_device" ]]; then
  echo "no interface on link subnet $link_subnet" >&2
  exit 1
fi
echo "$link_device" > /run/link-device

exec socat -d "TCP-LISTEN:${listen_port},fork,reuseaddr,nodelay" "TCP:${forward_to},nodelay"
