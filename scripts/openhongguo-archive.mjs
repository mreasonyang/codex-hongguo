export function archiveURL(revision) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw Error('Invalid openhongguo source revision')
  return 'https://codeload.github.com/beilunyang/openhongguo/tar.gz/' + revision
}

export async function downloadArchive(revision) {
  const limit = 8 * 1024 * 1024
  const response = await fetch(archiveURL(revision), { redirect: 'error', signal: AbortSignal.timeout(60000) })
  if (!response.ok || Number(response.headers.get('content-length')) > limit)
    throw Error('Official openhongguo source unavailable')
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > limit) throw Error('openhongguo source exceeds limit')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
