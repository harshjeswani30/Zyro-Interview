export interface InterviewStartResult {
  allowed: boolean
  [key: string]: unknown
}

interface InterviewReadinessDependencies {
  prewarmGatewayToken: () => Promise<string | null>
  checkBalance: () => Promise<InterviewStartResult>
}

export async function prepareInterviewStart(
  dependencies: InterviewReadinessDependencies
): Promise<InterviewStartResult> {
  const [gatewayToken, balance] = await Promise.all([
    dependencies.prewarmGatewayToken(),
    dependencies.checkBalance()
  ])
  if (!gatewayToken) throw new Error('Gateway token pre-warm failed')
  return balance
}
