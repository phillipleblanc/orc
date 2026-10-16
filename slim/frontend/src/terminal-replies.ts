// What a terminal sends by itself, in answer to a program's query or when it gains or loses focus: device attributes,
// cursor position, keyboard flags, mode, status and window reports, focus changes, and DCS, OSC and APC replies.
const REPLY = [
  String.raw`\x1b\[[?>][\d;]*c`,
  String.raw`\x1b\[\??\d+;\d+(?:;\d+)?R`,
  String.raw`\x1b\[\?\d*u`,
  String.raw`\x1b\[\??\d+;\d+\$y`,
  String.raw`\x1b\[\??\d[\d;]*n`,
  String.raw`\x1b\[\d+(?:;\d+)*t`,
  String.raw`\x1b\[[IO]`,
  String.raw`\x1bP[\s\S]*?\x1b\\`,
  String.raw`\x1b\][\s\S]*?(?:\x07|\x1b\\)`,
  String.raw`\x1b_[\s\S]*?\x1b\\`
].join('|')
const REPLIES = new RegExp(`^(?:${REPLY})+$`)

/**
 * Whether input from a viewer's terminal is only its replies, which every viewer's terminal sends when a program
 * queries it, rather than the person typing. Ctrl+F3 and Shift+F3 encode like a cursor position report and count as
 * replies.
 */
export function onlyTerminalReplies(text: string): boolean {
  return text.length > 0 && REPLIES.test(text)
}
