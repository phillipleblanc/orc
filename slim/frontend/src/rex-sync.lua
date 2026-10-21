-- Syncs Orc's sessions into Rex: one Rex session per Orc session, labeled with its name, with a tab that runs
-- `orc attach` for it. The runtime runs it with `rex do rex-sync.lua --json --args -` (see rex.ts).
--
-- rex.args: `sessions`, the running Orc sessions ({handle, name, cwd, command}); `map`, the Rex session and tab
-- made for each Orc session, by handle ({session, window, name}); `dismissed`, the handles of Orc sessions whose
-- Rex session or tab was closed in Rex, which stay out of Rex until `orc rex start` runs again.
-- Returns the new `map` and `dismissed`, the names `created`, `renamed` and `closed`, and any `errors`.

local TERMINAL = "com.superlogical.terminal.shell"
local args = rex.args or {}
local result = { map = {}, dismissed = {}, created = {}, renamed = {}, closed = {}, errors = {} }

local function call(method, params)
  local value, err = rex.call(method, params)
  if value == nil then error(method .. ": " .. tostring(err), 0) end
  return value
end

local function find_window(view, id)
  for _, window in ipairs(view.windows or {}) do
    if window.window_id == id then return window end
  end
end

local function destroy_if_empty(session_id)
  if #(call("session.view", { session_id = session_id }).windows or {}) == 0 then call("session.destroy", { session_id = session_id }) end
end

local live, running, dismissed = {}, {}, {}
for _, session in ipairs(call("session.list", {}).sessions or {}) do live[session.session_id] = true end
for _, session in ipairs(args.sessions or {}) do running[session.handle] = session end
for _, handle in ipairs(args.dismissed or {}) do dismissed[handle] = true end

-- Rex sessions made before: relabel renamed ones, close those of ended Orc sessions, and remember the ones closed in Rex.
for handle, entry in pairs(args.map or {}) do
  local session = running[handle]
  local ok, err = pcall(function()
    if not live[entry.session] then
      if session then dismissed[handle] = true end
      return
    end
    local view = call("session.attach", { session_id = entry.session }).view or {}
    local window = find_window(view, entry.window)
    if not session then
      -- The Orc session ended. Other tabs someone opened in its Rex session keep it open.
      if window then call("session.close_window", { session_id = entry.session, window_id = entry.window }) end
      destroy_if_empty(entry.session)
      table.insert(result.closed, entry.name)
    elseif not window then
      -- Its tab was closed, or detached, in Rex.
      dismissed[handle] = true
      destroy_if_empty(entry.session)
    else
      if view.label ~= session.name or window.label ~= session.name then
        call("session.set_label", { session_id = entry.session, label = session.name })
        call("session.set_window_label", { session_id = entry.session, window_id = entry.window, label = session.name })
        table.insert(result.renamed, session.name)
      end
      result.map[handle] = { session = entry.session, window = entry.window, name = session.name }
    end
  end)
  if not ok then
    table.insert(result.errors, err)
    -- Kept, so a later sync retries it rather than making a second Rex session.
    if session and not dismissed[handle] then result.map[handle] = entry end
  end
end

for _, session in ipairs(args.sessions or {}) do
  if not result.map[session.handle] and not dismissed[session.handle] then
    local ok, err = pcall(function()
      local created = call("session.create", { label = session.name, initial_windows = { { window_label = session.name,
        layout = { block = { flavor = TERMINAL, label = session.name, options = { command = session.command, shell = "none", cwd = session.cwd } } } } } })
      local window = created.initial_windows[1]
      result.map[session.handle] = { session = created.session_id, window = window.window_id, name = session.name }
      table.insert(result.created, session.name)
      -- A tab follows the size of the client that owns it; this one gives it up so the app showing it sizes it.
      call("session.attach", { session_id = created.session_id })
      call("session.disown_block", { session_id = created.session_id, block_ids = window.block_ids })
    end)
    if not ok then table.insert(result.errors, err) end
  end
end

for handle in pairs(dismissed) do
  if running[handle] then table.insert(result.dismissed, handle) end
end
return result
