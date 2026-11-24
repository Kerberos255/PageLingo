import { afterEach, describe, expect, it } from "vitest";
import { sourceTextSample } from "../src/shared/source-text-sample";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("source text sampling", () => {
  it("ignores generated translations while retaining hidden source DOM text", () => {
    document.body.innerHTML = `
      <main>
        <p class="flt-source-hidden">Original English source text</p>
        <span data-flt-generated="translation">生成的中文译文</span>
      </main>
    `;

    expect(sourceTextSample(document)).toContain("Original English source text");
    expect(sourceTextSample(document)).not.toContain("生成的中文译文");
  });

  it("ignores script/style/template text", () => {
    document.body.innerHTML = `
      <main>
        <p>Visible source</p>
        <script>script words</script>
        <style>.x { content: "style words"; }</style>
        <template>template words</template>
      </main>
    `;

    const sample = sourceTextSample(document);
    expect(sample).toContain("Visible source");
    expect(sample).not.toContain("script words");
    expect(sample).not.toContain("style words");
    expect(sample).not.toContain("template words");
  });

  it("ignores user-authored text inside textarea, select options, and contenteditable editors", () => {
    document.body.innerHTML = `
      <div class="main">
        <p>Short description or tagline</p>
        <textarea>这是一段用户在表单里填写的中文项目简介</textarea>
        <select><option>游戏分类选项</option></select>
        <div contenteditable="true"><p>富文本编辑器里的中文内容</p></div>
      </div>
    `;

    const sample = sourceTextSample(document);
    expect(sample).toContain("Short description or tagline");
    expect(sample).not.toContain("中文项目简介");
    expect(sample).not.toContain("游戏分类选项");
    expect(sample).not.toContain("富文本编辑器");
  });
});
