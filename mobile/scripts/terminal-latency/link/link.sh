#!/usr/bin/env bash
# Brings up, shapes and tears down an impaired link between the phone and a target.
#
#   link.sh up <name> <local-port> <target-host:port>
#   link.sh shape <name> '<uplink netem args>' '<downlink netem args>'
#   link.sh outage <name> <seconds>
#   link.sh down <name>
#
# The phone connects to 127.0.0.1:<local-port>. Uplink is phone -> target, downlink is the reverse.
# Netem arguments are passed to `tc qdisc change ... netem` unchanged, for example:
#   'delay 150ms 30ms distribution normal loss gemodel 1% 20% rate 2mbit limit 200'
set -euo pipefail

image=orca-terminal-latency-link
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
command=${1:?command}
name=${2:?link name}
network="orca-latency-${name}"
near="orca-latency-${name}-near"
far="orca-latency-${name}-far"

case "$command" in
  up)
    local_port=${3:?local port}
    target=${4:?target host:port}
    docker image inspect "$image" >/dev/null 2>&1 || docker build -q -t "$image" "$script_dir" >/dev/null
    docker network inspect "$network" >/dev/null 2>&1 || docker network create "$network" >/dev/null
    docker rm -f "$near" "$far" >/dev/null 2>&1 || true
    subnet=$(docker network inspect -f '{{(index .IPAM.Config 0).Subnet}}' "$network")
    # Why: each end sits on the default bridge too, so reaching the phone or the target does not
    # cross the shaped interface and only the hop between the two ends is impaired.
    docker create --name "$far" --cap-add NET_ADMIN \
      --add-host host.docker.internal:host-gateway \
      -e LISTEN_PORT=7000 -e FORWARD_TO="$target" -e LINK_SUBNET="$subnet" "$image" >/dev/null
    docker network connect "$network" "$far"
    docker start "$far" >/dev/null
    docker create --name "$near" --cap-add NET_ADMIN \
      -p "127.0.0.1:${local_port}:7000" \
      -e LISTEN_PORT=7000 -e FORWARD_TO="${far}:7000" -e LINK_SUBNET="$subnet" "$image" >/dev/null
    docker network connect "$network" "$near"
    docker start "$near" >/dev/null
    ;;
  shape)
    uplink=${3:?uplink netem args}
    downlink=${4:?downlink netem args}
    # shellcheck disable=SC2086 -- netem arguments are a word list by design.
    docker exec "$near" sh -c "tc qdisc change dev \$(cat /run/link-device) root netem $uplink"
    # shellcheck disable=SC2086
    docker exec "$far" sh -c "tc qdisc change dev \$(cat /run/link-device) root netem $downlink"
    ;;
  outage)
    seconds=${3:?seconds}
    # Why: 100% loss in both directions is what a tunnel or a handover gap looks like to TCP;
    # the previous shape is restored by the caller with `shape`.
    docker exec "$near" sh -c 'tc qdisc change dev $(cat /run/link-device) root netem loss 100%'
    docker exec "$far" sh -c 'tc qdisc change dev $(cat /run/link-device) root netem loss 100%'
    sleep "$seconds"
    ;;
  down)
    docker rm -f "$near" "$far" >/dev/null 2>&1 || true
    docker network rm "$network" >/dev/null 2>&1 || true
    ;;
  *)
    echo "unknown command: $command" >&2
    exit 64
    ;;
esac
