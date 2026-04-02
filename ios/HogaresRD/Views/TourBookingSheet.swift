import SwiftUI

// MARK: - Tour Booking Sheet (Client)

struct TourBookingSheet: View {
    let listing: Listing
    let brokerId: String
    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) var dismiss

    @State private var step = 1
    @State private var availableDates: [String] = []
    @State private var currentMonth = Date()
    @State private var selectedDate: String?
    @State private var availableSlots: [AvailableSlot] = []
    @State private var selectedTime: String?
    @State private var loadingSlots = false
    @State private var loadingDates = false

    // Contact info
    @State private var name    = ""
    @State private var phone   = ""
    @State private var email   = ""
    @State private var notes   = ""
    @State private var sending = false
    @State private var sent    = false
    @State private var errorMsg: String?

    private let dayNames = ["Do", "Lu", "Ma", "Mi", "Ju", "Vi", "Sa"]
    private let monthNames = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
                              "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"]

    var body: some View {
        NavigationStack {
            if sent {
                successView
            } else {
                VStack(spacing: 0) {
                    stepIndicator
                    ScrollView {
                        VStack(alignment: .leading, spacing: 20) {
                            switch step {
                            case 1: dateStepView
                            case 2: timeStepView
                            case 3: contactStepView
                            default: EmptyView()
                            }
                        }
                        .padding(16)
                    }
                }
                .navigationTitle("Agendar Visita")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cerrar") { dismiss() }
                    }
                }
            }
        }
        .onAppear {
            if let user = api.currentUser {
                name  = user.name
                email = user.email
                if let p = user.phone { phone = p }
            }
            loadMonth()
        }
    }

    // MARK: - Step Indicator

    private var stepIndicator: some View {
        HStack(spacing: 0) {
            ForEach(1...3, id: \.self) { s in
                if s > 1 {
                    Rectangle()
                        .fill(s <= step ? Color.rdBlue : Color(.systemGray4))
                        .frame(height: 2)
                        .frame(maxWidth: 40)
                }
                ZStack {
                    Circle()
                        .fill(s < step ? Color.rdGreen : s == step ? Color.rdBlue : Color(.systemGray5))
                        .frame(width: 30, height: 30)
                    if s < step {
                        Image(systemName: "checkmark")
                            .font(.caption2.bold()).foregroundStyle(.white)
                    } else {
                        Text("\(s)")
                            .font(.caption2.bold())
                            .foregroundStyle(s == step ? .white : .secondary)
                    }
                }
            }
        }
        .padding(.vertical, 12)
        .padding(.horizontal, 40)
    }

    // MARK: - Step 1: Date

    private var dateStepView: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Selecciona un día")
                .font(.headline)
            Text("Los días resaltados tienen horarios disponibles.")
                .font(.caption).foregroundStyle(.secondary)

            // Month navigation
            HStack {
                Button { prevMonth() } label: {
                    Image(systemName: "chevron.left")
                        .font(.caption.bold())
                        .padding(8)
                        .background(Color(.systemGray6), in: Circle())
                }
                Spacer()
                Text(monthLabel)
                    .font(.subheadline.bold())
                Spacer()
                Button { nextMonth() } label: {
                    Image(systemName: "chevron.right")
                        .font(.caption.bold())
                        .padding(8)
                        .background(Color(.systemGray6), in: Circle())
                }
            }

            if loadingDates {
                ProgressView().frame(maxWidth: .infinity).padding()
            } else {
                calendarGrid
            }

            // Legend
            HStack(spacing: 16) {
                HStack(spacing: 4) {
                    Circle().fill(Color.rdGreen.opacity(0.2)).frame(width: 10, height: 10)
                    Text("Disponible").font(.caption2).foregroundStyle(.secondary)
                }
                HStack(spacing: 4) {
                    Circle().fill(Color(.systemGray5)).frame(width: 10, height: 10)
                    Text("No disponible").font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
    }

    private var calendarGrid: some View {
        let calendar = Calendar.current
        let year  = calendar.component(.year, from: currentMonth)
        let month = calendar.component(.month, from: currentMonth)
        let firstOfMonth = calendar.date(from: DateComponents(year: year, month: month, day: 1))!
        let firstWeekday = calendar.component(.weekday, from: firstOfMonth) - 1
        let daysInMonth  = calendar.range(of: .day, in: .month, for: firstOfMonth)!.count
        let today = todayString()

        let columns = Array(repeating: GridItem(.flexible(), spacing: 4), count: 7)

        return LazyVGrid(columns: columns, spacing: 4) {
            // Headers
            ForEach(dayNames, id: \.self) { day in
                Text(day)
                    .font(.caption2.bold())
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
            }

            // Empty cells for padding
            ForEach(0..<firstWeekday, id: \.self) { _ in
                Color.clear.frame(height: 40)
            }

            // Day cells
            ForEach(1...daysInMonth, id: \.self) { day in
                let dateStr = String(format: "%04d-%02d-%02d", year, month, day)
                let isAvail = availableDates.contains(dateStr) && dateStr >= today
                let isSelected = dateStr == selectedDate
                let isPast = dateStr < today

                Button {
                    if isAvail {
                        selectedDate = dateStr
                        selectedTime = nil
                        step = 2
                        loadSlots(dateStr)
                    }
                } label: {
                    Text("\(day)")
                        .font(.callout.bold())
                        .frame(maxWidth: .infinity)
                        .frame(height: 40)
                        .background(
                            isSelected ? Color.rdBlue :
                            isAvail ? Color.rdGreen.opacity(0.15) :
                            Color.clear
                        )
                        .foregroundStyle(
                            isSelected ? .white :
                            isPast || !isAvail ? Color(.systemGray4) :
                            .primary
                        )
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                }
                .disabled(!isAvail || isPast)
            }
        }
    }

    // MARK: - Step 2: Time

    private var timeStepView: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Selecciona la hora")
                .font(.headline)
            if let date = selectedDate {
                Text(formatDateLabel(date))
                    .font(.subheadline).foregroundStyle(.secondary)
            }

            if loadingSlots {
                ProgressView("Cargando horarios...")
                    .frame(maxWidth: .infinity).padding(.vertical, 30)
            } else if availableSlots.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "clock.badge.xmark")
                        .font(.system(size: 36))
                        .foregroundStyle(.secondary)
                    Text("No hay horarios disponibles para esta fecha.")
                        .font(.subheadline).foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity).padding(.vertical, 30)
            } else {
                let columns = Array(repeating: GridItem(.flexible(), spacing: 8), count: 3)
                LazyVGrid(columns: columns, spacing: 8) {
                    ForEach(availableSlots, id: \.time) { slot in
                        Button {
                            selectedTime = slot.time
                            step = 3
                        } label: {
                            Text(formatTime(slot.time))
                                .font(.callout.bold())
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 14)
                                .background(
                                    selectedTime == slot.time ? Color.rdBlue : Color(.systemGray6)
                                )
                                .foregroundStyle(
                                    selectedTime == slot.time ? .white : .primary
                                )
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                    }
                }
            }

            Button {
                step = 1
            } label: {
                Label("Cambiar fecha", systemImage: "calendar")
                    .font(.subheadline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(Color(.systemGray6), in: RoundedRectangle(cornerRadius: 10))
            }
            .foregroundStyle(.primary)
        }
    }

    // MARK: - Step 3: Contact

    private var contactStepView: some View {
        VStack(alignment: .leading, spacing: 16) {
            // Summary
            if let date = selectedDate, let time = selectedTime {
                HStack(spacing: 12) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 10)
                            .fill(Color.rdBlue.opacity(0.1))
                            .frame(width: 50, height: 50)
                        Image(systemName: "calendar.badge.clock")
                            .foregroundStyle(Color.rdBlue)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(formatDateLabel(date))
                            .font(.subheadline.bold())
                        Text(formatTime(time))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button {
                        step = 2
                    } label: {
                        Text("Cambiar")
                            .font(.caption.bold())
                            .foregroundStyle(Color.rdBlue)
                    }
                }
                .padding(12)
                .background(Color.rdBlue.opacity(0.04))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }

            Text("Tu información")
                .font(.headline)

            VStack(spacing: 12) {
                formField("Nombre completo", text: $name, icon: "person.fill")
                formField("Teléfono", text: $phone, icon: "phone.fill", keyboard: .phonePad)
                formField("Correo electrónico", text: $email, icon: "envelope.fill", keyboard: .emailAddress)

                VStack(alignment: .leading, spacing: 4) {
                    Text("Notas (opcional)")
                        .font(.caption).foregroundStyle(.secondary)
                    TextField("Algo que el agente deba saber...", text: $notes, axis: .vertical)
                        .lineLimit(3...)
                        .padding(12)
                        .background(Color(.systemGray6))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                }
            }

            if let err = errorMsg {
                Text(err)
                    .font(.caption).foregroundStyle(Color.rdRed)
            }

            Text("El agente deberá confirmar tu solicitud. Recibirás una notificación cuando sea aprobada.")
                .font(.caption).foregroundStyle(.tertiary)

            HStack(spacing: 10) {
                Button {
                    step = 2
                } label: {
                    Text("Atrás")
                        .font(.subheadline).bold()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(Color(.systemGray6), in: RoundedRectangle(cornerRadius: 12))
                }
                .foregroundStyle(.primary)

                Button {
                    Task { await submitTour() }
                } label: {
                    if sending {
                        ProgressView().frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(Color.rdBlue, in: RoundedRectangle(cornerRadius: 12))
                    } else {
                        Text("Solicitar Visita")
                            .font(.subheadline).bold()
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(Color.rdBlue, in: RoundedRectangle(cornerRadius: 12))
                            .foregroundStyle(.white)
                    }
                }
                .disabled(sending || name.isEmpty || phone.isEmpty)
            }
        }
    }

    // MARK: - Success

    private var successView: some View {
        VStack(spacing: 24) {
            Spacer()
            ZStack {
                Circle().fill(Color.rdGreen.opacity(0.1)).frame(width: 88, height: 88)
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 48)).foregroundStyle(Color.rdGreen)
            }
            VStack(spacing: 8) {
                Text("¡Visita solicitada!")
                    .font(.title2).bold()
                Text("Tu solicitud ha sido enviada al agente. Recibirás una confirmación cuando sea aprobada.")
                    .font(.subheadline).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center).padding(.horizontal, 24)
            }
            if let date = selectedDate, let time = selectedTime {
                VStack(spacing: 4) {
                    Text(formatDateLabel(date))
                        .font(.subheadline.bold())
                    Text(formatTime(time))
                        .font(.caption).foregroundStyle(.secondary)
                }
                .padding(14)
                .background(Color(.systemGray6), in: RoundedRectangle(cornerRadius: 12))
            }
            Spacer()
            Button("Cerrar") { dismiss() }
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding()
                .background(Color.rdBlue)
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .padding(.horizontal, 24)
                .padding(.bottom, 32)
        }
    }

    // MARK: - Helpers

    private func formField(_ placeholder: String, text: Binding<String>, icon: String, keyboard: UIKeyboardType = .default) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 20)
            TextField(placeholder, text: text)
                .keyboardType(keyboard)
                .textInputAutocapitalization(keyboard == .emailAddress ? .never : .words)
        }
        .padding(12)
        .background(Color(.systemGray6))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func loadMonth() {
        let cal = Calendar.current
        let y = cal.component(.year, from: currentMonth)
        let m = cal.component(.month, from: currentMonth)
        let monthStr = String(format: "%04d-%02d", y, m)
        loadingDates = true
        Task {
            do {
                let dates = try await api.fetchSchedule(brokerId: brokerId, month: monthStr)
                await MainActor.run {
                    availableDates = dates
                    loadingDates = false
                }
            } catch {
                await MainActor.run { loadingDates = false }
            }
        }
    }

    private func loadSlots(_ date: String) {
        loadingSlots = true
        availableSlots = []
        Task {
            do {
                let slots = try await api.fetchAvailableSlots(brokerId: brokerId, date: date)
                await MainActor.run {
                    availableSlots = slots
                    loadingSlots = false
                }
            } catch {
                await MainActor.run { loadingSlots = false }
            }
        }
    }

    private func prevMonth() {
        let cal = Calendar.current
        let now = Date()
        if let prev = cal.date(byAdding: .month, value: -1, to: currentMonth) {
            if cal.component(.year, from: prev) > cal.component(.year, from: now) ||
               (cal.component(.year, from: prev) == cal.component(.year, from: now) &&
                cal.component(.month, from: prev) >= cal.component(.month, from: now)) {
                currentMonth = prev
                loadMonth()
            }
        }
    }

    private func nextMonth() {
        let cal = Calendar.current
        if let next = cal.date(byAdding: .month, value: 1, to: currentMonth) {
            currentMonth = next
            loadMonth()
        }
    }

    private var monthLabel: String {
        let cal = Calendar.current
        let m = cal.component(.month, from: currentMonth)
        let y = cal.component(.year, from: currentMonth)
        return "\(monthNames[m - 1]) \(y)"
    }

    private func todayString() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: Date())
    }

    private func formatDateLabel(_ dateStr: String) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        guard let date = f.date(from: dateStr) else { return dateStr }
        f.dateFormat = "EEEE d 'de' MMMM"
        f.locale = Locale(identifier: "es_DO")
        return f.string(from: date).capitalized
    }

    private func formatTime(_ time: String) -> String {
        let parts = time.split(separator: ":")
        guard parts.count >= 2, let h = Int(parts[0]) else { return time }
        let m = parts[1]
        let ampm = h >= 12 ? "PM" : "AM"
        let h12 = h > 12 ? h - 12 : (h == 0 ? 12 : h)
        return "\(h12):\(m) \(ampm)"
    }

    private func submitTour() async {
        guard let date = selectedDate, let time = selectedTime else { return }
        sending = true; errorMsg = nil
        do {
            _ = try await api.requestTour(
                listingId: listing.id, brokerId: brokerId,
                date: date, time: time,
                name: name, phone: phone, email: email, notes: notes
            )
            sent = true
        } catch {
            errorMsg = error.localizedDescription
        }
        sending = false
    }
}

// MARK: - Broker Tours View

struct BrokerToursView: View {
    @EnvironmentObject var api: APIService
    @State private var tours: [TourRequest] = []
    @State private var loading = true
    @State private var selectedTab = 0

    var body: some View {
        VStack(spacing: 0) {
            // Tab bar
            Picker("", selection: $selectedTab) {
                Text("Pendientes").tag(0)
                Text("Confirmadas").tag(1)
                Text("Historial").tag(2)
            }
            .pickerStyle(.segmented)
            .padding()

            if loading {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if filteredTours.isEmpty {
                VStack(spacing: 12) {
                    Spacer()
                    Image(systemName: "calendar.badge.clock")
                        .font(.system(size: 40))
                        .foregroundStyle(.secondary)
                    Text("No hay visitas en esta categoría")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Spacer()
                }
            } else {
                List {
                    ForEach(filteredTours) { tour in
                        tourCard(tour)
                    }
                }
                .listStyle(.plain)
            }
        }
        .navigationTitle("Visitas")
        .task { await loadTours() }
        .refreshable { await loadTours() }
    }

    private var filteredTours: [TourRequest] {
        switch selectedTab {
        case 0: return tours.filter { $0.status == "pending" }
        case 1: return tours.filter { $0.status == "confirmed" }
        default: return tours.filter { ["rejected", "cancelled", "completed"].contains($0.status) }
        }
    }

    @ViewBuilder
    private func tourCard(_ tour: TourRequest) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(tour.listing_title)
                    .font(.subheadline).bold()
                    .lineLimit(1)
                Spacer()
                statusBadge(tour.status)
            }

            HStack(spacing: 12) {
                Label(tour.formattedDate, systemImage: "calendar")
                    .font(.caption)
                Label(tour.formattedTime, systemImage: "clock")
                    .font(.caption)
            }
            .foregroundStyle(.secondary)

            HStack(spacing: 8) {
                Label(tour.client_name, systemImage: "person.fill")
                    .font(.caption)
                Label(tour.client_phone, systemImage: "phone.fill")
                    .font(.caption)
            }
            .foregroundStyle(.secondary)

            if let notes = tour.client_notes, !notes.isEmpty {
                Text(notes)
                    .font(.caption).italic()
                    .foregroundStyle(.tertiary)
            }

            if tour.isPending {
                HStack(spacing: 8) {
                    Button {
                        Task { await updateStatus(tour.id, "confirmed") }
                    } label: {
                        Label("Confirmar", systemImage: "checkmark")
                            .font(.caption).bold()
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .background(Color.rdGreen, in: RoundedRectangle(cornerRadius: 8))
                            .foregroundStyle(.white)
                    }
                    Button {
                        Task { await updateStatus(tour.id, "rejected") }
                    } label: {
                        Label("Rechazar", systemImage: "xmark")
                            .font(.caption).bold()
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .background(Color.rdRed, in: RoundedRectangle(cornerRadius: 8))
                            .foregroundStyle(.white)
                    }
                }
            }
        }
        .padding(14)
    }

    @ViewBuilder
    private func statusBadge(_ status: String) -> some View {
        let (text, color): (String, Color) = {
            switch status {
            case "pending":   return ("Pendiente", .orange)
            case "confirmed": return ("Confirmada", .rdGreen)
            case "rejected":  return ("Rechazada", .rdRed)
            case "cancelled": return ("Cancelada", .gray)
            default:          return (status.capitalized, .gray)
            }
        }()
        Text(text)
            .font(.caption2).bold()
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(color.opacity(0.15))
            .foregroundStyle(color)
            .clipShape(Capsule())
    }

    private func loadTours() async {
        loading = true
        tours = (try? await api.fetchBrokerTourRequests()) ?? []
        loading = false
    }

    private func updateStatus(_ id: String, _ status: String) async {
        try? await api.updateTourStatus(tourId: id, status: status)
        await loadTours()
    }
}

// MARK: - Broker Availability View (Unified Calendar + Day Editor)

struct BrokerAvailabilityView: View {
    @EnvironmentObject var api: APIService
    @State private var weekly:    [AvailabilitySlot] = []
    @State private var overrides: [AvailabilitySlot] = []
    @State private var loading = true
    @State private var duration = 30
    @State private var calYear: Int = Calendar.current.component(.year, from: Date())
    @State private var editingDate: String?

    private let dayFull   = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"]
    private let monthNames = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
                              "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"]

    private func slotsForDay(_ dow: Int) -> [AvailabilitySlot] {
        weekly.filter { $0.day_of_week == dow }
    }

    private var activeDays: Set<Int> { Set(weekly.map { $0.day_of_week }) }
    private var blockedDates: Set<String> {
        Set(overrides.filter { $0.available == false }.compactMap { $0.date })
    }
    private func overrideForDate(_ dateStr: String) -> AvailabilitySlot? {
        overrides.first { $0.date == dateStr && $0.available == false }
    }
    private func todayStr() -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; return f.string(from: Date())
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                // ── Duration + Year nav ──
                HStack {
                    HStack(spacing: 6) {
                        Text("Duración:")
                            .font(.caption).foregroundStyle(.secondary)
                        Picker("", selection: $duration) {
                            Text("15m").tag(15)
                            Text("30m").tag(30)
                            Text("60m").tag(60)
                        }
                        .pickerStyle(.segmented)
                        .frame(maxWidth: 150)
                    }
                    Spacer()
                    HStack(spacing: 12) {
                        Button { calYear -= 1 } label: {
                            Image(systemName: "chevron.left").font(.caption.bold())
                        }
                        Text(String(calYear)).font(.headline)
                        Button { calYear += 1 } label: {
                            Image(systemName: "chevron.right").font(.caption.bold())
                        }
                    }
                    .foregroundStyle(Color.rdBlue)
                }
                .padding(.horizontal, 16)

                // ── Legend ──
                HStack(spacing: 14) {
                    legendDot(color: Color.rdBlue.opacity(0.25), label: "Disponible")
                    legendDot(color: Color.rdRed.opacity(0.2), label: "Bloqueado")
                    legendDot(color: Color(.systemGray5), label: "Sin horario")
                }
                .font(.caption2)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 16)

                // ── Instruction ──
                Text("Toca un día para configurar horarios")
                    .font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity).multilineTextAlignment(.center)

                // ── 12-month grid ──
                LazyVGrid(columns: [
                    GridItem(.flexible(), spacing: 12),
                    GridItem(.flexible(), spacing: 12)
                ], spacing: 16) {
                    ForEach(1...12, id: \.self) { month in
                        monthCard(month: month, year: calYear)
                    }
                }
                .padding(.horizontal, 12)
            }
            .padding(.vertical, 16)
        }
        .navigationTitle("Disponibilidad")
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $editingDate) { dateStr in
            DayEditorSheet(
                dateStr: dateStr,
                weekly: weekly,
                overrides: overrides,
                duration: duration,
                api: api,
                onSave: { await load(); editingDate = nil }
            )
        }
    }

    // MARK: - Legend

    private func legendDot(color: Color, label: String) -> some View {
        HStack(spacing: 4) {
            RoundedRectangle(cornerRadius: 3).fill(color).frame(width: 10, height: 10)
            Text(label).foregroundStyle(.secondary)
        }
    }

    // MARK: - Month Card

    private func monthCard(month: Int, year: Int) -> some View {
        let cal = Calendar.current
        let firstOfMonth = cal.date(from: DateComponents(year: year, month: month, day: 1))!
        let daysInMonth = cal.range(of: .day, in: .month, for: firstOfMonth)!.count
        let firstWeekday = cal.component(.weekday, from: firstOfMonth) - 1 // 0=Sun
        let dayHeaders = ["D", "L", "M", "X", "J", "V", "S"]

        return VStack(spacing: 4) {
            Text(monthNames[month - 1])
                .font(.system(size: 13, weight: .bold))
                .frame(maxWidth: .infinity)

            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 2), count: 7), spacing: 2) {
                ForEach(dayHeaders, id: \.self) { h in
                    Text(h)
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                }
            }

            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 2), count: 7), spacing: 2) {
                ForEach(0..<firstWeekday, id: \.self) { _ in
                    Text("").frame(height: 26)
                }

                ForEach(1...daysInMonth, id: \.self) { day in
                    let dateStr = String(format: "%04d-%02d-%02d", year, month, day)
                    let dateObj = cal.date(from: DateComponents(year: year, month: month, day: day))!
                    let dow = cal.component(.weekday, from: dateObj) - 1
                    let hasSchedule = activeDays.contains(dow)
                    let isBlocked = blockedDates.contains(dateStr)
                    let today = todayStr()
                    let isPast = dateStr < today

                    Button {
                        editingDate = dateStr
                    } label: {
                        Text("\(day)")
                            .font(.system(size: 11, weight: dateStr == today ? .black : (hasSchedule && !isBlocked ? .semibold : .regular)))
                            .frame(maxWidth: .infinity)
                            .frame(height: 26)
                            .background(dayCellColor(hasSchedule: hasSchedule, isBlocked: isBlocked, isPast: isPast))
                            .foregroundStyle(dayCellFg(hasSchedule: hasSchedule, isBlocked: isBlocked, isPast: isPast))
                            .clipShape(RoundedRectangle(cornerRadius: 5))
                            .overlay(
                                RoundedRectangle(cornerRadius: 5)
                                    .stroke(dateStr == today ? Color.rdBlue : .clear, lineWidth: 2)
                            )
                    }
                    .disabled(isPast)
                }
            }
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(Color(.systemBackground))
                .shadow(color: .black.opacity(0.06), radius: 3, y: 1)
        )
    }

    private func dayCellColor(hasSchedule: Bool, isBlocked: Bool, isPast: Bool) -> Color {
        if isPast { return Color(.systemGray6) }
        if isBlocked { return Color.rdRed.opacity(0.2) }
        if hasSchedule { return Color.rdBlue.opacity(0.18) }
        return Color(.systemGray6).opacity(0.5)
    }

    private func dayCellFg(hasSchedule: Bool, isBlocked: Bool, isPast: Bool) -> Color {
        if isPast { return .secondary.opacity(0.35) }
        if isBlocked { return Color.rdRed }
        if hasSchedule { return Color.rdBlue }
        return .secondary
    }

    private func load() async {
        loading = true
        if let result = try? await api.fetchBrokerAvailability() {
            weekly = result.weekly; overrides = result.overrides
        }
        loading = false
    }
}

// MARK: - Day Editor Sheet

struct DayEditorSheet: View {
    let dateStr: String
    let weekly: [AvailabilitySlot]
    let overrides: [AvailabilitySlot]
    let duration: Int
    let api: APIService
    let onSave: () async -> Void

    @Environment(\.dismiss) private var dismiss

    enum DayStatus: String, CaseIterable { case available, blocked, off }

    @State private var status: DayStatus = .off
    @State private var timeRanges: [(start: Date, end: Date)] = []
    @State private var applyToAll = false
    @State private var saving = false

    private let dayFull = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"]
    private let monthNames = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
                              "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"]

    private var dateObj: Date {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; return f.date(from: dateStr) ?? Date()
    }
    private var dow: Int { Calendar.current.component(.weekday, from: dateObj) - 1 }
    private var dayName: String { dayFull[dow] }
    private var formattedDate: String {
        let cal = Calendar.current
        let d = cal.component(.day, from: dateObj)
        let m = cal.component(.month, from: dateObj)
        let y = cal.component(.year, from: dateObj)
        return "\(d) de \(monthNames[m - 1]), \(y)"
    }

    private var weeklySlots: [AvailabilitySlot] { weekly.filter { $0.day_of_week == dow } }
    private var isBlocked: Bool { overrides.contains { $0.date == dateStr && $0.available == false } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    // ── Header ──
                    VStack(alignment: .leading, spacing: 4) {
                        Text(dayName).font(.title2.bold())
                        Text(formattedDate).font(.subheadline).foregroundStyle(.secondary)
                    }
                    .padding(.horizontal)

                    // ── Status picker ──
                    HStack(spacing: 8) {
                        statusButton(.available, label: "Disponible", icon: "checkmark", activeColor: Color.rdBlue)
                        statusButton(.blocked, label: "Bloqueado", icon: "xmark", activeColor: Color.rdRed)
                        statusButton(.off, label: "Sin horario", icon: "minus", activeColor: Color(.systemGray3))
                    }
                    .padding(.horizontal)

                    // ── Time ranges (only when available) ──
                    if status == .available {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("HORARIOS DISPONIBLES")
                                .font(.caption2.bold())
                                .foregroundStyle(.secondary)
                                .tracking(0.5)

                            ForEach(timeRanges.indices, id: \.self) { i in
                                HStack(spacing: 8) {
                                    DatePicker("", selection: Binding(
                                        get: { timeRanges[i].start },
                                        set: { timeRanges[i].start = $0 }
                                    ), displayedComponents: .hourAndMinute)
                                    .labelsHidden()

                                    Text("a").foregroundStyle(.secondary).font(.caption)

                                    DatePicker("", selection: Binding(
                                        get: { timeRanges[i].end },
                                        set: { timeRanges[i].end = $0 }
                                    ), displayedComponents: .hourAndMinute)
                                    .labelsHidden()

                                    if timeRanges.count > 1 {
                                        Button {
                                            timeRanges.remove(at: i)
                                        } label: {
                                            Image(systemName: "trash")
                                                .font(.caption)
                                                .foregroundStyle(Color.rdRed)
                                        }
                                    }
                                }
                                .padding(10)
                                .background(Color(.systemGray6))
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                            }

                            Button {
                                let cal = Calendar.current
                                timeRanges.append((
                                    start: cal.date(from: DateComponents(hour: 9, minute: 0))!,
                                    end: cal.date(from: DateComponents(hour: 17, minute: 0))!
                                ))
                            } label: {
                                HStack {
                                    Image(systemName: "plus")
                                    Text("Agregar horario")
                                }
                                .font(.caption.bold())
                                .foregroundStyle(Color.rdBlue)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 10)
                                .background(
                                    RoundedRectangle(cornerRadius: 10)
                                        .strokeBorder(Color.rdBlue.opacity(0.3), style: StrokeStyle(lineWidth: 1.5, dash: [6]))
                                )
                            }
                        }
                        .padding(.horizontal)
                    }

                    // ── Apply to all toggle ──
                    Toggle(isOn: $applyToAll) {
                        HStack(spacing: 6) {
                            Image(systemName: "arrow.triangle.2.circlepath")
                                .font(.caption)
                                .foregroundStyle(Color.rdBlue)
                            Text("Aplicar a todos los \(dayName)")
                                .font(.subheadline)
                        }
                    }
                    .toggleStyle(.switch)
                    .tint(Color.rdBlue)
                    .padding()
                    .background(Color.rdBlue.opacity(0.05))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .padding(.horizontal)

                    Spacer(minLength: 20)

                    // ── Actions ──
                    HStack(spacing: 12) {
                        Button { dismiss() } label: {
                            Text("Cancelar")
                                .font(.subheadline.bold())
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 14)
                                .background(Color(.systemGray6))
                                .clipShape(RoundedRectangle(cornerRadius: 12))
                        }
                        .foregroundStyle(.primary)

                        Button {
                            saving = true
                            Task {
                                await save()
                                saving = false
                            }
                        } label: {
                            HStack {
                                if saving { ProgressView().tint(.white) }
                                Text("Guardar")
                            }
                            .font(.subheadline.bold())
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(Color.rdBlue)
                            .foregroundStyle(.white)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                        }
                        .disabled(saving)
                    }
                    .padding(.horizontal)
                }
                .padding(.vertical)
            }
            .navigationTitle("Editar día")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cerrar") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .onAppear { setupInitialState() }
    }

    // MARK: - Status Button

    private func statusButton(_ s: DayStatus, label: String, icon: String, activeColor: Color) -> some View {
        Button {
            status = s
        } label: {
            VStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.caption.bold())
                Text(label)
                    .font(.system(size: 11, weight: .semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(status == s ? activeColor.opacity(0.12) : Color(.systemGray6))
            .foregroundStyle(status == s ? activeColor : .secondary)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(status == s ? activeColor : .clear, lineWidth: 1.5)
            )
        }
    }

    // MARK: - Setup

    private func setupInitialState() {
        let cal = Calendar.current
        if isBlocked {
            status = .blocked
        } else if !weeklySlots.isEmpty {
            status = .available
        } else {
            status = .off
        }

        // Populate time ranges from weekly slots
        if !weeklySlots.isEmpty {
            timeRanges = weeklySlots.map { slot in
                let sParts = slot.start_time.split(separator: ":").map { Int($0) ?? 0 }
                let eParts = slot.end_time.split(separator: ":").map { Int($0) ?? 0 }
                return (
                    start: cal.date(from: DateComponents(hour: sParts[0], minute: sParts.count > 1 ? sParts[1] : 0))!,
                    end: cal.date(from: DateComponents(hour: eParts[0], minute: eParts.count > 1 ? eParts[1] : 0))!
                )
            }
        } else {
            timeRanges = [(
                start: cal.date(from: DateComponents(hour: 9, minute: 0))!,
                end: cal.date(from: DateComponents(hour: 17, minute: 0))!
            )]
        }
    }

    // MARK: - Save

    private func save() async {
        let cal = Calendar.current

        // Remove existing blocked override for this date
        if let existing = overrides.first(where: { $0.date == dateStr && $0.available == false }) {
            try? await api.deleteBrokerOverride(overrideId: existing.id)
        }

        if status == .blocked {
            try? await api.saveBrokerOverride(date: dateStr, available: false)
        }

        if applyToAll || status == .available || status == .off {
            // Update weekly schedule for this DOW
            let oldSlots = weeklySlots
            for s in oldSlots {
                try? await api.deleteBrokerAvailability(slotId: s.id)
            }
            if status == .available {
                for range in timeRanges {
                    let sH = cal.component(.hour, from: range.start)
                    let sM = cal.component(.minute, from: range.start)
                    let eH = cal.component(.hour, from: range.end)
                    let eM = cal.component(.minute, from: range.end)
                    let start = String(format: "%02d:%02d", sH, sM)
                    let end = String(format: "%02d:%02d", eH, eM)
                    if start < end {
                        try? await api.saveBrokerAvailability(
                            dayOfWeek: dow, startTime: start, endTime: end, duration: duration
                        )
                    }
                }
            }
        }

        await onSave()
    }
}

// Make String conform to Identifiable for sheet(item:)
extension String: @retroactive Identifiable {
    public var id: String { self }
}

// Make Int conform to Identifiable for sheet(item:)
extension Int: @retroactive Identifiable {
    public var id: Int { self }
}

// MARK: - Client My Tours View

struct MyToursView: View {
    @EnvironmentObject var api: APIService
    @State private var tours: [TourRequest] = []
    @State private var loading = true

    var body: some View {
        Group {
            if loading {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if tours.isEmpty {
                VStack(spacing: 12) {
                    Spacer()
                    Image(systemName: "calendar.badge.clock")
                        .font(.system(size: 40))
                        .foregroundStyle(.secondary)
                    Text("No tienes visitas agendadas")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Spacer()
                }
            } else {
                List {
                    ForEach(tours) { tour in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(tour.listing_title)
                                    .font(.subheadline).bold()
                                    .lineLimit(1)
                                Spacer()
                                Text(tour.statusLabel)
                                    .font(.caption2).bold()
                                    .padding(.horizontal, 8).padding(.vertical, 3)
                                    .background(statusColor(tour.status).opacity(0.15))
                                    .foregroundStyle(statusColor(tour.status))
                                    .clipShape(Capsule())
                            }
                            HStack(spacing: 12) {
                                Label(tour.formattedDate, systemImage: "calendar")
                                Label(tour.formattedTime, systemImage: "clock")
                            }
                            .font(.caption).foregroundStyle(.secondary)

                            if tour.isPending {
                                Button {
                                    Task { await cancel(tour.id) }
                                } label: {
                                    Text("Cancelar visita")
                                        .font(.caption).bold()
                                        .foregroundStyle(Color.rdRed)
                                }
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
                .listStyle(.plain)
            }
        }
        .navigationTitle("Mis Visitas")
        .task { await load() }
        .refreshable { await load() }
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "pending":   return .orange
        case "confirmed": return .rdGreen
        case "rejected":  return .rdRed
        default:          return .gray
        }
    }

    private func load() async {
        loading = true
        tours = (try? await api.fetchMyTourRequests()) ?? []
        loading = false
    }

    private func cancel(_ id: String) async {
        try? await api.cancelTour(tourId: id)
        await load()
    }
}
