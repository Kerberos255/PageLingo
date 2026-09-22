// PageLingo built-in glossary.
// Maintained with the extension source; not exposed in the settings UI.
// User custom terminology always overrides entries here.
globalThis.__PAGELINGO_BUILTIN_GLOSSARY__ = Object.freeze({
  // Hard-preserve terms are protected before translation while the surrounding sentence
  // is still translated as one HTML segment. Use this for brands, product names, protocols,
  // code/tool identifiers, and user-visible tokens that must never be rewritten.
  hardPreserve: Object.freeze([
    "auth",
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

  // Legacy post-correction preserve list. Keep the field for compatibility with older
  // catalog shapes, but new immutable names should normally live in hardPreserve.
  preserve: Object.freeze([]),

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
