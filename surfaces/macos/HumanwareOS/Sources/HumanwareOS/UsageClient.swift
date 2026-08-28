import Foundation

/// One rate-limit window as the app renders it: a label ("5-hour", "Weekly",
/// "Fable only"), the used-percent, and when it resets (ISO, formatted locally).
struct UsageWindow: Identifiable {
    let id = UUID()
    let label: String
    let usedPercent: Double
    let resetsAt: Date?
}

/// The usage module's data: Claude and Codex windows from the latest sample, or
/// an honest failure so the view can say "no usage data" instead of faking zeros.
struct UsageSnapshot {
    var claude: [UsageWindow] = []
    var codex: [UsageWindow] = []
    var sampledAt: Date?
    var ok: Bool = false
    var error: String?
}

/// Reads the usage feed from the ingest service's `GET /usage` over Tailscale —
/// the same window-utilization samples that drive the stats page pace gauges.
/// The app never fabricates: a missing feed surfaces as `ok == false`.
final class UsageClient {
    static let shared = UsageClient()

    private let defaultEndpoint = "http://100.74.220.98:8899/usage"

    private var endpoint: URL {
        if let stored = UserDefaults.standard.string(forKey: "usageEndpoint"),
           let url = URL(string: stored) {
            return url
        }
        // Derive from the capture endpoint override if only that is set, so a
        // single override repoints both.
        if let capture = UserDefaults.standard.string(forKey: "ingestEndpoint"),
           let base = URL(string: capture),
           let usage = URL(string: "/usage", relativeTo: base) {
            return usage.absoluteURL
        }
        return URL(string: defaultEndpoint)!
    }

    func fetch(completion: @escaping (UsageSnapshot) -> Void) {
        var request = URLRequest(url: endpoint, timeoutInterval: 8)
        request.httpMethod = "GET"
        if let token = UserDefaults.standard.string(forKey: "ingestToken"), !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error {
                completion(UsageSnapshot(ok: false, error: error.localizedDescription))
                return
            }
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  let data,
                  let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                completion(UsageSnapshot(ok: false, error: "usage feed unavailable"))
                return
            }
            guard (root["ok"] as? Bool) == true,
                  let providers = root["providers"] as? [String: Any] else {
                completion(UsageSnapshot(ok: false, error: root["error"] as? String ?? "no usage data"))
                return
            }
            let iso = ISO8601DateFormatter()
            let fractionalISO = ISO8601DateFormatter()
            fractionalISO.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            func parseDate(_ raw: String) -> Date? {
                fractionalISO.date(from: raw) ?? iso.date(from: raw)
            }
            func windows(_ key: String) -> [UsageWindow] {
                guard let provider = providers[key] as? [String: Any],
                      let list = provider["windows"] as? [[String: Any]] else { return [] }
                return list.compactMap { win in
                    guard let label = win["label"] as? String else { return nil }
                    let used = (win["usedPercent"] as? NSNumber)?.doubleValue ?? 0
                    var reset: Date?
                    if let raw = win["resetsAt"] as? String { reset = parseDate(raw) }
                    return UsageWindow(label: label, usedPercent: used, resetsAt: reset)
                }
            }
            var snapshot = UsageSnapshot(ok: true)
            if let raw = root["sampledAt"] as? String {
                snapshot.sampledAt = parseDate(raw)
            }
            snapshot.claude = windows("claude")
            snapshot.codex = windows("codex")
            if snapshot.claude.isEmpty && snapshot.codex.isEmpty {
                snapshot.ok = false
                snapshot.error = "no usage windows"
            }
            completion(snapshot)
        }.resume()
    }
}
