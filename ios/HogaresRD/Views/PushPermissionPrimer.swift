import SwiftUI

// MARK: - Push Permission Primer (contextual soft-ask)
//
// A custom in-app popup shown before the native iOS notification prompt.
// Appears after high-intent actions (favoriting a listing, saving a search,
// etc) when system authorization is still .notDetermined. Explains the
// value of push notifications so the user is primed to tap "Allow" on the
// subsequent native prompt — dramatically improving opt-in rates vs
// cold-asking at first launch.

struct PushPermissionPrimer: View {
    @Binding var isPresented: Bool
    @EnvironmentObject var pushService: PushNotificationService

    @State private var requesting = false
    @State private var grantedSuccess = false

    var body: some View {
        ZStack {
            // Dimmed background — tap outside to dismiss as "Not now"
            Color.black.opacity(0.4)
                .ignoresSafeArea()
                .onTapGesture { dismissNotNow() }

            VStack(spacing: 0) {
                // Close button row
                HStack {
                    Spacer()
                    Button { dismissNotNow() } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 28))
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.bottom, 4)

                if grantedSuccess {
                    successCard
                } else {
                    primerCard
                }
            }
            .padding(24)
            .background(Color(.systemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 20))
            .shadow(color: .black.opacity(0.2), radius: 20, y: 10)
            .padding(.horizontal, 28)
            .transition(.scale(scale: 0.85).combined(with: .opacity))
        }
        .transition(.opacity)
    }

    // MARK: - Primer Card

    private var primerCard: some View {
        VStack(spacing: 18) {
            // Icon
            ZStack {
                Circle()
                    .fill(Color.rdBlue.opacity(0.12))
                    .frame(width: 72, height: 72)
                Image(systemName: "bell.badge.fill")
                    .font(.system(size: 34))
                    .foregroundStyle(Color.rdBlue)
            }

            // Title
            Text("No te pierdas de nada")
                .font(.title3.bold())
                .multilineTextAlignment(.center)

            // Body copy
            Text("Activa las notificaciones para recibir alertas sobre tus propiedades favoritas, mensajes de agentes y mas.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            // Feature list
            VStack(alignment: .leading, spacing: 10) {
                featureRow(icon: "arrow.down.circle.fill", color: .rdGreen,
                           text: "Bajadas de precio en tus favoritos")
                featureRow(icon: "house.fill", color: .rdBlue,
                           text: "Nuevos listados que coinciden con tu busqueda")
                featureRow(icon: "bubble.left.fill", color: Color.rdPurple,
                           text: "Mensajes de agentes")
                featureRow(icon: "doc.text.fill", color: .orange,
                           text: "Actualizaciones de tus aplicaciones")
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 12))

            // Primary action
            Button {
                Task { await requestPermission() }
            } label: {
                HStack(spacing: 8) {
                    if requesting {
                        ProgressView().tint(.white)
                    } else {
                        Image(systemName: "bell.fill")
                            .font(.system(size: 14))
                    }
                    Text(requesting ? "Solicitando..." : "Activar notificaciones")
                        .font(.subheadline.bold())
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(Color.rdBlue, in: RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)
            .disabled(requesting)

            // Secondary (Not now)
            Button {
                dismissNotNow()
            } label: {
                Text("Ahora no")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Success Card

    private var successCard: some View {
        VStack(spacing: 16) {
            ZStack {
                Circle()
                    .fill(Color.rdGreen.opacity(0.12))
                    .frame(width: 72, height: 72)
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 42))
                    .foregroundStyle(Color.rdGreen)
            }

            Text("Listo!")
                .font(.title3.bold())

            Text("Las notificaciones estan activadas. Te avisaremos cuando haya novedades importantes para ti.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            Button {
                withAnimation(.easeInOut(duration: 0.25)) { isPresented = false }
            } label: {
                Text("Cerrar")
                    .font(.subheadline.bold())
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(Color.rdGreen, in: RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Feature Row

    private func featureRow(icon: String, color: Color, text: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 14))
                .foregroundStyle(color)
                .frame(width: 22)
            Text(text)
                .font(.caption)
                .foregroundStyle(.primary)
            Spacer()
        }
    }

    // MARK: - Actions

    private func requestPermission() async {
        requesting = true
        let granted = await pushService.requestPermission()
        requesting = false

        if granted {
            await MainActor.run {
                pushService.enableAllPreferences()
            }
            withAnimation(.easeInOut(duration: 0.25)) { grantedSuccess = true }
            // Auto dismiss after 2.5s
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(2.5))
                withAnimation(.easeInOut(duration: 0.25)) { isPresented = false }
            }
        } else {
            // Native iOS said no — store dismissal so we don't nag
            UserDefaults.standard.set(Date().timeIntervalSince1970,
                                      forKey: SavedStore.SOFT_ASK_DISMISSED_KEY)
            withAnimation(.easeInOut(duration: 0.25)) { isPresented = false }
        }
    }

    private func dismissNotNow() {
        UserDefaults.standard.set(Date().timeIntervalSince1970,
                                  forKey: SavedStore.SOFT_ASK_DISMISSED_KEY)
        withAnimation(.easeInOut(duration: 0.25)) { isPresented = false }
    }
}
