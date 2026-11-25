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

    if (/^<script\b/i.test(html.slice(i, i + 8))) {
      let endOpen = i + 7;
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
      const scriptCloseMatch = /<\/script\s*>/i.exec(html.slice(endOpen + 1));
      if (!scriptCloseMatch) {
        result += html.slice(i);
        break;
      }
      const closeEnd =
        endOpen + 1 + scriptCloseMatch.index + scriptCloseMatch[0].length;
      result += html.slice(i, closeEnd);
      i = closeEnd;
      continue;
    }

    // 3. Real inert <noscript ...> ... </noscript>
    if (/^<noscript\b/i.test(html.slice(i, i + 10))) {
      const noscriptCloseMatch = /<\/noscript\s*>/i.exec(html.slice(i));
      if (!noscriptCloseMatch) {
        break;
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
