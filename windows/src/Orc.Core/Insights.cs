using System.Text.Json.Nodes;

namespace Orc.Core;

/// <summary>
/// Where an agent session's work stands, as the host's <c>brief.list</c> reports it: written by a model from the
/// agent's transcript (Sources/OrcKit/AgentBrief.swift).
/// </summary>
public sealed record AgentBrief(string Name, string? Headline, string? Goal, string? Now, string? NeedsYou, DateTimeOffset? GeneratedAt,
    string? Error, bool Generating)
{
    /// <summary>The briefs in a <c>brief.list</c> result, by session name.</summary>
    public static IReadOnlyDictionary<string, AgentBrief> List(JsonObject result)
    {
        var briefs = new Dictionary<string, AgentBrief>();
        foreach (var record in (result["briefs"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
        {
            if (record["name"]?.ToString() is not { Length: > 0 } name || briefs.ContainsKey(name)) continue;
            var brief = record["brief"] as JsonObject;
            briefs[name] = new AgentBrief(name, Text(brief?["headline"]), Text(brief?["goal"]), Text(brief?["now"]), Text(brief?["needsYou"]),
                Insights.Time(record["generatedAt"]), Text(record["error"]), record["generating"] is JsonValue g && g.TryGetValue(out bool generating) && generating);
        }
        return briefs;
    }

    private static string? Text(JsonNode? node) => node is JsonValue value && value.TryGetValue(out string? text) && !string.IsNullOrWhiteSpace(text) ? text.Trim() : null;
}

/// <summary>How close a usage window is to its limit: worth noticing from 60 percent, urgent from 80.</summary>
public enum UsageLevel { Normal, High, Critical }

/// <summary>A rate-limit window: a session (five hours), the week, or the week on one model.</summary>
public sealed record UsageWindow(string Kind, string Label, double UsedPercent, DateTimeOffset? ResetsAt)
{
    public UsageLevel Level => UsedPercent >= 80 ? UsageLevel.Critical : UsedPercent >= 60 ? UsageLevel.High : UsageLevel.Normal;
    public int Percent => (int)Math.Round(UsedPercent, MidpointRounding.AwayFromZero);
}

/// <summary>An agent's subscription usage, as the host's <c>usage.read</c> reports it (Sources/OrcKit/AgentUsage.swift).</summary>
public sealed record ProviderUsage(string Provider, string Name, string? Plan, IReadOnlyList<UsageWindow> Windows, int? ResetCredits,
    string Status, string? Error, DateTimeOffset? UpdatedAt)
{
    /// <summary>Not installed or not signed in on the host: not shown.</summary>
    public bool Unavailable => Status == "unavailable";

    /// <summary>The window closest to its limit.</summary>
    public UsageWindow? Tightest => Windows.MaxBy(w => w.UsedPercent);

    /// <summary>The providers in a <c>usage.read</c> result.</summary>
    public static IReadOnlyList<ProviderUsage> List(JsonObject result) =>
        (result["providers"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().Select(provider => new ProviderUsage(
            provider["provider"]?.ToString() ?? "", provider["name"]?.ToString() ?? provider["provider"]?.ToString() ?? "",
            provider["plan"] is JsonValue plan && plan.TryGetValue(out string? p) ? p : null,
            (provider["windows"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().Select(window => new UsageWindow(
                window["kind"]?.ToString() ?? "", window["label"]?.ToString() ?? "",
                window["usedPercent"] is JsonValue used && used.TryGetValue(out double percent) ? Math.Clamp(percent, 0, 100) : 0,
                Insights.Time(window["resetsAt"]))).ToList(),
            provider["resetCredits"] is JsonValue credits && credits.TryGetValue(out int c) ? c : null,
            provider["status"]?.ToString() ?? "ok",
            provider["error"] is JsonValue error && error.TryGetValue(out string? e) ? e : null,
            Insights.Time(provider["updatedAt"]))).ToList();
}

public static class Insights
{
    /// <summary>A time the host gives in Unix milliseconds.</summary>
    internal static DateTimeOffset? Time(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue(out double milliseconds) && double.IsFinite(milliseconds)
            ? DateTimeOffset.FromUnixTimeMilliseconds((long)milliseconds) : null;

    /// <summary>A length of time, coarsely, as Orc.app writes it: "now", "&lt;1m", "45m", "2h 13m", "3d 4h".</summary>
    public static string Duration(TimeSpan interval)
    {
        if (interval <= TimeSpan.Zero) return "now";
        var minutes = (int)interval.TotalMinutes;
        if (minutes < 1) return "<1m";
        if (minutes < 60) return $"{minutes}m";
        var (hours, remainder) = (minutes / 60, minutes % 60);
        if (hours >= 24) return hours % 24 > 0 ? $"{hours / 24}d {hours % 24}h" : $"{hours / 24}d";
        return remainder > 0 ? $"{hours}h {remainder}m" : $"{hours}h";
    }
}
