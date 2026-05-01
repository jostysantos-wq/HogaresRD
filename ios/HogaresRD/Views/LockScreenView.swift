import SwiftUI

/// Full-screen overlay shown when the app is locked after idle timeout.
/// Requires Face ID / Touch ID to dismiss. Falls back to "Cerrar sesion".
struct LockScreenView: View {
    @EnvironmentObject var api: APIService
    @EnvironmentObject var lockManager: AppLockManager

    @State private var error: String?
    @State private var loading = false

    private let bio = BiometricService.shared

    var body: some View {
        ZStack {
            // Background
            LinearGradient(
                colors: [Color(red: 0, green: 0.07, blue: 0.19), Color.rdBlue],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer()

                // Logo
                Image(systemName: "house.fill")
                    .font(.system(size: 36))
                    .foregroundStyle(.white)
                Text("HogaresRD")
                    .font(.title2).bold()
                    .foregroundStyle(.white)
                    .padding(.top, 8)

                Spacer().frame(height: 48)

                // User avatar
                if let user = api.currentUser {
                    ZStack {
                        Circle()
                            .fill(.white.opacity(0.15))
                            .frame(width: 72, height: 72)
                        Text(user.initials)
                            .font(.title).bold()
                            .foregroundStyle(.white)
                    }
                    .overlay(Circle().stroke(.white.opacity(0.3), lineWidth: 2))

                    Text(user.name)
                        .font(.headline)
                        .foregroundStyle(.white)
                        .padding(.top, 10)
                }

                Spacer().frame(height: 40)

                // Biometric button
                Button {
                    Task { await authenticate() }
                } label: {
                    ZStack {
                        Circle()
                            .fill(.white.opacity(0.1))
                            .frame(width: 88, height: 88)
                            .overlay(Circle().stroke(.white.opacity(0.25), lineWidth: 2))

                        if loading {
                            ProgressView()
                                .tint(.white)
                                .scaleEffect(1.3)
                        } else {
                            Image(systemName: bio.biometricIcon)
                                .font(.system(size: 40))
                                .foregroundStyle(.white)
                        }
                    }
                }
                .disabled(loading)
                .accessibilityLabel("Desbloquear con \(bio.biometricLabel)")
                .accessibilityHint("Autentica con biometría para entrar a la app")

                Text(bio.isAvailable
                     ? "Usa \(bio.biometricLabel) para continuar"
                     : "Toca para desbloquear")
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.7))
                    .padding(.top, 16)

                if let err = error {
                    Text(err)
                        .font(.caption)
                        .foregroundStyle(Color.rdRed)
                        .padding(.top, 8)
                        .accessibilityLabel("Error: \(err)")
                }

                Spacer()

                // Logout fallback
                Button {
                    api.logout()
                    lockManager.unlock()
                } label: {
                    Text("Cerrar sesion")
                        .font(.subheadline)
                        .foregroundStyle(.white.opacity(0.5))
                        .underline()
                }
                .padding(.bottom, 60)
            }
        }
        .task {
            // Auto-trigger biometric on appear
            try? await Task.sleep(for: .milliseconds(500))
            await authenticate()
        }
    }

    private func authenticate() async {
        error = nil
        loading = true
        do {
            let ok = try await bio.authenticate(reason: "Desbloquea HogaresRD")
            if ok {
                await MainActor.run { lockManager.unlock() }
            } else {
                error = "Verificacion cancelada"
            }
        } catch {
            self.error = "Error al verificar"
        }
        loading = false
    }
}
