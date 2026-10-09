// Interface languages (vedu #1645, #1776): the app's words in English, 简体中文, 繁體中文, Español, Français, 日本語,
// 한국어 or हिन्दी (the String Catalog, AgentSoup/Resources/Localizable.xcstrings). The choice is display.lang in
// /api/app/prefs, shared with the web: auto follows this iPhone's languages. Only the interface is translated: what
// people and agents write never is.
//
// A change applies at once, without a relaunch: the root sets the SwiftUI locale (Text, titles and labels look their
// words up in it; dates and numbers follow it), words built in code read the chosen .lproj (String(localized: …,
// bundle: .l10n)), and the screens are rebuilt so every word is read again (the root's id). The choice is also written as
// this app's AppleLanguages, so from the next launch iOS itself (Locale.current, the system's own words) agrees.

import Foundation
import ObjectiveC
import SwiftUI

enum AppLanguage: String, CaseIterable, Identifiable {
    case auto, en, zhHans = "zh-Hans", zhHant = "zh-Hant", es, fr, ja, ko, hi

    var id: String { rawValue }
    static let values = allCases.map(\.rawValue)

    /// Each language in its own words (never translated), for the picker. Automatic is the one translated label.
    var nativeName: String {
        switch self {
        case .auto: return String(localized: "Automatic (device)", bundle: .l10n)
        case .en: return "English"
        case .zhHans: return "简体中文"
        case .zhHant: return "繁體中文"
        case .es: return "Español"
        case .fr: return "Français"
        case .ja: return "日本語"
        case .ko: return "한국어"
        case .hi: return "हिन्दी"
        }
    }
}

enum L10n {
    /// The .lproj strings are read from right now (nil: the bundle's own choice).
    nonisolated(unsafe) private(set) static var bundle: Bundle?
    /// The language in use (an .lproj name: "en", "zh-Hans", …).
    nonisolated(unsafe) private(set) static var current = "en"
    /// The language for atteo.dev pages opened from the app (?lang=): `current`, or on automatic the phone's own when the
    /// web has it and the app doesn't (de, pt, ru, tr…).
    nonisolated(unsafe) private(set) static var web = "en"
    private static let overrideKey = "AppleLanguages"
    /// What we last wrote as this app's AppleLanguages (so "auto" knows it may remove it).
    private static let wroteKey = "atteo-lang-override"

    /// The SwiftUI locale for the root: the language, in this iPhone's region.
    static var locale: Locale {
        var c = Locale.Components(locale: Locale.autoupdatingCurrent)
        c.languageComponents = Locale.Language.Components(identifier: current)
        return Locale(components: c)
    }

    /// This iPhone's languages, in order: a launch argument's (UI tests pass -AppleLanguages (en)) or the system's,
    /// never the override written below.
    private static var deviceLanguages: [String] {
        let defaults = UserDefaults.standard
        if let a = defaults.volatileDomain(forName: UserDefaults.argumentDomain)[overrideKey] as? [String], !a.isEmpty { return a }
        if let g = defaults.persistentDomain(forName: UserDefaults.globalDomain)?[overrideKey] as? [String], !g.isEmpty { return g }
        return Locale.preferredLanguages
    }

    /// Use `pref` (a display.lang value) from now on.
    static func apply(_ pref: String) {
        installBundleOverride()
        // Only the languages the picker offers (Info.plist CFBundleLocalizations): the string catalog also carries a few
        // dozen strings in the web's other languages (de, pt, ru, tr…), and a phone in one of those would otherwise get
        // a half-translated app instead of English.
        let have = Bundle.main.localizations.filter { $0 != "Base" && AppLanguage.values.contains($0) }
        var device = deviceLanguages
        #if DEBUG
        // UI tests: ATTEO_LANG=en pins "automatic" to English whatever the simulator's languages (an -AppleLanguages
        // launch argument would do it too, but it also changes how iOS lays out text, which moves chat scroll tests).
        if let l = API.environment("LANG"), !l.isEmpty { device = [l] }
        #endif
        let wanted = pref == "auto" || !AppLanguage.values.contains(pref) ? device : [pref]
        let lang = Bundle.preferredLocalizations(from: have, forPreferences: wanted).first ?? "en"
        current = lang
        // The web's pages (the guide) come in more languages than the app: on automatic they follow the phone, as before.
        web = pref == "auto" || !AppLanguage.values.contains(pref)
            ? Bundle.preferredLocalizations(from: Bundle.main.localizations.filter { $0 != "Base" }, forPreferences: wanted).first ?? lang
            : lang
        bundle = Bundle.main.path(forResource: lang, ofType: "lproj").flatMap(Bundle.init(path:))
        // From the next launch iOS uses it too (dates in code, the system's words). Never over a launch argument.
        let defaults = UserDefaults.standard
        if pref == "auto" || !AppLanguage.values.contains(pref) {
            if defaults.bool(forKey: wroteKey) { defaults.removeObject(forKey: overrideKey); defaults.set(false, forKey: wroteKey) }
        } else {
            defaults.set([pref], forKey: overrideKey)
            defaults.set(true, forKey: wroteKey)
        }
    }

    private static var installed = false
    private static func installBundleOverride() {
        guard !installed else { return }
        installed = true
        object_setClass(Bundle.main, LanguageBundle.self)
    }
}

extension Bundle {
    /// The chosen language's strings, for words built in code: `String(localized: "…", bundle: .l10n)`. (Plain
    /// String(localized:) reads the language iOS picked at launch, so it would only follow a change after a relaunch.)
    static var l10n: Bundle { L10n.bundle ?? .main }
}

/// Bundle.main, looking its strings up in the chosen language (NSLocalizedString and UIKit's own lookups).
private final class LanguageBundle: Bundle, @unchecked Sendable {
    override func localizedString(forKey key: String, value: String?, table tableName: String?) -> String {
        if let b = L10n.bundle { return b.localizedString(forKey: key, value: value, table: tableName) }
        return super.localizedString(forKey: key, value: value, table: tableName)
    }
}

/// Settings → Appearance (Everyday) and → Display (Developer): the app's language. Saved to display.lang, so the web
/// follows it too; the app changes at once (Settings closes onto the screens in the new words).
struct LanguagePicker: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        Picker(selection: Binding(get: { state.display.lang }, set: { v in
            var d = state.display
            d.lang = v
            state.setDisplay(d)
        })) {
            ForEach(AppLanguage.allCases) { l in Text(verbatim: l.nativeName).tag(l.rawValue) }
        } label: {
            Text("Language")
        }
        .pickerStyle(.navigationLink)
        .accessibilityIdentifier("display-lang")
    }
}
