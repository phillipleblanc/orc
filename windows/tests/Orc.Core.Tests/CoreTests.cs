using System.Text.Json.Nodes;
using Orc.Protocol.Tests;
using Xunit;

namespace Orc.Core.Tests;

public sealed class ActivityTests
{
    [Theory]
    [InlineData(null, null, AgentActivity.Unknown)]
    [InlineData(false, null, AgentActivity.NoAgent)]
    [InlineData(true, "idle", AgentActivity.Idle)]
    [InlineData(true, "done", AgentActivity.Idle)]
    [InlineData(true, "working", AgentActivity.Active)]
    [InlineData(true, "permission", AgentActivity.NeedsAttention)]
    [InlineData(true, "blocked", AgentActivity.NeedsAttention)]
    [InlineData(true, "waiting", AgentActivity.NeedsAttention)]
    [InlineData(true, "something-new", AgentActivity.Unknown)]
    public void MapsAgentStatusLikeTheMacApp(bool? running, string? state, AgentActivity expected) =>
        Assert.Equal(expected, AgentActivities.From(running, state));

    [Fact]
    public void OfflineSessionsAreOfflineWhateverTheyLastReported()
    {
        var offline = new SessionInfo("t1", "a", "w", "/p", false, "claude", null, null);
        var snapshot = new HostSnapshot([offline], [], new Dictionary<string, AgentActivity> { ["t1"] = AgentActivity.Active }, DateTimeOffset.Now);
        Assert.Equal(AgentActivity.Offline, snapshot.ActivityOf(offline));
    }
}

public sealed class SessionParsingTests
{
    [Fact]
    public void ReadsTerminalListRows()
    {
        var row = JsonNode.Parse("""
            {"handle":"term_1","title":"oncall","worktreeId":"local::/Users/me/proj","worktreePath":"/Users/me/proj",
             "connected":true,"agentIdentity":"claude","incarnationId":"inc-9"}
            """)!.AsObject();
        Assert.Equal(new SessionInfo("term_1", "oncall", "local::/Users/me/proj", "/Users/me/proj", true, "claude", "inc-9", null), SessionInfo.FromJson(row));
    }

    [Fact]
    public void FallsBackToTheHandleForAnUnnamedSession() =>
        Assert.Equal("term_2", SessionInfo.FromJson(JsonNode.Parse("""{"handle":"term_2","title":""}""")!.AsObject())!.Name);

    [Fact]
    public void ShowsWhatAReportingProgramSays()
    {
        var row = JsonNode.Parse("""
            {"handle":"t","title":"build","connected":true,"agentIdentity":null,
             "programStatus":{"state":"working","records":[{"id":"","state":"working","app":"make","msg":"linking","progress":40}]}}
            """)!.AsObject();
        Assert.Equal("make · linking · 40%", SessionInfo.FromJson(row)!.Detail);
    }

    [Theory]
    [InlineData("blocked", "permission", null, "needs permission")]
    [InlineData("blocked", "auth", null, "needs you to sign in")]
    [InlineData("error", null, null, "failed")]
    [InlineData("working", null, 5, "working, 5%")]
    public void DescribesProgramStates(string state, string? kind, int? progress, string expected) =>
        Assert.Equal(expected, new ProgramRecord("", state, kind, progress, null, null, null).Text);

    [Fact]
    public void TheMostUrgentRootRecordLeads()
    {
        var status = new ProgramStatus("blocked", [
            new ProgramRecord("child", "blocked", "question", null, "child", null, null),
            new ProgramRecord("", "blocked", "permission", null, "root", null, null),
            new ProgramRecord("other", "working", null, null, "other", null, null)]);
        Assert.Equal("root", status.Lead?.App);
    }
}

public sealed class InsightTests
{
    [Fact]
    public void ReadsBriefs()
    {
        var briefs = AgentBrief.List((JsonObject)JsonNode.Parse("""
            {"briefs": [
              {"name": "fix-auth", "brief": {"headline": " Waiting on your review ", "goal": "Fix auth", "progress": [], "now": "Idle", "next": [], "needsYou": "Approve the PR?"},
               "generatedAt": 1760000000000, "model": "anthropic/claude", "error": null, "mark": "x", "generating": true},
              {"name": "new-one", "brief": null, "generatedAt": null, "model": null, "error": "no transcript", "mark": null, "generating": false}
            ]}
            """)!);
        Assert.Equal("Waiting on your review", briefs["fix-auth"].Headline);
        Assert.Equal("Approve the PR?", briefs["fix-auth"].NeedsYou);
        Assert.True(briefs["fix-auth"].Generating);
        Assert.Equal(DateTimeOffset.FromUnixTimeMilliseconds(1760000000000), briefs["fix-auth"].GeneratedAt);
        Assert.Null(briefs["new-one"].Headline);
        Assert.Equal("no transcript", briefs["new-one"].Error);
    }

    [Fact]
    public void ReadsUsage()
    {
        var providers = ProviderUsage.List((JsonObject)JsonNode.Parse("""
            {"providers": [
              {"provider": "claude", "name": "Claude", "plan": "Max 5x", "status": "ok", "error": null, "updatedAt": 1760000000000,
               "windows": [{"kind": "session", "label": "Session", "usedPercent": 61.5, "resetsAt": 1760003600000, "windowMinutes": 300},
                           {"kind": "weekly", "label": "Week", "usedPercent": 84, "resetsAt": null, "windowMinutes": null}]},
              {"provider": "codex", "name": "Codex", "plan": null, "windows": [], "status": "unavailable", "error": "Not signed in", "updatedAt": null, "resetCredits": 2}
            ]}
            """)!);
        var claude = providers[0];
        Assert.Equal(("Claude", "Max 5x", 2), (claude.Name, claude.Plan, claude.Windows.Count));
        Assert.Equal((62, UsageLevel.High), (claude.Windows[0].Percent, claude.Windows[0].Level));
        Assert.Equal(("Week", UsageLevel.Critical), (claude.Tightest?.Label, claude.Tightest?.Level));
        Assert.Equal(DateTimeOffset.FromUnixTimeMilliseconds(1760003600000), claude.Windows[0].ResetsAt);
        Assert.True(providers[1].Unavailable);
        Assert.Equal(2, providers[1].ResetCredits);
        Assert.Equal(UsageLevel.Normal, new UsageWindow("weekly", "Week", 59.9, null).Level);
    }

    [Theory]
    [InlineData(-5, "now")]
    [InlineData(30, "<1m")]
    [InlineData(45 * 60, "45m")]
    [InlineData(2 * 3600 + 13 * 60, "2h 13m")]
    [InlineData(3 * 3600, "3h")]
    [InlineData(3 * 86400 + 4 * 3600 + 59, "3d 4h")]
    [InlineData(2 * 86400, "2d")]
    public void WritesDurationsAsOrcDoes(int seconds, string text) => Assert.Equal(text, Insights.Duration(TimeSpan.FromSeconds(seconds)));
}

public sealed class SectionTests
{
    private static SessionInfo Session(string handle, string worktree, string path) => new(handle, handle, worktree, path, true, "claude", null, null);

    [Fact]
    public void GroupsByProjectInTheOrderOfEachProjectsFirstSession()
    {
        var sessions = new[] { Session("a", "p2", "/code/web"), Session("b", "p1", "/code/api"), Session("c", "p2", "/code/web") };
        var projects = new[] { new Project("p1", "/code/api", "api"), new Project("p2", "/code/web", null) };
        var sections = SessionSections.Build(sessions, projects);
        Assert.Equal(new[] { "web", "api" }, sections.Select(s => s.Title));
        Assert.Equal(new[] { "a", "c" }, sections[0].Sessions.Select(s => s.Handle));
    }

    [Fact]
    public void AFolderOutsideEveryProjectGetsItsOwnSection()
    {
        var sections = SessionSections.Build([Session("a", "local::/Users/me/scratch", "/Users/me/scratch")], []);
        Assert.Equal("scratch", Assert.Single(sections).Title);
    }

    [Fact]
    public void SameNamedProjectsShowTheirPaths()
    {
        var sessions = new[] { Session("a", "p1", "/one/app"), Session("b", "p2", "/two/app") };
        var sections = SessionSections.Build(sessions, [new Project("p1", "/one/app", null), new Project("p2", "/two/app", null)]);
        Assert.Equal(new[] { "app · /one/app", "app · /two/app" }, sections.Select(s => s.Title));
    }
}
