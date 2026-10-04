import { describe, expect, it } from "vitest";
import { assessTranslationQuality } from "../src/core/translation-quality";

describe("translation quality guard", () => {
  it("accepts natural Simplified Chinese with protected technical names", () => {
    const result = assessTranslationQuality({
      sourceText: "OpenClaw works with Node.js and the Gateway service.",
      translatedText: "OpenClaw 可与 Node.js 和 Gateway 服务配合使用。",
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
    });
    expect(result.accepted).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("rejects unexpected Japanese kana in an English to Chinese translation", () => {
    const result = assessTranslationQuality({
      sourceText: "Read the security guide before exposing the Gateway remotely.",
      translatedText: "请阅读安全指南かくのように，然后再远程公开 Gateway。",
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
    });
    expect(result.accepted).toBe(false);
    expect(result.reasons).toContain("unexpected_kana");
  });

  it("rejects template-like underscore garbage", () => {
    const result = assessTranslationQuality({
      sourceText: "Windows users can install the desktop application.",
      translatedText: "Windows 用户可以安装桌面应用。（______）取消",
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
    });
    expect(result.accepted).toBe(false);
    expect(result.reasons).toContain("placeholder_garbage");
  });

  it("rejects a long output that never meaningfully enters the Chinese target language", () => {
    const result = assessTranslationQuality({
      sourceText: "Configure the gateway and verify the service before connecting another user.",
      translatedText: "Configure the gateway and verify the service before connecting another user.",
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
    });
    expect(result.accepted).toBe(false);
    expect(result.reasons).toContain("target_language_mismatch");
  });

  it("rejects extreme expansion and repeated output", () => {
    const result = assessTranslationQuality({
      sourceText: "Install the package.",
      translatedText: "thereof thereof thereof thereof thereof thereof thereof thereof thereof thereof thereof thereof",
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
    });
    expect(result.accepted).toBe(false);
    expect(result.reasons).toContain("repeated_output");
  });

  it("ignores PageLingo transport placeholders when judging text quality", () => {
    const result = assessTranslationQuality({
      sourceText: "Run __FLT_OPAQUE_0__ and read __FLT_LINK_START_0__the guide__FLT_LINK_END_0__.",
      translatedText: "运行 __FLT_OPAQUE_0__，然后阅读 __FLT_LINK_START_0__指南__FLT_LINK_END_0__。",
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
    });
    expect(result.accepted).toBe(true);
  });

  it("rejects the historical OpenClaw leaf-safe template-garbage output", () => {
    const result = assessTranslationQuality({
      sourceText: "Check your Node version with node --version. Windows users: the native Windows Hub app is the easiest desktop path. The PowerShell installer and WSL2 Gateway paths are also supported. See Windows. Need to install Node? See Node setup.",
      translatedText: "通过检查你的节点版本来确认 node --version. Windows users: 原生 Windows 中心应用是最简单的桌面路径。 PowerShell 安装程序和 WSL2 网关路径也受支持。参见： 窗口 （______）。 需要安装 Node 吗？查看 节点设置.",
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
    });
    expect(result.accepted).toBe(false);
    expect(result.reasons).toContain("placeholder_garbage");
  });

  it("rejects the historical GitHub leaf-safe mixed-Japanese output", () => {
    const result = assessTranslationQuality({
      sourceText: "Tools run on the host for the main session unless you configure sandboxing. Read the security guide, exposure runbook, and sandboxing guide before connecting other users or exposing the Gateway remotely.",
      translatedText: "主会话上的工具将在主机上运行，除非您配置了沙箱环境。阅读 安全指南, 暴露运行手册かくのように、このファイルは、その後に続く文字を含むすべてのファイルを読み取りするために使用される 沙箱化指南 连接其他用户或远程暴露网关之前。",
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
    });
    expect(result.accepted).toBe(false);
    expect(result.reasons).toContain("unexpected_kana");
  });

  it("accepts the historical OpenClaw whole-root translation when no garbage is present", () => {
    const result = assessTranslationQuality({
      sourceText: "Check your Node version with node --version. Windows users: the native Windows Hub app is the easiest desktop path. The PowerShell installer and WSL2 Gateway paths are also supported. See Windows. Need to install Node? See Node setup.",
      translatedText: "通过 node --version 检查您的节点版本。 Windows 用户： 本机 Windows 中心应用是最简单的桌面路径。 PowerShell 安装程序和 WSL2 Gateway 路径也受支持。 请参阅 Windows。 需要安装 Node？请参阅 Node 设置。",
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
    });
    expect(result.accepted).toBe(true);
    expect(result.reasons).toEqual([]);
  });

});
