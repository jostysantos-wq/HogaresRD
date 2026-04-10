import SwiftUI
import EventKit

// MARK: - Time Period Grouping
private enum TimePeriod: String, CaseIterable {
    case morning   = "Mañana"
    case afternoon = "Tarde"
    case evening   = "Noche"

    var icon: String {
        switch self {
        case .morning:   return "sun.max.fill"
        case .afternoon: return "cloud.sun.fill"
        case .evening:   return "moon.fill"
        }
    }

    var color: Color {
        switch self {
        case .morning:   return .orange
        case .afternoon: return Color.rdBlue
        case .evening:   return .indigo
        }
    }

    static func from(time: String) -> TimePeriod {
        let h = Int(time.prefix(2)) ?? 12
        if h < 12 { return .morning }
        if h < 17 { return .afternoon }
        return .evening
    }
}

// MARK: - Date Strip Day
private struct DateStripDay: Identifiable {
    let id: String       // yyyy-MM-dd
    let dayName: String  // "Lun"
    let dayNum: Int
    let isAvailable: Bool
    let isToday: Bool
}

// MARK: - Tour Booking Sheet (Client — Redesigned)

struct TourBookingSheet: View {
    let listing: Listing
    let brokerId: String
    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) var dismiss

    // Date/time selection
    @State private var availableDates: [String] = []
    @State private var currentMonth = Date()
    @State private var selectedDate: String?
    @State private var availableSlots: [AvailableSlot] = []
    @State private var selectedTime: String?
    @State private var loadingSlots = false
    @State private var loadingDates = false
    @State private var showFullCalendar = false
    @State private var dateStrip: [DateStripDay] = []

    // Contact info
    @State private var name      = ""
    @State private var phone     = ""
    @State private var email     = ""
    @State private var notes     = ""
    @State private var tourType  = "presencial"
    @State private var sending   = false
    @State private var sent      = false
    @State private var errorMsg: String?
    @State private var showContactFields = false
    @State private var calendarAdded = false

    private let dayNames = ["Do", "Lu", "Ma", "Mi", "Ju", "Vi", "Sa"]
    private let monthNames = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
                              "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"]

    private var canSubmit: Bool {
        selectedDate != nil && selectedTime != nil && !name.isEmpty && !phone.isEmpty && !sending
    }

    private var submitLabel: String {
        if let d = selectedDate, let t = selectedTime {
            return "Solicitar · \(formatDateShort(d)) · \(formatTime(t))"
        }
        return "Selecciona fecha y hora"
    }

    private var groupedSlots: [(TimePeriod, [AvailableSlot])] {
        let groups = Dictionary(grouping: availableSlots) { TimePeriod.from(time: $0.time) }
        return TimePeriod.allCases.compactMap { period in
            guard let slots = groups[period], !slots.isEmpty else { return nil }
            return (period, slots)
        }
    }

    var body: some View {
        NavigationStack {
            if sent {
                successView
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        // ── Listing context card ────────────────────
                        listingCard

                        // ── Date selection ──────────────────────────
                        dateSection

                        // ── Time slots ──────────────────────────────
                        if selectedDate != nil {
                            timeSlotsSection
                        }

                        // ── Tour type ───────────────────────────────
                        if selectedTime != nil {
                            tourTypeSection
                        }

                        // ── Contact info ────────────────────────────
                        if selectedTime != nil {
                            contactSection
                        }

                        // ── Notes ───────────────────────────────────
                        if selectedTime != nil {
                            notesSection
                        }

                        if let err = errorMsg {
                            Text(err)
                                .font(.caption).foregroundStyle(Color.rdRed)
                                .padding(.horizontal, 4)
                        }

                        Color.clear.frame(height: 80)
                    }
                    .padding(16)
                }
                .scrollDismissesKeyboard(.interactively)
                .navigationTitle("Agendar Visita")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cerrar") { dismiss() }
                    }
                }
                .safeAreaInset(edge: .bottom) {
                    // Sticky submit button
                    Button {
                        Task { await submitTour() }
                    } label: {
                        HStack {
                            if sending {
                                ProgressView().tint(.white)
                            } else {
                                Image(systemName: "calendar.badge.plus")
                            }
                            Text(submitLabel)
                                .font(.subheadline.bold())
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                        .foregroundStyle(.white)
                        .background(canSubmit ? Color.rdBlue : Color(.systemGray4),
                                    in: RoundedRectangle(cornerRadius: 14))
                    }
                    .disabled(!canSubmit)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
                    .background(.regularMaterial)
                }
            }
        }
        .onAppear {
            if let user = api.currentUser {
                name  = user.name
                email = user.email
                if let p = user.phone { phone = p }
            }
            buildDateStrip()
            loadMonth()
        }
    }

    // MARK: - Listing Context Card

    private var listingCard: some View {
        HStack(spacing: 12) {
            AsyncImage(url: listing.firstImageURL) { phase in
                switch phase {
                case .success(let img): img.resizable().scaledToFill()
                default:
                    RoundedRectangle(cornerRadius: 10)
                        .fill(Color.rdBlue.opacity(0.08))
                        .overlay(Image(systemName: "house.fill").foregroundStyle(Color.rdBlue.opacity(0.3)))
                }
            }
            .frame(width: 64, height: 64)
            .clipShape(RoundedRectangle(cornerRadius: 10))

            VStack(alignment: .leading, spacing: 3) {
                Text(listing.title)
                    .font(.subheadline.bold())
                    .lineLimit(2)
                Text(listing.priceFormatted)
                    .font(.caption.bold())
                    .foregroundStyle(Color.rdBlue)
                if let city = listing.city {
                    Label(city, systemImage: "mappin.circle.fill")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
    }

    // MARK: - Date Section

    private var dateSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Selecciona una fecha", systemImage: "calendar")
                .font(.headline)

            if loadingDates && dateStrip.isEmpty {
                ProgressView("Cargando disponibilidad...")
                    .frame(maxWidth: .infinity).padding(.vertical, 20)
            } else {
                // Horizontal date strip — next 14 days
                ScrollViewReader { proxy in
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(dateStrip) { day in
                                Button {
                                    if day.isAvailable {
                                        withAnimation(.easeOut(duration: 0.15)) {
                                            selectedDate = day.id
                                            selectedTime = nil
                                        }
                                        loadSlots(day.id)
                                    }
                                } label: {
                                    VStack(spacing: 4) {
                                        Text(day.dayName)
                                            .font(.system(size: 11, weight: .medium))
                                        Text("\(day.dayNum)")
                                            .font(.system(size: 18, weight: .bold))
                                        Circle()
                                            .fill(day.isAvailable ? Color.rdGreen : Color(.systemGray5))
                                            .frame(width: 6, height: 6)
                                    }
                                    .frame(width: 52, height: 70)
                                    .foregroundStyle(
                                        selectedDate == day.id ? .white :
                                        day.isAvailable ? .primary :
                                        Color(.systemGray4)
                                    )
                                    .background(
                                        selectedDate == day.id ? Color.rdBlue :
                                        day.isToday ? Color.rdBlue.opacity(0.08) :
                                        Color(.secondarySystemFill),
                                        in: RoundedRectangle(cornerRadius: 12)
                                    )
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 12)
                                            .stroke(day.isToday && selectedDate != day.id ? Color.rdBlue.opacity(0.3) : .clear, lineWidth: 1)
                                    )
                                }
                                .buttonStyle(.plain)
                                .disabled(!day.isAvailable)
                                .id(day.id)
                            }
                        }
                    }
                    .onAppear {
                        if let sel = selectedDate {
                            proxy.scrollTo(sel, anchor: .center)
                        }
                    }
                }

                // Expand to full calendar
                Button {
                    withAnimation(.easeInOut(duration: 0.25)) {
                        showFullCalendar.toggle()
                    }
                } label: {
                    Label(
                        showFullCalendar ? "Ocultar calendario" : "Ver calendario completo",
                        systemImage: showFullCalendar ? "chevron.up" : "calendar"
                    )
                    .font(.caption.bold())
                    .foregroundStyle(Color.rdBlue)
                }

                if showFullCalendar {
                    fullCalendarView
                        .transition(.opacity.combined(with: .scale(scale: 0.98, anchor: .top)))
                }
            }
        }
    }

    // MARK: - Full Calendar (expandable)

    private var fullCalendarView: some View {
        VStack(spacing: 12) {
            // Month navigation
            HStack {
                Button { prevMonth() } label: {
                    Image(systemName: "chevron.left").font(.caption.bold())
                        .padding(8).background(Color(.systemGray6), in: Circle())
                }
                Spacer()
                Text(monthLabel).font(.subheadline.bold())
                Spacer()
                Button { nextMonth() } label: {
                    Image(systemName: "chevron.right").font(.caption.bold())
                        .padding(8).background(Color(.systemGray6), in: Circle())
                }
            }

            calendarGrid
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
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
            ForEach(dayNames, id: \.self) { day in
                Text(day).font(.caption2.bold()).foregroundStyle(.secondary).frame(maxWidth: .infinity)
            }
            ForEach(0..<firstWeekday, id: \.self) { _ in Color.clear.frame(height: 36) }
            ForEach(1...daysInMonth, id: \.self) { day in
                let dateStr = String(format: "%04d-%02d-%02d", year, month, day)
                let isAvail = availableDates.contains(dateStr) && dateStr >= today
                let isSelected = dateStr == selectedDate
                let isPast = dateStr < today

                Button {
                    if isAvail {
                        selectedDate = dateStr; selectedTime = nil
                        loadSlots(dateStr)
                    }
                } label: {
                    Text("\(day)")
                        .font(.caption.bold())
                        .frame(maxWidth: .infinity).frame(height: 36)
                        .background(isSelected ? Color.rdBlue : isAvail ? Color.rdGreen.opacity(0.15) : Color.clear)
                        .foregroundStyle(isSelected ? .white : isPast || !isAvail ? Color(.systemGray4) : .primary)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }
                .disabled(!isAvail || isPast)
            }
        }
    }

    // MARK: - Time Slots Section (Grouped by Period)

    private var timeSlotsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("Horarios disponibles", systemImage: "clock")
                    .font(.headline)
                Spacer()
                if let d = selectedDate {
                    Text(formatDateShort(d))
                        .font(.caption.bold())
                        .foregroundStyle(Color.rdBlue)
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(Color.rdBlue.opacity(0.08), in: Capsule())
                }
            }

            if loadingSlots {
                ProgressView("Cargando horarios...")
                    .frame(maxWidth: .infinity).padding(.vertical, 24)
            } else if availableSlots.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "clock.badge.xmark")
                        .font(.system(size: 32)).foregroundStyle(.secondary)
                    Text("No hay horarios disponibles para esta fecha.")
                        .font(.caption).foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity).padding(.vertical, 20)
            } else {
                ForEach(groupedSlots, id: \.0) { period, slots in
                    VStack(alignment: .leading, spacing: 8) {
                        // Period header
                        Label(period.rawValue, systemImage: period.icon)
                            .font(.caption.bold())
                            .foregroundStyle(period.color)

                        // Slot chips (wrapping flow)
                        FlowLayout(spacing: 8) {
                            ForEach(slots, id: \.time) { slot in
                                Button {
                                    withAnimation(.easeOut(duration: 0.1)) {
                                        selectedTime = slot.time
                                    }
                                } label: {
                                    Text(formatTime(slot.time))
                                        .font(.caption.bold())
                                        .padding(.horizontal, 14).padding(.vertical, 10)
                                        .foregroundStyle(selectedTime == slot.time ? .white : .primary)
                                        .background(
                                            selectedTime == slot.time ? Color.rdBlue : Color(.secondarySystemFill),
                                            in: Capsule()
                                        )
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    .padding(12)
                    .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
                }
            }
        }
    }

    // MARK: - Tour Type Section

    private var tourTypeSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Tipo de visita", systemImage: "person.wave.2")
                .font(.headline)

            HStack(spacing: 10) {
                tourTypeCard(
                    type: "presencial",
                    icon: "house.fill",
                    title: "Presencial",
                    subtitle: "Visita en persona"
                )
                tourTypeCard(
                    type: "virtual",
                    icon: "video.fill",
                    title: "Virtual",
                    subtitle: "Videollamada"
                )
            }
        }
    }

    private func tourTypeCard(type: String, icon: String, title: String, subtitle: String) -> some View {
        Button {
            withAnimation(.easeOut(duration: 0.15)) { tourType = type }
        } label: {
            VStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 22))
                    .foregroundStyle(tourType == type ? .white : Color.rdBlue)
                Text(title)
                    .font(.caption.bold())
                    .foregroundStyle(tourType == type ? .white : .primary)
                Text(subtitle)
                    .font(.system(size: 9))
                    .foregroundStyle(tourType == type ? .white.opacity(0.8) : .secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .background(
                tourType == type ? Color.rdBlue : Color(.secondarySystemGroupedBackground),
                in: RoundedRectangle(cornerRadius: 14)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14)
                    .stroke(tourType == type ? Color.rdBlue : Color(.systemGray4).opacity(0.5), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    // MARK: - Contact Section

    private var contactSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Tus datos", systemImage: "person.text.rectangle")
                .font(.headline)

            if !name.isEmpty && !phone.isEmpty && !showContactFields {
                // Compact summary for logged-in users
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(name).font(.subheadline.bold())
                        Text(phone).font(.caption).foregroundStyle(.secondary)
                        if !email.isEmpty {
                            Text(email).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Button {
                        showContactFields = true
                    } label: {
                        Text("Editar")
                            .font(.caption.bold())
                            .foregroundStyle(Color.rdBlue)
                    }
                }
                .padding(12)
                .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
            } else {
                VStack(spacing: 10) {
                    formField("Nombre completo", text: $name, icon: "person.fill")
                    formField("Teléfono", text: $phone, icon: "phone.fill", keyboard: .phonePad)
                    formField("Correo electrónico", text: $email, icon: "envelope.fill", keyboard: .emailAddress)
                }
            }
        }
    }

    // MARK: - Notes Section

    private var notesSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Notas (opcional)", systemImage: "note.text")
                .font(.caption.bold())
                .foregroundStyle(.secondary)
            TextField("Algo que el agente deba saber...", text: $notes, axis: .vertical)
                .lineLimit(2...4)
                .padding(12)
                .background(Color(.secondarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: 12))

            Text("El agente deberá confirmar tu solicitud. Recibirás una notificación cuando sea aprobada.")
                .font(.system(size: 10)).foregroundStyle(.tertiary)
        }
    }

    // MARK: - Success View

    private var successView: some View {
        VStack(spacing: 20) {
            Spacer()

            ZStack {
                Circle().fill(Color.rdGreen.opacity(0.1)).frame(width: 100, height: 100)
                Circle().fill(Color.rdGreen.opacity(0.05)).frame(width: 130, height: 130)
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 56)).foregroundStyle(Color.rdGreen)
            }

            VStack(spacing: 8) {
                Text("¡Visita solicitada!")
                    .font(.title2).bold()
                Text("Tu solicitud ha sido enviada al agente. Recibirás una confirmación cuando sea aprobada.")
                    .font(.subheadline).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center).padding(.horizontal, 24)
            }

            if let date = selectedDate, let time = selectedTime {
                HStack(spacing: 14) {
                    Image(systemName: tourType == "virtual" ? "video.fill" : "house.fill")
                        .font(.title3).foregroundStyle(Color.rdBlue)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(formatDateLabel(date)).font(.subheadline.bold())
                        Text(formatTime(time)).font(.caption).foregroundStyle(.secondary)
                        Text(tourType == "virtual" ? "Videollamada" : "Presencial")
                            .font(.caption2).foregroundStyle(Color.rdBlue)
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
                .padding(.horizontal, 24)
            }

            Spacer()

            VStack(spacing: 10) {
                // Add to Calendar button
                if let date = selectedDate, let time = selectedTime {
                    Button {
                        addToCalendar(date: date, time: time)
                    } label: {
                        Label(calendarAdded ? "Agregado al Calendario" : "Agregar al Calendario",
                              systemImage: calendarAdded ? "checkmark" : "calendar.badge.plus")
                            .font(.subheadline.bold())
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .foregroundStyle(calendarAdded ? Color.rdGreen : Color.rdBlue)
                            .background(
                                calendarAdded ? Color.rdGreen.opacity(0.08) : Color.rdBlue.opacity(0.08),
                                in: RoundedRectangle(cornerRadius: 14)
                            )
                    }
                    .disabled(calendarAdded)
                }

                Button {
                    dismiss()
                } label: {
                    Text("Cerrar")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                        .foregroundStyle(.white)
                        .background(Color.rdBlue, in: RoundedRectangle(cornerRadius: 14))
                }
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 32)
        }
    }

    // MARK: - Helpers

    private func formField(_ placeholder: String, text: Binding<String>, icon: String, keyboard: UIKeyboardType = .default) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon).font(.caption).foregroundStyle(.secondary).frame(width: 20)
            TextField(placeholder, text: text)
                .keyboardType(keyboard)
                .textInputAutocapitalization(keyboard == .emailAddress ? .never : .words)
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func buildDateStrip() {
        let cal = Calendar.current
        let today = Date()
        let fmt = DateFormatter()
        fmt.locale = Locale(identifier: "es_DO")
        let dateFmt = DateFormatter()
        dateFmt.dateFormat = "yyyy-MM-dd"

        dateStrip = (0..<14).compactMap { offset -> DateStripDay? in
            guard let date = cal.date(byAdding: .day, value: offset, to: today) else { return nil }
            fmt.dateFormat = "EEE"
            let dayName = fmt.string(from: date).prefix(3).capitalized
            let dayNum = cal.component(.day, from: date)
            let dateStr = dateFmt.string(from: date)
            return DateStripDay(
                id: dateStr,
                dayName: String(dayName),
                dayNum: dayNum,
                isAvailable: false, // will be updated when availableDates loads
                isToday: offset == 0
            )
        }
    }

    private func updateDateStripAvailability() {
        let today = todayString()
        dateStrip = dateStrip.map { day in
            DateStripDay(
                id: day.id,
                dayName: day.dayName,
                dayNum: day.dayNum,
                isAvailable: availableDates.contains(day.id) && day.id >= today,
                isToday: day.isToday
            )
        }
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
                    updateDateStripAvailability()
                    loadingDates = false
                }
            } catch {
                await MainActor.run { loadingDates = false }
            }
            // Also load next month for the 14-day strip
            if let next = cal.date(byAdding: .month, value: 1, to: currentMonth) {
                let ny = cal.component(.year, from: next)
                let nm = cal.component(.month, from: next)
                let nextStr = String(format: "%04d-%02d", ny, nm)
                if let moreDates = try? await api.fetchSchedule(brokerId: brokerId, month: nextStr) {
                    await MainActor.run {
                        availableDates.append(contentsOf: moreDates)
                        updateDateStripAvailability()
                    }
                }
            }
        }
    }

    private func loadSlots(_ date: String) {
        loadingSlots = true
        availableSlots = []
        Task {
            do {
                let slots = try await api.fetchAvailableSlots(brokerId: brokerId, date: date)
                await MainActor.run { availableSlots = slots; loadingSlots = false }
            } catch {
                await MainActor.run { loadingSlots = false }
            }
        }
    }

    private func prevMonth() {
        let cal = Calendar.current; let now = Date()
        if let prev = cal.date(byAdding: .month, value: -1, to: currentMonth) {
            if cal.component(.year, from: prev) > cal.component(.year, from: now) ||
               (cal.component(.year, from: prev) == cal.component(.year, from: now) &&
                cal.component(.month, from: prev) >= cal.component(.month, from: now)) {
                currentMonth = prev; loadMonth()
            }
        }
    }

    private func nextMonth() {
        if let next = Calendar.current.date(byAdding: .month, value: 1, to: currentMonth) {
            currentMonth = next; loadMonth()
        }
    }

    private var monthLabel: String {
        let cal = Calendar.current
        let m = cal.component(.month, from: currentMonth)
        let y = cal.component(.year, from: currentMonth)
        return "\(monthNames[m - 1]) \(y)"
    }

    private func todayString() -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; return f.string(from: Date())
    }

    private func formatDateLabel(_ dateStr: String) -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"
        guard let date = f.date(from: dateStr) else { return dateStr }
        f.dateFormat = "EEEE d 'de' MMMM"; f.locale = Locale(identifier: "es_DO")
        return f.string(from: date).capitalized
    }

    private func formatDateShort(_ dateStr: String) -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"
        guard let date = f.date(from: dateStr) else { return dateStr }
        f.dateFormat = "EEE d MMM"; f.locale = Locale(identifier: "es_DO")
        return f.string(from: date).capitalized
    }

    private func formatTime(_ time: String) -> String {
        let parts = time.split(separator: ":")
        guard parts.count >= 2, let h = Int(parts[0]) else { return time }
        let m = parts[1]; let ampm = h >= 12 ? "PM" : "AM"
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
                name: name, phone: phone, email: email, notes: notes,
                tourType: tourType
            )
            sent = true
        } catch {
            errorMsg = error.localizedDescription
        }
        sending = false
    }

    private func addToCalendar(date: String, time: String) {
        let store = EKEventStore()
        store.requestFullAccessToEvents { granted, _ in
            guard granted else { return }
            let event = EKEvent(eventStore: store)
            event.title = "Visita: \(listing.title)"
            event.location = listing.city ?? listing.province ?? ""

            let df = DateFormatter()
            df.dateFormat = "yyyy-MM-dd HH:mm"
            if let start = df.date(from: "\(date) \(time)") {
                event.startDate = start
                event.endDate = Calendar.current.date(byAdding: .minute, value: 30, to: start) ?? start
            }
            event.addAlarm(EKAlarm(relativeOffset: -900)) // 15 min before
            event.notes = tourType == "virtual" ? "Videollamada con agente" : "Visita presencial"
            event.calendar = store.defaultCalendarForNewEvents

            do {
                try store.save(event, span: .thisEvent)
                DispatchQueue.main.async { calendarAdded = true }
            } catch {
                print("[Tour] Calendar save error:", error.localizedDescription)
            }
        }
    }
}

// FlowLayout is defined in ListingDetailView.swift — reused here for time slot chips

// MARK: - Broker Tours View

struct BrokerToursView: View {
    @EnvironmentObject var api: APIService
    @State private var tours: [TourRequest] = []
    @State private var loading = true
    @State private var selectedTab = 0
    @State private var rejectingId: String?
    @State private var rejectReason = ""
    @State private var reschedulingTour: TourRequest?

    var body: some View {
        VStack(spacing: 0) {
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
        .alert("Motivo del rechazo", isPresented: .init(
            get: { rejectingId != nil },
            set: { if !$0 { rejectingId = nil; rejectReason = "" } }
        )) {
            TextField("Motivo (opcional)", text: $rejectReason)
            Button("Rechazar", role: .destructive) {
                if let id = rejectingId {
                    Task { await updateStatus(id, "rejected", notes: rejectReason) }
                }
                rejectingId = nil; rejectReason = ""
            }
            Button("Cancelar", role: .cancel) { rejectingId = nil; rejectReason = "" }
        }
        .sheet(item: $reschedulingTour) { tour in
            RescheduleSheet(tour: tour, onDone: { await loadTours() })
                .environmentObject(api)
        }
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
                if tour.isVirtual {
                    Text("Virtual")
                        .font(.caption2).bold()
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Color.purple.opacity(0.15))
                        .foregroundStyle(.purple)
                        .clipShape(Capsule())
                }
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

            if let link = tour.virtual_link, !link.isEmpty, tour.isVirtual {
                Link(destination: URL(string: link) ?? URL(string: "https://hogaresrd.com")!) {
                    Label("Enlace virtual", systemImage: "video.fill")
                        .font(.caption).bold()
                }
            }

            // Feedback display
            if let rating = tour.feedback_rating {
                HStack(spacing: 4) {
                    ForEach(1...5, id: \.self) { i in
                        Image(systemName: i <= rating ? "star.fill" : "star")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                    }
                    if let comment = tour.feedback_comment, !comment.isEmpty {
                        Text(comment).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }

            // Action buttons
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
                        rejectingId = tour.id
                    } label: {
                        Label("Rechazar", systemImage: "xmark")
                            .font(.caption).bold()
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .background(Color.rdRed, in: RoundedRectangle(cornerRadius: 8))
                            .foregroundStyle(.white)
                    }
                }
            } else if tour.isConfirmed {
                HStack(spacing: 8) {
                    Button {
                        Task { await completeTour(tour.id) }
                    } label: {
                        Label("Completar", systemImage: "checkmark.circle.fill")
                            .font(.caption).bold()
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .background(Color.rdBlue, in: RoundedRectangle(cornerRadius: 8))
                            .foregroundStyle(.white)
                    }
                    Button {
                        reschedulingTour = tour
                    } label: {
                        Label("Reprogramar", systemImage: "calendar.badge.clock")
                            .font(.caption).bold()
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .background(Color.purple.opacity(0.15), in: RoundedRectangle(cornerRadius: 8))
                            .foregroundStyle(.purple)
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
            case "pending":    return ("Pendiente", .orange)
            case "confirmed":  return ("Confirmada", .rdGreen)
            case "rejected":   return ("Rechazada", .rdRed)
            case "cancelled":  return ("Cancelada", .gray)
            case "completed":  return ("Completada", .rdBlue)
            default:           return (status.capitalized, .gray)
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

    private func updateStatus(_ id: String, _ status: String, notes: String? = nil) async {
        try? await api.updateTourStatus(tourId: id, status: status, notes: notes)
        await loadTours()
    }

    private func completeTour(_ id: String) async {
        try? await api.completeTour(tourId: id)
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
    @State private var editingDates: [String] = []
    @State private var showEditor = false
    @State private var selectedDates: Set<String> = []
    @State private var autoConfirm = false

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
                // ── Auto-confirm toggle ──
                Toggle(isOn: $autoConfirm) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Confirmar automáticamente")
                            .font(.subheadline).bold()
                        Text("Las solicitudes se confirman sin aprobación manual")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
                .tint(Color.rdBlue)
                .padding(12)
                .background(Color(.systemGray6))
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .onChange(of: autoConfirm) { _, newVal in
                    Task { try? await api.updateAutoConfirmTours(enabled: newVal) }
                }

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
                Text(selectedDates.isEmpty
                     ? "Toca un día para editarlo, o selecciona varios"
                     : "\(selectedDates.count) día\(selectedDates.count > 1 ? "s" : "") seleccionado\(selectedDates.count > 1 ? "s" : "")")
                    .font(.caption).foregroundStyle(selectedDates.isEmpty ? .secondary : Color.rdBlue)
                    .fontWeight(selectedDates.isEmpty ? .regular : .bold)
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
        .overlay(alignment: .bottom) {
            if !selectedDates.isEmpty {
                HStack(spacing: 12) {
                    Text("\(selectedDates.count) día\(selectedDates.count > 1 ? "s" : "")")
                        .font(.subheadline.bold())
                        .foregroundStyle(.white)

                    Button {
                        editingDates = selectedDates.sorted()
                        showEditor = true
                    } label: {
                        Text("Editar")
                            .font(.caption.bold())
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .background(.white)
                            .foregroundStyle(Color.rdBlue)
                            .clipShape(Capsule())
                    }

                    Button {
                        selectedDates.removeAll()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.caption.bold())
                            .foregroundStyle(.white.opacity(0.8))
                            .padding(8)
                            .background(.white.opacity(0.2))
                            .clipShape(Circle())
                    }
                }
                .padding(.horizontal, 20).padding(.vertical, 12)
                .background(Color.rdBlue)
                .clipShape(Capsule())
                .shadow(color: .black.opacity(0.2), radius: 10, y: 4)
                .padding(.bottom, 16)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .animation(.spring(response: 0.3), value: selectedDates.isEmpty)
            }
        }
        .sheet(isPresented: $showEditor) {
            DayEditorSheet(
                dates: editingDates,
                weekly: weekly,
                overrides: overrides,
                duration: duration,
                api: api,
                onSave: {
                    await load()
                    selectedDates.removeAll()
                    showEditor = false
                }
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
                        if selectedDates.isEmpty {
                            // Single tap → open editor for this day
                            editingDates = [dateStr]
                            showEditor = true
                        } else {
                            // Multi-select mode: toggle
                            if selectedDates.contains(dateStr) {
                                selectedDates.remove(dateStr)
                            } else {
                                selectedDates.insert(dateStr)
                            }
                        }
                    } label: {
                        let isSelected = selectedDates.contains(dateStr)
                        Text("\(day)")
                            .font(.system(size: 11, weight: dateStr == today ? .black : (hasSchedule && !isBlocked ? .semibold : .regular)))
                            .frame(maxWidth: .infinity)
                            .frame(height: 26)
                            .background(isSelected ? Color.rdBlue.opacity(0.35) : dayCellColor(hasSchedule: hasSchedule, isBlocked: isBlocked, isPast: isPast))
                            .foregroundStyle(isSelected ? Color.rdBlue : dayCellFg(hasSchedule: hasSchedule, isBlocked: isBlocked, isPast: isPast))
                            .clipShape(RoundedRectangle(cornerRadius: 5))
                            .overlay(
                                RoundedRectangle(cornerRadius: 5)
                                    .stroke(isSelected ? Color.rdBlue : (dateStr == today ? Color.rdBlue : .clear), lineWidth: isSelected ? 2.5 : 2)
                            )
                            .scaleEffect(isSelected ? 1.08 : 1.0)
                    }
                    .disabled(isPast)
                    .simultaneousGesture(LongPressGesture(minimumDuration: 0.4).onEnded { _ in
                        if !isPast {
                            // Long press starts multi-select
                            selectedDates.insert(dateStr)
                        }
                    })
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
        if let settings = try? await api.fetchTourSettings() {
            autoConfirm = settings["auto_confirm_tours"] ?? false
        }
        loading = false
    }
}

// MARK: - Day Editor Sheet

struct DayEditorSheet: View {
    let dates: [String]
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

    private var isMulti: Bool { dates.count > 1 }
    private var firstDateStr: String { dates.first ?? "" }
    private var dateObj: Date {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; return f.date(from: firstDateStr) ?? Date()
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

    private var uniqueDows: [Int] {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"
        let dows = dates.compactMap { f.date(from: $0) }.map { Calendar.current.component(.weekday, from: $0) - 1 }
        return Array(Set(dows)).sorted()
    }
    private var dowLabel: String {
        uniqueDows.map { dayFull[$0] }.joined(separator: ", ")
    }

    private var headerTitle: String {
        isMulti ? "\(dates.count) días seleccionados" : dayName
    }
    private var headerSub: String {
        isMulti ? dowLabel : formattedDate
    }

    private var weeklySlots: [AvailabilitySlot] { isMulti ? [] : weekly.filter { $0.day_of_week == dow } }
    private var isBlocked: Bool { isMulti ? false : overrides.contains { $0.date == firstDateStr && $0.available == false } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    // ── Header ──
                    VStack(alignment: .leading, spacing: 4) {
                        Text(headerTitle).font(.title2.bold())
                        Text(headerSub).font(.subheadline).foregroundStyle(.secondary)
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
                            Text("Aplicar a todos los \(isMulti ? dowLabel : dayName)")
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
        if isMulti {
            status = .available
            applyToAll = true
        } else if isBlocked {
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
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"

        // Process overrides for each selected date
        for dateStr in dates {
            if let existing = overrides.first(where: { $0.date == dateStr && $0.available == false }) {
                try? await api.deleteBrokerOverride(overrideId: existing.id)
            }
            if status == .blocked {
                try? await api.saveBrokerOverride(date: dateStr, available: false)
            }
        }

        // Update weekly schedule for affected DOWs
        if applyToAll || status == .available || status == .off {
            let affectedDows = uniqueDows
            for dowVal in affectedDows {
                let oldSlots = weekly.filter { $0.day_of_week == dowVal }
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
                                dayOfWeek: dowVal, startTime: start, endTime: end, duration: duration
                            )
                        }
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

// MARK: - Reschedule Sheet

struct RescheduleSheet: View {
    let tour: TourRequest
    let onDone: () async -> Void
    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) var dismiss

    @State private var step = 1
    @State private var availableDates: [String] = []
    @State private var currentMonth = Date()
    @State private var selectedDate: String?
    @State private var availableSlots: [AvailableSlot] = []
    @State private var selectedTime: String?
    @State private var loadingDates = false
    @State private var loadingSlots = false
    @State private var saving = false
    @State private var errorMsg: String?

    private let dayNames = ["Do", "Lu", "Ma", "Mi", "Ju", "Vi", "Sa"]
    private let monthNames = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
                              "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"]

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Step indicator
                HStack(spacing: 0) {
                    stepDot(1, "Fecha")
                    Rectangle().fill(step >= 2 ? Color.rdBlue : Color(.systemGray4)).frame(height: 2).frame(maxWidth: 40)
                    stepDot(2, "Hora")
                }
                .padding()

                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        // Current appointment info
                        HStack(spacing: 10) {
                            Image(systemName: "arrow.triangle.swap")
                                .foregroundStyle(Color.rdBlue)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Fecha actual: \(tour.formattedDate)")
                                    .font(.caption).foregroundStyle(.secondary)
                                Text("Hora actual: \(tour.formattedTime)")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .padding(10)
                        .background(Color.rdBlue.opacity(0.06))
                        .clipShape(RoundedRectangle(cornerRadius: 10))

                        if step == 1 { dateStepBody }
                        else { timeStepBody }
                    }
                    .padding(16)
                }
            }
            .navigationTitle("Reprogramar Visita")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cerrar") { dismiss() }
                }
            }
        }
        .onAppear { loadMonth() }
    }

    @ViewBuilder private func stepDot(_ s: Int, _ label: String) -> some View {
        VStack(spacing: 4) {
            ZStack {
                Circle()
                    .fill(s <= step ? Color.rdBlue : Color(.systemGray4))
                    .frame(width: 28, height: 28)
                Text("\(s)").font(.caption2.bold()).foregroundStyle(.white)
            }
            Text(label).font(.caption2).foregroundStyle(s <= step ? .primary : .secondary)
        }
    }

    // MARK: - Date Step
    @ViewBuilder private var dateStepBody: some View {
        let cal = Calendar.current
        let comps = cal.dateComponents([.year, .month], from: currentMonth)
        let year = comps.year!, month = comps.month!
        let monthLabel = "\(monthNames[month - 1]) \(year)"
        let monthStr = String(format: "%04d-%02d", year, month)

        VStack(spacing: 12) {
            HStack {
                Button { moveMonth(-1) } label: { Image(systemName: "chevron.left").font(.caption.bold()) }
                Spacer()
                Text(monthLabel).font(.subheadline.bold())
                Spacer()
                Button { moveMonth(1) } label: { Image(systemName: "chevron.right").font(.caption.bold()) }
            }

            LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 7), spacing: 8) {
                ForEach(dayNames, id: \.self) { d in
                    Text(d).font(.caption2.bold()).foregroundStyle(.secondary)
                }
                let firstWeekday = cal.component(.weekday, from: cal.date(from: DateComponents(year: year, month: month, day: 1))!) - 1
                ForEach(0..<firstWeekday, id: \.self) { _ in Color.clear.frame(height: 36) }
                let daysInMonth = cal.range(of: .day, in: .month, for: currentMonth)!.count
                ForEach(1...daysInMonth, id: \.self) { day in
                    let dateStr = String(format: "%04d-%02d-%02d", year, month, day)
                    let isAvail = availableDates.contains(dateStr)
                    let isSel = selectedDate == dateStr

                    Button {
                        if isAvail {
                            selectedDate = dateStr
                            loadSlots(dateStr)
                            step = 2
                        }
                    } label: {
                        Text("\(day)")
                            .font(.caption)
                            .frame(width: 36, height: 36)
                            .background(isSel ? Color.rdBlue : (isAvail ? Color.rdBlue.opacity(0.1) : Color.clear))
                            .foregroundStyle(isSel ? .white : (isAvail ? .primary : .secondary.opacity(0.4)))
                            .clipShape(Circle())
                    }
                    .disabled(!isAvail)
                }
            }

            if loadingDates {
                ProgressView().padding()
            }
        }
    }

    // MARK: - Time Step
    @ViewBuilder private var timeStepBody: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button { step = 1; selectedTime = nil } label: {
                Label("Cambiar fecha", systemImage: "chevron.left")
                    .font(.caption.bold()).foregroundStyle(Color.rdBlue)
            }

            if loadingSlots {
                ProgressView().frame(maxWidth: .infinity).padding()
            } else if availableSlots.isEmpty {
                Text("No hay horarios disponibles para esta fecha")
                    .font(.caption).foregroundStyle(.secondary).padding()
            } else {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 3), spacing: 8) {
                    ForEach(availableSlots, id: \.time) { slot in
                        let isSel = selectedTime == slot.time
                        Button { selectedTime = slot.time } label: {
                            Text(formatTime(slot.time))
                                .font(.caption).bold()
                                .padding(.vertical, 10)
                                .frame(maxWidth: .infinity)
                                .background(isSel ? Color.rdBlue : Color(.systemGray6))
                                .foregroundStyle(isSel ? .white : .primary)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
            }

            if let err = errorMsg {
                Text(err).font(.caption).foregroundStyle(.red)
            }

            if selectedTime != nil {
                Button {
                    Task { await reschedule() }
                } label: {
                    if saving {
                        ProgressView().frame(maxWidth: .infinity).padding(.vertical, 12)
                    } else {
                        Text("Confirmar Reprogramación")
                            .font(.subheadline).bold()
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                    }
                }
                .background(Color.rdBlue, in: RoundedRectangle(cornerRadius: 10))
                .foregroundStyle(.white)
                .disabled(saving)
            }
        }
    }

    // MARK: - Helpers
    private func formatTime(_ t: String) -> String {
        let parts = t.split(separator: ":")
        guard parts.count >= 2, let h = Int(parts[0]) else { return t }
        let m = parts[1]
        let ampm = h >= 12 ? "PM" : "AM"
        let h12 = h > 12 ? h - 12 : (h == 0 ? 12 : h)
        return "\(h12):\(m) \(ampm)"
    }

    private func moveMonth(_ delta: Int) {
        currentMonth = Calendar.current.date(byAdding: .month, value: delta, to: currentMonth)!
        selectedDate = nil; selectedTime = nil
        loadMonth()
    }

    private func loadMonth() {
        loadingDates = true
        let comps = Calendar.current.dateComponents([.year, .month], from: currentMonth)
        let monthStr = String(format: "%04d-%02d", comps.year!, comps.month!)
        Task {
            availableDates = (try? await api.fetchSchedule(brokerId: tour.broker_id, month: monthStr)) ?? []
            loadingDates = false
        }
    }

    private func loadSlots(_ date: String) {
        loadingSlots = true
        Task {
            availableSlots = (try? await api.fetchAvailableSlots(brokerId: tour.broker_id, date: date)) ?? []
            loadingSlots = false
        }
    }

    private func reschedule() async {
        guard let date = selectedDate, let time = selectedTime else { return }
        saving = true; errorMsg = nil
        do {
            try await api.rescheduleTour(tourId: tour.id, date: date, time: time)
            await onDone()
            dismiss()
        } catch {
            errorMsg = "Error al reprogramar. Intenta de nuevo."
        }
        saving = false
    }
}

// MARK: - Client My Tours View

struct MyToursView: View {
    @EnvironmentObject var api: APIService
    @State private var tours: [TourRequest] = []
    @State private var loading = true
    @State private var feedbackTourId: String?
    @State private var feedbackRating = 5
    @State private var feedbackComment = ""
    @State private var reschedulingTour: TourRequest?

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
                        myTourCard(tour).padding(.vertical, 4)
                    }
                }
                .listStyle(.plain)
            }
        }
        .navigationTitle("Mis Visitas")
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $feedbackTourId) { tourId in
            feedbackSheet(tourId: tourId)
        }
        .sheet(item: $reschedulingTour) { tour in
            RescheduleSheet(tour: tour, onDone: { await load() })
                .environmentObject(api)
        }
    }

    @ViewBuilder
    private func myTourCard(_ tour: TourRequest) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(tour.listing_title)
                    .font(.subheadline).bold()
                    .lineLimit(1)
                if tour.isVirtual {
                    Text("Virtual")
                        .font(.caption2).bold()
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Color.purple.opacity(0.15))
                        .foregroundStyle(.purple)
                        .clipShape(Capsule())
                }
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

            if let link = tour.virtual_link, !link.isEmpty, tour.isVirtual, tour.isConfirmed {
                Link(destination: URL(string: link) ?? URL(string: "https://hogaresrd.com")!) {
                    Label("Unirse a visita virtual", systemImage: "video.fill")
                        .font(.caption).bold()
                }
            }

            if let notes = tour.broker_notes, !notes.isEmpty {
                Text("Nota del agente: \(notes)")
                    .font(.caption).foregroundStyle(.secondary)
            }

            // Feedback display
            if let rating = tour.feedback_rating {
                HStack(spacing: 2) {
                    ForEach(1...5, id: \.self) { i in
                        Image(systemName: i <= rating ? "star.fill" : "star")
                            .font(.caption2).foregroundStyle(.orange)
                    }
                    if let c = tour.feedback_comment, !c.isEmpty {
                        Text(c).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }

            // Actions
            HStack(spacing: 8) {
                if tour.isPending || tour.isConfirmed {
                    Button {
                        reschedulingTour = tour
                    } label: {
                        Label("Reprogramar", systemImage: "calendar.badge.clock")
                            .font(.caption).bold()
                            .foregroundStyle(.purple)
                    }
                    Button {
                        Task { await cancel(tour.id) }
                    } label: {
                        Text("Cancelar")
                            .font(.caption).bold()
                            .foregroundStyle(Color.rdRed)
                    }
                }
                if tour.isCompleted && tour.feedback_rating == nil {
                    Button {
                        feedbackTourId = tour.id
                    } label: {
                        Label("Calificar", systemImage: "star.fill")
                            .font(.caption).bold()
                            .foregroundStyle(.orange)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func feedbackSheet(tourId: String) -> some View {
        NavigationStack {
            VStack(spacing: 20) {
                Text("¿Cómo fue tu visita?")
                    .font(.title3).bold()

                HStack(spacing: 8) {
                    ForEach(1...5, id: \.self) { i in
                        Image(systemName: i <= feedbackRating ? "star.fill" : "star")
                            .font(.title2)
                            .foregroundStyle(.orange)
                            .onTapGesture { feedbackRating = i }
                    }
                }

                TextField("Comentario (opcional)", text: $feedbackComment, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(3...5)

                Button {
                    Task {
                        try? await api.submitTourFeedback(tourId: tourId, rating: feedbackRating, comment: feedbackComment)
                        feedbackTourId = nil
                        feedbackRating = 5
                        feedbackComment = ""
                        await load()
                    }
                } label: {
                    Text("Enviar Calificación")
                        .font(.subheadline).bold()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Color.rdBlue, in: RoundedRectangle(cornerRadius: 10))
                        .foregroundStyle(.white)
                }

                Spacer()
            }
            .padding()
            .navigationTitle("Calificar Visita")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cerrar") { feedbackTourId = nil }
                }
            }
        }
        .presentationDetents([.medium])
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "pending":    return .orange
        case "confirmed":  return .rdGreen
        case "rejected":   return .rdRed
        case "cancelled":  return .gray
        case "completed":  return .rdBlue
        default:           return .gray
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
