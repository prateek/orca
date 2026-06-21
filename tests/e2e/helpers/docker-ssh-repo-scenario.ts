import type { Page } from '@stablyai/playwright-test'
import type { Repo } from '../../../src/shared/types'
import type { DockerSshRelayTarget } from './docker-ssh-relay-target'

export type ConnectedDockerSshTarget = {
  targetId: string
  hostId: `ssh:${string}`
  label: string
}

export type AddedDockerSshRepo = {
  repo: Repo
  worktreeCount: number
}

function toSshHostId(targetId: string): `ssh:${string}` {
  return `ssh:${encodeURIComponent(targetId)}`
}

export async function connectDockerSshTarget(
  page: Page,
  target: DockerSshRelayTarget,
  label: string
): Promise<ConnectedDockerSshTarget> {
  const targetId = await page.evaluate(
    async ({ label, target }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      const credentialUnsub = window.api.ssh.onCredentialRequest((request) => {
        void window.api.ssh.submitCredential({ requestId: request.requestId, value: null })
      })
      try {
        const createdTarget = await window.api.ssh.addTarget({
          target: {
            label,
            host: '127.0.0.1',
            port: target.port,
            username: 'root',
            identityFile: target.identityFile,
            identitiesOnly: true,
            relayGracePeriodSeconds: 1
          }
        })
        const state = await window.api.ssh.connect({ targetId: createdTarget.id })
        if (!state || state.status !== 'connected') {
          throw new Error(`SSH target did not connect: ${JSON.stringify(state)}`)
        }
        store.getState().setSshConnectionState(createdTarget.id, state)
        const labels = new Map(store.getState().sshTargetLabels)
        labels.set(createdTarget.id, createdTarget.label)
        store.getState().setSshTargetLabels(labels)
        return createdTarget.id
      } finally {
        credentialUnsub()
      }
    },
    { label, target }
  )
  return { targetId, hostId: toSshHostId(targetId), label }
}

export async function reconnectDockerSshTarget(
  page: Page,
  target: ConnectedDockerSshTarget
): Promise<void> {
  await page.evaluate(async (target) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const credentialUnsub = window.api.ssh.onCredentialRequest((request) => {
      void window.api.ssh.submitCredential({ requestId: request.requestId, value: null })
    })
    try {
      const state = await window.api.ssh.connect({ targetId: target.targetId })
      if (!state || state.status !== 'connected') {
        throw new Error(`SSH target did not reconnect: ${JSON.stringify(state)}`)
      }
      store.getState().setSshConnectionState(target.targetId, state)
      const labels = new Map(store.getState().sshTargetLabels)
      labels.set(target.targetId, target.label)
      store.getState().setSshTargetLabels(labels)
    } finally {
      credentialUnsub()
    }
  }, target)
}

export async function addDockerSshRepo(
  page: Page,
  args: {
    targetId: string
    remotePath: string
    displayName: string
  }
): Promise<AddedDockerSshRepo> {
  return await page.evaluate(async (args) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const result = await window.api.repos.addRemote({
      connectionId: args.targetId,
      remotePath: args.remotePath,
      displayName: args.displayName
    })
    if ('error' in result) {
      throw new Error(result.error)
    }
    await store.getState().fetchRepos()
    const state = store.getState()
    const repo =
      state.repos.find((candidate) => candidate.id === result.repo.id) ??
      state.repos.find(
        (candidate) =>
          candidate.connectionId === args.targetId && candidate.path === result.repo.path
      )
    if (!repo) {
      throw new Error(`Expected remote repo to be loaded: ${result.repo.path}`)
    }
    await state.fetchWorktrees(repo.id)
    return {
      repo,
      worktreeCount: store.getState().worktreesByRepo[repo.id]?.length ?? 0
    }
  }, args)
}
