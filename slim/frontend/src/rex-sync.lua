-- Syncs Orc's sessions into Rex: one Rex session per Orc project, labeled with the project's name, with a tab for
-- each Orc session in the project, labeled with the session's name, that runs `orc attach` for it. The runtime runs
-- it with `rex do rex-sync.lua --json --args -` (see rex.ts).
--
-- rex.args: `sessions`, the running Orc sessions ({handle, name, cwd, command, project = {id, name}}); `map`, the
-- tab made for each Orc session, by handle ({session, window, name, project}); `projects`, the Rex session made for
-- each project, by project id ({session, name}); `dismissed`, the handles of Orc sessions whose tab or project
-- session was closed in Rex, which stay out of Rex until `orc rex start` runs again; and `clear`, true to close
-- everything in `map` and forget every project, as `orc rex clear` does.
-- Returns the new `map`, `projects` and `dismissed`; the session names `created`, `renamed` and `closed`; the
-- project names `removed`, and when clearing, `kept` (a project session that other tabs keep open); and `errors`.

local TERMINAL = "com.superlogical.terminal.shell"
local args = rex.args or {}
local result = { map = {}, projects = {}, dismissed = {}, created = {}, renamed = {}, closed = {}, removed = {}, kept = {}, errors = {} }

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

local function guarded(work)
  local ok, err = pcall(work)
  if not ok then table.insert(result.errors, err) end
  return ok
end

local live, running, dismissed, touched = {}, {}, {}, {}
for _, session in ipairs(call("session.list", {}).sessions or {}) do live[session.session_id] = true end
for _, session in ipairs(args.clear and {} or args.sessions or {}) do running[session.handle] = session end
for _, handle in ipairs(args.dismissed or {}) do dismissed[handle] = true end
for id, project in pairs(args.projects or {}) do
  if live[project.session] then result.projects[id] = project end
end

-- Tabs made before: relabel renamed sessions, close those of ended ones, and remember the ones closed in Rex.
for handle, entry in pairs(args.map or {}) do
  local session = running[handle]
  local ok = guarded(function()
    if not live[entry.session] then
      if session then dismissed[handle] = true end
      return
    end
    local view = call("session.attach", { session_id = entry.session }).view or {}
    local window = find_window(view, entry.window)
    if not session then
      if window then call("session.close_window", { session_id = entry.session, window_id = entry.window }) end
      touched[entry.session] = view.label or entry.name
      table.insert(result.closed, entry.name)
    elseif not window then
      dismissed[handle] = true
    else
      if window.label ~= session.name then
        call("session.set_window_label", { session_id = entry.session, window_id = entry.window, label = session.name })
        table.insert(result.renamed, session.name)
      end
      result.map[handle] = { session = entry.session, window = entry.window, name = session.name, project = entry.project }
    end
  end)
  -- Kept, so a later sync retries it rather than making a second tab or leaving one behind.
  if not ok and not dismissed[handle] then result.map[handle] = entry end
end

-- New tabs, in their project's Rex session, made when missing.
for _, session in ipairs(args.clear and {} or args.sessions or {}) do
  if not result.map[session.handle] and not dismissed[session.handle] then
    guarded(function()
      local project = result.projects[session.project.id]
      if not project then
        project = { session = call("session.create", { label = session.project.name }).session_id, name = session.project.name }
        result.projects[session.project.id] = project
      end
      call("session.attach", { session_id = project.session })
      local window = call("session.new_window", { session_id = project.session, window_label = session.name, focus = false,
        -- Started directly, without a login wrapper, so Rex sees the program and shows its icon.
        layout = { block = { flavor = TERMINAL, label = session.name, options = { command = session.command, shell = "none", login = false, cwd = session.cwd } } } })
      result.map[session.handle] = { session = project.session, window = window.window_id, name = session.name, project = session.project.id }
      table.insert(result.created, session.name)
      -- A tab follows the size of the client that owns it; this one gives it up so the app showing it sizes it.
      call("session.disown_block", { session_id = project.session, block_ids = window.block_ids })
    end)
  end
end

-- Rex sessions with no synced tab left, the projects' and any a tab was closed in, are removed once empty.
local names, shown = {}, {}
for _, session in ipairs(args.clear and {} or args.sessions or {}) do names[session.project.id] = session.project.name end
for _, entry in pairs(result.map) do shown[entry.session] = true end
local function remove_if_empty(session_id, label)
  call("session.attach", { session_id = session_id })
  if #(call("session.view", { session_id = session_id }).windows or {}) > 0 then return false end
  call("session.destroy", { session_id = session_id })
  table.insert(result.removed, label)
  return true
end
for id, project in pairs(result.projects) do
  touched[project.session] = nil
  guarded(function()
    if shown[project.session] then
      if names[id] and names[id] ~= project.name then
        call("session.set_label", { session_id = project.session, label = names[id] })
        project.name = names[id]
      end
    elseif remove_if_empty(project.session, project.name) then
      result.projects[id] = nil
    elseif args.clear then
      result.projects[id] = nil
      table.insert(result.kept, project.name)
    end
  end)
end
for session_id, label in pairs(touched) do
  if not shown[session_id] then
    guarded(function()
      if not remove_if_empty(session_id, label) and args.clear then table.insert(result.kept, label) end
    end)
  end
end

for handle in pairs(dismissed) do
  if running[handle] then table.insert(result.dismissed, handle) end
end
return result
