import Foundation
import Capacitor
import Security

/**
 * Keychain-backed storage for the Microsoft refresh token.
 *
 * Capacitor's Preferences plugin is backed by UserDefaults, which is neither
 * encrypted nor excluded from unencrypted backups — the wrong place for a
 * credential that grants access to someone's Xbox account. Items here use
 * kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly: available to background
 * refreshes after the first unlock, but never migrated to another device.
 */
@objc(KeychainPlugin)
public class KeychainPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "KeychainPlugin"
    public let jsName = "Keychain"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]

    private let service = "io.williamsdigital.relay"

    private func query(for key: String) -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key
        ]
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("key is required")
            return
        }

        var lookup = query(for: key)
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(lookup as CFDictionary, &item)

        if status == errSecItemNotFound {
            call.resolve(["value": NSNull()])
            return
        }
        guard status == errSecSuccess,
              let data = item as? Data,
              let value = String(data: data, encoding: .utf8) else {
            // Report absence rather than an error: a caller cannot do anything
            // useful with a keychain failure except prompt for sign-in, which
            // is what a nil value already triggers.
            call.resolve(["value": NSNull()])
            return
        }
        call.resolve(["value": value])
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = call.getString("key"),
              let value = call.getString("value"),
              let data = value.data(using: .utf8) else {
            call.reject("key and value are required")
            return
        }

        // Replace rather than update, so a changed accessibility attribute
        // actually takes effect.
        SecItemDelete(query(for: key) as CFDictionary)

        var insert = query(for: key)
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

        let status = SecItemAdd(insert as CFDictionary, nil)
        if status == errSecSuccess {
            call.resolve()
        } else {
            call.reject("Could not save to the keychain (status \(status))")
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("key is required")
            return
        }
        let status = SecItemDelete(query(for: key) as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound {
            call.resolve()
        } else {
            call.reject("Could not remove from the keychain (status \(status))")
        }
    }
}
