import LocalAuthentication
import Security

class BiometricService {
    static let shared = BiometricService()

    enum BiometricType { case faceID, touchID, none }

    var availableType: BiometricType {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
            return .none
        }
        return context.biometryType == .faceID ? .faceID : .touchID
    }

    var isAvailable: Bool { availableType != .none }

    var biometricLabel: String {
        switch availableType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        case .none: return "Biometrico"
        }
    }

    var biometricIcon: String {
        switch availableType {
        case .faceID: return "faceid"
        case .touchID: return "touchid"
        case .none: return "lock.shield"
        }
    }

    func authenticate(reason: String) async throws -> Bool {
        let context = LAContext()
        context.localizedCancelTitle = "Cancelar"
        return try await context.evaluatePolicy(
            .deviceOwnerAuthenticationWithBiometrics,
            localizedReason: reason
        )
    }

    // MARK: - Keychain

    private let service = "com.hogaresrd.biometric"

    func saveBiometricToken(_ token: String, for email: String) throws {
        let data = Data(token.utf8)

        // Delete existing
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: email,
        ]
        SecItemDelete(deleteQuery as CFDictionary)

        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: email,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
        ]
        let status = SecItemAdd(addQuery as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: "BiometricService", code: Int(status), userInfo: [NSLocalizedDescriptionKey: "Error guardando token biometrico"])
        }
    }

    func getBiometricToken(for email: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: email,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func deleteBiometricToken(for email: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: email,
        ]
        SecItemDelete(query as CFDictionary)
    }

    func hasBiometricToken(for email: String) -> Bool {
        return getBiometricToken(for: email) != nil
    }

    /// Get the saved email for biometric login (if any)
    func savedBiometricEmail() -> String? {
        UserDefaults.standard.string(forKey: "rd_biometric_email")
    }

    func saveBiometricEmail(_ email: String) {
        UserDefaults.standard.set(email, forKey: "rd_biometric_email")
    }

    func clearBiometricEmail() {
        UserDefaults.standard.removeObject(forKey: "rd_biometric_email")
    }
}
