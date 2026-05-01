import SwiftUI

// MARK: - LabeledRow
//
// Form-card row pattern: leading label, trailing value/control.
// Wraps SwiftUI's `LabeledContent` so we get accessibility for free
// while still pinning our spacing rules. Use inside `FormCard { }`.
//
// Examples:
//   LabeledRow("Nombre") { Text("Maria") }
//   LabeledRow("Notificaciones") { Toggle("", isOn: $on).labelsHidden() }

struct LabeledRow<Content: View>: View {
    let label: String
    @ViewBuilder var content: () -> Content

    init(_ label: String, @ViewBuilder content: @escaping () -> Content) {
        self.label = label
        self.content = content
    }

    var body: some View {
        LabeledContent {
            content()
                .foregroundStyle(Color.rdInkSoft)
        } label: {
            Text(label)
                .font(.body)
                .foregroundStyle(Color.rdInk)
        }
        .padding(.vertical, Spacing.s8)
    }
}

#Preview("LabeledRow") {
    VStack(spacing: 0) {
        LabeledRow("Nombre") { Text("Maria del Carmen") }
        Divider().opacity(0.4)
        LabeledRow("Plan") { Text("Broker") }
        Divider().opacity(0.4)
        LabeledRow("Notificaciones") { Toggle("", isOn: .constant(true)).labelsHidden() }
    }
    .padding()
    .background(Color.rdSurface)
}
