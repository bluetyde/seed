// A tiny element builder. Text is always set as text, never as HTML, so app names and error output cannot inject markup.
// Plain script: no imports.

function el(tag: string, attrs: Record<string, string | boolean | ((e: any) => void) | undefined> = {}, ...kids: (Node | string | null | undefined | false)[]): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "string") e.style.cssText = v;   // CSSOM, so the page can forbid inline style attributes
    else if (v === true) e.setAttribute(k, "");
    else e.setAttribute(k, v);
  }
  for (const c of kids) if (c) e.append(c);
  return e;
}

function svgNode(name: string, size = 16): Node {
  const t = document.createElement("template");
  t.innerHTML = iconSvg(name, size);
  return t.content.firstChild!;
}
