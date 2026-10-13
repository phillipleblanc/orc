/**
 * A `data` handler for a text stream that calls `line` with each line, without its newline. Only new text is
 * searched for newlines, so a line that spans many chunks, like a durable agent's snapshot, costs time in
 * proportion to its length.
 */
export function splitLines(line: (text: string) => void): (chunk: string) => void {
  let partial = ''
  return (chunk) => {
    let start = 0
    let newline: number
    while ((newline = chunk.indexOf('\n', start)) >= 0) {
      const text = partial + chunk.slice(start, newline)
      partial = ''
      start = newline + 1
      line(text)
    }
    partial += chunk.slice(start)
  }
}
