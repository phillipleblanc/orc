/** Edit the current Orca terminal's Orc note with nvim inside Pi. */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HANDLE = /^term_[A-Za-z0-9_-]+$/;

function noteFile(handle: string): string {
  const config = process.env.ORC_CONFIG_DIR || join(homedir(), ".config", "orc");
  return join(config, "notes", `${handle}.txt`);
}

function migrateLegacyNote(handle: string, file: string): void {
  if (existsSync(file)) return;
  let legacy = "";
  try {
    legacy = execFileSync("/usr/bin/defaults", ["read", "dev.phillipleblanc.orc", `sessionNotes.${handle}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).replace(/\n$/, "");
  } catch { /* No note in the app's earlier UserDefaults store. */ }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try { writeFileSync(file, legacy, { flag: "wx", mode: 0o600 }); }
  catch (error: any) { if (error?.code !== "EEXIST") throw error; }
}

async function openNvim(file: string, ui: any): Promise<number | null> {
  return ui.custom(async (tui: any, _theme: unknown, _keys: unknown, done: (result: number | null) => void) => {
    tui.stop();
    let status: number | null = null;
    try {
      status = await new Promise<number | null>((resolve) => {
        const child = spawn("nvim", [file], { stdio: "inherit" });
        child.once("error", () => resolve(null));
        child.once("close", (code) => resolve(code));
      });
    } finally {
      tui.start();
      tui.requestRender(true);
      done(status);
    }
    return { render: () => [], invalidate: () => {} };
  });
}

export default function (pi: any): void {
  pi.registerCommand("notes", {
    description: "Edit this Orca session's Orc notes in nvim",
    handler: async (_args: string, ctx: any) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/notes needs an interactive Pi terminal.", "error");
        return;
      }
      const handle = process.env.ORCA_TERMINAL_HANDLE;
      if (!handle || !HANDLE.test(handle)) {
        ctx.ui.notify("/notes needs a Pi session launched in an Orca terminal.", "error");
        return;
      }
      const file = noteFile(handle);
      try {
        migrateLegacyNote(handle, file);
        const status = await openNvim(file, ctx.ui);
        if (status !== 0) ctx.ui.notify("nvim did not save the note successfully.", "error");
      } catch (error) {
        ctx.ui.notify(`Could not open session notes: ${String(error)}`, "error");
      }
    },
  });
}
