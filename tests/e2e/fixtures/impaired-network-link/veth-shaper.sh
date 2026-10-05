#!/usr/bin/env bash
# Shapes the traffic of one other container from outside it, on the host side of its veth pair.
#
# Run with --privileged --net=host. The veth is a forwarding hop between the two TCP endpoints, so
# neither sender's stack learns about a drop except by missing an ACK. That is where netem has to
# sit for TCP behaviour to be realistic (tc-netem(8): "netem must be placed on the ingress of the
# receiver host").
#
# After start, /run/shaper/up names the device carrying client -> container packets and
# /run/shaper/down the one carrying container -> client packets.
set -euo pipefail

veth_index=${VETH_INDEX:?}
ifb=${IFB_NAME:?}

veth=$(ip -o link | awk -F': ' -v i="$veth_index" '$1 == i { print $2 }' | cut -d@ -f1)
if [[ -z "$veth" ]]; then
  echo "no interface with index $veth_index" >&2
  exit 1
fi

teardown() {
  tc qdisc del dev "$veth" root 2>/dev/null || true
  tc qdisc del dev "$veth" clsact 2>/dev/null || true
  ip link del "$ifb" 2>/dev/null || true
}
trap 'teardown; exit 0' TERM INT

ip link add "$ifb" type ifb
ip link set "$ifb" up
tc qdisc add dev "$veth" clsact
# Why: tc can only delay what a device sends. Packets the container sends arrive on the veth, so
# they are redirected to an ifb device and shaped as that device sends them on.
tc filter add dev "$veth" ingress pref 10 protocol all u32 match u32 0 0 \
  action mirred egress redirect dev "$ifb"
# Why: with offload on, one "packet" can be many segments, and netem's loss, limit and rate would
# apply to the bundle instead of to what crosses a real link.
ethtool -K "$veth" tso off gso off gro off >/dev/null 2>&1 || true

mkdir -p /run/shaper
echo "$veth" > /run/shaper/up
echo "$ifb" > /run/shaper/down

sleep infinity &
wait $!
