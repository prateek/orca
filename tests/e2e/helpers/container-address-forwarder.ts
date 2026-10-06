import { spawn } from 'node:child_process'

/**
 * A loopback port that forwards to a container's own address, for clients macOS will not let
 * reach it directly.
 *
 * Why it exists: macOS Local Network privacy refuses the Electron binary a route to container
 * addresses (`connect EHOSTUNREACH`) until a person approves it in System Settings, while plain
 * `node` is allowed. The forwarder is a `node` process on this machine, so the connection that
 * crosses the shaped path is still made by this machine's TCP stack to the container's IP; only
 * the hop from the app to the forwarder is loopback. It is not Docker's published port, which
 * would end the connection inside the VM and hide the impairment.
 *
 * Why a separate process: the test process blocks on synchronous `docker exec` calls while it
 * shapes the path, which would stall bytes forwarded on its own event loop.
 */
export type ContainerAddressForwarder = {
  port: number
  /** Set once the process has died on its own, so a later connection failure is not the app's. */
  readonly exited: { code: number | null; signal: NodeJS.Signals | null } | null
  stop: () => void
}

/** Throws if the forwarder died during the run; call after the rest of a topology is torn down. */
export function assertContainerAddressForwarderLived(forwarder: ContainerAddressForwarder): void {
  if (forwarder.exited) {
    throw new Error(
      `The container address forwarder on port ${forwarder.port} died during the run ` +
        `(code ${forwarder.exited.code}, signal ${forwarder.exited.signal})`
    )
  }
}

const FORWARDER_SCRIPT = `
const net = require('node:net')
const [host, port] = [process.argv[1], Number(process.argv[2])]
const server = net.createServer((client) => {
  const upstream = net.connect(port, host)
  for (const socket of [client, upstream]) {
    socket.setNoDelay(true)
    socket.on('error', () => {})
    socket.on('close', () => { client.destroy(); upstream.destroy() })
  }
  client.pipe(upstream).pipe(client)
})
server.listen(0, '127.0.0.1', () => console.log('FORWARDER_PORT=' + server.address().port))
`

export function startContainerAddressForwarder(
  address: string,
  port: number
): Promise<ContainerAddressForwarder> {
  const child = spawn(process.execPath, ['-e', FORWARDER_SCRIPT, address, String(port)], {
    stdio: ['ignore', 'pipe', 'inherit']
  })
  let exited: ContainerAddressForwarder['exited'] = null
  let stopping = false
  child.once('exit', (code, signal) => {
    if (!stopping) {
      exited = { code, signal }
    }
  })
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`Forwarder did not report a port within 15s; it printed: ${output}`))
    }, 15_000)
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`Forwarder exited early with code ${code}`)))
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      // Why a tagged line: a preload inherited through NODE_OPTIONS may print first.
      const listening = /^FORWARDER_PORT=(\d+)$/m.exec(output)?.[1]
      if (listening) {
        clearTimeout(timer)
        resolve({
          port: Number(listening),
          get exited() {
            return exited
          },
          stop: () => {
            stopping = true
            child.kill()
          }
        })
      }
    })
  })
}
