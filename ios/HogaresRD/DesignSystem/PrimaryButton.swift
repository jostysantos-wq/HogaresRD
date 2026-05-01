import SwiftUI

// MARK: - PrimaryButton
//
// The single canonical "primary action" button. Ink fill, white label,
// 12pt corners, 56pt tall when full-width. Switches to a `ProgressView`
// while `isLoading` is true. Implemented as a `ButtonStyle` so callers
// can keep using `Button(action:label:)` and just attach the style.
//
// Usage:
//   Button("Continuar", action: submit)
//       .buttonStyle(PrimaryButtonStyle(isLoading: viewModel.isSubmitting))
//
// Or call the convenience `PrimaryButton` view if you don't need a
// custom label.

struct PrimaryButtonStyle: ButtonStyle {
    var isLoading: Bool = false

    func makeBody(configuration: Configuration) -> some View {
        ZStack {
            configuration.label
                .font(.body.weight(.semibold))
                .foregroundStyle(Color.white)
                .opacity(isLoading ? 0 : 1)
            if isLoading {
                ProgressView()
                    .tint(.white)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 56)
        .background(
            RoundedRectangle(cornerRadius: Radius.medium, style: .continuous)
                .fill(Color.rdInk)
                .opacity(configuration.isPressed ? 0.85 : 1.0)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Radius.medium, style: .continuous)
                .stroke(Color.clear)
        )
        .scaleEffect(configuration.isPressed ? 0.98 : 1.0)
        .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
        .accessibilityAddTraits(isLoading ? .updatesFrequently : [])
    }
}

/// Convenience wrapper so common cases don't have to spell out the
/// style call site by site.
struct PrimaryButton: View {
    let title: String
    var isLoading: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
        }
        .buttonStyle(PrimaryButtonStyle(isLoading: isLoading))
        .disabled(isLoading)
    }
}

#Preview("PrimaryButton") {
    VStack(spacing: Spacing.s16) {
        PrimaryButton(title: "Continuar") {}
        PrimaryButton(title: "Guardando…", isLoading: true) {}
    }
    .padding()
    .background(Color.rdBg)
}
