import Foundation
import StoreKit

// ══════════════════════════════════════════════════════════════════════════
// HogaresRD — StoreKit 2 Subscription Manager
//
// Product IDs (App Store Connect):
//   com.hogaresrd.broker.monthly       — $9.99/mo
//   com.hogaresrd.inmobiliaria.monthly  — $24.99/mo
//   com.hogaresrd.constructora.monthly  — $24.99/mo
// ══════════════════════════════════════════════════════════════════════════

@MainActor
class StoreManager: ObservableObject {
    static let shared = StoreManager()

    // Product IDs matching App Store Connect
    static let productIDs: Set<String> = [
        "com.hogaresrd.broker.monthly",
        "com.hogaresrd.inmobiliaria.monthly",
        "com.hogaresrd.constructora.monthly",
    ]

    // Map product ID → app role
    static let roleMap: [String: String] = [
        "com.hogaresrd.broker.monthly": "broker",
        "com.hogaresrd.inmobiliaria.monthly": "inmobiliaria",
        "com.hogaresrd.constructora.monthly": "constructora",
    ]

    @Published var products: [Product] = []
    @Published var purchasedProductIDs: Set<String> = []
    @Published var isLoading = false
    @Published var error: String?
    @Published var activeSubscription: StoreKit.Transaction?

    private var transactionListener: Task<Void, Never>?

    // Sorted products for display (broker < inmobiliaria < constructora)
    var sortedProducts: [Product] {
        let order = ["com.hogaresrd.broker.monthly", "com.hogaresrd.inmobiliaria.monthly", "com.hogaresrd.constructora.monthly"]
        return products.sorted { order.firstIndex(of: $0.id) ?? 99 < order.firstIndex(of: $1.id) ?? 99 }
    }

    var hasActiveSubscription: Bool { !purchasedProductIDs.isEmpty }

    var activeRole: String? {
        for pid in purchasedProductIDs {
            if let role = Self.roleMap[pid] { return role }
        }
        return nil
    }

    // ── Init ────────────────────────────────────────────────────

    init() {
        transactionListener = listenForTransactions()
    }

    deinit {
        transactionListener?.cancel()
    }

    // ── Load Products ───────────────────────────────────────────

    func loadProducts() async {
        guard products.isEmpty else { return }
        isLoading = true
        error = nil
        do {
            let storeProducts = try await Product.products(for: Self.productIDs)
            products = storeProducts
            await updatePurchasedProducts()
        } catch {
            self.error = "No se pudieron cargar los planes: \(error.localizedDescription)"
            print("[StoreManager] Load products error:", error)
        }
        isLoading = false
    }

    // ── Purchase ────────────────────────────────────────────────

    func purchase(_ product: Product) async -> Bool {
        isLoading = true
        error = nil
        do {
            let result = try await product.purchase()
            switch result {
            case .success(let verification):
                let transaction = try checkVerified(verification)
                await transaction.finish()
                await updatePurchasedProducts()
                // Notify server of the purchase
                await syncWithServer(transaction: transaction)
                isLoading = false
                return true

            case .userCancelled:
                isLoading = false
                return false

            case .pending:
                error = "Compra pendiente de aprobación."
                isLoading = false
                return false

            @unknown default:
                isLoading = false
                return false
            }
        } catch {
            self.error = "Error al procesar la compra: \(error.localizedDescription)"
            print("[StoreManager] Purchase error:", error)
            isLoading = false
            return false
        }
    }

    // ── Restore Purchases ───────────────────────────────────────

    func restorePurchases() async {
        isLoading = true
        error = nil
        do {
            try await AppStore.sync()
            await updatePurchasedProducts()
        } catch {
            self.error = "Error al restaurar compras: \(error.localizedDescription)"
        }
        isLoading = false
    }

    // ── Transaction Listener ────────────────────────────────────

    private func listenForTransactions() -> Task<Void, Never> {
        Task.detached {
            for await result in StoreKit.Transaction.updates {
                do {
                    let transaction = try self.checkVerified(result)
                    await transaction.finish()
                    await self.updatePurchasedProducts()
                    await self.syncWithServer(transaction: transaction)
                } catch {
                    print("[StoreManager] Transaction update error:", error)
                }
            }
        }
    }

    // ── Update Purchased Status ─────────────────────────────────

    func updatePurchasedProducts() async {
        var purchased: Set<String> = []
        var latestTransaction: StoreKit.Transaction?

        for await result in StoreKit.Transaction.currentEntitlements {
            if let transaction = try? checkVerified(result) {
                if transaction.revocationDate == nil {
                    purchased.insert(transaction.productID)
                    if latestTransaction == nil || transaction.purchaseDate > (latestTransaction?.purchaseDate ?? .distantPast) {
                        latestTransaction = transaction
                    }
                }
            }
        }

        purchasedProductIDs = purchased
        activeSubscription = latestTransaction
    }

    // ── Verify Transaction ──────────────────────────────────────

    private func checkVerified<T>(_ result: VerificationResult<T>) throws -> T {
        switch result {
        case .unverified(_, let error):
            throw error
        case .verified(let item):
            return item
        }
    }

    // ── Server Sync ─────────────────────────────────────────────
    // Notify the backend of subscription changes so it can upgrade/downgrade the user role

    private func syncWithServer(transaction: StoreKit.Transaction) async {
        guard let api = await getAPIService() else { return }
        let role = Self.roleMap[transaction.productID] ?? "user"

        do {
            try await api.syncAppleSubscription(
                productID: transaction.productID,
                transactionID: String(transaction.id),
                originalTransactionID: String(transaction.originalID),
                role: role,
                expirationDate: transaction.expirationDate?.ISO8601Format()
            )
            print("[StoreManager] Server synced: \(transaction.productID) → \(role)")
        } catch {
            print("[StoreManager] Server sync failed:", error.localizedDescription)
        }
    }

    @MainActor
    private func getAPIService() -> APIService? {
        // Access the shared API service
        // This is a workaround since StoreManager isn't in the SwiftUI environment
        return nil // Will be set via setAPIService()
    }

    // Injected API reference
    private var _api: APIService?

    func setAPIService(_ api: APIService) {
        _api = api
    }

    func syncCurrentSubscription() async {
        guard let transaction = activeSubscription, let api = _api else { return }
        let role = Self.roleMap[transaction.productID] ?? "user"
        do {
            try await api.syncAppleSubscription(
                productID: transaction.productID,
                transactionID: String(transaction.id),
                originalTransactionID: String(transaction.originalID),
                role: role,
                expirationDate: transaction.expirationDate?.ISO8601Format()
            )
        } catch {
            print("[StoreManager] Sync error:", error.localizedDescription)
        }
    }

    // ── Helpers ──────────────────────────────────────────────────

    func product(for id: String) -> Product? {
        products.first { $0.id == id }
    }

    func isPurchased(_ productID: String) -> Bool {
        purchasedProductIDs.contains(productID)
    }

    func displayPrice(for product: Product) -> String {
        product.displayPrice
    }

    func planName(for productID: String) -> String {
        switch productID {
        case "com.hogaresrd.broker.monthly": return "Broker"
        case "com.hogaresrd.inmobiliaria.monthly": return "Inmobiliaria"
        case "com.hogaresrd.constructora.monthly": return "Constructora"
        default: return "Plan"
        }
    }

    func planIcon(for productID: String) -> String {
        switch productID {
        case "com.hogaresrd.broker.monthly": return "person.text.rectangle.fill"
        case "com.hogaresrd.inmobiliaria.monthly": return "building.2.fill"
        case "com.hogaresrd.constructora.monthly": return "hammer.fill"
        default: return "star.fill"
        }
    }

    func planColor(for productID: String) -> String {
        switch productID {
        case "com.hogaresrd.broker.monthly": return "green"
        case "com.hogaresrd.inmobiliaria.monthly": return "purple"
        case "com.hogaresrd.constructora.monthly": return "orange"
        default: return "blue"
        }
    }
}
