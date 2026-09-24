/** Keep a Pi session's /name and its Orca tab title aligned. */
import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const run = promisify(execFile);
const PANE = /^([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function profileFile(): string | undefined {
  const root = process.env.ORCA_USER_DATA_PATH || join(homedir(), "Library", "Application Support", "orca");
  try {
    const index = JSON.parse(readFileSync(join(root, "orca-profile-index.json"), "utf8"));
    const id = index.activeProfileId;
    if (typeof id !== "string" || !PROFILE.test(id) || !index.profiles?.some((profile: any) => profile.id === id)) return;
    return join(root, "profiles", id, "orca-data.json");
  } catch (error: any) {
    if (error?.code === "ENOENT") return join(root, "orca-data.json");
    return;
  }
}

export function savedTabName(file: string, worktreeId: string, tabId: string): string | null | undefined {
  try {
    const state = JSON.parse(readFileSync(file, "utf8"));
    const sessions = [state.workspaceSession, ...Object.values(state.workspaceSessionsByHostId ?? {})] as any[];
    for (const session of sessions) {
      const tab = session?.tabsByWorktree?.[worktreeId]?.find((tab: any) => tab.id === tabId);
      if (tab) return typeof tab.customTitle === "string" ? tab.customTitle.trim() || null : null;
    }
  } catch { /* A profile write may be in progress. */ }
}

async function renameTab(worktreeId: string, tabId: string, leafId: string, name: string): Promise<void> {
  const cli = process.env.ORCA_CLI_PATH || "orca";
  const { stdout } = await run(cli, ["terminal", "list", "--limit", "10000", "--json"], { timeout: 15_000, maxBuffer: 8_000_000 });
  const listing = JSON.parse(stdout);
  if (!listing.ok || listing.result?.truncated) throw new Error("Could not list this Orca session.");
  const terminals = listing.result?.terminals as any[] | undefined;
  const terminal = terminals?.find((item) => item.worktreeId === worktreeId && item.tabId === tabId && item.leafId === leafId)
    ?? terminals?.find((item) => item.worktreeId === worktreeId && item.handle === process.env.ORCA_TERMINAL_HANDLE);
  if (!terminal) throw new Error("This Pi pane is not in Orca's terminal list.");
  const args = ["terminal", "rename", "--terminal", terminal.handle];
  if (name) args.push("--title", name);
  args.push("--json");
  const response = JSON.parse((await run(cli, args, { timeout: 15_000, maxBuffer: 1_000_000 })).stdout);
  if (!response.ok) throw new Error(response.error?.message || "Orca rejected the name.");
}

export default function (pi: ExtensionAPI): void {
  const match = process.env.ORCA_PANE_KEY?.match(PANE);
  const worktreeId = process.env.ORCA_WORKTREE_ID;
  if (!match || !worktreeId) return;
  const owner = process.env.ORC_PI_NAME_OWNER;
  if (owner && owner !== String(process.pid)) return;
  process.env.ORC_PI_NAME_OWNER = String(process.pid);

  const [, tabId, leafId] = match;
  const file = profileFile();
  if (!file) return;
  const ownersKey = Symbol.for("orc.pi.sessionName.owners");
  const owners = ((globalThis as any)[ownersKey] ??= new Map<string, () => void>()) as Map<string, () => void>;
  owners.get(process.env.ORCA_PANE_KEY!)?.();
  let disposed = false;
  let watcher: FSWatcher | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let lastOrcaName: string | null | undefined;
  let pendingPiName: string | undefined;
  let renameQueue = Promise.resolve();
  const suppressed = new Map<string, number>();

  function syncFromOrca(): void {
    if (disposed) return;
    const name = savedTabName(file!, worktreeId!, tabId);
    if (name === undefined || pendingPiName !== undefined) return;
    const previous = lastOrcaName;
    lastOrcaName = name;
    if (name === null && previous === undefined) return;
    const target = name ?? "";
    if ((pi.getSessionName() ?? "") === target) return;
    suppressed.set(target, (suppressed.get(target) ?? 0) + 1);
    try { pi.setSessionName(target); }
    catch {
      suppressed.set(target, Math.max(0, (suppressed.get(target) ?? 1) - 1));
    }
  }

  function scheduleSync(): void {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(syncFromOrca, 100);
    debounce.unref?.();
  }

  try {
    watcher = watch(dirname(file), { persistent: false }, (_event, changed) => {
      if (!changed || changed === "orca-data.json") scheduleSync();
    });
  } catch { /* Periodic reconciliation also covers unavailable file watching. */ }
  const interval = setInterval(syncFromOrca, 30_000);
  interval.unref?.();

  function dispose(): void {
    disposed = true;
    watcher?.close();
    clearInterval(interval);
    if (debounce) clearTimeout(debounce);
    if (owners.get(process.env.ORCA_PANE_KEY!) === dispose) owners.delete(process.env.ORCA_PANE_KEY!);
  }
  owners.set(process.env.ORCA_PANE_KEY!, dispose);

  pi.on("session_start", () => { lastOrcaName = undefined; syncFromOrca(); });
  pi.on("session_info_changed", (event, ctx) => {
    if (disposed) return;
    const name = event.name ?? "";
    const count = suppressed.get(name) ?? 0;
    if (count > 0) {
      if (count === 1) suppressed.delete(name);
      else suppressed.set(name, count - 1);
      return;
    }
    pendingPiName = name;
    renameQueue = renameQueue.then(async () => {
      if (disposed) return;
      let renamed = false;
      try {
        await renameTab(worktreeId, tabId, leafId, name);
        renamed = true;
      } catch (error) {
        try { ctx.ui.notify(`Could not rename the Orca tab: ${String(error)}`, "error"); } catch { /* UI unavailable. */ }
      } finally {
        if (pendingPiName === name) {
          pendingPiName = undefined;
          if (renamed) lastOrcaName = name || null;
          else syncFromOrca();
        }
      }
    });
  });
  pi.on("session_shutdown", dispose);
}
