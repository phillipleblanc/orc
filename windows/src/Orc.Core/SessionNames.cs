using System.Globalization;
using System.Text;

namespace Orc.Core;

/// <summary>The runtime's rule for session names, which are also directory and file names (Session.isValidName).</summary>
public static class SessionNames
{
    public const int MaxLength = 64;

    /// <summary>Why <paramref name="name"/> cannot name a session, or null when it can.</summary>
    public static string? Problem(string name)
    {
        if (name.Length == 0) return "Enter a name.";
        if (name != name.Trim()) return "A name cannot start or end with spaces.";
        if (name.Length > MaxLength) return $"Use at most {MaxLength} characters.";
        if (name.StartsWith('.')) return "A name cannot start with \".\".";
        if (name.Contains('/')) return "A name cannot contain \"/\".";
        if (name.Any(c => char.IsControl(c) || CharUnicodeInfo.GetUnicodeCategory(c) == UnicodeCategory.Format)) return "A name cannot contain control characters.";
        if (!name.IsNormalized(NormalizationForm.FormC)) return "Use the composed (NFC) form of the name.";
        return null;
    }

    /// <summary>A child's full name: the parent's, a hyphen, and the suffix (SessionHierarchy.childName).</summary>
    public static string ChildName(SessionInfo parent, string suffix)
    {
        suffix = suffix.Trim();
        if (suffix.Length == 0) throw new ArgumentException("Enter a child session name.");
        var name = parent.Name + "-" + suffix;
        if (Encoding.UTF8.GetByteCount(name) > 200 || name.Any(char.IsControl))
            throw new ArgumentException("Choose a combined session name of at most 200 bytes without control characters.");
        return name;
    }
}
