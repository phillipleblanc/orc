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