-- Syncs Orc's sessions into Rex: one Rex session per Orc project, labeled with the project's name, with a tab for
-- each Orc session in the project, labeled with the session's name, that runs `orc attach` for it. The runtime runs
-- it with `rex do rex-sync.lua --json --args -` (see rex.ts).
--
-- rex.args: `sessions`, the running Orc sessions ({handle, name, cwd, command, project = {id, name}}); `map`, the
-- tab made for each Orc session, by handle ({session, window, name, project, adopted}), where an adopted tab is one
-- of the user's own in which `orc new` started the session; `projects`, the Rex session made for
-- each project, by project id ({session, name}); `dismissed`, the handles of Orc sessions whose tab or project
-- session was closed in Rex, which stay out of Rex until `orc rex start` runs again; `order`, the handles of the
-- sessions in the order their tabs go in; `seen`, the order of the synced tabs in each Rex session as the last sync
-- left it ({[session] = {window, ...}}); `project_order`, the ids of the projects in the order their Rex sessions
-- go in; `seen_sessions`, the order of the projects' Rex sessions as the last sync left it; and `clear`, true to close everything in `map` and forget every project, as
-- `orc rex clear` does.
-- Returns the new `map`, `projects`, `dismissed`, `seen` and `seen_sessions`; `reordered`, for each Rex session whose
-- synced tabs were moved in Rex since the last sync, their handles in their new order, and `projects_reordered`, the
-- project ids in their Rex sessions' new order when those were moved in Rex, which the sync leaves for the runtime to
-- adopt;
-- the session names `created`, `renamed` and `closed`; the project names `removed`, and when clearing, `kept` (a
-- project session that other tabs keep open); and `errors`.

local TERMINAL = "com.superlogical.terminal.shell"
local args = rex.args or {}
local result = { map = {}, projects = {}, dismissed = {}, seen = {}, reordered = {}, seen_sessions = {}, projects_reordered = {}, created = {}, renamed = {}, closed = {}, removed = {}, kept = {}, errors = {} }

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
      -- A tab of the user's own stays when its session ends.
      if entry.adopted then return end
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
      result.map[handle] = { session = entry.session, window = entry.window, name = session.name, project = entry.project, adopted = entry.adopted }
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

-- Tabs in each Rex session in `order`, unless they were moved in Rex since the last sync. Other tabs stay where they are.
local function same_order(left, right)
  local inside = {}
  for _, window in ipairs(right) do inside[window] = true end
  local common = {}
  for _, window in ipairs(left) do if inside[window] then table.insert(common, window) end end
  local index = 1
  for _, window in ipairs(right) do
    if window == common[index] then index = index + 1 end
  end
  return index > #common
end
local function synced_tabs(session_id, wanted)
  local tabs = {}
  for _, window in ipairs(call("session.view", { session_id = session_id }).windows or {}) do
    if wanted[window.window_id] then table.insert(tabs, window.window_id) end
  end
  return tabs
end
local desired, handles, wanted = {}, {}, {}
for _, handle in ipairs(args.clear and {} or args.order or {}) do
  local entry = result.map[handle]
  if entry then
    desired[entry.session] = desired[entry.session] or {}
    table.insert(desired[entry.session], entry.window)
    handles[entry.window] = handle
    wanted[entry.window] = true
  end
end
for session_id, windows in pairs(desired) do
  guarded(function()
    call("session.attach", { session_id = session_id })
    local current = synced_tabs(session_id, wanted)
    local seen = (args.seen or {})[session_id]
    if seen and not same_order(current, seen) then
      local moved = {}
      for _, window in ipairs(current) do table.insert(moved, handles[window]) end
      table.insert(result.reordered, moved)
      result.seen[session_id] = current
      return
    end
    if table.concat(current, " ") ~= table.concat(windows, " ") then
      for index = #windows - 1, 1, -1 do
        call("session.move_window", { session_id = session_id, window_id = windows[index], before_window_id = windows[index + 1] })
      end
      current = synced_tabs(session_id, wanted)
    end
    result.seen[session_id] = current
  end)
end

-- The projects' Rex sessions in `project_order`, unless they were moved in Rex since the last sync. Other sessions stay
-- where they are.
local function project_sessions(wanted)
  local sessions = {}
  for _, session in ipairs(call("session.list", {}).sessions or {}) do
    if wanted[session.session_id] then table.insert(sessions, session.session_id) end
  end
  return sessions
end
local ordered, project_of, wanted_sessions = {}, {}, {}
for _, id in ipairs(args.clear and {} or args.project_order or {}) do
  local project = result.projects[id]
  if project and not project_of[project.session] then
    table.insert(ordered, project.session)
    project_of[project.session] = id
    wanted_sessions[project.session] = true
  end
end
if #ordered > 0 then
  guarded(function()
    local current = project_sessions(wanted_sessions)
    if args.seen_sessions and not same_order(current, args.seen_sessions) then
      for _, session_id in ipairs(current) do table.insert(result.projects_reordered, project_of[session_id]) end
      result.seen_sessions = current
      return
    end
    if table.concat(current, " ") ~= table.concat(ordered, " ") then
      for index = #ordered - 1, 1, -1 do
        call("session.attach", { session_id = ordered[index] })
        call("session.move", { session_id = ordered[index], before_session_id = ordered[index + 1] })
      end
      current = project_sessions(wanted_sessions)
    end
    result.seen_sessions = current
  end)
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
