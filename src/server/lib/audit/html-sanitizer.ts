/**
 * Strips inert <noscript>...</noscript> blocks outside of comments and <script>
 * without swallowing live content or falling victim to script literals or quoted attributes like "<noscript>".
 */
export function sanitizeNoscript(html: string): string {
  let result = "";
  let i = 0;
  const len = html.length;

  while (i < len) {
    if (html.startsWith("<!--", i)) {
      const endComment = html.indexOf("-->", i + 4);
      if (endComment === -1) {
        result += html.slice(i);
        break;
      }
      result += html.slice(i, endComment + 3);
      i = endComment + 3;
      continue;
    }

    // 2. Raw text & RCDATA elements: <script>, <style>, <textarea>, <title>, <xmp> (Sol R24-04)
    // Their contents are NOT parsed as HTML tags, so any "<noscript>" inside them is inert/literal text
    const rawMatch = /^<(script|style|textarea|title|xmp)\b/i.exec(
      html.slice(i, i + 10),
    );
    if (rawMatch) {
      const tagName = rawMatch[1].toLowerCase();
      let endOpen = i + rawMatch[0].length;
      let inQuote: string | null = null;
      while (endOpen < len) {
        const ch = html[endOpen];
        if (inQuote && ch === inQuote) {
          inQuote = null;
        } else if (!inQuote && (ch === '"' || ch === "'")) {
          inQuote = ch;
        } else if (!inQuote && ch === ">") {
          break;
        }
        endOpen++;
      }
      if (endOpen >= len) {
        result += html.slice(i);
        break;
      }
      const closeRegex = new RegExp(`</${tagName}\\s*>`, "i");
      const closeMatch = closeRegex.exec(html.slice(endOpen + 1));
      if (!closeMatch) {
        result += html.slice(i);
        break;
      }
      const closeEnd = endOpen + 1 + closeMatch.index + closeMatch[0].length;
      result += html.slice(i, closeEnd);
      i = closeEnd;
      continue;
    }

    // 3. Real inert <noscript ...> ... </noscript>
    // Sol R24-04: Must match exact tag delimiter (whitespace, '/', '>', or EOF), NOT <noscript-placeholder>
    if (/^<noscript(?=[\s/>]|$)/i.test(html.slice(i, i + 10))) {
      const noscriptCloseMatch = /<\/noscript\s*>/i.exec(html.slice(i));
      if (!noscriptCloseMatch) {
        // Sol R24-04: If unclosed, do not discard the rest of document
        result += html[i];
        i++;
        continue;
      }
      i += noscriptCloseMatch.index + noscriptCloseMatch[0].length;
      continue;
    }

    // 4. Any other HTML tag: <tag ...> or </tag ...> (Sol Round 22 F02: quote-aware tag skip)
    if (html[i] === "<" && i + 1 < len && /[a-zA-Z/!]/.test(html[i + 1])) {
      let tagEnd = i + 1;
      let inQuote: string | null = null;
      while (tagEnd < len) {
        const ch = html[tagEnd];
        if (inQuote && ch === inQuote) {
          inQuote = null;
        } else if (!inQuote && (ch === '"' || ch === "'")) {
          inQuote = ch;
        } else if (!inQuote && ch === ">") {
          break;
        }
        tagEnd++;
      }
      const endPos = tagEnd < len ? tagEnd + 1 : len;
      result += html.slice(i, endPos);
      i = endPos;
      continue;
    }

    result += html[i];
    i++;
  }

  return result;
}
