// Serialize sends and pause the source while the destination drains. A large
// legal frame is never discarded merely because another frame follows it.
export function createSocketForwarder(source, target, translate, onError) {
  let queue = []
  let sending = false
  let disposed = false
  let completion
  const flush = () => {
    if (disposed || sending) return
    const item = queue.shift()
    if (!item) {
      if (completion) { const done = completion; completion = undefined; done() }
      else source.resume()
      return
    }
    if (target.readyState !== 1) { dispose(); return }
    sending = true
    try {
      const [data, binary] = item
      target.send(binary ? data : translate(data.toString('utf8')), { binary }, error => {
        sending = false
        if (disposed) return
        if (error) { dispose(); onError(error); return }
        flush()
      })
    } catch (error) { sending = false; dispose(); onError(error) }
  }
  const dispose = () => { disposed = true; queue = []; completion = undefined }
  return {
    write(data, binary) {
      if (disposed || completion) return
      source.pause()
      queue.push([data, binary])
      flush()
    },
    // Keep already received frames ahead of the upstream close notification.
    finish(done) {
      if (disposed) return
      completion = done
      flush()
    },
    dispose,
  }
}
