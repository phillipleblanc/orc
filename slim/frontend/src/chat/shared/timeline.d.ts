// Types for timeline.js, which the chat views load as a plain browser module.
export type TimelineItem = Record<string, any> & { kind: string; id: string }
export type ToolInfo = { status: string | null; path?: string | null; added?: number; removed?: number }
export function timelineRows(items: TimelineItem[], info: (item: TimelineItem) => ToolInfo, context: { busy: boolean; runStartedAt: number | null }): any[]
export function grouped(items: TimelineItem[], info: (item: TimelineItem) => ToolInfo, live?: boolean): any[]
export function summarize(tools: TimelineItem[], info: (item: TimelineItem) => ToolInfo, thoughts?: number): string
export function changedFiles(items: TimelineItem[], info: (item: TimelineItem) => ToolInfo): { files: { path: string; added: number; removed: number }[]; calls: TimelineItem[]; added: number; removed: number }
export function patchCounts(patch: string | null | undefined): { added: number; removed: number }
