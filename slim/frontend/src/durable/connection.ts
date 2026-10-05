import { createConnection } from 'node:net'

/** One request to a durable agent's worker over its socket (see worker.ts for the methods). */
export function durableRequest(socketPath: string, method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let buffered = ''
    const timer = setTimeout(() => finish(new Error(`the durable agent did not answer ${method}`)), timeoutMs)
    const finish = (error: Error | null, result?: unknown) => {
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(result)
    }
    socket.setEncoding('utf8')
    socket.on('error', (error) => finish(error))
    socket.on('connect', () => socket.write(JSON.stringify({ id: 1, method, params }) + '\n'))
    socket.on('data', (chunk: string) => {
      buffered += chunk
      const newline = buffered.indexOf('\n')
      if (newline < 0) return
      const reply = JSON.parse(buffered.slice(0, newline))
      finish(reply.error ? new Error(reply.error) : null, reply.result)
    })
  })
}

/** The entries a durable agent's worker shows views: its snapshot when subscribing, after which the connection closes. */
export function durableSnapshot(socketPath: string, timeoutMs = 10_000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let buffered = ''
    const timer = setTimeout(() => finish(new Error('the durable agent did not send its conversation')), timeoutMs)
    const finish = (error: Error | null, entries?: any[]) => {
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(entries ?? [])
    }
    socket.setEncoding('utf8')
    socket.on('error', (error) => finish(error))
    socket.on('connect', () => socket.write(JSON.stringify({ id: 1, method: 'subscribe', params: {} }) + '\n'))
    socket.on('data', (chunk: string) => {
      buffered += chunk
      let newline: number
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffered.slice(0, newline))
        buffered = buffered.slice(newline + 1)
        if (message.error) return finish(new Error(message.error))
        if (message.type === 'snapshot') return finish(null, message.snapshot?.entries ?? [])
      }
    })
  })
}
