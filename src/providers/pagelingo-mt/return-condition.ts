import type {TranslationRequest} from "../../core/provider";
import {fixedMtPrompt, type FixedMtText} from "./fixed-text";
import {mtRouteSupported} from "./protocol";

const returnPrefix = /^⟦0⟧Returns?\s+⟦\/0⟧⟪P0⟫⟦1⟧\s+if\s+/u;
const anotherCondition = /\b(?:if|iff|only|unless|otherwise|except|else|but|whereas|until|provided|when|returns?|in (?:all )?other cases)\b/iu;
const linkSentinel = /^__FLT_LINK_(?:START|END)_\d+__$/u;

function plainChild(text: Text | undefined, body: HTMLElement): Node | null {
  if (text?.parentNode === body) return text;
  const span = text?.parentElement;
  return span?.parentElement === body && span.matches("span[data-flt-text-id]") && span.childNodes.length === 1
    ? span : null;
}

/** Make a return value explicit in the prompt while keeping the original frame for decoding. */
export function clarifyReturnCondition(encoded: FixedMtText, request: TranslationRequest, maxPromptBytes: number): string | undefined {
  if (!mtRouteSupported(request)) return undefined;
  const prefix = returnPrefix.exec(encoded.source);
  if (!prefix) return undefined;

  const leading = plainChild(encoded.texts[0]?.node, encoded.body);
  const connector = plainChild(encoded.texts[1]?.node, encoded.body);
  const code = Array.from(encoded.body.querySelectorAll("code")).filter(node => !linkSentinel.test(node.textContent ?? ""));
  // The two edited slots must both be ordinary prose. The value is one inline
  // code node. The condition can contain linked code, whose ownership is untouched.
  const value = code[0];
  if (code.length !== 2 || !value || !leading || !connector || leading.nextSibling !== value || value.nextSibling !== connector) {
    return undefined;
  }

  const condition = encoded.source.slice(prefix[0].length);
  const prose = condition.replace(/⟦\/?\d+⟧/gu, "").replace(/⟪P\d+⟫/gu, " code ").trim();
  if (anotherCondition.test(prose) || /[,;:]|[.!?]\s*\S/u.test(prose) || encoded.body.querySelector("br,wbr")) return undefined;
  const source = "⟦0⟧The return value is ⟦/0⟧⟪P0⟫⟦1⟧ under this condition: " + condition;
  const prompt = fixedMtPrompt({...encoded, source}, request);
  return new TextEncoder().encode(prompt).length <= maxPromptBytes ? prompt : undefined;
}
