import SwiftUI

// MARK: - FormCard
//
// Cardified form section: cream `rdSurface` background, 16pt internal
// padding, optional sentence-case header, automatic dividers between
// children. Use this instead of building one-off `VStack { … }` cards
// in every screen.
//
// Children pass via the trailing `@ViewBuilder content` closure. Use
// `LabeledRow` (see below) for individual label/value rows so the
// rhythm is consistent.
//
// Example:
//   FormCard("Datos personales") {
//       LabeledRow("Nombre") { Text("Maria") }
//       LabeledRow("Email")  { Text("maria@x.com") }
//   }

struct FormCard<Content: View>: View {
    let title: String?
    @ViewBuilder var content: () -> Content

    init(_ title: String? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s12) {
            if let title {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.rdInk)
                    .padding(.horizontal, Spacing.s4)
            }

            VStack(spacing: 0) {
                _VariadicView.Tree(DividedLayout()) {
                    content()
                }
            }
            .padding(Spacing.s16)
            .background(
                RoundedRectangle(cornerRadius: Radius.large, style: .continuous)
                    .fill(Color.rdSurface)
            )
        }
    }
}

// MARK: - Internal: dividers between children
//
// `_VariadicView.Tree` is the (Apple-internal-but-stable) hook that
// lets us insert a `Divider` between every direct child of the form
// card, no matter how the caller arranges them. SwiftUI itself uses
// the same hook for `Section`'s row layout.
private struct DividedLayout: _VariadicView_UnaryViewRoot {
    @ViewBuilder
    func body(children: _VariadicView.Children) -> some View {
        let last = children.last?.id
        ForEach(children) { child in
            child
            if child.id != last {
                Divider().opacity(0.4)
            }
        }
    }
}

#Preview("FormCard") {
    ScrollView {
        VStack(spacing: Spacing.s16) {
            FormCard("Datos personales") {
                LabeledRow("Nombre") { Text("Maria del Carmen") }
                LabeledRow("Email")  { Text("maria@example.com") }
                LabeledRow("Teléfono") { Text("+1 809 555 0142") }
            }
            FormCard {
                LabeledRow("Sin título") { Text("Funciona también") }
            }
        }
        .padding()
    }
    .background(Color.rdBg)
}
