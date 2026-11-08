// Release dependent test resources before their temporary parent directories.
const stacks = new WeakMap()
export function defer(t, cleanup) {
  let stack = stacks.get(t)
  if (!stack) {
    stacks.set(t, stack = [])
    t.after(async () => {
      const failures = []
      for (const dispose of stack.reverse()) {
        try { await dispose() } catch (error) { failures.push(error) }
      }
      if (failures.length) throw new AggregateError(failures, 'Test resource cleanup failed')
    })
  }
  stack.push(cleanup)
}
