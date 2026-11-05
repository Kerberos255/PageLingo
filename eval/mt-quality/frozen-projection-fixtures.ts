// Manual structure oracles and negative controls; never model generations.
export const frozenProjectionFixtures = [
  {id: "direct-table-cell", html: '<table data-layout="kept"><tbody><tr><td data-root>Read <a href="/guide">the guide</a> now.</td><td>Other cell unchanged</td></tr></tbody></table>',
    root_selector: "[data-root]", target: "现在阅读指南。", spans: [{id: "s0", start: 4, end: 6}], displayed: true},
  {id: "table-cell", html: '<table data-layout="kept"><tbody><tr><td><p data-root>Read <a href="/guide" class="ref">the guide</a> now.</p></td><td>Other cell unchanged</td></tr></tbody></table>',
    root_selector: "[data-root]", target: "现在阅读指南。", spans: [{id: "s0", start: 4, end: 6}], displayed: true},
  {id: "list-item", html: '<ol start="3"><li data-root>Wait <em>until</em> ready.</li><li>Other item unchanged</li></ol>',
    root_selector: "[data-root]", target: "等待直到就绪。", spans: [{id: "s0", start: 2, end: 4}], displayed: true},
  {id: "heading", html: '<h2 data-root>Read the <a href="/guide">guide</a> first.</h2><p>Following paragraph unchanged</p>',
    root_selector: "[data-root]", target: "先阅读指南。", spans: [{id: "s0", start: 3, end: 5}], displayed: true},
  {id: "nested-format-link", html: '<p>Read <a href="/guide" style="color: red"><strong>the guide</strong></a> now.</p>',
    target: "现在阅读指南。", spans: [{id: "s0", start: 4, end: 6}, {id: "s1", start: 4, end: 6}], displayed: true},
  {id: "link-reorder-refused", html: '<p>Choose <a href="/one">one</a> then <a href="/two">two</a>.</p>',
    target: "选择二，再选一。", spans: [{id: "s0", start: 6, end: 7}, {id: "s1", start: 2, end: 3}], displayed: false},
  {id: "missing-carrier-refused", html: '<p><code>x()</code> now.</p>', target: "现在调用x()。",
    spans: [{id: "s0", start: 4, end: 7}], displayed: false},
  {id: "literal-html-is-text", html: '<p>Source text.</p>', target: '中文 <img src=x onerror="alert(1)"> 字符', spans: [], displayed: true},
];
