import Foundation
import StoreKit
#if canImport(UIKit)
import UIKit
#endif

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

    // Transactions whose server sync failed. They are NOT finished — finish()
    // is only called after the backend has acknowledged the subscription, so
    // the user keeps Apple's "subscribed" state until the server agrees.
    // Held in memory plus persisted IDs in UserDefaults to survive relaunch.
    private var syncFailedTransactions: [StoreKit.Transaction] = []
    private static let pendingSyncIDsKey = "rd_pending_sync_tx_ids"
    private var didBecomeActiveObserver: NSObjectProtocol?

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

        // Retry any persisted failed syncs whenever the app comes back to
        // foreground (the most likely time the network has recovered).
        #if canImport(UIKit)
        didBecomeActiveObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                await self?.retryPendingSyncs()
            }
        }
        #endif

        // Also retry on cold launch — a queued transaction may already be
        // visible in `Transaction.currentEntitlements` even if the server
        // never confirmed it.
        Task { @MainActor in
            await retryPendingSyncs()
        }
    }

    deinit {
        transactionListener?.cancel()
        if let obs = didBecomeActiveObserver {
            NotificationCenter.default.removeObserver(obs)
        }
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
            debugLog("[StoreManager] Load products error: \(error)")
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
                let transaction = try Self.verify(verification)
                await updatePurchasedProducts()
                // Notify server of the purchase. ONLY finish the transaction
                // after the backend confirms — otherwise a 5xx leaves the
                // user paying with no role on the server.
                do {
                    try await syncWithServer(transaction: transaction)
                    await transaction.finish()
                } catch {
                    enqueueFailedSync(transaction)
                    debugLog("[StoreManager] Sync failed during purchase, queued for retry: \(error)")
                }
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
            debugLog("[StoreManager] Purchase error: \(error)")
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
                    let transaction = try StoreManager.verify(result)
                    await self.updatePurchasedProducts()
                    // Only finish the transaction after the backend has
                    // acknowledged it. Failed syncs are queued and retried.
                    do {
                        try await self.syncWithServer(transaction: transaction)
                        await transaction.finish()
                    } catch {
                        await self.enqueueFailedSync(transaction)
                        debugLog("[StoreManager] Sync failed in listener, queued for retry: \(error)")
                    }
                } catch {
                    debugLog("[StoreManager] Transaction update error: \(error)")
                }
            }
            // Once the listener spins up, retry any pending syncs from disk.
            await self.retryPendingSyncs()
        }
    }

    // ── Update Purchased Status ─────────────────────────────────

    func updatePurchasedProducts() async {
        var purchased: Set<String> = []
        var latestTransaction: StoreKit.Transaction?

        for await result in StoreKit.Transaction.currentEntitlements {
            if let transaction = try? Self.verify(result) {
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

    nonisolated private static func verify<T>(_ result: VerificationResult<T>) throws -> T {
        switch result {
        case .unverified(_, let error):
            throw error
        case .verified(let item):
            return item
        }
    }

    // ── Server Sync ─────────────────────────────────────────────
    // Notify the backend of subscription changes so it can upgrade/downgrade the user role

    /// Throws when the backend can't be reached or returns an error so the
    /// caller can decide whether to finish() the transaction or queue it.
    private func syncWithServer(transaction: StoreKit.Transaction) async throws {
        struct NoAPIServiceError: Error {}
        guard let api = _api else {
            debugLog("[StoreManager] No API service set — deferring server sync")
            throw NoAPIServiceError()
        }
        let role = Self.roleMap[transaction.productID] ?? "user"

        try await api.syncAppleSubscription(
            productID: transaction.productID,
            transactionID: String(transaction.id),
            originalTransactionID: String(transaction.originalID),
            role: role,
            expirationDate: transaction.expirationDate?.ISO8601Format()
        )
        debugLog("[StoreManager] Server synced: \(transaction.productID) → \(role)")
    }

    // MARK: - Failed-sync retry queue

    /// Append a transaction to the in-memory queue and persist its ID so the
    /// queue survives a relaunch. The transaction itself is NOT finish()ed.
    private func enqueueFailedSync(_ transaction: StoreKit.Transaction) {
        if !syncFailedTransactions.contains(where: { $0.id == transaction.id }) {
            syncFailedTransactions.append(transaction)
        }
        var ids = UserDefaults.standard.array(forKey: Self.pendingSyncIDsKey) as? [String] ?? []
        let txID = String(transaction.id)
        if !ids.contains(txID) {
            ids.append(txID)
            UserDefaults.standard.set(ids, forKey: Self.pendingSyncIDsKey)
        }
    }

    private func removePendingSync(_ transactionID: UInt64) {
        syncFailedTransactions.removeAll { $0.id == transactionID }
        var ids = UserDefaults.standard.array(forKey: Self.pendingSyncIDsKey) as? [String] ?? []
        ids.removeAll { $0 == String(transactionID) }
        if ids.isEmpty {
            UserDefaults.standard.removeObject(forKey: Self.pendingSyncIDsKey)
        } else {
            UserDefaults.standard.set(ids, forKey: Self.pendingSyncIDsKey)
        }
    }

    /// Walk current entitlements and retry sync for any transaction whose ID
    /// is in the persisted pending list, plus anything still queued in memory.
    func retryPendingSyncs() async {
        let persistedIDs = Set((UserDefaults.standard.array(forKey: Self.pendingSyncIDsKey) as? [String]) ?? [])
        guard !persistedIDs.isEmpty || !syncFailedTransactions.isEmpty else { return }

        // Rehydrate Transaction objects from current entitlements so we can
        // call finish() on them after a successful sync.
        var byID: [UInt64: StoreKit.Transaction] = [:]
        for tx in syncFailedTransactions { byID[tx.id] = tx }

        for await result in StoreKit.Transaction.currentEntitlements {
            if let tx = try? Self.verify(result), persistedIDs.contains(String(tx.id)) {
                byID[tx.id] = tx
            }
        }

        for (txID, transaction) in byID {
            do {
                try await syncWithServer(transaction: transaction)
                await transaction.finish()
                removePendingSync(txID)
                debugLog("[StoreManager] Retried sync succeeded: \(transaction.productID)")
            } catch {
                debugLog("[StoreManager] Retry sync still failing for \(transaction.productID): \(error)")
            }
        }
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
            debugLog("[StoreManager] Sync error: \(error.localizedDescription)")
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
