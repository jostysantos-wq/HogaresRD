import Foundation
import Security

/// Lightweight wrapper around the iOS Keychain for storing string-valued
/// session credentials (JWT, encoded user profile JSON). Mirrors the
/// pattern used by `BiometricService` but exposes a generic-account API
/// so APIService can stash multiple slots under a shared service name.
///
/// Items are stored with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`
/// so they survive app backgrounding but never sync via iCloud Keychain
/// or get included in encrypted iTunes/Finder backups.
enum KeychainStore {
    /// All credential items live under this service. Distinct accounts
    /// (e.g. `rd_token`, `rd_user`) keep separate slots.
    private static let service = "rd-credentials"

    /// Persist `value` under `account`, replacing any existing entry.
    /// Returns true if the write succeeded.
    @discardableResult
    static func saveString(_ value: String, account: String) -> Bool {
        let data = Data(value.utf8)

        // Delete any existing item first — SecItemAdd would otherwise
        // return errSecDuplicateItem.
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(deleteQuery as CFDictionary)

        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemAdd(addQuery as CFDictionary, nil)
        return status == errSecSuccess
    }

    /// Persist arbitrary `Data` under `account`, replacing any existing entry.
    @discardableResult
    static func saveData(_ data: Data, account: String) -> Bool {
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(deleteQuery as CFDictionary)

        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemAdd(addQuery as CFDictionary, nil)
        return status == errSecSuccess
    }

    /// Read the string previously stored under `account`, or nil if absent.
    static func loadString(account: String) -> String? {
        guard let data = loadData(account: account) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Read the raw `Data` previously stored under `account`, or nil if absent.
    static func loadData(account: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess else { return nil }
        return result as? Data
    }

    /// Remove the entry under `account`. Idempotent.
    static func delete(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
