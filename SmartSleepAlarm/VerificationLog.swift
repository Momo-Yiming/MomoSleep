import Foundation
import SwiftUI

struct VerificationEntry: Codable, Identifiable {
    let id: UUID
    let capturedAt: Date
    let trigger: String
    let sleepStillOngoing: Bool?
    let sampleCount: Int
    let ringConnSampleCount: Int
    let newestSampleEnd: Date?
    let sources: [String]
    let note: String
}

@MainActor
final class VerificationLogStore: ObservableObject {
    @Published private(set) var entries: [VerificationEntry] = []
    @Published private(set) var errorMessage: String?

    private let fileURL: URL

    init(fileManager: FileManager = .default) {
        let directory = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first!
        fileURL = directory.appendingPathComponent("phase-0-verification.json")
        load()
    }

    func append(samples: [SleepSample], trigger: String, sleepStillOngoing: Bool?, note: String = "") {
        let entry = VerificationEntry(
            id: UUID(),
            capturedAt: .now,
            trigger: trigger,
            sleepStillOngoing: sleepStillOngoing,
            sampleCount: samples.count,
            ringConnSampleCount: samples.filter { $0.source.localizedCaseInsensitiveContains("ringconn") }.count,
            newestSampleEnd: samples.map(\.end).max(),
            sources: Array(Set(samples.map(\.source))).sorted(),
            note: note.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        entries.insert(entry, at: 0)
        save()
    }

    func delete(at offsets: IndexSet) {
        entries.remove(atOffsets: offsets)
        save()
    }

    var csv: String {
        let header = "captured_at,trigger,sleep_still_ongoing,sample_count,ringconn_sample_count,newest_sample_end,sources,note"
        return ([header] + entries.map { entry in
            [
                entry.capturedAt.ISO8601Format(), entry.trigger,
                entry.sleepStillOngoing.map(String.init) ?? "unknown",
                String(entry.sampleCount), String(entry.ringConnSampleCount),
                entry.newestSampleEnd?.ISO8601Format() ?? "",
                entry.sources.joined(separator: " | "), entry.note
            ].map(csvField).joined(separator: ",")
        }).joined(separator: "\n")
    }

    var report: String {
        let candidates = entries.filter { $0.sleepStillOngoing == true && $0.ringConnSampleCount > 0 }
        let observerCallbacks = entries.filter { $0.trigger == "healthkit-observer" }
        let newest = entries.compactMap(\.newestSampleEnd).max()?.ISO8601Format() ?? "无"
        let conclusion = candidates.isEmpty
            ? "尚未记录到睡眠进行中的 RingConn 来源样本；实时唤醒链路未通过。"
            : "发现 \(candidates.count) 条候选记录；仍需人工核对版本、样本阶段和睡眠确实尚未结束。"
        return """
        # 智能睡眠闹钟 Phase 0 验收摘要

        生成时间：\(Date.now.ISO8601Format())
        总记录数：\(entries.count)
        HealthKit observer 回调记录：\(observerCallbacks.count)
        睡眠进行中且含 RingConn 样本的候选记录：\(candidates.count)
        最新样本结束时间：\(newest)

        结论：\(conclusion)

        边界：模拟数据不会被计为 RingConn；本摘要不能替代 iPhone 真机、RingConn App/固件版本和 Apple Health 样本明细的人工核对。
        """
    }

    private func load() {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return }
        do { entries = try JSONDecoder().decode([VerificationEntry].self, from: Data(contentsOf: fileURL)) }
        catch { errorMessage = "读取验证记录失败：\(error.localizedDescription)" }
    }

    private func save() {
        do {
            let data = try JSONEncoder().encode(entries)
            try data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            errorMessage = nil
        } catch { errorMessage = "保存验证记录失败：\(error.localizedDescription)" }
    }

    private func csvField(_ value: String) -> String {
        "\"\(value.replacingOccurrences(of: "\"", with: "\"\""))\""
    }
}

struct VerificationLogView: View {
    @EnvironmentObject private var model: SleepViewModel
    @ObservedObject var store: VerificationLogStore
    @State private var sleepStillOngoing = true
    @State private var note = ""

    var body: some View {
        List {
            Section("记录当前观察") {
                Toggle("睡眠尚未结束", isOn: $sleepStillOngoing)
                TextField("RingConn App 状态、版本或备注", text: $note, axis: .vertical)
                Button {
                    model.recordVerificationSnapshot(sleepStillOngoing: sleepStillOngoing, note: note)
                    note = ""
                } label: {
#if VALIDATION_APP
                    Text("保存当前模拟数据快照")
#else
                    Text("保存当前 HealthKit 快照")
#endif
                }
                .keyboardShortcut(.defaultAction)
            }
            Section("本地记录") {
                if let error = store.errorMessage { Text(error).foregroundStyle(.red) }
                ShareLink(item: store.csv) { Label("分享 CSV 文本", systemImage: "square.and.arrow.up") }
                ShareLink(item: store.report) { Label("分享验收摘要", systemImage: "doc.text") }
                LabeledContent("RingConn 候选证据", value: "\(store.entries.filter { $0.sleepStillOngoing == true && $0.ringConnSampleCount > 0 }.count) 条")
                if store.entries.isEmpty { Text("尚无记录。先保存一次当前快照。") }
                ForEach(store.entries) { entry in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(entry.capturedAt.formatted(date: .abbreviated, time: .standard)).fontWeight(.semibold)
                        Text("触发：\(entry.trigger) · RingConn 样本：\(entry.ringConnSampleCount)/\(entry.sampleCount)")
                        Text("睡眠进行中：\(entry.sleepStillOngoing.map { $0 ? "是" : "否" } ?? "未知")")
                        if let end = entry.newestSampleEnd { Text("最新样本结束：\(end.formatted(date: .abbreviated, time: .standard))") }
                        if !entry.note.isEmpty { Text(entry.note) }
                    }
                    .font(.caption)
                }
                .onDelete(perform: store.delete)
                if !store.entries.isEmpty { Text("向左轻扫或使用删除操作可移除记录。") }
            }
            Section("判定边界") {
                Text("自动 observer 记录中的“睡眠进行中”为未知。只有手动确认睡眠尚未结束，且记录中已有 RingConn 来源阶段样本，才构成增量写入证据。")
            }
        }
        .navigationTitle("Phase 0 真机记录")
    }
}
