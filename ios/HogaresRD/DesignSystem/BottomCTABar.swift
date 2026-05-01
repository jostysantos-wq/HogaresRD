import SwiftUI

// MARK: - BottomCTABar
//
// `.bottomCTA(...)` modifier that anchors a primary action (with an
// optional secondary text button) to the bottom safe-area inset. Uses
// `.ultraThinMaterial` so content scrolling underneath stays visible
// while the bar floats. Designed for forms where the user spends time
// scrolling and we don't want them to lose the CTA.

private struct BottomCTABarModifier: ViewModifier {
    let title: String
    let isLoading: Bool
    let action: () -> Void
    let secondaryTitle: String?
    let secondaryAction: (() -> Void)?

    func body(content: Content) -> some View {
        content
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 0) {
                    Divider().background(Color.rdLine)
                    VStack(spacing: Spacing.s8) {
                        PrimaryButton(title: title, isLoading: isLoading, action: action)
                        if let secondaryTitle, let secondaryAction {
                            Button(secondaryTitle, action: secondaryAction)
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(Color.rdInkSoft)
                                .padding(.top, 2)
                        }
                    }
                    .padding(.horizontal, Spacing.s16)
                    .padding(.top, Spacing.s12)
                    .padding(.bottom, Spacing.s8)
                }
                .background(.ultraThinMaterial)
            }
    }
}

extension View {
    /// Pin a primary CTA button to the bottom safe area, with an
    /// optional secondary text button beneath it.
    func bottomCTA(
        title: String,
        isLoading: Bool = false,
        action: @escaping () -> Void,
        secondaryTitle: String? = nil,
        secondaryAction: (() -> Void)? = nil
    ) -> some View {
        modifier(BottomCTABarModifier(
            title: title,
            isLoading: isLoading,
            action: action,
            secondaryTitle: secondaryTitle,
            secondaryAction: secondaryAction
        ))
    }
}

#Preview("BottomCTABar") {
    NavigationStack {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.s16) {
                ForEach(0..<20, id: \.self) { i in
                    Text("Línea de contenido #\(i)")
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding()
                        .background(Color.rdSurface)
                        .clipShape(RoundedRectangle(cornerRadius: Radius.medium))
                }
            }
            .padding()
        }
        .background(Color.rdBg)
        .bottomCTA(
            title: "Enviar solicitud",
            isLoading: false,
            action: {},
            secondaryTitle: "Cancelar",
            secondaryAction: {}
        )
    }
}
