import {
  execDockerSshRelayTargetCommand,
  shellQuote,
  type DockerSshRelayTarget
} from './docker-ssh-relay-target'

export type DockerSshRelayProcessSnapshot = {
  relayPid: number
  watcherPids: number[]
  relayDir: string
}

export type DockerSshRelayArtifactState = {
  installComplete: boolean
  relayWatcher: boolean
}

type RelayProcessRow = {
  type: 'relay' | 'watcher'
  pid: number
  parentPid: number
  cwd: string
}

/**
 * Walks /proc and runs `body` for each process with `argv`, `base` (argv[1]'s basename, the
 * script node runs) and `pid` set. Why /proc rather than `pgrep -f`: that pattern would also
 * match the shell running it.
 */
function relayProcessWalk(body: string): string {
  return `
for proc in /proc/[0-9]*; do
  [ -r "$proc/cmdline" ] || continue
  argv=()
  mapfile -d '' -t argv < "$proc/cmdline" 2>/dev/null || continue
  entry="\${argv[1]:-}"
  base="\${entry##*/}"
  pid="\${proc##*/}"
${body}
done
`
}

const LIST_RELAY_PROCESSES_COMMAND = relayProcessWalk(`
  type=
  if [ "$base" = relay-watcher.js ]; then
    type=watcher
  elif [ "$base" = relay.js ]; then
    for arg in "\${argv[@]:2}"; do
      if [ "$arg" = --detached ]; then type=relay; break; fi
    done
  fi
  [ -n "$type" ] || continue
  ppid="$(awk '/^PPid:/{print $2}' "$proc/status" 2>/dev/null)"
  cwd="$(readlink "$proc/cwd" 2>/dev/null)"
  printf '%s\\t%s\\t%s\\t%s\\n' "$type" "$pid" "$ppid" "$cwd"
`)

const LIST_EVERY_RELAY_PROCESS_COMMAND = relayProcessWalk(`
  case "$base" in relay.js|relay-watcher.js) ;; *) continue ;; esac
  printf '%s %s %s\\n' "$pid" "$base" "\${argv[*]:2}"
`)

function parseRelayProcessRows(output: string): RelayProcessRow[] {
  if (!output) {
    return []
  }
  return output.split('\n').map((line) => {
    const [type, rawPid, rawParentPid, cwd] = line.split('\t')
    // Why: Number('') is 0, so empty pid/ppid (e.g. vanished /proc status) must
    // throw so callers retry the observation instead of accepting parentPid: 0.
    const pid = Number(rawPid)
    const parentPid = Number(rawParentPid)
    if (
      (type !== 'relay' && type !== 'watcher') ||
      rawPid === undefined ||
      rawPid === '' ||
      rawParentPid === undefined ||
      rawParentPid === '' ||
      !Number.isInteger(pid) ||
      !Number.isInteger(parentPid) ||
      !cwd
    ) {
      throw new Error(`Unexpected Docker SSH relay process row: ${line}`)
    }
    return { type, pid, parentPid, cwd }
  })
}

export function readDockerSshRelayProcessSnapshot(
  target: DockerSshRelayTarget
): DockerSshRelayProcessSnapshot | null {
  const groups = readDockerSshRelayProcessSnapshots(target)
  if (groups.length > 1) {
    throw new Error(`Expected one Docker SSH relay process group, found ${groups.length}`)
  }
  return groups[0] ?? null
}

/**
 * Every relay process on the target as "pid script args" lines: daemons, `--connect` bridges
 * and watchers alike. For diagnostics that count what a reconnect leaves behind.
 */
export function listDockerSshRelayProcesses(target: DockerSshRelayTarget): string[] {
  return execDockerSshRelayTargetCommand(target, LIST_EVERY_RELAY_PROCESS_COMMAND)
    .split('\n')
    .filter((line) => line.length > 0)
}

export function readDockerSshRelayProcessSnapshots(
  target: DockerSshRelayTarget
): DockerSshRelayProcessSnapshot[] {
  const rows = parseRelayProcessRows(
    execDockerSshRelayTargetCommand(target, LIST_RELAY_PROCESSES_COMMAND)
  )
  const relays = rows.filter((row) => row.type === 'relay')
  const groups = relays.flatMap((relay) => {
    const watcherPids = rows
      .filter((row) => row.type === 'watcher' && row.parentPid === relay.pid)
      .map((row) => row.pid)
      .sort((left, right) => left - right)
    return watcherPids.length > 0 ? [{ relayPid: relay.pid, watcherPids, relayDir: relay.cwd }] : []
  })
  return groups.sort((left, right) => left.relayPid - right.relayPid)
}

export function signalDockerSshRelayWatchers(
  target: DockerSshRelayTarget,
  snapshot: DockerSshRelayProcessSnapshot
): void {
  const { relayPid, watcherPids } = snapshot
  if (!Number.isInteger(relayPid) || watcherPids.some((pid) => !Number.isInteger(pid))) {
    throw new Error('Docker SSH relay process IDs must be integers')
  }
  execDockerSshRelayTargetCommand(
    target,
    [
      `relay_proc=/proc/${relayPid}`,
      '[ -r "$relay_proc/cmdline" ]',
      'relay_argv=()',
      'mapfile -d \'\' -t relay_argv < "$relay_proc/cmdline"',
      '[ "${relay_argv[1]##*/}" = relay.js ]',
      '[[ " ${relay_argv[*]:2} " = *" --detached "* ]]',
      ...watcherPids.flatMap((watcherPid) => [
        `proc=/proc/${watcherPid}`,
        '[ -r "$proc/cmdline" ]',
        'argv=()',
        'mapfile -d \'\' -t argv < "$proc/cmdline"',
        '[ "${argv[1]##*/}" = relay-watcher.js ]',
        `ppid="$(awk '/^PPid:/{print $2}' "$proc/status")"`,
        `[ "$ppid" = ${relayPid} ]`,
        `kill -SEGV ${watcherPid}`
      ])
    ].join(' && ')
  )
}

export function terminateDockerSshRelay(
  target: DockerSshRelayTarget,
  snapshot: DockerSshRelayProcessSnapshot
): void {
  const { relayPid } = snapshot
  if (!Number.isInteger(relayPid)) {
    throw new Error('Docker SSH relay process ID must be an integer')
  }
  execDockerSshRelayTargetCommand(
    target,
    [
      `proc=/proc/${relayPid}`,
      '[ -r "$proc/cmdline" ]',
      'argv=()',
      'mapfile -d \'\' -t argv < "$proc/cmdline"',
      '[ "${argv[1]##*/}" = relay.js ]',
      '[[ " ${argv[*]:2} " = *" --detached "* ]]',
      `kill -TERM ${relayPid}`
    ].join(' && ')
  )
}

export function isDockerSshRelayPidRunning(
  target: DockerSshRelayTarget,
  relayPid: number
): boolean {
  if (!Number.isInteger(relayPid)) {
    return false
  }
  const result = execDockerSshRelayTargetCommand(
    target,
    `proc=/proc/${relayPid}; ` +
      'if [ -r "$proc/cmdline" ]; then ' +
      'argv=(); mapfile -d \'\' -t argv < "$proc/cmdline"; ' +
      'if [ "${argv[1]##*/}" = relay.js ] && ' +
      '[[ " ${argv[*]:2} " = *" --detached "* ]]; then echo ALIVE; else echo DEAD; fi; ' +
      'else echo DEAD; fi'
  )
  return result === 'ALIVE'
}

export function readDockerSshRelayArtifactState(
  target: DockerSshRelayTarget,
  relayDir: string
): DockerSshRelayArtifactState {
  const quotedDir = shellQuote(relayDir)
  const output = execDockerSshRelayTargetCommand(
    target,
    `test -f ${quotedDir}/.install-complete && marker=yes || marker=no; ` +
      `test -f ${quotedDir}/relay-watcher.js && watcher=yes || watcher=no; ` +
      'printf "%s %s" "$marker" "$watcher"'
  )
  const [marker, watcher] = output.split(' ')
  return { installComplete: marker === 'yes', relayWatcher: watcher === 'yes' }
}

export function removeDockerSshRelayWatcherArtifact(
  target: DockerSshRelayTarget,
  relayDir: string
): void {
  const quotedDir = shellQuote(relayDir)
  execDockerSshRelayTargetCommand(
    target,
    `test -f ${quotedDir}/.install-complete && rm -f ${quotedDir}/relay-watcher.js && ` +
      `test -f ${quotedDir}/.install-complete && test ! -e ${quotedDir}/relay-watcher.js`
  )
}
