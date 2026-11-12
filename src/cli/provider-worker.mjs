import { checkProvider } from './provider-check.mjs'
import { previewProvider } from './provider-preview.mjs'

process.once('message', async input => {
  try {
    if (input.action === 'preview') {
      const preview = await previewProvider(input)
      process.once('disconnect', async () => { await preview.close(); process.exit(0) })
      process.send({ port: Number(new URL(preview.origin).port) })
      return
    }
    const ok = await checkProvider(input, (stage, status, code, details) => process.send({ stage, status, code, ...details }))
    process.send({ done: ok }, () => process.exit(ok ? 0 : 1))
  } catch { process.exit(1) }
})
