// PageLingo built-in glossary.
// Maintained with the extension source; not exposed in the settings UI.
// User custom terminology always overrides entries here.
globalThis.__PAGELINGO_BUILTIN_GLOSSARY__ = Object.freeze({
  // Only terms known to be unstable in the local model are segmented before translation.
  // Keep this list intentionally tiny: every extra inline boundary can hurt sentence quality.
  hardProtect: Object.freeze([
    "auth"
  ]),

  // Preferred tokens/brands. These are corrected after whole-sentence translation instead of
  // being injected as inline spans into the source sentence.
  preserve: Object.freeze([
    "OpenClaw", "Tailscale", "OAuth", "OpenAI", "GitHub", "Git",
    "Slack", "Discord", "Telegram", "WhatsApp", "Signal", "Matrix",
    "Feishu", "Google Chat", "Microsoft Teams", "iMessage", "Mattermost",
    "Nextcloud Talk", "IRC", "LINE", "Nostr", "QQ bot", "ClickClack", "Buzz",
    "API", "SDK", "CLI", "UI", "GUI", "WASM", "WebAssembly",
    "HTTP", "HTTPS", "WebSocket", "JSON", "YAML", "TOML",
    "Docker", "Kubernetes", "npm", "pnpm", "bun", "Nix",
    "macOS", "Linux", "Windows", "PowerShell", "WSL", "WSL2",
    "localhost"
  ]),

  pairs: Object.freeze({
    "en->zh-Hans": Object.freeze([
      ["Gateway", "网关"],
      ["Control UI", "控制界面"],
      ["Dashboard", "仪表板"],
      ["webhook", "webhook"],
      ["runtime", "运行时"]
    ]),
    "en->zh-Hant": Object.freeze([
      ["Gateway", "閘道"],
      ["Control UI", "控制介面"],
      ["Dashboard", "儀表板"],
      ["webhook", "webhook"],
      ["runtime", "執行階段"]
    ])
  })
});
