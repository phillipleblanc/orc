import Foundation

public enum SessionCreationDefaults {
    public static func project(_ selector: String? = nil, in projects: [Workspace]) throws -> Workspace {
        let query = selector ?? "spiceai-project"
        let matches = projects.filter {
            if selector == nil, $0.hostId != nil, $0.hostId != "local" { return false }
            if query.hasPrefix("id:") { return $0.id == String(query.dropFirst(3)) }
            if query.hasPrefix("path:") { return $0.path == String(query.dropFirst(5)) }
            if query.hasPrefix("/") { return $0.path == query }
            return $0.name == query || URL(fileURLWithPath: $0.path).lastPathComponent == query
        }
        guard matches.count == 1, let project = matches.first else {
            if matches.isEmpty {
                let subject = selector == nil ? "Default local project" : "Project"
                throw OrcError("\(subject) '\(query)' is not registered in Orca. Run `orc projects` or use --project SELECTOR.")
            }
            throw OrcError("Multiple projects match '\(query)'. Use --project id:ID or --project path:/absolute/path to choose one.")
        }
        return project
    }

    public static func name(excluding existing: Set<String>) throws -> String {
        let reserved = Set(existing.map { $0.lowercased() })
        guard let name = names.filter({ !reserved.contains($0) }).randomElement() else {
            throw OrcError("All generated session names are in use. Choose a name with `orc new --name NAME`.")
        }
        return name
    }

    private static let verbs = [
        "bake", "beam", "bend", "bind", "bloom", "boost", "build", "carve",
        "chase", "cheer", "climb", "coast", "craft", "dance", "draw", "drift",
        "fetch", "find", "float", "forge", "glide", "glow", "grow", "guide",
        "hop", "hunt", "jump", "knit", "lift", "link", "march", "move",
        "paint", "plant", "play", "race", "ride", "rise", "roam", "roll",
        "sail", "seek", "shine", "skip", "soar", "spark", "spin", "swim"
    ]
    private static let nouns = [
        "ant", "ash", "bay", "bear", "bee", "bell", "bird", "boat",
        "book", "bull", "cave", "cloud", "coral", "crab", "crane", "creek",
        "crow", "cube", "deer", "dove", "drum", "duck", "dune", "eagle",
        "elm", "fern", "field", "fish", "flame", "fox", "frog", "frost",
        "gem", "goat", "gull", "hare", "hawk", "hill", "horse", "ibis",
        "jade", "jay", "kite", "lake", "lamb", "leaf", "lion", "lynx",
        "mink", "moon", "moose", "mouse", "oak", "orca", "otter", "owl",
        "panda", "pearl", "pine", "pond", "seal", "star", "wave", "wren"
    ]
    static let names = verbs.flatMap { verb in nouns.map { verb + "-" + $0 } }
}
