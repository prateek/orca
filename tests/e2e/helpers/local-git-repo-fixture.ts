import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import path from 'path'

function git(repoPath: string, args: string[]): void {
  execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' })
}

export function createLocalGitRepo(
  rootPath: string,
  repoName: string,
  options: { originUrl?: string; upstreamUrl?: string } = {}
): string {
  const repoPath = path.join(rootPath, repoName)
  mkdirSync(repoPath, { recursive: true })
  git(repoPath, ['init'])
  git(repoPath, ['config', 'user.email', 'e2e@test.local'])
  git(repoPath, ['config', 'user.name', 'Orca Multi Host E2E'])
  writeFileSync(path.join(repoPath, 'README.md'), `# ${repoName}\n`)
  git(repoPath, ['add', 'README.md'])
  git(repoPath, ['commit', '-m', 'Initial commit'])
  git(repoPath, ['branch', '-M', 'main'])
  if (options.originUrl) {
    git(repoPath, ['remote', 'add', 'origin', options.originUrl])
  }
  if (options.upstreamUrl) {
    git(repoPath, ['remote', 'add', 'upstream', options.upstreamUrl])
  }
  return repoPath
}
