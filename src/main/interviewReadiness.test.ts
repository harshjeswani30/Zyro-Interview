import { describe, expect, it } from 'vitest'
import { prepareInterviewStart } from './interviewReadiness'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('prepareInterviewStart', () => {
  it('does not report the interview ready until gateway pre-warming succeeds', async () => {
    const gateway = deferred<string>()
    let settled = false

    const preparing = prepareInterviewStart({
      prewarmGatewayToken: () => gateway.promise,
      checkBalance: async () => ({ allowed: true, sessions_balance: 1 })
    }).then((result) => {
      settled = true
      return result
    })

    await Promise.resolve()
    expect(settled).toBe(false)

    gateway.resolve('signed-gateway-token')

    await expect(preparing).resolves.toEqual({ allowed: true, sessions_balance: 1 })
  })

  it('fails interview preparation when pre-warming produces no token', async () => {
    const preparing = prepareInterviewStart({
      prewarmGatewayToken: async () => null,
      checkBalance: async () => ({ allowed: true })
    })

    await expect(preparing).rejects.toThrow('Gateway token pre-warm failed')
  })
})
