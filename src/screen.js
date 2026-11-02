/**
 * What a terminal shows, from what was written to it. Claude Code draws its screen by
 * moving the cursor - to a column instead of writing spaces, back up a line to redraw
 * one - so the text in the order it was written is not the text on the screen. A token
 * read straight off the output comes out cut short; read off the screen, it comes out
 * as it was shown.
 */

const LONG_TOKEN = /^sk-ant-oat\d+-[A-Za-z0-9_-]{40,}$/;

/** The rows a terminal `cols` wide would show after `raw` was written to it, scrolled-off ones first. */
export function screenRows(raw, cols = 80, height = Infinity) {
  const rows = [[]];
  let r = 0, c = 0, wrap = false, saved = [0, 0];
  const row = (i) => { while (rows.length <= i) rows.push([]); return rows[i]; };
  const top = () => Math.max(0, rows.length - height);
  const s = String(raw);
  for (let i = 0; i < s.length; i++) {
    let ch = s[i];
    if (ch === '\x1b') {
      const next = s[i + 1];
      if (next === '[') {
        const m = /^\x1b\[([0-9;:?<=>]*)([ -/]*)([@-~])/.exec(s.slice(i, i + 64));
        if (!m) continue;
        i += m[0].length - 1;
        if (/^[?<=>]/.test(m[1]) || m[2]) continue;   // modes and queries: nothing drawn
        const ps = m[1].split(';').map((x) => parseInt(x, 10));
        const n = ps[0] > 0 ? ps[0] : 1;
        wrap = false;
        switch (m[3]) {
          case 'A': r = Math.max(top(), r - n); break;
          case 'B': r += n; break;
          case 'C': c = Math.min(cols - 1, c + n); break;
          case 'D': c = Math.max(0, c - n); break;
          case 'E': r += n; c = 0; break;
          case 'F': r = Math.max(top(), r - n); c = 0; break;
          case 'G': case '`': c = Math.min(cols - 1, n - 1); break;
          case 'd': r = top() + n - 1; break;
          case 'H': case 'f': r = top() + n - 1; c = Math.min(cols - 1, (ps[1] > 0 ? ps[1] : 1) - 1); break;
          case 'K': {
            const line = row(r), how = ps[0] || 0;
            if (how === 0) line.length = Math.min(line.length, c);
            else if (how === 1) for (let k = 0; k <= c; k++) line[k] = undefined;
            else line.length = 0;
            break;
          }
          case 'J': {
            const how = ps[0] || 0;
            if (how === 0) { row(r).length = Math.min(row(r).length, c); rows.length = r + 1; }
            else if (how === 1) { for (let k = top(); k < r; k++) rows[k] = []; for (let k = 0; k <= c; k++) row(r)[k] = undefined; }
            else if (how === 2) for (let k = top(); k < rows.length; k++) rows[k] = [];
            else { const t = top(); rows.splice(0, t); r -= t; }
            break;
          }
          default: break;   // colours and the like
        }
        continue;
      }
      if (next === ']' || next === 'P' || next === '_') {   // a string, to BEL or ST: a link's address, a title
        const end = s.slice(i + 2).search(/\x07|\x1b\\/);
        i = end < 0 ? s.length : i + 2 + end + (s[i + 2 + end] === '\x07' ? 0 : 1);
        continue;
      }
      if (next === '7') saved = [r, c];
      else if (next === '8') [r, c] = saved;
      else if (next === 'M') r = Math.max(top(), r - 1);
      else if (next === 'E') { r++; c = 0; }
      else if ('()*+#%'.includes(next)) i++;   // a character set: one more
      i++;
      wrap = false;
      continue;
    }
    if (ch === '\r') { c = 0; wrap = false; continue; }
    if (ch === '\n' || ch === '\v' || ch === '\f') { r++; wrap = false; continue; }
    if (ch === '\b') { c = Math.max(0, c - 1); wrap = false; continue; }
    if (ch === '\t') { c = Math.min(cols - 1, (Math.floor(c / 8) + 1) * 8); continue; }
    if (ch < ' ' || ch === '\x7f') continue;
    const code = ch.codePointAt(0);
    if (code > 0xffff) { ch = s.slice(i, i + 2); i++; }
    const wide = code > 0xffff ? 2 : 1;
    if (wrap || c + wide > cols) { r++; c = 0; wrap = false; }
    const line = row(r);
    line[c] = ch;
    if (wide === 2) line[c + 1] = '';
    if (c + wide >= cols) { c = cols - 1; wrap = true; } else c += wide;
  }
  return rows.map((x) => Array.from(x, (ch) => (ch == null ? ' ' : ch)).join('').trimEnd());
}

/**
 * The last long-lived token on the screen. Claude Code wraps it to the width of the
 * screen, each line indented, so it carries on through every following row that holds
 * nothing but more of it.
 */
export function tokenIn(raw, cols, height) {
  const rows = screenRows(raw, cols, height);
  for (let i = rows.length - 1; i >= 0; i--) {
    const at = rows[i].lastIndexOf('sk-ant-oat');
    if (at < 0) continue;
    let token = /^[A-Za-z0-9_-]+/.exec(rows[i].slice(at))[0];
    for (let k = i + 1; k < rows.length && /^\s*[A-Za-z0-9_-]+$/.test(rows[k]); k++) token += rows[k].trim();
    return LONG_TOKEN.test(token) ? token : null;
  }
  return null;
}
