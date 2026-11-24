/**
 * Lightweight, zero-dependency LaTeX & Office Math (OMML) -> Native Browser MathML renderer.
 * Produces pure DOM nodes in the MathML namespace (`http://www.w3.org/1998/Math/MathML`)
 * with zero innerHTML, zero remote assets, and `translate="no"` protection.
 */

export const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

function mEl(doc: Document, tag: string, text?: string): Element {
  const el = doc.createElementNS(MATHML_NS, tag);
  if (text !== undefined) el.textContent = text;
  return el;
}

const LATEX_SYMBOLS: Record<string, { kind: "mi" | "mo"; text: string; largeOp?: boolean }> = {
  // Lowercase Greek
  alpha: { kind: "mi", text: "α" },
  beta: { kind: "mi", text: "β" },
  gamma: { kind: "mi", text: "γ" },
  delta: { kind: "mi", text: "δ" },
  epsilon: { kind: "mi", text: "ϵ" },
  varepsilon: { kind: "mi", text: "ε" },
  zeta: { kind: "mi", text: "ζ" },
  eta: { kind: "mi", text: "η" },
  theta: { kind: "mi", text: "θ" },
  vartheta: { kind: "mi", text: "ϑ" },
  iota: { kind: "mi", text: "ι" },
  kappa: { kind: "mi", text: "κ" },
  lambda: { kind: "mi", text: "λ" },
  mu: { kind: "mi", text: "μ" },
  nu: { kind: "mi", text: "ν" },
  xi: { kind: "mi", text: "ξ" },
  pi: { kind: "mi", text: "π" },
  varpi: { kind: "mi", text: "ϖ" },
  rho: { kind: "mi", text: "ρ" },
  varrho: { kind: "mi", text: "ϱ" },
  sigma: { kind: "mi", text: "σ" },
  varsigma: { kind: "mi", text: "ς" },
  tau: { kind: "mi", text: "τ" },
  upsilon: { kind: "mi", text: "υ" },
  phi: { kind: "mi", text: "ϕ" },
  varphi: { kind: "mi", text: "φ" },
  chi: { kind: "mi", text: "χ" },
  psi: { kind: "mi", text: "ψ" },
  omega: { kind: "mi", text: "ω" },
  // Uppercase Greek
  Gamma: { kind: "mi", text: "Γ" },
  Delta: { kind: "mi", text: "Δ" },
  Theta: { kind: "mi", text: "Θ" },
  Lambda: { kind: "mi", text: "Λ" },
  Xi: { kind: "mi", text: "Ξ" },
  Pi: { kind: "mi", text: "Π" },
  Sigma: { kind: "mi", text: "Σ" },
  Upsilon: { kind: "mi", text: "Υ" },
  Phi: { kind: "mi", text: "Φ" },
  Psi: { kind: "mi", text: "Ψ" },
  Omega: { kind: "mi", text: "Ω" },
  // Special letters & constants
  infty: { kind: "mi", text: "∞" },
  partial: { kind: "mo", text: "∂" },
  nabla: { kind: "mo", text: "∇" },
  ell: { kind: "mi", text: "ℓ" },
  hbar: { kind: "mi", text: "ℏ" },
  emptyset: { kind: "mi", text: "∅" },
  varnothing: { kind: "mi", text: "∅" },
  aleph: { kind: "mi", text: "ℵ" },
  // Big operators
  sum: { kind: "mo", text: "∑", largeOp: true },
  prod: { kind: "mo", text: "∏", largeOp: true },
  coprod: { kind: "mo", text: "∐", largeOp: true },
  int: { kind: "mo", text: "∫", largeOp: true },
  iint: { kind: "mo", text: "∬", largeOp: true },
  iiint: { kind: "mo", text: "∭", largeOp: true },
  oint: { kind: "mo", text: "∮", largeOp: true },
  bigcup: { kind: "mo", text: "⋃", largeOp: true },
  bigcap: { kind: "mo", text: "⋂", largeOp: true },
  bigoplus: { kind: "mo", text: "⨁", largeOp: true },
  bigotimes: { kind: "mo", text: "⨂", largeOp: true },
  bigvee: { kind: "mo", text: "⋁", largeOp: true },
  bigwedge: { kind: "mo", text: "⋀", largeOp: true },
  // Binary / relational operators
  times: { kind: "mo", text: "×" },
  cdot: { kind: "mo", text: "·" },
  cdots: { kind: "mo", text: "⋯" },
  ldots: { kind: "mo", text: "…" },
  dots: { kind: "mo", text: "…" },
  vdots: { kind: "mo", text: "⋮" },
  ddots: { kind: "mo", text: "⋱" },
  pm: { kind: "mo", text: "±" },
  mp: { kind: "mo", text: "∓" },
  div: { kind: "mo", text: "÷" },
  ast: { kind: "mo", text: "∗" },
  star: { kind: "mo", text: "⋆" },
  circ: { kind: "mo", text: "∘" },
  bullet: { kind: "mo", text: "•" },
  oplus: { kind: "mo", text: "⊕" },
  otimes: { kind: "mo", text: "⊗" },
  odot: { kind: "mo", text: "⊙" },
  le: { kind: "mo", text: "≤" },
  leq: { kind: "mo", text: "≤" },
  leqslant: { kind: "mo", text: "≤" },
  ge: { kind: "mo", text: "≥" },
  geq: { kind: "mo", text: "≥" },
  geqslant: { kind: "mo", text: "≥" },
  ne: { kind: "mo", text: "≠" },
  neq: { kind: "mo", text: "≠" },
  approx: { kind: "mo", text: "≈" },
  equiv: { kind: "mo", text: "≡" },
  sim: { kind: "mo", text: "∼" },
  simeq: { kind: "mo", text: "≃" },
  cong: { kind: "mo", text: "≅" },
  propto: { kind: "mo", text: "∝" },
  ll: { kind: "mo", text: "≪" },
  gg: { kind: "mo", text: "≫" },
  in: { kind: "mo", text: "∈" },
  notin: { kind: "mo", text: "∉" },
  ni: { kind: "mo", text: "∋" },
  subset: { kind: "mo", text: "⊂" },
  subseteq: { kind: "mo", text: "⊆" },
  supset: { kind: "mo", text: "⊃" },
  supseteq: { kind: "mo", text: "⊇" },
  cup: { kind: "mo", text: "∪" },
  cap: { kind: "mo", text: "∩" },
  setminus: { kind: "mo", text: "∖" },
  forall: { kind: "mo", text: "∀" },
  exists: { kind: "mo", text: "∃" },
  neg: { kind: "mo", text: "¬" },
  lnot: { kind: "mo", text: "¬" },
  land: { kind: "mo", text: "∧" },
  wedge: { kind: "mo", text: "∧" },
  lor: { kind: "mo", text: "∨" },
  vee: { kind: "mo", text: "∨" },
  top: { kind: "mo", text: "⊤" },
  bot: { kind: "mo", text: "⊥" },
  perp: { kind: "mo", text: "⊥" },
  parallel: { kind: "mo", text: "∥" },
  mid: { kind: "mo", text: "∣" },
  vert: { kind: "mo", text: "|" },
  Vert: { kind: "mo", text: "‖" },
  "|": { kind: "mo", text: "‖" },
  langle: { kind: "mo", text: "⟨" },
  rangle: { kind: "mo", text: "⟩" },
  lfloor: { kind: "mo", text: "⌊" },
  rfloor: { kind: "mo", text: "⌋" },
  lceil: { kind: "mo", text: "⌈" },
  rceil: { kind: "mo", text: "⌉" },
  "{": { kind: "mo", text: "{" },
  "}": { kind: "mo", text: "}" },
  to: { kind: "mo", text: "→" },
  rightarrow: { kind: "mo", text: "→" },
  leftarrow: { kind: "mo", text: "←" },
  leftrightarrow: { kind: "mo", text: "↔" },
  Rightarrow: { kind: "mo", text: "⇒" },
  Leftarrow: { kind: "mo", text: "⇐" },
  Leftrightarrow: { kind: "mo", text: "⇔" },
  implies: { kind: "mo", text: "⇒" },
  iff: { kind: "mo", text: "⇔" },
  mapsto: { kind: "mo", text: "↦" },
  longrightarrow: { kind: "mo", text: "⟶" },
  angle: { kind: "mo", text: "∠" },
  dagger: { kind: "mo", text: "†" },
  prime: { kind: "mo", text: "′" },
  coloneqq: { kind: "mo", text: "≔" },
};

const NAMED_FUNCTIONS = new Set([
  "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan",
  "sinh", "cosh", "tanh", "exp", "log", "ln", "lg", "det", "dim", "ker",
  "deg", "gcd", "hom", "min", "max", "sup", "inf", "lim", "limsup", "liminf",
  "arg", "argmax", "argmin", "Pr", "softmax", "sigmoid", "ReLU", "tanh", "diag", "tr", "Var", "Cov",
]);

const LIMIT_FUNCTIONS = new Set(["lim", "limsup", "liminf", "min", "max", "sup", "inf", "argmax", "argmin"]);

const ACCENT_MAP: Record<string, { over: boolean; glyph: string }> = {
  hat: { over: true, glyph: "^" },
  widehat: { over: true, glyph: "^" },
  bar: { over: true, glyph: "¯" },
  overline: { over: true, glyph: "¯" },
  tilde: { over: true, glyph: "~" },
  widetilde: { over: true, glyph: "~" },
  vec: { over: true, glyph: "→" },
  dot: { over: true, glyph: "˙" },
  ddot: { over: true, glyph: "¨" },
  underline: { over: false, glyph: "_" },
  underbrace: { over: false, glyph: "⏟" },
  overbrace: { over: true, glyph: "⏞" },
};

const BLACKBOARD_MAP: Record<string, string> = {
  A: "𝔸", B: "𝔹", C: "ℂ", D: "𝔻", E: "𝔼", F: "𝔽", G: "𝔾", H: "ℍ", I: "𝕀",
  J: "𝕁", K: "𝕂", L: "𝕃", M: "𝕄", N: "ℕ", O: "𝕆", P: "ℙ", Q: "ℚ", R: "ℝ",
  S: "𝕊", T: "𝕋", U: "𝕌", V: "𝕍", W: "𝕎", X: "𝕏", Y: "𝕐", Z: "ℤ", "1": "𝟙",
};

const ENV_DELIMITERS: Record<string, [string, string]> = {
  pmatrix: ["(", ")"],
  bmatrix: ["[", "]"],
  Bmatrix: ["{", "}"],
  vmatrix: ["|", "|"],
  Vmatrix: ["‖", "‖"],
  cases: ["{", ""],
  dcases: ["{", ""],
};

class LatexParser {
  readonly #doc: Document;
  readonly #src: string;
  readonly #display: boolean;
  #pos = 0;

  constructor(doc: Document, src: string, display: boolean) {
    this.#doc = doc;
    this.#src = src;
    this.#display = display;
  }

  #skipWs(): void {
    while (this.#pos < this.#src.length && /\s/.test(this.#src[this.#pos]!)) {
      this.#pos += 1;
    }
  }

  #peek(): string {
    return this.#src[this.#pos] ?? "";
  }

  #readCommand(): string {
    // Assumes current char is '\'
    this.#pos += 1;
    if (this.#pos >= this.#src.length) return "";
    const ch = this.#src[this.#pos]!;
    if (!/[A-Za-z]/.test(ch)) {
      this.#pos += 1;
      return ch;
    }
    const start = this.#pos;
    while (this.#pos < this.#src.length && /[A-Za-z*]/.test(this.#src[this.#pos]!)) {
      this.#pos += 1;
    }
    return this.#src.slice(start, this.#pos);
  }

  #readBracedRaw(): string {
    this.#skipWs();
    if (this.#peek() !== "{") {
      if (this.#peek() === "\\") return "\\" + this.#readCommand();
      return this.#src[this.#pos++] ?? "";
    }
    this.#pos += 1;
    let depth = 1;
    const start = this.#pos;
    while (this.#pos < this.#src.length && depth > 0) {
      const ch = this.#src[this.#pos]!;
      if (ch === "\\") {
        this.#pos += 2;
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      this.#pos += 1;
    }
    return this.#src.slice(start, Math.max(start, this.#pos - 1));
  }

  #readOptionalBracket(): Element | null {
    this.#skipWs();
    if (this.#peek() !== "[") return null;
    this.#pos += 1;
    const row = this.parseSequence("]");
    if (this.#peek() === "]") this.#pos += 1;
    return row;
  }

  #readArg(): Element {
    this.#skipWs();
    if (this.#peek() === "{") {
      this.#pos += 1;
      const seq = this.parseSequence("}");
      if (this.#peek() === "}") this.#pos += 1;
      return seq;
    }
    return this.#parseAtom() ?? mEl(this.#doc, "mrow");
  }

  #readDelimiterToken(): string {
    this.#skipWs();
    const ch = this.#peek();
    if (!ch) return "";
    if (ch === ".") {
      this.#pos += 1;
      return "";
    }
    if (ch === "\\") {
      const cmd = this.#readCommand();
      const sym = LATEX_SYMBOLS[cmd];
      return sym ? sym.text : cmd;
    }
    this.#pos += 1;
    return ch;
  }

  #parseEnvironment(envName: string): Element {
    const endMarker = `\\end{${envName}}`;
    const endIdx = this.#src.indexOf(endMarker, this.#pos);
    const body = endIdx >= 0 ? this.#src.slice(this.#pos, endIdx) : this.#src.slice(this.#pos);
    this.#pos = endIdx >= 0 ? endIdx + endMarker.length : this.#src.length;

    const cleanEnv = envName.replace(/\*$/, "");
    // Split rows by \\ at brace depth 0
    const rows: string[] = [];
    let cur = "";
    let depth = 0;
    for (let i = 0; i < body.length; i += 1) {
      const ch = body[i]!;
      if (ch === "{") { depth += 1; cur += ch; continue; }
      if (ch === "}") { depth = Math.max(0, depth - 1); cur += ch; continue; }
      if (depth === 0 && ch === "\\" && body[i + 1] === "\\") {
        rows.push(cur);
        cur = "";
        i += 1;
        // Skip optional row spacing like \\[4pt]
        if (body[i + 1] === "[") {
          const close = body.indexOf("]", i + 2);
          if (close > i) i = close;
        }
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) rows.push(cur);

    if ((cleanEnv === "equation" || cleanEnv === "multline") && rows.length <= 1) {
      const inner = new LatexParser(this.#doc, (rows[0] ?? body).trim(), true).parseSequence();
      return inner;
    }

    const table = mEl(this.#doc, "mtable");
    for (const rowText of rows) {
      if (!rowText.trim()) continue;
      const tr = mEl(this.#doc, "mtr");
      // Split cells by '&' at brace depth 0
      const cells: string[] = [];
      let cell = "";
      let cDepth = 0;
      for (let i = 0; i < rowText.length; i += 1) {
        const ch = rowText[i]!;
        if (ch === "\\" && rowText[i + 1]) { cell += ch + rowText[i + 1]!; i += 1; continue; }
        if (ch === "{") cDepth += 1;
        else if (ch === "}") cDepth = Math.max(0, cDepth - 1);
        if (cDepth === 0 && ch === "&") {
          cells.push(cell);
          cell = "";
          continue;
        }
        cell += ch;
      }
      cells.push(cell);
      for (const cellText of cells) {
        const td = mEl(this.#doc, "mtd");
        td.append(new LatexParser(this.#doc, cellText.trim(), this.#display).parseSequence());
        tr.append(td);
      }
      table.append(tr);
    }

    const delims = ENV_DELIMITERS[cleanEnv];
    if (!delims) return table;
    const row = mEl(this.#doc, "mrow");
    if (delims[0]) {
      const open = mEl(this.#doc, "mo", delims[0]);
      open.setAttribute("stretchy", "true");
      row.append(open);
    }
    row.append(table);
    if (delims[1]) {
      const close = mEl(this.#doc, "mo", delims[1]);
      close.setAttribute("stretchy", "true");
      row.append(close);
    }
    return row;
  }

  #parseAtom(): Element | null {
    this.#skipWs();
    if (this.#pos >= this.#src.length) return null;
    const ch = this.#peek();

    if (ch === "{") {
      this.#pos += 1;
      const seq = this.parseSequence("}");
      if (this.#peek() === "}") this.#pos += 1;
      return seq;
    }

    if (ch === "\\") {
      const cmd = this.#readCommand();
      if (!cmd) return null;

      // Spacing commands
      if (cmd === "," || cmd === ";" || cmd === ":" || cmd === " " || cmd === "quad" || cmd === "qquad") {
        const space = mEl(this.#doc, "mspace");
        space.setAttribute("width", cmd === "qquad" ? "2em" : cmd === "quad" ? "1em" : "0.25em");
        return space;
      }
      if (cmd === "!" || cmd === "displaystyle" || cmd === "textstyle" || cmd === "scriptstyle" || cmd === "limits" || cmd === "nolimits" || cmd === "nonumber" || cmd === "notag") {
        return null;
      }
      if (cmd === "tag" || cmd === "label") {
        const raw = this.#readBracedRaw();
        if (cmd === "label") return null;
        return mEl(this.#doc, "mtext", ` (${raw})`);
      }

      // Fractions & binomials
      if (cmd === "frac" || cmd === "dfrac" || cmd === "tfrac" || cmd === "cfrac") {
        const num = this.#readArg();
        const den = this.#readArg();
        const frac = mEl(this.#doc, "mfrac");
        frac.append(num, den);
        return frac;
      }
      if (cmd === "binom" || cmd === "dbinom" || cmd === "tbinom") {
        const num = this.#readArg();
        const den = this.#readArg();
        const frac = mEl(this.#doc, "mfrac");
        frac.setAttribute("linethickness", "0");
        frac.append(num, den);
        const row = mEl(this.#doc, "mrow");
        row.append(mEl(this.#doc, "mo", "("), frac, mEl(this.#doc, "mo", ")"));
        return row;
      }

      // Square root & nth root
      if (cmd === "sqrt") {
        const idx = this.#readOptionalBracket();
        const base = this.#readArg();
        if (idx) {
          const root = mEl(this.#doc, "mroot");
          root.append(base, idx);
          return root;
        }
        const sqrt = mEl(this.#doc, "msqrt");
        sqrt.append(base);
        return sqrt;
      }

      // Delimiters \left ... \right
      if (cmd === "left") {
        const open = this.#readDelimiterToken();
        const inner = this.parseSequence("\\right");
        let close = "";
        if (this.#src.startsWith("\\right", this.#pos)) {
          this.#pos += 6;
          close = this.#readDelimiterToken();
        }
        const row = mEl(this.#doc, "mrow");
        if (open) {
          const mo = mEl(this.#doc, "mo", open);
          mo.setAttribute("stretchy", "true");
          row.append(mo);
        }
        row.append(inner);
        if (close) {
          const mo = mEl(this.#doc, "mo", close);
          mo.setAttribute("stretchy", "true");
          row.append(mo);
        }
        return row;
      }
      if (cmd === "big" || cmd === "Big" || cmd === "bigg" || cmd === "Bigg" || cmd === "bigl" || cmd === "bigr" || cmd === "Bigl" || cmd === "Bigr") {
        const d = this.#readDelimiterToken();
        return d ? mEl(this.#doc, "mo", d) : null;
      }

      // Environments \begin{...}...\end{...}
      if (cmd === "begin") {
        const envName = this.#readBracedRaw().trim();
        return this.#parseEnvironment(envName);
      }

      // Text & styled math alphabets
      if (cmd === "text" || cmd === "textrm" || cmd === "mbox" || cmd === "hbox") {
        const rawText = this.#readBracedRaw().replace(/^ +| +$/g, (m) => "\u00A0".repeat(m.length));
        return mEl(this.#doc, "mtext", rawText);
      }
      if (cmd === "operatorname" || cmd === "mathrm" || cmd === "mathsf" || cmd === "texttt") {
        const el = mEl(this.#doc, "mi", this.#readBracedRaw());
        el.setAttribute("mathvariant", "normal");
        return el;
      }
      if (cmd === "mathbf" || cmd === "boldsymbol" || cmd === "bm") {
        const raw = this.#readBracedRaw();
        if (raw.includes("\\")) {
          const inner = new LatexParser(this.#doc, raw, this.#display).parseSequence();
          inner.setAttribute("mathvariant", "bold");
          return inner;
        }
        const el = mEl(this.#doc, "mi", raw);
        el.setAttribute("mathvariant", "bold");
        return el;
      }
      if (cmd === "mathbb") {
        const raw = this.#readBracedRaw();
        const mapped = Array.from(raw).map((c) => BLACKBOARD_MAP[c] ?? c).join("");
        const el = mEl(this.#doc, "mi", mapped);
        el.setAttribute("mathvariant", "normal");
        return el;
      }
      if (cmd === "mathcal" || cmd === "mathscr" || cmd === "mathfrak" || cmd === "mathit") {
        const raw = this.#readBracedRaw();
        const el = mEl(this.#doc, "mi", raw);
        el.setAttribute("mathvariant", cmd === "mathit" ? "italic" : "script");
        return el;
      }

      // Accents, underbrace/overbrace, overset/underset
      if (cmd === "overset" || cmd === "underset") {
        const script = this.#readArg();
        const base = this.#readArg();
        const node = mEl(this.#doc, cmd === "overset" ? "mover" : "munder");
        node.append(base, script);
        return node;
      }
      if (cmd in ACCENT_MAP) {
        const spec = ACCENT_MAP[cmd]!;
        const base = this.#readArg();
        const node = mEl(this.#doc, spec.over ? "mover" : "munder");
        const accent = mEl(this.#doc, "mo", spec.glyph);
        accent.setAttribute("stretchy", "true");
        node.append(base, accent);
        return node;
      }

      // Named math functions
      if (NAMED_FUNCTIONS.has(cmd)) {
        const fn = mEl(this.#doc, "mi", cmd);
        fn.setAttribute("mathvariant", "normal");
        if (LIMIT_FUNCTIONS.has(cmd)) fn.setAttribute("data-pl-largeop", "1");
        return fn;
      }

      // Known symbols & Greek letters
      if (cmd in LATEX_SYMBOLS) {
        const sym = LATEX_SYMBOLS[cmd]!;
        const el = mEl(this.#doc, sym.kind, sym.text);
        if (sym.largeOp) el.setAttribute("data-pl-largeop", "1");
        return el;
      }

      // Unknown command fallback: render cleanly without crashing
      return mEl(this.#doc, "mi", cmd);
    }

    // Numbers
    if (/[0-9]/.test(ch)) {
      const start = this.#pos;
      while (this.#pos < this.#src.length && /[0-9.]/.test(this.#src[this.#pos]!)) {
        this.#pos += 1;
      }
      return mEl(this.#doc, "mn", this.#src.slice(start, this.#pos));
    }

    // Letters (single math variable identifier)
    if (/[A-Za-z]/.test(ch)) {
      this.#pos += 1;
      return mEl(this.#doc, "mi", ch);
    }

    // Operators & punctuation
    this.#pos += 1;
    if (ch === "-") return mEl(this.#doc, "mo", "−");
    if (ch === "'") return mEl(this.#doc, "mo", "′");
    const op = mEl(this.#doc, "mo", ch);
    if (ch === "(" || ch === ")" || ch === "[" || ch === "]") op.setAttribute("stretchy", "false");
    return op;
  }

  #parseScriptedAtom(): Element | null {
    let base = this.#parseAtom();
    if (!base) return null;

    let sub: Element | null = null;
    let sup: Element | null = null;

    while (true) {
      this.#skipWs();
      const ch = this.#peek();
      if (ch === "_" && !sub) {
        this.#pos += 1;
        sub = this.#readArg();
      } else if (ch === "^" && !sup) {
        this.#pos += 1;
        sup = this.#readArg();
      } else if (ch === "'") {
        // Handle f'(x) or f''(x)
        let primes = "";
        while (this.#peek() === "'") {
          primes += "′";
          this.#pos += 1;
        }
        const primeEl = mEl(this.#doc, "mo", primes);
        if (!sup) {
          sup = primeEl;
        } else {
          const row = mEl(this.#doc, "mrow");
          row.append(sup, primeEl);
          sup = row;
        }
      } else {
        break;
      }
    }

    if (!sub && !sup) return base;

    const isLargeOp = base.getAttribute("data-pl-largeop") === "1";
    if (isLargeOp) base.removeAttribute("data-pl-largeop");
    const useUnderOver = this.#display && isLargeOp;

    if (sub && sup) {
      const el = mEl(this.#doc, useUnderOver ? "munderover" : "msubsup");
      el.append(base, sub, sup);
      return el;
    }
    if (sub) {
      const el = mEl(this.#doc, useUnderOver ? "munder" : "msub");
      el.append(base, sub);
      return el;
    }
    const el = mEl(this.#doc, useUnderOver ? "mover" : "msup");
    el.append(base, sup!);
    return el;
  }

  parseSequence(stopToken?: string): Element {
    const items: Element[] = [];
    while (this.#pos < this.#src.length) {
      this.#skipWs();
      if (this.#pos >= this.#src.length) break;
      if (stopToken) {
        if (stopToken.length === 1 && this.#peek() === stopToken) break;
        if (stopToken.length > 1 && this.#src.startsWith(stopToken, this.#pos)) break;
      }
      if (!stopToken && (this.#peek() === "}" || this.#src.startsWith("\\right", this.#pos))) {
        this.#pos += this.#peek() === "}" ? 1 : 6;
        continue;
      }
      const before = this.#pos;
      const node = this.#parseScriptedAtom();
      if (node) items.push(node);
      else if (this.#pos === before) this.#pos += 1;
    }

    if (items.length === 1) return items[0]!;
    const row = mEl(this.#doc, "mrow");
    for (const item of items) row.append(item);
    return row;
  }
}

export function latexToMathMl(doc: Document, latex: string, display = false): Element {
  const cleaned = latex.trim();
  const math = mEl(doc, "math");
  math.setAttribute("display", display ? "block" : "inline");
  math.setAttribute("translate", "no");
  math.setAttribute("data-flt-fixed", "formula");
  math.setAttribute("data-latex", cleaned);
  try {
    const body = new LatexParser(doc, cleaned, display).parseSequence();
    math.append(body);
  } catch {
    math.append(mEl(doc, "mtext", cleaned));
  }
  return math;
}

// ---------------------------------------------------------------------------
// Microsoft Word Office Math Markup Language (OMML) -> Native Browser MathML
// ---------------------------------------------------------------------------

function ommlDirectChild(el: Element, localName: string): Element | undefined {
  return Array.from(el.children).find((c) => c.localName === localName);
}

function ommlVal(el: Element | undefined, attrLocal = "val"): string {
  if (!el) return "";
  for (const attr of Array.from(el.attributes)) {
    if (attr.localName === attrLocal || attr.name === attrLocal || attr.name === `m:${attrLocal}`) {
      return attr.value;
    }
  }
  return "";
}

function tokenizeMathRun(doc: Document, text: string): Element[] {
  const out: Element[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (/\s/.test(ch)) { i += 1; continue; }
    if (/[0-9]/.test(ch)) {
      let end = i + 1;
      while (end < text.length && /[0-9.]/.test(text[end]!)) end += 1;
      out.push(mEl(doc, "mn", text.slice(i, end)));
      i = end;
      continue;
    }
    if (/[A-Za-zα-ωΑ-Ωϑφϕϖϱς∞ℓℏℝℂℤℕℚ]/.test(ch)) {
      // Keep multi-letter English function/word runs together inside <mi>
      let end = i + 1;
      if (/[A-Za-z]/.test(ch)) {
        while (end < text.length && /[A-Za-z]/.test(text[end]!)) end += 1;
      }
      const word = text.slice(i, end);
      if (word.length >= 2 && NAMED_FUNCTIONS.has(word)) {
        const fn = mEl(doc, "mi", word);
        fn.setAttribute("mathvariant", "normal");
        out.push(fn);
      } else if (word.length > 3) {
        out.push(mEl(doc, "mtext", word));
      } else {
        for (const letter of Array.from(word)) out.push(mEl(doc, "mi", letter));
      }
      i = end;
      continue;
    }
    const op = mEl(doc, "mo", ch === "-" ? "−" : ch);
    if (ch === "(" || ch === ")" || ch === "[" || ch === "]") op.setAttribute("stretchy", "false");
    out.push(op);
    i += 1;
  }
  return out;
}

function convertOmmlChildren(doc: Document, parent: Element, display: boolean): Element {
  const items: Element[] = [];
  for (const child of Array.from(parent.children)) {
    const converted = convertOmmlNode(doc, child, display);
    if (converted) items.push(converted);
  }
  if (items.length === 0) return mEl(doc, "mrow");
  if (items.length === 1) return items[0]!;
  const row = mEl(doc, "mrow");
  for (const item of items) row.append(item);
  return row;
}

function convertOmmlNode(doc: Document, el: Element, display: boolean): Element | null {
  const local = el.localName;
  if (local.endsWith("Pr")) return null;

  if (local === "oMath" || local === "oMathPara" || local === "e" || local === "num" || local === "den"
    || local === "sup" || local === "sub" || local === "deg" || local === "lim" || local === "box" || local === "borderBox") {
    return convertOmmlChildren(doc, el, display);
  }

  if (local === "r") {
    const text = Array.from(el.children)
      .filter((c) => c.localName === "t")
      .map((c) => c.textContent ?? "")
      .join("");
    if (!text) return null;
    const rPr = ommlDirectChild(el, "rPr");
    const isNormal = rPr ? Array.from(rPr.children).some((c) => c.localName === "nor") : false;
    if (isNormal) return mEl(doc, "mtext", text);
    const tokens = tokenizeMathRun(doc, text);
    if (tokens.length === 0) return null;
    if (tokens.length === 1) return tokens[0]!;
    const row = mEl(doc, "mrow");
    for (const tok of tokens) row.append(tok);
    return row;
  }

  if (local === "t") {
    const text = el.textContent ?? "";
    const tokens = tokenizeMathRun(doc, text);
    if (tokens.length === 0) return null;
    if (tokens.length === 1) return tokens[0]!;
    const row = mEl(doc, "mrow");
    for (const tok of tokens) row.append(tok);
    return row;
  }

  if (local === "f") {
    const num = ommlDirectChild(el, "num");
    const den = ommlDirectChild(el, "den");
    const fPr = ommlDirectChild(el, "fPr");
    const fType = ommlVal(ommlDirectChild(fPr ?? el, "type"));
    const frac = mEl(doc, "mfrac");
    if (fType === "noBar") frac.setAttribute("linethickness", "0");
    frac.append(
      num ? convertOmmlChildren(doc, num, display) : mEl(doc, "mrow"),
      den ? convertOmmlChildren(doc, den, display) : mEl(doc, "mrow"),
    );
    return frac;
  }

  if (local === "rad") {
    const radPr = ommlDirectChild(el, "radPr");
    const degHide = ommlVal(ommlDirectChild(radPr ?? el, "degHide")) === "1" || ommlVal(ommlDirectChild(radPr ?? el, "degHide")) === "on";
    const deg = ommlDirectChild(el, "deg");
    const base = ommlDirectChild(el, "e");
    const degContent = !degHide && deg && (deg.textContent ?? "").trim() ? convertOmmlChildren(doc, deg, display) : null;
    if (degContent) {
      const mroot = mEl(doc, "mroot");
      mroot.append(base ? convertOmmlChildren(doc, base, display) : mEl(doc, "mrow"), degContent);
      return mroot;
    }
    const msqrt = mEl(doc, "msqrt");
    msqrt.append(base ? convertOmmlChildren(doc, base, display) : mEl(doc, "mrow"));
    return msqrt;
  }

  if (local === "sSup") {
    const base = ommlDirectChild(el, "e");
    const sup = ommlDirectChild(el, "sup");
    const msup = mEl(doc, "msup");
    msup.append(
      base ? convertOmmlChildren(doc, base, display) : mEl(doc, "mrow"),
      sup ? convertOmmlChildren(doc, sup, display) : mEl(doc, "mrow"),
    );
    return msup;
  }

  if (local === "sSub") {
    const base = ommlDirectChild(el, "e");
    const sub = ommlDirectChild(el, "sub");
    const msub = mEl(doc, "msub");
    msub.append(
      base ? convertOmmlChildren(doc, base, display) : mEl(doc, "mrow"),
      sub ? convertOmmlChildren(doc, sub, display) : mEl(doc, "mrow"),
    );
    return msub;
  }

  if (local === "sSubSup") {
    const base = ommlDirectChild(el, "e");
    const sub = ommlDirectChild(el, "sub");
    const sup = ommlDirectChild(el, "sup");
    const msubsup = mEl(doc, "msubsup");
    msubsup.append(
      base ? convertOmmlChildren(doc, base, display) : mEl(doc, "mrow"),
      sub ? convertOmmlChildren(doc, sub, display) : mEl(doc, "mrow"),
      sup ? convertOmmlChildren(doc, sup, display) : mEl(doc, "mrow"),
    );
    return msubsup;
  }

  if (local === "nary") {
    const pr = ommlDirectChild(el, "naryPr");
    const chr = ommlVal(pr ? ommlDirectChild(pr, "chr") : undefined) || "∫";
    const sub = ommlDirectChild(el, "sub");
    const sup = ommlDirectChild(el, "sup");
    const body = ommlDirectChild(el, "e");
    const hasSub = Boolean(sub && (sub.textContent ?? "").trim());
    const hasSup = Boolean(sup && (sup.textContent ?? "").trim());
    const op = mEl(doc, "mo", chr);
    let head: Element = op;
    const useUnderOver = display && chr !== "∫" && chr !== "∬" && chr !== "∮";
    if (hasSub && hasSup) {
      head = mEl(doc, useUnderOver ? "munderover" : "msubsup");
      head.append(op, convertOmmlChildren(doc, sub!, display), convertOmmlChildren(doc, sup!, display));
    } else if (hasSub) {
      head = mEl(doc, useUnderOver ? "munder" : "msub");
      head.append(op, convertOmmlChildren(doc, sub!, display));
    } else if (hasSup) {
      head = mEl(doc, useUnderOver ? "mover" : "msup");
      head.append(op, convertOmmlChildren(doc, sup!, display));
    }
    const row = mEl(doc, "mrow");
    row.append(head);
    if (body) row.append(convertOmmlChildren(doc, body, display));
    return row;
  }

  if (local === "d") {
    const pr = ommlDirectChild(el, "dPr");
    const begChr = pr && ommlDirectChild(pr, "begChr") ? ommlVal(ommlDirectChild(pr, "begChr")) : "(";
    const endChr = pr && ommlDirectChild(pr, "endChr") ? ommlVal(ommlDirectChild(pr, "endChr")) : ")";
    const sepChr = pr && ommlDirectChild(pr, "sepChr") ? ommlVal(ommlDirectChild(pr, "sepChr")) : ",";
    const items = Array.from(el.children).filter((c) => c.localName === "e");
    const row = mEl(doc, "mrow");
    if (begChr) {
      const open = mEl(doc, "mo", begChr);
      open.setAttribute("stretchy", "true");
      row.append(open);
    }
    items.forEach((item, idx) => {
      if (idx > 0 && sepChr) row.append(mEl(doc, "mo", sepChr));
      row.append(convertOmmlChildren(doc, item, display));
    });
    if (endChr) {
      const close = mEl(doc, "mo", endChr);
      close.setAttribute("stretchy", "true");
      row.append(close);
    }
    return row;
  }

  if (local === "m") {
    const table = mEl(doc, "mtable");
    for (const mr of Array.from(el.children).filter((c) => c.localName === "mr")) {
      const tr = mEl(doc, "mtr");
      for (const cell of Array.from(mr.children).filter((c) => c.localName === "e")) {
        const td = mEl(doc, "mtd");
        td.append(convertOmmlChildren(doc, cell, display));
        tr.append(td);
      }
      table.append(tr);
    }
    return table;
  }

  if (local === "eqArr") {
    const table = mEl(doc, "mtable");
    for (const rowEl of Array.from(el.children).filter((c) => c.localName === "e")) {
      const tr = mEl(doc, "mtr");
      const td = mEl(doc, "mtd");
      td.append(convertOmmlChildren(doc, rowEl, display));
      tr.append(td);
      table.append(tr);
    }
    return table;
  }

  if (local === "acc") {
    const pr = ommlDirectChild(el, "accPr");
    const chr = ommlVal(pr ? ommlDirectChild(pr, "chr") : undefined) || "^";
    const base = ommlDirectChild(el, "e");
    const mover = mEl(doc, "mover");
    mover.append(base ? convertOmmlChildren(doc, base, display) : mEl(doc, "mrow"), mEl(doc, "mo", chr));
    return mover;
  }

  if (local === "bar") {
    const pr = ommlDirectChild(el, "barPr");
    const pos = ommlVal(pr ? ommlDirectChild(pr, "pos") : undefined) || "top";
    const base = ommlDirectChild(el, "e");
    const node = mEl(doc, pos === "bot" ? "munder" : "mover");
    const bar = mEl(doc, "mo", pos === "bot" ? "_" : "¯");
    bar.setAttribute("stretchy", "true");
    node.append(base ? convertOmmlChildren(doc, base, display) : mEl(doc, "mrow"), bar);
    return node;
  }

  if (local === "groupChr") {
    const pr = ommlDirectChild(el, "groupChrPr");
    const chr = ommlVal(pr ? ommlDirectChild(pr, "chr") : undefined) || "⏟";
    const pos = ommlVal(pr ? ommlDirectChild(pr, "pos") : undefined) || "bot";
    const base = ommlDirectChild(el, "e");
    const node = mEl(doc, pos === "top" ? "mover" : "munder");
    const mo = mEl(doc, "mo", chr);
    mo.setAttribute("stretchy", "true");
    node.append(base ? convertOmmlChildren(doc, base, display) : mEl(doc, "mrow"), mo);
    return node;
  }

  if (local === "limLow" || local === "limUpp") {
    const base = ommlDirectChild(el, "e");
    const lim = ommlDirectChild(el, "lim");
    const node = mEl(doc, local === "limLow" ? "munder" : "mover");
    node.append(
      base ? convertOmmlChildren(doc, base, display) : mEl(doc, "mrow"),
      lim ? convertOmmlChildren(doc, lim, display) : mEl(doc, "mrow"),
    );
    return node;
  }

  if (local === "func") {
    const fName = ommlDirectChild(el, "fName");
    const arg = ommlDirectChild(el, "e");
    const row = mEl(doc, "mrow");
    if (fName) {
      const fn = convertOmmlChildren(doc, fName, display);
      fn.setAttribute("mathvariant", "normal");
      row.append(fn);
    }
    if (arg) row.append(convertOmmlChildren(doc, arg, display));
    return row;
  }

  return convertOmmlChildren(doc, el, display);
}

export function ommlToMathMl(doc: Document, ommlNode: Element, display = false): Element | null {
  const content = convertOmmlNode(doc, ommlNode, display);
  if (!content || !(content.textContent ?? "").trim()) return null;
  const math = mEl(doc, "math");
  math.setAttribute("display", display ? "block" : "inline");
  math.setAttribute("translate", "no");
  math.setAttribute("data-flt-fixed", "formula");
  math.append(content);
  return math;
}
