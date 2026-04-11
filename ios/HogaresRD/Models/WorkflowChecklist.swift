import Foundation
import SwiftUI

// MARK: - Workflow Checklist
//
// A linear, user-facing view of the application workflow. Each stage
// maps to one or more backend statuses and carries enough metadata
// to render a checklist row + the correct primary action button.
//
// The stages themselves are linear (done → active → future), but the
// underlying state machine has branches (documentos_insuficientes
// loops back, reservado is optional, rejection is terminal). We model
// those with a set of "reached" statuses per stage.

enum WorkflowActor {
    case broker      // broker takes action here
    case client      // waiting on client
    case review      // broker review (docs or payment)
    case system      // auto-transitions

    var label: String {
        switch self {
        case .broker: return "Tú"
        case .client: return "Cliente"
        case .review: return "Revisión"
        case .system: return "Automático"
        }
    }
    var color: Color {
        switch self {
        case .broker: return .blue
        case .client: return .orange
        case .review: return .purple
        case .system: return .gray
        }
    }
}

enum WorkflowAction: Equatable {
    case setStatus(String, reasonRequired: Bool)
    case openDocumentRequest
    case reviewDocuments
    case reviewPayment
    case contactClient
    case openCommission
    case remindClient
}

struct WorkflowStep: Identifiable {
    let id: String
    let title: String
    let subtitle: String
    let icon: String
    let actor: WorkflowActor

    // The set of statuses at which this step is considered "done".
    // Used to mark the row with a checkmark.
    let doneAt: Set<String>
    // The set of statuses at which this step is the CURRENT focus.
    // Used to highlight one row and show its action button.
    let activeAt: Set<String>

    // Optional primary action when this step is active.
    let actionLabel: String?
    let action: WorkflowAction?
}

struct WorkflowChecklist {

    // MARK: - Canonical stage list

    /// Ordered list of checklist steps. The display iterates through
    /// this array top-to-bottom and resolves state from the current
    /// application status.
    static func steps(for status: String) -> [WorkflowStep] {
        // Stage 0: Broker reviews the application
        let review = WorkflowStep(
            id: "review",
            title: "Revisar Aplicación",
            subtitle: "Confirmar que la información del cliente está completa",
            icon: "doc.text.magnifyingglass",
            actor: .broker,
            doneAt: ["en_revision", "documentos_requeridos", "documentos_enviados",
                     "documentos_insuficientes", "en_aprobacion", "reservado", "aprobado",
                     "pendiente_pago", "pago_enviado", "pago_aprobado", "completado"],
            activeAt: ["aplicado"],
            actionLabel: "Iniciar Revisión",
            action: .setStatus("en_revision", reasonRequired: false)
        )

        // Stage 1: Request documents
        let requestDocs = WorkflowStep(
            id: "request_docs",
            title: "Solicitar Documentos",
            subtitle: "Pide al cliente los documentos necesarios",
            icon: "folder.badge.plus",
            actor: .broker,
            doneAt: ["documentos_requeridos", "documentos_enviados",
                     "documentos_insuficientes", "en_aprobacion", "reservado", "aprobado",
                     "pendiente_pago", "pago_enviado", "pago_aprobado", "completado"],
            activeAt: ["en_revision", "documentos_insuficientes"],
            actionLabel: "Solicitar Documentos",
            action: .openDocumentRequest
        )

        // Stage 2: Client uploads documents (waiting)
        let receiveDocs = WorkflowStep(
            id: "receive_docs",
            title: "Recibir Documentos",
            subtitle: "El cliente sube los documentos solicitados",
            icon: "tray.and.arrow.down.fill",
            actor: .client,
            doneAt: ["documentos_enviados", "en_aprobacion", "reservado", "aprobado",
                     "pendiente_pago", "pago_enviado", "pago_aprobado", "completado"],
            activeAt: ["documentos_requeridos"],
            actionLabel: "Recordar al Cliente",
            action: .remindClient
        )

        // Stage 3: Broker reviews uploaded documents
        let reviewDocs = WorkflowStep(
            id: "review_docs",
            title: "Revisar Documentos",
            subtitle: "Aprueba o rechaza cada documento enviado",
            icon: "checkmark.seal",
            actor: .review,
            doneAt: ["en_aprobacion", "reservado", "aprobado",
                     "pendiente_pago", "pago_enviado", "pago_aprobado", "completado"],
            activeAt: ["documentos_enviados"],
            actionLabel: "Revisar Documentos",
            action: .reviewDocuments
        )

        // Stage 4: Send to approval
        let toApproval = WorkflowStep(
            id: "approval",
            title: "Enviar a Aprobación",
            subtitle: "Mover la aplicación a la etapa de aprobación",
            icon: "arrow.right.circle.fill",
            actor: .broker,
            doneAt: ["en_aprobacion", "reservado", "aprobado",
                     "pendiente_pago", "pago_enviado", "pago_aprobado", "completado"],
            activeAt: [],   // reached implicitly from en_revision or documentos_enviados
            actionLabel: "Enviar a Aprobación",
            action: .setStatus("en_aprobacion", reasonRequired: false)
        )

        // Stage 5: Approve application
        let approve = WorkflowStep(
            id: "approve",
            title: "Aprobar Aplicación",
            subtitle: "Marca la aplicación como aprobada",
            icon: "checkmark.circle.fill",
            actor: .broker,
            doneAt: ["aprobado", "pendiente_pago", "pago_enviado",
                     "pago_aprobado", "completado"],
            activeAt: ["en_aprobacion", "reservado"],
            actionLabel: "Aprobar",
            action: .setStatus("aprobado", reasonRequired: false)
        )

        // Stage 6: Open payment
        let openPayment = WorkflowStep(
            id: "open_payment",
            title: "Abrir Pagos",
            subtitle: "Cambia el estado a Pendiente de Pago",
            icon: "creditcard",
            actor: .broker,
            doneAt: ["pendiente_pago", "pago_enviado", "pago_aprobado", "completado"],
            activeAt: ["aprobado"],
            actionLabel: "Abrir Pagos",
            action: .setStatus("pendiente_pago", reasonRequired: false)
        )

        // Stage 7: Receive payment (waiting on client)
        let receivePayment = WorkflowStep(
            id: "receive_payment",
            title: "Recibir Comprobante",
            subtitle: "El cliente sube el comprobante de pago",
            icon: "tray.and.arrow.down",
            actor: .client,
            doneAt: ["pago_enviado", "pago_aprobado", "completado"],
            activeAt: ["pendiente_pago"],
            actionLabel: "Recordar al Cliente",
            action: .remindClient
        )

        // Stage 8: Verify payment (review)
        let verifyPayment = WorkflowStep(
            id: "verify_payment",
            title: "Verificar Pago",
            subtitle: "Aprueba o rechaza el comprobante del cliente",
            icon: "checkmark.seal.fill",
            actor: .review,
            doneAt: ["pago_aprobado", "completado"],
            activeAt: ["pago_enviado"],
            actionLabel: "Revisar Pago",
            action: .reviewPayment
        )

        // Stage 9: Mark completed
        let complete = WorkflowStep(
            id: "complete",
            title: "Cerrar Venta",
            subtitle: "Marca la aplicación como completada y registra comisión",
            icon: "flag.checkered",
            actor: .broker,
            doneAt: ["completado"],
            activeAt: ["pago_aprobado"],
            actionLabel: "Marcar Completado",
            action: .setStatus("completado", reasonRequired: false)
        )

        return [review, requestDocs, receiveDocs, reviewDocs,
                toApproval, approve, openPayment,
                receivePayment, verifyPayment, complete]
    }

    // MARK: - Row state resolution

    enum RowState {
        case done      // step already completed
        case active    // current focus — show action button
        case waiting   // current focus but waiting on someone else
        case future    // not yet reachable
    }

    static func rowState(for step: WorkflowStep, status: String) -> RowState {
        if step.activeAt.contains(status) {
            // Active — but if the actor is the client, mark as waiting
            return step.actor == .client ? .waiting : .active
        }
        if step.doneAt.contains(status) {
            return .done
        }
        return .future
    }

    // MARK: - Primary "next action" for a given status

    /// Returns the single most important step the broker should act on
    /// right now (or nil if terminal / nothing actionable).
    static func primaryAction(for status: String) -> WorkflowStep? {
        let all = steps(for: status)
        // Prefer broker/review actions; fall back to client-waiting steps
        // so we can still surface "remind client".
        return all.first { $0.activeAt.contains(status) && ($0.actor == .broker || $0.actor == .review) }
            ?? all.first { $0.activeAt.contains(status) }
    }

    /// Secondary action when the primary is branching (e.g. en_revision
    /// can go to "solicitar documentos" OR "enviar a aprobación"). This
    /// surfaces the skip-docs shortcut.
    static func secondaryAction(for status: String) -> WorkflowStep? {
        switch status {
        case "en_revision":
            // Primary = request docs, secondary = skip to approval
            return steps(for: status).first { $0.id == "approval" }
        case "en_aprobacion":
            // Primary = approve, secondary = reserve unit
            return WorkflowStep(
                id: "reserve",
                title: "Reservar Unidad",
                subtitle: "Marcar la unidad como reservada",
                icon: "bookmark.fill",
                actor: .broker,
                doneAt: [],
                activeAt: ["en_aprobacion"],
                actionLabel: "Reservar Unidad",
                action: .setStatus("reservado", reasonRequired: false)
            )
        case "documentos_enviados":
            // Primary = review docs, secondary = send straight to approval
            return steps(for: status).first { $0.id == "approval" }
        default:
            return nil
        }
    }
}
