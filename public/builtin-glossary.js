// PageLingo built-in glossary.
// Maintained with the extension source; not exposed in the settings UI.
// User custom terminology always overrides entries here.
globalThis.__PAGELINGO_BUILTIN_GLOSSARY__ = Object.freeze({
  // Hard-preserve terms are protected before translation while the surrounding sentence
  // is still translated as one HTML segment. Use this for brands, product names, protocols,
  // code/tool identifiers, and user-visible tokens that must never be rewritten.
  hardPreserve: Object.freeze([
    // AI, developer platforms, and developer tools.
    "OpenClaw", "OpenCode", "Tailscale", "OAuth", "OpenAI", "Anthropic",
    "ChatGPT", "GPT", "Claude", "Gemini", "DeepSeek", "Codex", "Grok",
    "Llama", "Qwen", "Mistral", "Hugging Face", "Midjourney", "Stability AI",
    "GitHub", "GitHub Actions", "GitHub Copilot", "GitLab", "Bitbucket", "Git",
    "Docker", "Kubernetes", "npm", "pnpm", "bun", "Nix",
    "Node.js", "TypeScript", "JavaScript", "Python", "React", "Vue", "Svelte",
    "Next.js", "Vite", "Playwright", "Selenium", "Bergamot", "Marian",
    "JetBrains", "HashiCorp", "Terraform", "DigitalOcean", "Heroku", "Akamai",

    // Messaging, collaboration, and social communication products.
    "Slack", "Discord", "Telegram", "WhatsApp", "Signal", "Matrix",
    "Feishu", "DingTalk", "WeChat", "Google Chat", "Microsoft Teams",
    "iMessage", "Mattermost", "Nextcloud Talk", "IRC", "LINE", "Nostr",
    "QQ bot", "ClickClack", "Buzz",

    // Cloud, enterprise software, data platforms, and observability.
    "AWS", "Azure", "Google Cloud", "GCP", "Cloudflare", "Vercel", "Render",
    "Salesforce", "ServiceNow", "SAP", "VMware", "Red Hat", "Atlassian",
    "Jira", "Confluence", "Snowflake", "Databricks", "MongoDB", "Elastic",
    "Grafana", "Splunk",

    // Browsers, operating systems, and productivity/design products.
    "Firefox", "Chrome", "Chromium", "Safari", "Microsoft Edge",
    "Visual Studio Code", "VS Code", "Microsoft 365", "Google Workspace",
    "Adobe", "Photoshop", "Illustrator", "Lightroom", "Figma", "Canva",
    "Notion", "Dropbox", "OneDrive", "SharePoint", "Trello", "Miro",
    "Airtable", "Evernote",
    "macOS", "Linux", "Windows", "PowerShell", "WSL", "WSL2",

    // Semiconductors, hardware, electronics, and networking vendors/products.
    "NVIDIA", "AMD", "Qualcomm", "Broadcom", "MediaTek", "TSMC", "ASML",
    "Samsung Electronics", "SK hynix", "Supermicro", "Raspberry Pi", "Arduino",
    "Logitech", "Synology", "QNAP", "Lenovo", "ASUS", "Acer", "MSI",
    "Xiaomi", "Huawei", "ZTE", "OnePlus", "Cisco", "Ericsson", "Nokia",

    // Finance, payments, and financial-information platforms.
    "PayPal", "Stripe", "Mastercard", "American Express", "JPMorgan Chase",
    "Goldman Sachs", "Morgan Stanley", "BlackRock", "Bloomberg", "Coinbase",
    "Binance", "Alipay", "WeChat Pay", "UnionPay", "Ant Group", "Revolut",

    // E-commerce, retail, and marketplaces.
    "Alibaba", "AliExpress", "eBay", "Shopify", "Temu", "Taobao", "Tmall",
    "JD.com", "Shopee", "Mercado Libre", "Lazada", "Walmart", "Costco",
    "IKEA", "Uniqlo",

    // Automotive and mobility brands.
    "Tesla", "Toyota", "Honda", "Hyundai", "Kia", "Mercedes-Benz",
    "Volkswagen", "BMW", "Porsche", "Ferrari", "Lamborghini", "Audi",
    "Lexus", "Mazda", "Subaru", "Volvo", "BYD", "Geely", "NIO", "XPeng",
    "Li Auto", "Rivian", "Lucid Motors",

    // Media, streaming, creator, and community platforms.
    "Netflix", "Spotify", "YouTube", "TikTok", "Instagram", "LinkedIn",
    "Reddit", "Twitch", "Pinterest", "Snapchat", "Bilibili", "Weibo",
    "Douyin", "Vimeo", "SoundCloud",

    // Gaming and interactive entertainment.
    "PlayStation", "Xbox", "Nintendo", "Epic Games", "Unreal Engine",
    "Roblox", "Minecraft", "Fortnite", "Riot Games", "League of Legends",
    "Valorant", "Genshin Impact", "HoYoverse",

    // Travel, hospitality, and transportation.
    "Airbnb", "Booking.com", "Trip.com", "Uber", "Lyft", "Expedia",
    "Agoda", "Skyscanner", "Marriott", "Hilton", "Hyatt", "Emirates",
    "Qatar Airways", "Singapore Airlines",

    // Healthcare, pharmaceuticals, and medical technology.
    "Pfizer", "Moderna", "AstraZeneca", "Roche", "Novartis", "Eli Lilly",
    "Sanofi", "GSK", "BioNTech", "Merck", "Medtronic",
    "Siemens Healthineers", "Johnson & Johnson",

    // Industrial, energy, aerospace, and engineering brands/products.
    "Siemens", "Bosch", "Honeywell", "Schneider Electric", "ABB",
    "ExxonMobil", "Saudi Aramco", "TotalEnergies", "CATL",
    "Boeing", "Airbus", "SpaceX", "Blue Origin", "Lockheed Martin",
    "Northrop Grumman", "Autodesk", "AutoCAD", "MATLAB", "SolidWorks", "Ansys",

    // Consumer, food, sportswear, and luxury brands.
    "Coca-Cola", "PepsiCo", "Starbucks", "McDonald's", "KFC", "Nike",
    "Adidas", "LEGO", "Dyson", "GoPro", "Louis Vuitton", "Gucci",
    "Prada", "Chanel", "Hermès", "Rolex",

    // Education, research, publishing, and news organizations/platforms.
    "Coursera", "edX", "Khan Academy", "arXiv", "PubMed", "Elsevier",
    "Springer Nature", "Reuters", "Associated Press", "Financial Times",
    "The New York Times", "BBC", "CNN",

    // Standards, formats, protocols, and identifiers that should stay literal.
    "API", "SDK", "CLI", "UI", "GUI", "WASM", "WebAssembly",
    "HTTP", "HTTPS", "WebSocket", "JSON", "YAML", "TOML", "localhost"
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
