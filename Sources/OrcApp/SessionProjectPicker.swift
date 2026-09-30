import SwiftUI
import OrcKit

struct SessionProjectPicker: View {
    let projects: [Workspace]
    @Binding var selection: String?

    var body: some View {
        Picker("Project", selection: $selection) {
            Text("All projects").tag(String?.none)
            ForEach(projects) { project in
                Text(projects.filter { $0.name == project.name }.count > 1
                     ? "\(project.name) · \(project.path)" : project.name)
                    .tag(Optional(project.id))
            }
        }
        .labelsHidden().accessibilityLabel("Filter by project")
    }
}
