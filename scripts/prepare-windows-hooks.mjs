import { readFile, writeFile } from 'node:fs/promises'

// Keep the reviewed PowerShell source beside the hook definitions. Passing its
// fixed UTF-16LE encoding as one argument avoids re-parsing by the parent shell.
const source = await readFile(new URL('../hooks/windows-bootstrap.ps1', import.meta.url), 'utf8')
const command = 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(source, 'utf16le').toString('base64')
const path = new URL('../hooks/hooks.json', import.meta.url)
const hooks = JSON.parse(await readFile(path, 'utf8'))
for (const groups of Object.values(hooks.hooks)) for (const group of groups) for (const handler of group.hooks) handler.commandWindows = command
const updated = JSON.stringify(hooks, null, 2) + '\n'
if (await readFile(path, 'utf8') !== updated) await writeFile(path, updated)
