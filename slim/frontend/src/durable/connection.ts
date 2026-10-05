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
