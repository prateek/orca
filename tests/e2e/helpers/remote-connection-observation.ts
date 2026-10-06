import type { Page } from '@stablyai/playwright-test'
import { resolveActiveTabId } from './terminal-pane-identity'

/** Which connection a sample reads: a direct SSH target or a paired remote Orca server. */
export type RemoteConnectionSource =
  | { kind: 'ssh'; targetId: string }
  | { kind: 'runtime'; environmentId: string }

export type RemoteConnectionSample = {
  /** Renderer `performance.now()`. */
  atMs: number
  /** What the store says about the connection. */
  state: string
  /** Visible text that mentions a connection or process problem. */
  notices: string[]
  ptyId: string | null
}

export type RemoteConnectionChange = {
  /** Milliseconds from the origin the caller chose, usually the start of a cut. */
  atMs: number
  state: string
  notices: string[]
  ptyId: string | null
}

/**
 * One reading of what the app shows about a remote connection: the store's state for it, and the
 * text of any status region (the terminal's reconnect overlay and banner) a person would read as
 * "disconnected" or "the process died".
 *
 * Why no `innerText`: it forces layout on the renderer thread whose parse time is the metric;
 * `textContent` of the few `role="status"` elements does not.
 */
export async function sampleRemoteConnection(
  page: Page,
  source: RemoteConnectionSource
): Promise<RemoteConnectionSample> {
  const tabId = await resolveActiveTabId(page)
  return page.evaluate(
    ({ source, tabId }) => {
      const state = window.__store?.getState()
      let connection = 'unknown'
      if (source.kind === 'ssh') {
        const ssh = state?.sshConnectionStates.get(source.targetId)
        connection = ssh ? `${ssh.status}${ssh.error ? ` (${ssh.error})` : ''}` : 'absent'
      } else {
        const snapshot = state?.runtimeStatusByEnvironmentId.get(source.environmentId)?.snapshot
        connection = snapshot ? `${snapshot.verification}/${snapshot.transport}` : 'absent'
      }
      const manager = tabId ? window.__paneManagers?.get(tabId) : null
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      const problem =
        /disconnect|reconnect|connecting|connection required|offline|unreachable|connection lost|not connected|exited|terminated|unavailable|timed out|lost contact/i
      const notices = new Set<string>()
      for (const region of document.querySelectorAll('[role="status"]')) {
        // Why text nodes: `textContent` would run a title straight into the line after it.
        const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT)
        const parts: string[] = []
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const part = node.textContent?.trim() ?? ''
          if (part.length > 0) {
            parts.push(part)
          }
        }
        const text = parts.join(' ')
        if (text.length > 0 && text.length <= 240 && problem.test(text)) {
          notices.add(text)
        }
      }
      // Why the icon: the sidebar marks a disconnected host with an icon, which has no text.
      const hostsShownOffline = document.querySelectorAll('svg.lucide-server-off').length
      return {
        atMs: performance.now(),
        state:
          hostsShownOffline > 0
            ? `${connection}, ${hostsShownOffline} host shown offline`
            : connection,
        notices: [...notices].sort().slice(0, 8),
        ptyId: pane ? (pane.container.dataset.ptyId ?? null) : 'no-pane'
      }
    },
    { source, tabId }
  )
}

/** The store's status for an SSH target: `connected`, `reconnecting`, ..., or null if unknown. */
export async function readSshConnectionStatus(
  page: Page,
  targetId: string
): Promise<string | null> {
  return page.evaluate(
    (id) => window.__store?.getState().sshConnectionStates.get(id)?.status ?? null,
    targetId
  )
}

/** Keeps the first sample and every sample that differs from the one before it. */
export function remoteConnectionChanges(
  samples: RemoteConnectionSample[],
  originMs: number
): RemoteConnectionChange[] {
  const changes: RemoteConnectionChange[] = []
  let previous = ''
  for (const sample of samples) {
    const key = JSON.stringify([sample.state, sample.notices, sample.ptyId])
    if (key !== previous) {
      previous = key
      changes.push({
        atMs: Math.round(sample.atMs - originMs),
        state: sample.state,
        notices: sample.notices,
        ptyId: sample.ptyId
      })
    }
  }
  return changes
}
