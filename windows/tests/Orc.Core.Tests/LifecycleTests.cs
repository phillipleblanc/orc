using System.Text.Json.Nodes;
using Orc.Protocol;
using Orc.Protocol.Tests;
using Xunit;

namespace Orc.Core.Tests;

/// <summary>Ports Tests/OrcKitTests/SessionHierarchyTests.swift case for case, then the sidebar rows.</summary>
public sealed class HierarchyTests
{
    private static SessionInfo Session(string handle, string name) => new(handle, name, "project", "/code/project", true, "codex", handle, null);

    [Fact]
    public void ExistingNamesGroupWithoutMetadataAndKeepTheFullName()
    {
        var child = Session("child", "orca-frontend-review");
        var other = Session("other", "unrelated");
        var parent = Session("parent", "orca-frontend");
        var hierarchy = new SessionHierarchy([child, other, parent]);
        Assert.Equal(new[] { "other", "parent" }, hierarchy.Groups.Select(g => g.Session.Handle));
        Assert.Equal(new[] { "child" }, hierarchy.Groups[1].Children.Select(c => c.Handle));
        Assert.Equal("parent", hierarchy.ParentOf(child)?.Handle);
        Assert.True(hierarchy.CanCreateChild(parent));
        Assert.False(hierarchy.CanCreateChild(child));
        Assert.Equal("review", hierarchy.DisplayName(child));
        Assert.Equal(child.Name, SessionNames.ChildName(parent, " review "));
    }

    [Fact]
    public void OneLevelNestingDoesNotMakeAChildAnotherParent()
    {
        var root = Session("root", "orca");
        var child = Session("child", "orca-frontend");
        var grandchildName = Session("long", "orca-frontend-review");
        var hierarchy = new SessionHierarchy([grandchildName, child, root]);
        Assert.Equal(new[] { "root" }, hierarchy.Groups.Select(g => g.Session.Handle));
        Assert.Equal(new[] { "long", "child" }, hierarchy.Groups[0].Children.Select(c => c.Handle));
        Assert.Equal("root", hierarchy.ParentOf(grandchildName)?.Handle);
        Assert.Equal("frontend-review", hierarchy.DisplayName(grandchildName));
    }

    [Fact]
    public void RenamingRegroups()
    {
        var parent = Session("parent", "orca-frontend");
        Assert.Equal(2, new SessionHierarchy([parent, Session("child", "review")]).Groups.Count);
        Assert.Single(new SessionHierarchy([parent, Session("child", "orca-frontend-review")]).Groups);
    }

    [Fact]
    public void AnAmbiguousParentNameDoesNotAdoptChildren()
    {
        var first = Session("first", "shared");
        var second = Session("second", "shared");
        var child = Session("child", "shared-review");
        var hierarchy = new SessionHierarchy([first, second, child]);
        Assert.Equal(3, hierarchy.Groups.Count);
        Assert.Null(hierarchy.ParentOf(child));
        Assert.False(hierarchy.CanCreateChild(first));
        Assert.False(hierarchy.CanCreateChild(second));
        Assert.Equal(child.Name, hierarchy.DisplayName(child));
    }

    [Theory]
    [InlineData("  ")]
    [InlineData("bad\nname")]
    public void ChildNamesRejectBlankAndControlSuffixes(string suffix) =>
        Assert.Throws<ArgumentException>(() => SessionNames.ChildName(Session("parent", "orca-frontend"), suffix));

    [Fact]
    public void ChildNamesRejectLongCombinations() =>
        Assert.Throws<ArgumentException>(() => SessionNames.ChildName(Session("parent", "orca-frontend"), new string('a', 200)));

    [Fact]
    public void TheMacExampleNestsAndCollapses()
    {
        var sessions = new[] { "state-store-plan", "slack-watch", "state-store-plan-lease", "state-store-plan-cleanup", "oncall" }
            .Select((name, i) => Session($"t{i}", name)).ToList();
        var hierarchy = new SessionHierarchy(sessions);
        var rows = hierarchy.Rows(new HashSet<string>());
        Assert.Equal(new[] { "state-store-plan", "state-store-plan-lease", "state-store-plan-cleanup", "slack-watch", "oncall" },
            rows.Select(r => r.Session.Name));
        Assert.Equal(new[] { "lease", "cleanup" }, rows.Where(r => r.ParentHandle == "t0").Select(r => hierarchy.DisplayName(r.Session)));
        Assert.True(rows[0].HasChildren);
        Assert.Equal(new[] { "state-store-plan", "slack-watch", "oncall" },
            hierarchy.Rows(new HashSet<string> { "t0" }).Select(r => r.Session.Name));
    }

    [Fact]
    public void ParentageStaysWithinAProject()
    {
        var parent = new SessionInfo("p", "web", "project-a", "/a", true, "claude", null, null);
        var child = new SessionInfo("c", "web-tests", "project-b", "/b", true, "claude", null, null);
        var sections = SessionSections.Build([parent, child], []);
        Assert.All(sections, s => Assert.All(s.Hierarchy.Groups, g => Assert.Empty(g.Children)));
    }
}

public sealed class NameTests
{
    [Theory]
    [InlineData("fix-login", null)]
    [InlineData("", "Enter a name.")]
    [InlineData(" padded", "A name cannot start or end with spaces.")]
    [InlineData(".hidden", "A name cannot start with \".\".")]
    [InlineData("a/b", "A name cannot contain \"/\".")]
    [InlineData("tab\there", "A name cannot contain control characters.")]
    public void FollowsTheRuntimesRules(string name, string? problem) => Assert.Equal(problem, SessionNames.Problem(name));

    [Fact]
    public void LimitsLengthTo64() => Assert.NotNull(SessionNames.Problem(new string('a', 65)));

    [Fact]
    public void RequiresTheComposedForm() => Assert.NotNull(SessionNames.Problem("café"));
}

public sealed class SessionCommandTests
{
    private static readonly Project Proj = new("local::/Users/me/proj", "/Users/me/proj", "proj");

    [Fact]
    public async Task CreatesRenamesRestartsAndClosesThroughTheRuntime()
    {
        await using var runtime = new FakeRuntime();
        await using var connection = await RuntimeConnection.ConnectAsync(runtime.Pairing(), TestContext.Current.CancellationToken);
        SessionCommands.Request request = connection.RequestAsync;

        var handle = await SessionCommands.CreateAsync(request, "fix-login", Proj, SessionKind.Find("codex")!.Command, ["github"], new TerminalSize(132, 40), "m-1");
        Assert.Equal("term-new", handle);
        await SessionCommands.RenameAsync(request, handle, "fix-login-2");
        Assert.Equal("term-restarted", await SessionCommands.RestartAsync(request, handle));
        await SessionCommands.CloseAsync(request, "term-restarted");

        var calls = runtime.Calls.ToArray();
        Assert.Equal(new[] { "terminal.create", "terminal.rename", "terminal.restart", "terminal.close" }, calls.Select(c => c.Method));
        var create = JsonNode.Parse(calls[0].Parameters)!;
        Assert.Equal("fix-login", create["title"]?.ToString());
        Assert.Equal("id:local::/Users/me/proj", create["worktree"]?.ToString());
        Assert.Equal("codex --no-daemon", create["command"]?.ToString());
        Assert.Equal("m-1", create["clientMutationId"]?.ToString());
        Assert.Equal(new[] { "github" }, create["mcp"]!.AsArray().Select(m => m!.ToString()));
        Assert.Equal((132, 40), (create["cols"]!.GetValue<int>(), create["rows"]!.GetValue<int>()));
        Assert.Equal("fix-login-2", JsonNode.Parse(calls[1].Parameters)!["title"]?.ToString());
    }

    [Fact]
    public async Task ATerminalSessionSendsNoCommand()
    {
        await using var runtime = new FakeRuntime();
        await using var connection = await RuntimeConnection.ConnectAsync(runtime.Pairing(), TestContext.Current.CancellationToken);
        await SessionCommands.CreateAsync(connection.RequestAsync, "shell", Proj, SessionKind.Find("terminal")!.Command, [], new TerminalSize(80, 24));
        var create = JsonNode.Parse(runtime.Calls.Single().Parameters)!.AsObject();
        Assert.False(create.ContainsKey("command"));
        Assert.False(create.ContainsKey("mcp"));
    }

    [Fact]
    public async Task ListsAProjectsMcpConfigs()
    {
        await using var runtime = new FakeRuntime();
        await using var connection = await RuntimeConnection.ConnectAsync(runtime.Pairing(), TestContext.Current.CancellationToken);
        var configs = await SessionCommands.McpConfigsAsync(connection.RequestAsync, Proj);
        Assert.Equal(new[] { "github", "broken" }, configs.Select(c => c.Name));
        Assert.Equal(new[] { "github" }, configs[0].Servers);
        Assert.Equal("not valid JSON", configs[1].Error);
    }

    [Theory]
    [InlineData("id:local::/Users/me/proj", 1)]
    [InlineData("id:local", 1)]
    [InlineData("path:/Users/me/proj", 1)]
    [InlineData("/Users/me/proj", 1)]
    [InlineData("proj", 1)]
    [InlineData("other", 0)]
    public void MatchesProjectSelectorsLikeTheMac(string selector, int count) =>
        Assert.Equal(count, SessionCommands.ProjectsMatching(selector, [Proj]).Count);

    [Fact]
    public void RemembersTheLastKindAndProjectAndKeepsOtherSettings()
    {
        var file = Path.Combine(Path.GetTempPath(), $"orc-defaults-{Guid.NewGuid():N}.json");
        try
        {
            File.WriteAllText(file, """{"theme":"dark","defaultSessionType":"pi"}""");
            Assert.False(SessionDefaults.Load(file + ".missing").HasKind);
            var defaults = SessionDefaults.Load(file);
            Assert.Equal("pi", defaults.Kind);
            Assert.True(defaults.HasKind);
            Assert.Null(defaults.ProjectIn([Proj]));
            defaults.Remember(SessionKind.Find("claude")!, Proj);
            var reloaded = SessionDefaults.Load(file);
            Assert.Equal("claude", reloaded.Kind);
            Assert.Equal(Proj, reloaded.ProjectIn([Proj]));
            Assert.Equal("dark", JsonNode.Parse(File.ReadAllText(file))!["theme"]?.ToString());
        }
        finally { File.Delete(file); }
    }
}

public sealed class HostDataTests
{
    [Fact]
    public async Task SavesAttachmentsAndQuotesTheirPaths()
    {
        await using var runtime = new FakeRuntime { Capabilities = [HostInfo.HostData] };
        await using var connection = await RuntimeConnection.ConnectAsync(runtime.Pairing(), TestContext.Current.CancellationToken);
        var path = await HostData.SaveAttachmentAsync(connection.RequestAsync, "shot.png", [1, 2, 3]);
        Assert.Equal("/Users/me/.config/orc/attachments/abc/shot.png", path);
        var saved = JsonNode.Parse(runtime.Calls.Single().Parameters)!;
        Assert.Equal(("shot.png", "AQID"), (saved["name"]?.ToString(), saved["data"]?.ToString()));
        await Assert.ThrowsAsync<InvalidOperationException>(() => HostData.SaveAttachmentAsync(connection.RequestAsync, "big.bin", new byte[HostData.MaxAttachmentBytes + 1]));
        Assert.Equal("'/tmp/it'\"'\"'s here.png'", HostData.ShellQuote("/tmp/it's here.png"));
    }

    [Fact]
    public async Task BrowsesFoldersInTheHome()
    {
        await using var runtime = new FakeRuntime { Capabilities = [HostInfo.HostData] };
        await using var connection = await RuntimeConnection.ConnectAsync(runtime.Pairing(), TestContext.Current.CancellationToken);
        var listing = await HostData.ListFoldersAsync(connection.RequestAsync, "/Users/me/");
        Assert.Equal(("/Users/me", false), (listing.Path, listing.Truncated));
        // Folders only: files are not projects.
        Assert.Equal(["code"], listing.Folders);
        var forbidden = await Assert.ThrowsAsync<RpcException>(() => HostData.ListFoldersAsync(connection.RequestAsync, "/etc"));
        Assert.Equal("forbidden", forbidden.Code);
        Assert.Equal("/Users/me", HostData.ParentOf("/Users/me/code/"));
        Assert.Equal("/", HostData.ParentOf("/Users"));
        Assert.Null(HostData.ParentOf("/"));
        Assert.Equal("/Users/me/code", HostData.Child("/Users/me/", "code"));
    }

    [Fact]
    public async Task AddsAProjectAndMakesItTheDefault()
    {
        await using var runtime = new FakeRuntime { Capabilities = [HostInfo.HostData] };
        await using var connection = await RuntimeConnection.ConnectAsync(runtime.Pairing(), TestContext.Current.CancellationToken);
        var project = await HostData.AddProjectAsync(connection.RequestAsync, "/Users/me/code/site", makeDefault: true);
        Assert.Equal(("r2", "/Users/me/code/site", "site"), (project.Id, project.Path, project.Name));
        var calls = runtime.Calls.ToArray();
        Assert.Equal(["repo.add", "config.set"], calls.Select(c => c.Method));
        Assert.Equal("id:r2", JsonNode.Parse(calls[1].Parameters)!["defaultProject"]?.ToString());
        await HostData.AddProjectAsync(connection.RequestAsync, "/Users/me/code/other", makeDefault: false);
        Assert.Equal(3, runtime.Calls.Count);
    }

    [Fact]
    public async Task NewSessionsUseTheHostsDefaultsWithoutChangingThem()
    {
        await using var runtime = new FakeRuntime { Capabilities = [HostInfo.HostData] };
        await using var connection = await RuntimeConnection.ConnectAsync(runtime.Pairing(), TestContext.Current.CancellationToken);
        var defaults = await HostData.DefaultsAsync(connection.RequestAsync);
        Assert.Equal(("claude", true, "id:local::/Users/me/proj"), (defaults.Kind, defaults.HasKind, defaults.Project));
        var project = new Project("local::/Users/me/proj", "/Users/me/proj", "proj");
        Assert.Equal(project, defaults.ProjectIn([project]));
        // Creating a session on this PC leaves the host's defaults, and this PC's file, alone.
        defaults.Remember(SessionKind.Find("codex")!, project);
        Assert.Equal("claude", defaults.Kind);
        Assert.Empty(runtime.Calls);
    }
}

/// <summary>Sources/OrcKit/SessionSidebarOrder.swift's behavior, ported from Tests/OrcKitTests/SessionSidebarOrderTests.swift.</summary>
public sealed class SidebarOrderTests
{
    private static readonly HashSet<string> None = [];

    private static SessionInfo Session(string handle, string? name = null, string project = "project") =>
        new(handle, name ?? handle, project, "/code/" + project, true, "pi", handle, null);

    private static readonly SessionHierarchy Hierarchy =
        new([Session("a"), Session("a-one"), Session("a-two"), Session("b"), Session("b-one"), Session("c")]);

    private static string[] Ids(SidebarOrder order, IReadOnlySet<string>? collapsed = null, SessionHierarchy? hierarchy = null) =>
        order.Rows(hierarchy ?? Hierarchy, collapsed ?? None).Select(r => r.Session.Handle).ToArray();

    [Fact]
    public void TopLevelSessionsMoveBothWaysAndKeepTheirChildren()
    {
        var order = new SidebarOrder();
        Assert.Equal(["a", "a-one", "a-two", "b", "b-one", "c"], Ids(order));
        Assert.True(order.Move(5, 0, order.Rows(Hierarchy, None)));
        Assert.Equal(["c", "a", "a-one", "a-two", "b", "b-one"], Ids(order));
        order.Move(1, 6, order.Rows(Hierarchy, None));
        Assert.Equal(["c", "b", "b-one", "a", "a-one", "a-two"], Ids(order));
        order.Move(0, 3, order.Rows(Hierarchy, None));
        Assert.Equal(["b", "b-one", "c", "a", "a-one", "a-two"], Ids(order));
    }

    [Fact]
    public void ChildrenMoveOnlyAmongTheirSiblings()
    {
        var order = new SidebarOrder();
        order.Move(1, 3, order.Rows(Hierarchy, None));
        Assert.Equal(["a", "a-two", "a-one", "b", "b-one", "c"], Ids(order));
        order.Move(2, 1, order.Rows(Hierarchy, None));
        Assert.Equal(["a", "a-one", "a-two", "b", "b-one", "c"], Ids(order));
        var before = order.Keys.ToArray();
        foreach (var destination in new[] { 0, 4, 5, 6 })
        {
            Assert.False(order.Move(1, destination, order.Rows(Hierarchy, None)));
            Assert.Equal(before, order.Keys);
        }
        // A top-level session cannot split another's children.
        Assert.False(order.Move(5, 2, order.Rows(Hierarchy, None)));
    }

    [Fact]
    public void ACollapsedParentMovesWithItsHiddenChildren()
    {
        var order = new SidebarOrder();
        order.Move(2, 1, order.Rows(Hierarchy, None));
        var collapsed = order.Rows(Hierarchy, new HashSet<string> { "a", "b" });
        Assert.Equal(["a", "b", "c"], collapsed.Select(r => r.Session.Handle));
        Assert.True(collapsed[0].HasChildren);
        order.Move(0, 3, collapsed);
        Assert.Equal(["b", "b-one", "c", "a", "a-two", "a-one"], Ids(order));
        Assert.Equal(["b", "b-one", "c", "a"], Ids(order, new HashSet<string> { "a" }));
    }

    [Theory]
    [InlineData(6, 0)]
    [InlineData(0, -1)]
    [InlineData(0, 7)]
    [InlineData(0, 0)]
    [InlineData(0, 3)]
    [InlineData(1, 1)]
    [InlineData(1, 2)]
    [InlineData(5, 6)]
    public void InvalidAndNoOpMovesChangeNothing(int index, int destination)
    {
        var order = new SidebarOrder();
        Assert.False(order.Move(index, destination, order.Rows(Hierarchy, None)));
        Assert.Empty(order.Keys);
    }

    [Fact]
    public void TheOrderOutlivesNewHandlesAndAbsentSessions()
    {
        var a = Session("old-a", "Alpha");
        var b = Session("old-b", "Beta");
        var c = Session("c");
        var order = new SidebarOrder();
        order.Move(1, 0, order.Rows(new SessionHierarchy([a, b, c]), None));
        var saved = order.Keys.ToArray();
        Assert.Empty(order.Rows(new SessionHierarchy([]), None));
        Assert.Equal(["old-a", "c"], Ids(order, hierarchy: new SessionHierarchy([c, a])));
        Assert.Equal(["new-b", "old-a", "c", "new"], Ids(order, hierarchy: new SessionHierarchy([Session("new"), c, a, Session("new-b", "Beta")])));
        Assert.Equal(saved, order.Keys);
        var rows = order.Rows(new SessionHierarchy([c, a, Session("new-b", "Alpha-review")]), None);
        Assert.Equal(["old-a", "new-b", "c"], rows.Select(r => r.Session.Handle));
        Assert.Equal("old-a", rows[1].ParentHandle);
    }

    [Fact]
    public void StepsOnePlaceAmongSiblings()
    {
        var rows = new SidebarOrder().Rows(Hierarchy, None);
        Assert.Null(SidebarOrder.Step(0, -1, rows));
        Assert.Equal(5, SidebarOrder.Step(0, 1, rows));
        Assert.Equal(6, SidebarOrder.Step(3, 1, rows));
        Assert.Null(SidebarOrder.Step(5, 1, rows));
        // A child steps among its siblings only.
        Assert.Null(SidebarOrder.Step(2, 1, rows));
        Assert.Null(SidebarOrder.Step(1, -1, rows));
        Assert.Equal(3, SidebarOrder.Step(1, 1, rows));
        var order = new SidebarOrder();
        Assert.True(order.Move(1, SidebarOrder.Step(1, 1, rows)!.Value, rows));
        Assert.Equal(["a", "a-two", "a-one", "b", "b-one", "c"], Ids(order));
    }

    [Fact]
    public void SectionsFollowTheirFirstSession()
    {
        var sessions = new[] { Session("a", project: "one"), Session("b", project: "two"), Session("c", project: "one") };
        var order = new SidebarOrder();
        Assert.Equal(["one", "two"], SessionSections.Build(sessions, [], order).Select(s => s.Id));
        order.Move(1, 0, order.Rows(new SessionHierarchy(sessions), None));
        Assert.Equal(["two", "one"], SessionSections.Build(sessions, [], order).Select(s => s.Id));
    }
}

public sealed class MuteTests
{
    [Fact]
    public void MutesFollowRenamesArePrunedAndKept()
    {
        var file = Path.Combine(Path.GetTempPath(), $"orc-mutes-{Guid.NewGuid():N}.json");
        try
        {
            var mutes = SessionMutes.Load(file);
            mutes.Set(true, "fix-auth");
            mutes.Set(true, "docs");
            Assert.True(SessionMutes.Load(file).IsMuted("fix-auth"));
            mutes.Rename("fix-auth", "fix-login");
            Assert.False(mutes.IsMuted("fix-auth"));
            Assert.True(mutes.IsMuted("fix-login"));
            mutes.Prune(new HashSet<string> { "fix-login" });
            Assert.False(SessionMutes.Load(file).IsMuted("docs"));
            mutes.Set(false, "fix-login");
            Assert.False(SessionMutes.Load(file).IsMuted("fix-login"));
            Assert.Contains("\"names\"", File.ReadAllText(file));
        }
        finally { File.Delete(file); }
    }
}