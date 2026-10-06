/**
 * Runs `body`, then `tearDown`, which returns a verdict on the topology (a forwarder that died,
 * say) or null. A body failure is raised as itself, with the verdict attached as an
 * AggregateError so neither replaces the other; a verdict alone is raised on its own.
 */
export async function runWithTopologyTeardown<T>(
  body: () => Promise<T>,
  tearDown: () => Error | null
): Promise<T> {
  let result: T
  try {
    result = await body()
  } catch (error) {
    const verdict = tearDown()
    if (verdict) {
      const failure = error instanceof Error ? error : new Error(String(error))
      throw new AggregateError([failure, verdict], `${failure.message}\nAlso: ${verdict.message}`)
    }
    throw error
  }
  const verdict = tearDown()
  if (verdict) {
    throw verdict
  }
  return result
}
