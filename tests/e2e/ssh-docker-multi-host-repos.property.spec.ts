import { mkdtempSync, rmSync } from 'fs'
import os from 'os'
import path from 'path'
import type { TestInfo } from '@stablyai/playwright-test'
import { test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import {
  cleanupDockerSshRelayTarget,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget,
  type DockerSshRepoSeed
} from './helpers/docker-ssh-relay-target'
import { connectDockerSshTarget } from './helpers/docker-ssh-repo-scenario'
import {
  addScenarioRepo,
  applyGeneratedOperation,
  assertScenarioState,
  readStoreState,
  type OperationLog,
  type ScenarioRepo
} from './helpers/multi-host-repo-property-driver'
import { createLocalGitRepo } from './helpers/local-git-repo-fixture'
import { createRandom } from './helpers/seeded-property-random'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const SHARED_PROJECT_ID = 'github:stablyai/orca'
const SHARED_ORIGIN_URL = 'git@github.com:tmchow/orca.git'
const SHARED_UPSTREAM_URL = 'git@github.com:stablyai/orca.git'
const DOCKER_REPO_ROOT = '/tmp/orca-multi-host-repo-prop'
const SEED_COUNT = readPositiveIntegerEnv('ORCA_E2E_MULTI_HOST_PROP_SEEDS', 1)
const STEP_COUNT = readPositiveIntegerEnv('ORCA_E2E_MULTI_HOST_PROP_STEPS', 10)

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) {
    return fallback
  }
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function sharedDockerRepo(pathSuffix: string): DockerSshRepoSeed {
  return {
    path: `${DOCKER_REPO_ROOT}/${pathSuffix}`,
    readmeText: `shared docker checkout ${pathSuffix}`,
    originUrl: SHARED_ORIGIN_URL,
    upstreamUrl: SHARED_UPSTREAM_URL
  }
}

function sideDockerRepo(pathSuffix: string): DockerSshRepoSeed {
  return {
    path: `${DOCKER_REPO_ROOT}/${pathSuffix}`,
    readmeText: `side docker checkout ${pathSuffix}`,
    originUrl: `git@github.com:prateek/${pathSuffix}.git`
  }
}

function annotateSequence(testInfo: TestInfo, seed: number, log: OperationLog): void {
  testInfo.annotations.push({
    type: 'docker-ssh-multi-host-repo-property',
    description: `seed=${seed} steps=${log.join(' | ')}`
  })
}

test.use({ seedTestRepo: false })

test.describe('Docker SSH multi-host repo properties', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH repo properties.')
  test.skip(process.platform === 'win32', 'Docker SSH repo properties use POSIX ssh tooling.')

  for (let seed = 1; seed <= SEED_COUNT; seed += 1) {
    test(`preserves repo host partitions and shared project setups, seed ${seed}`, async ({
      orcaPage
    }, testInfo) => {
      test.slow()
      const log: OperationLog = []
      const targets: DockerSshRelayTarget[] = []
      let localRoot: string | null = null
      try {
        localRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-multi-host-prop-'))
        const localSharedPath = createLocalGitRepo(localRoot, 'local-shared-orca', {
          originUrl: SHARED_ORIGIN_URL,
          upstreamUrl: SHARED_UPSTREAM_URL
        })
        const localSidePath = createLocalGitRepo(localRoot, 'local-side-project', {
          originUrl: 'git@github.com:prateek/local-side-project.git'
        })

        const hostA = startDockerSshRelayTarget(testInfo, {
          nameSuffix: `prop-${seed}-a`,
          seedRepos: [sharedDockerRepo('host-a-shared-orca')]
        })
        const hostB = startDockerSshRelayTarget(testInfo, {
          nameSuffix: `prop-${seed}-b`,
          seedRepos: [sharedDockerRepo('host-b-shared-orca'), sideDockerRepo('host-b-side-project')]
        })
        targets.push(hostA, hostB)

        await waitForSessionReady(orcaPage)
        const hostATarget = await connectDockerSshTarget(
          orcaPage,
          hostA,
          `Docker prop host A ${seed}`
        )
        const hostBTarget = await connectDockerSshTarget(
          orcaPage,
          hostB,
          `Docker prop host B ${seed}`
        )
        const connectedTargets = [hostATarget, hostBTarget]
        const entries: ScenarioRepo[] = [
          {
            key: 'local/shared',
            kind: 'local',
            hostId: 'local',
            path: localSharedPath,
            displayName: 'Local shared Orca',
            sharedProject: true
          },
          {
            key: 'local/side',
            kind: 'local',
            hostId: 'local',
            path: localSidePath,
            displayName: 'Local side project',
            sharedProject: false
          },
          {
            key: 'ssh-a/shared',
            kind: 'ssh',
            hostId: hostATarget.hostId,
            targetId: hostATarget.targetId,
            path: `${DOCKER_REPO_ROOT}/host-a-shared-orca`,
            displayName: 'Host A shared Orca',
            sharedProject: true
          },
          {
            key: 'ssh-b/shared',
            kind: 'ssh',
            hostId: hostBTarget.hostId,
            targetId: hostBTarget.targetId,
            path: `${DOCKER_REPO_ROOT}/host-b-shared-orca`,
            displayName: 'Host B shared Orca',
            sharedProject: true
          },
          {
            key: 'ssh-b/side',
            kind: 'ssh',
            hostId: hostBTarget.hostId,
            targetId: hostBTarget.targetId,
            path: `${DOCKER_REPO_ROOT}/host-b-side-project`,
            displayName: 'Host B side project',
            sharedProject: false
          }
        ]

        for (const entry of entries.filter((candidate) => candidate.key !== 'local/side')) {
          await addScenarioRepo(orcaPage, entry)
          log.push(`setup: add ${entry.key} as ${entry.repoId}`)
        }
        assertScenarioState(entries, await readStoreState(orcaPage), SHARED_PROJECT_ID)

        const random = createRandom(seed)
        for (let step = 1; step <= STEP_COUNT; step += 1) {
          await applyGeneratedOperation(orcaPage, entries, connectedTargets, random, step, log)
          assertScenarioState(entries, await readStoreState(orcaPage), SHARED_PROJECT_ID)
        }
      } catch (error) {
        annotateSequence(testInfo, seed, log)
        throw error
      } finally {
        annotateSequence(testInfo, seed, log)
        for (const target of targets.reverse()) {
          cleanupDockerSshRelayTarget(target)
        }
        if (localRoot) {
          rmSync(localRoot, { recursive: true, force: true })
        }
      }
    })
  }
})
