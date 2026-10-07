import Foundation

/// What the programs in a terminal report about themselves with OSC 7501, the Program Status Protocol, as the runtime
/// keeps it: records by id ("" for the root) and the most urgent of their states.
public struct ProgramStatus: Codable, Hashable {
    public struct Record: Codable, Hashable {
        public let id: String
        /// `idle`, `working`, `done`, `blocked` or `error`.
        public let state: String
        /// What a blocked program waits for: `permission`, `question` or `auth`.
        public let kind: String?
        public let progress: Int?
        public let app: String?
        public let title: String?
        public let msg: String?

        public init(id: String = "", state: String, kind: String? = nil, progress: Int? = nil, app: String? = nil, title: String? = nil, msg: String? = nil) {
            self.id = id; self.state = state; self.kind = kind; self.progress = progress; self.app = app; self.title = title; self.msg = msg
        }

        /// The state in a few words, with a blocked program's reason and a working one's progress.
        public var stateText: String {
            switch state {
            case "working": return progress.map { "working, \($0)%" } ?? "working"
            case "blocked":
                switch kind {
                case "permission": return "needs permission"
                case "question": return "has a question"
                case "auth": return "needs you to sign in"
                default: return "needs you"
                }
            case "error": return "failed"
            default: return state
            }
        }

        /// What it says it is doing, or its state.
        public var text: String {
            let said = msg ?? title
            guard let said else { return stateText }
            if state == "working", let progress { return "\(said) · \(progress)%" }
            return said
        }
    }

    public let state: String?
    public let records: [Record]

    public init(state: String?, records: [Record]) {
        self.state = state; self.records = records
    }

    /// The record that speaks for the terminal: the most urgent one, the root first among equals.
    public var lead: Record? {
        let urgent = records.filter { $0.state == state }
        return urgent.first { $0.id.isEmpty } ?? urgent.first ?? records.first
    }

    /// The program's name, as it reported it.
    public var app: String? { lead?.app }

    /// A line for the session: what the most urgent program says it is doing.
    public var text: String? { lead?.text }
}
