import SwiftUI
import StoreKit

// ══════════════════════════════════════════════════════════════════════════
// HogaresRD — Subscription Plans View
// ══════════════════════════════════════════════════════════════════════════

struct PlansView: View {
    @EnvironmentObject var api: APIService
    @ObservedObject private var store = StoreManager.shared
    @Environment(\.dismiss) var dismiss
    @State private var purchasing: String?
    @State private var showSuccess = false
    @State private var showCancelFlow = false
    @State private var showManageSubscriptions = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {

                    // Header
                    VStack(spacing: 8) {
                        Image(systemName: "crown.fill")
                            .font(.system(size: 40))
                            .foregroundStyle(
                                LinearGradient(colors: [.yellow, .orange], startPoint: .top, endPoint: .bottom)
                            )

                        Text("HogaresRD Pro")
                            .font(.title.bold())

                        Text("Elige el plan que mejor se adapte a tu negocio inmobiliario.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal)
                    }
                    .padding(.top, 8)

                    // Current plan indicator
                    if store.hasActiveSubscription, let role = store.activeRole {
                        HStack(spacing: 8) {
                            Image(systemName: "checkmark.seal.fill")
                                .foregroundStyle(.green)
                            Text("Plan activo: \(roleName(role))")
                                .font(.subheadline.weight(.semibold))
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(.green.opacity(0.1))
                        .clipShape(Capsule())
                    }

                    if store.isLoading && store.products.isEmpty {
                        ProgressView("Cargando planes...")
                            .padding(.top, 40)
                    } else if let error = store.error {
                        VStack(spacing: 12) {
                            Image(systemName: "exclamationmark.triangle")
                                .font(.title)
                                .foregroundStyle(.orange)
                            Text(error)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)
                            Button("Reintentar") {
                                Task { await store.loadProducts() }
                            }
                            .buttonStyle(.bordered)
                        }
                        .padding(.top, 40)
                    } else {
                        // Plan cards
                        ForEach(store.sortedProducts, id: \.id) { product in
                            PlanCard(
                                product: product,
                                isPurchased: store.isPurchased(product.id),
                                isPurchasing: purchasing == product.id,
                                store: store
                            ) {
                                Task { await purchase(product) }
                            }
                        }
                    }

                    // Restore purchases — required by App Store Review
                    // 3.1.1. Lets users on a new device or after reinstall
                    // recover their previously-bought subscription.
                    Button {
                        Task { await store.restorePurchases() }
                    } label: {
                        Text("Restaurar compras")
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(.secondary)
                    }
                    .padding(.top, 8)

                    // Manage subscription — opens the system sheet so the
                    // user can change plan / cancel without leaving the
                    // app. Required surface per 3.1.2(c).
                    if store.hasActiveSubscription {
                        Button {
                            showManageSubscriptions = true
                        } label: {
                            Text("Gestionar suscripción")
                                .font(.footnote.weight(.medium))
                                .foregroundStyle(Color.rdBlue)
                        }
                        .padding(.top, 4)
                    }

                    // Legal text + required links — App Store Review 3.1.2
                    // wants the auto-renewal disclosure plus reachable
                    // Privacy Policy + Terms in any subscription flow.
                    VStack(spacing: 6) {
                        Text("La suscripción se renueva automáticamente cada mes. Puedes cancelar en cualquier momento desde Ajustes > Apple ID > Suscripciones.")
                        Text("El pago se carga a tu cuenta de Apple ID al confirmar la compra.")

                        HStack(spacing: 12) {
                            Link("Términos de Servicio",
                                 destination: URL(string: "https://hogaresrd.com/terminos")!)
                            Text("·")
                            Link("Política de Privacidad",
                                 destination: URL(string: "https://hogaresrd.com/privacidad")!)
                        }
                        .padding(.top, 4)
                    }
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)

                    // Cancel button
                    if !store.purchasedProductIDs.isEmpty || api.currentUser?.subscriptionStatus == "active" {
                        Button { showCancelFlow = true } label: {
                            Text("Cancelar suscripcion")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.top, 8)
                    }

                    Spacer().frame(height: 24)
                }
                .padding(.horizontal)
            }
            .navigationTitle("Planes")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: $showCancelFlow) {
                CancelSubscriptionView()
                    .environmentObject(api)
            }
            .manageSubscriptionsSheet(isPresented: $showManageSubscriptions)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cerrar") { dismiss() }
                }
            }
            .task {
                store.setAPIService(api)
                await store.loadProducts()
            }
            .alert("¡Suscripción activada!", isPresented: $showSuccess) {
                Button("OK") { dismiss() }
            } message: {
                Text("Tu cuenta ha sido actualizada. Disfruta de todas las funciones Pro.")
            }
        }
    }

    private func purchase(_ product: Product) async {
        purchasing = product.id
        let success = await store.purchase(product)
        purchasing = nil
        if success {
            await store.syncCurrentSubscription()
            showSuccess = true
        }
    }

    private func roleName(_ role: String) -> String {
        switch role {
        case "broker": return "Broker"
        case "inmobiliaria": return "Inmobiliaria"
        case "constructora": return "Constructora"
        default: return role.capitalized
        }
    }
}

// ── Plan Card ───────────────────────────────────────────────────

struct PlanCard: View {
    let product: Product
    let isPurchased: Bool
    let isPurchasing: Bool
    let store: StoreManager
    var onPurchase: () -> Void

    private var planColor: Color {
        switch store.planColor(for: product.id) {
        case "green": return Color.rdGreen
        case "purple": return Color.rdPurple
        case "orange": return Color.rdOrange
        default: return .blue
        }
    }

    private var features: [String] {
        switch product.id {
        case "com.hogaresrd.broker.monthly":
            return [
                "Publica propiedades ilimitadas",
                "Recibe leads con prioridad",
                "Dashboard de ventas completo",
                "Gestión de clientes y aplicaciones",
                "Enlace de afiliado personalizado",
                "Estadísticas de rendimiento",
            ]
        case "com.hogaresrd.inmobiliaria.monthly":
            return [
                "Todo lo del plan Broker",
                "Vincula agentes a tu equipo",
                "Panel de control de empresa",
                "Gestión de inventario avanzada",
                "Reportes de equipo",
                "Secretaria virtual",
            ]
        case "com.hogaresrd.constructora.monthly":
            return [
                "Todo lo del plan Inmobiliaria",
                "Gestión de proyectos y unidades",
                "Inventario con fases de entrega",
                "Control de avance de obra",
                "Vinculación de agentes externos",
                "Planos y documentos por unidad",
            ]
        default:
            return []
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 10)
                        .fill(planColor)
                        .frame(width: 40, height: 40)
                    Image(systemName: store.planIcon(for: product.id))
                        .font(.system(size: 18))
                        .foregroundColor(.white)
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text(store.planName(for: product.id))
                        .font(.headline)
                    Text(product.displayPrice + " / mes")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                if isPurchased {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.title2)
                        .foregroundStyle(.green)
                }
            }
            .padding()

            Divider()

            // Features
            VStack(alignment: .leading, spacing: 8) {
                ForEach(features, id: \.self) { feature in
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "checkmark")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(planColor)
                            .frame(width: 16)
                        Text(feature)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .padding()

            // CTA
            if isPurchased {
                Text("Plan activo")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.green)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(.green.opacity(0.1))
            } else {
                Button(action: onPurchase) {
                    HStack {
                        if isPurchasing {
                            ProgressView()
                                .tint(.white)
                        }
                        Text(isPurchasing ? "Procesando..." : "Suscribirse")
                            .font(.subheadline.weight(.bold))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .foregroundColor(.white)
                    .background(planColor)
                }
            }
        }
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(isPurchased ? Color.green : Color(.separator), lineWidth: isPurchased ? 2 : 1)
        )
        .shadow(color: .black.opacity(0.06), radius: 8, y: 4)
    }
}
