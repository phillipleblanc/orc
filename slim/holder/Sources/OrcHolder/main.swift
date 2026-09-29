import Darwin
import Foundation

let usage = """
usage: orc-holder --dir DIR --cols N --rows N [--cwd DIR] [--ring-bytes N] [--linger-seconds N] -- PROGRAM [ARGS...]
       orc-holder --version

Runs PROGRAM on a new PTY and serves it on DIR/sock until PROGRAM exits and a client closes the
session, or the linger period after exit elapses. PROGRAM runs with the holder's environment.
"""

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("orc-holder: \(message)\n".utf8))
    exit(2)
}

func parse(_ arguments: [String]) -> HolderOptions {
    var directory: String?
    var cwd: String?
    var cols: UInt16?
    var rows: UInt16?
    var ringLimit = 16 << 20
    var lingerSeconds = 3600
    var index = 0
    func value(_ flag: String) -> String {
        index += 1
        guard index < arguments.count else { fail("\(flag) needs a value\n\(usage)") }
        return arguments[index]
    }
    while index < arguments.count {
        let argument = arguments[index]
        switch argument {
        case "--version":
            print("orc-holder \(holderVersion) protocol \(holderProtocol)")
            exit(0)
        case "--dir": directory = value(argument)
        case "--cwd": cwd = value(argument)
        case "--cols": cols = UInt16(value(argument))
        case "--rows": rows = UInt16(value(argument))
        case "--ring-bytes": ringLimit = Int(value(argument)) ?? ringLimit
        case "--linger-seconds": lingerSeconds = Int(value(argument)) ?? lingerSeconds
        case "--":
            let program = Array(arguments[(index + 1)...])
            guard let directory, let cols, let rows, (1...1000).contains(cols), (1...500).contains(rows),
                  let executable = program.first else { fail(usage) }
            guard executable.hasPrefix("/") else { fail("PROGRAM must be an absolute path") }
            return HolderOptions(directory: directory, argv: program, cwd: cwd, cols: cols, rows: rows,
                                 ringLimit: ringLimit, lingerSeconds: lingerSeconds)
        default:
            fail("unknown argument \(argument)\n\(usage)")
        }
        index += 1
    }
    fail(usage)
}

signal(SIGPIPE, SIG_IGN)
signal(SIGHUP, SIG_IGN)
let options = parse(Array(CommandLine.arguments.dropFirst()))
do {
    let holder = try Holder(options: options)
    try holder.run()
} catch {
    fail("\(error)")
}
