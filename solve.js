// A faster drop-in for csv-reader 1.0.0 (make.fun bounty csv-reader-speed-01).
//
// run(input) returns csv-reader's {columns, rows, errors}, identical for every input.
//
// The text becomes UTF-8 bytes once and is read left to right by byte. CSV's delimiters are ASCII
// (0x2C comma, 0x0A LF, 0x0D CR, 0x22 quote) and UTF-8 never puts a byte below 0x80 inside a
// multi-byte character, so each field is copied from the input straight into the answer's JSON
// bytes as it is read: no field strings and no row arrays are built.
//
// answerBuffer(input) is the answer as the bytes of JSON.stringify(run(input)); main.ts writes
// those bytes straight to answers.json.

const C = 0x2c;
const LF = 0x0a;
const CR = 0x0d;
const Q = 0x22;
const BS = 0x5c;

const COMMA = 1;
const LINE_BREAK = 2;
const END = 3;

const HEX = new Uint8Array(16);
for (let i = 0; i < 10; i++) HEX[i] = 0x30 + i;
for (let i = 0; i < 6; i++) HEX[10 + i] = 0x61 + i;

class Buf {
  constructor(cap) {
    this.b = Buffer.allocUnsafe(cap);
    this.n = 0;
  }
  need(k) {
    if (this.n + k <= this.b.length) return;
    let cap = this.b.length || 4096;
    while (cap < this.n + k) cap *= 2;
    const next = Buffer.allocUnsafe(cap);
    this.b.copy(next, 0, 0, this.n);
    this.b = next;
  }
  byte(c) {
    this.need(1);
    this.b[this.n++] = c;
  }
  copyRange(src, from, to) {
    const k = to - from;
    if (k <= 0) return;
    this.need(k);
    src.copy(this.b, this.n, from, to);
    this.n += k;
  }
  // JSON-escapes src[from,to), without the surrounding quotes.
  escaped(src, from, to) {
    if (to <= from) return;
    this.need((to - from) * 6 + 2);
    const b = this.b;
    let p = this.n;
    let i = from;
    let run = from;
    while (i < to) {
      const c = src[i];
      if (c !== Q && c !== BS && c >= 0x20) {
        i++;
        continue;
      }
      if (i > run) {
        src.copy(b, p, run, i);
        p += i - run;
      }
      if (c === Q) {
        b[p++] = BS;
        b[p++] = Q;
      } else if (c === BS) {
        b[p++] = BS;
        b[p++] = BS;
      } else if (c === LF) {
        b[p++] = BS;
        b[p++] = 0x6e;
      } else if (c === CR) {
        b[p++] = BS;
        b[p++] = 0x72;
      } else if (c === 0x09) {
        b[p++] = BS;
        b[p++] = 0x74;
      } else if (c === 0x08) {
        b[p++] = BS;
        b[p++] = 0x62;
      } else if (c === 0x0c) {
        b[p++] = BS;
        b[p++] = 0x66;
      } else {
        b[p++] = BS;
        b[p++] = 0x75;
        b[p++] = 0x30;
        b[p++] = 0x30;
        b[p++] = HEX[(c >> 4) & 15];
        b[p++] = HEX[c & 15];
      }
      i++;
      run = i;
    }
    if (to > run) {
      src.copy(b, p, run, to);
      p += to - run;
    }
    this.n = p;
  }
}

export function answerBuffer(input) {
  const text = String(input.text);
  const header = input.header === true;
  const src = Buffer.from(text, 'utf8');
  const len = src.length;

  const rows = new Buf(len * 2 + 8192);
  const cols = new Buf(4096);
  const errs = [];

  let pos = 0;
  let line = 1;
  if (len >= 3 && src[0] === 0xef && src[1] === 0xbb && src[2] === 0xbf) pos = 3;

  let recordLine = 1;
  let recordRow = null;
  let ended = END;

  // The field just read: src[fs,fe), or `built` when a stray CR or a quote forced a rebuild.
  let fs = 0;
  let fe = 0;
  let built = null;
  let needEsc = false;
  let fieldAdded = 0;

  let width = -1;
  let haveColumns = false;
  let rowIndex = 0;
  let rowCount = 0;

  function pushErr(code, extra) {
    errs.push(
      '{"code":"' + code + '","line":' + recordLine + ',"row":' +
        (recordRow === null ? 'null' : recordRow) + extra + '}'
    );
  }

  // Reads an unquoted field from `start`. A stray CR is rare, so the common path allocates nothing.
  function readUnquoted(start) {
    let i = start;
    let esc = false;
    while (i < len) {
      const c = src[i];
      if (c === C) {
        fs = start;
        fe = i;
        built = null;
        needEsc = esc;
        fieldAdded = i - start;
        pos = i + 1;
        ended = COMMA;
        return;
      }
      if (c === LF) {
        fs = start;
        fe = i;
        built = null;
        needEsc = esc;
        fieldAdded = i - start;
        pos = i + 1;
        line++;
        ended = LINE_BREAK;
        return;
      }
      if (c === CR) {
        if (i + 1 < len && src[i + 1] === LF) {
          fs = start;
          fe = i;
          built = null;
          needEsc = esc;
          fieldAdded = i - start;
          pos = i + 2;
          line++;
          ended = LINE_BREAK;
          return;
        }
        // A stray CR is dropped and the field goes on: rebuild it from its pieces.
        strayTail(start, i);
        return;
      }
      if (c === Q || c === BS || c < 0x20) esc = true;
      i++;
    }
    fs = start;
    fe = len;
    built = null;
    needEsc = esc;
    fieldAdded = len - start;
    pos = len;
    ended = END;
  }

  function strayTail(start, at) {
    const parts = [src.subarray(start, at)];
    let esc = false;
    let i = at;
    pushErr('stray_cr', '');
    i++;
    let seg = i;
    while (i < len) {
      const c = src[i];
      let stop = -1;
      let kind = 0;
      if (c === C) {
        stop = i;
        kind = COMMA;
      } else if (c === LF) {
        stop = i;
        kind = LINE_BREAK;
      } else if (c === CR) {
        if (i + 1 < len && src[i + 1] === LF) {
          stop = i;
          kind = LINE_BREAK;
        } else {
          pushErr('stray_cr', '');
          if (i > seg) parts.push(src.subarray(seg, i));
          i++;
          seg = i;
          continue;
        }
      }
      if (stop >= 0) {
        if (stop > seg) parts.push(src.subarray(seg, stop));
        built = Buffer.concat(parts);
        fs = 0;
        fe = built.length;
        needEsc = true;
        fieldAdded = stop - start;
        if (kind === COMMA) {
          pos = stop + 1;
          ended = COMMA;
        } else {
          pos = c === CR ? stop + 2 : stop + 1;
          line++;
          ended = LINE_BREAK;
        }
        return;
      }
      if (c === Q || c === BS || c < 0x20) esc = true;
      i++;
    }
    if (len > seg) parts.push(src.subarray(seg, len));
    built = Buffer.concat(parts);
    fs = 0;
    fe = built.length;
    needEsc = true;
    fieldAdded = len - start;
    pos = len;
    ended = END;
  }

  function readQuoted() {
    const body = pos + 1;
    let scan = body;
    let closedAt = -1;
    let doubled = false;
    while (true) {
      const q = src.indexOf(Q, scan);
      if (q < 0) break;
      if (q + 1 < len && src[q + 1] === Q) {
        doubled = true;
        scan = q + 2;
        continue;
      }
      closedAt = q;
      break;
    }
    if (closedAt < 0) {
      // The quote never closes: a literal character, and the text after it is read again as unquoted.
      pos = body;
      pushErr('unterminated_quote', '');
      readUnquoted(body);
      const tail = built !== null ? built : src.subarray(fs, fe);
      const quoted = Buffer.allocUnsafe(tail.length + 1);
      quoted[0] = Q;
      tail.copy(quoted, 1);
      built = quoted;
      fs = 0;
      fe = quoted.length;
      needEsc = true;
      fieldAdded += 1;
      return;
    }

    let crAt = src.indexOf(CR, body);
    const hasCR = crAt >= 0 && crAt < closedAt;

    let nl = 0;
    let k = body;
    while (true) {
      const z = src.indexOf(LF, k);
      if (z < 0 || z >= closedAt) break;
      nl++;
      k = z + 1;
    }
    let lone = 0;
    if (hasCR) {
      let m = body;
      while (true) {
        const z = src.indexOf(CR, m);
        if (z < 0 || z >= closedAt) break;
        if (z + 1 < closedAt && src[z + 1] === LF) m = z + 2;
        else {
          lone++;
          m = z + 1;
        }
      }
    }
    line += nl + lone;

    let esc = hasCR;
    if (!doubled) {
      for (let q = body; q < closedAt; q++) {
        const ch = src[q];
        if (ch === Q || ch === BS || ch < 0x20) {
          esc = true;
          break;
        }
      }
    }

    if (doubled || hasCR) {
      // Normalise the body: "" is one quote, and CRLF or a lone CR is one LF.
      const tmp = Buffer.allocUnsafe(closedAt - body);
      let p = 0;
      let i = body;
      while (i < closedAt) {
        const c = src[i];
        if (c === Q && i + 1 < closedAt && src[i + 1] === Q) {
          tmp[p++] = Q;
          i += 2;
          continue;
        }
        if (c === CR) {
          tmp[p++] = LF;
          i += i + 1 < closedAt && src[i + 1] === LF ? 2 : 1;
          continue;
        }
        tmp[p++] = c;
        i++;
      }
      built = tmp.subarray(0, p);
      fs = 0;
      fe = p;
      esc = true;
    } else {
      built = null;
      fs = body;
      fe = closedAt;
    }
    needEsc = esc;
    fieldAdded = 0;
    pos = closedAt + 1;

    if (pos >= len) {
      ended = END;
      return;
    }
    const c = src[pos];
    if (c === C) {
      pos++;
      ended = COMMA;
      return;
    }
    if (c === LF) {
      pos++;
      line++;
      ended = LINE_BREAK;
      return;
    }
    if (c === CR && pos + 1 < len && src[pos + 1] === LF) {
      pos += 2;
      line++;
      ended = LINE_BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line break.
    const keep = built !== null ? built : src.subarray(fs, fe);
    readUnquoted(pos);
    const tail = built !== null ? built : src.subarray(fs, fe);
    built = Buffer.concat([keep, tail]);
    fs = 0;
    fe = built.length;
    needEsc = true;
    if (fieldAdded > 0) pushErr('quote_junk', '');
  }

  function emitField(target) {
    if (needEsc) {
      if (built !== null) target.escaped(built, 0, built.length);
      else target.escaped(src, fs, fe);
    } else {
      target.copyRange(src, fs, fe);
    }
  }

  function emitQuotedField(target) {
    target.byte(Q);
    emitField(target);
    target.byte(Q);
  }

  let emptyFirst = false;

  for (;;) {
    while (pos < len) {
      const c = src[pos];
      if (c === LF) {
        pos++;
        line++;
      } else if (c === CR && pos + 1 < len && src[pos + 1] === LF) {
        pos += 2;
        line++;
      } else break;
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && !haveColumns ? null : rowIndex;

    // The first field decides whether this is a record at all: a line left with no characters (a
    // line of stray CRs) is one empty unquoted field and is no record. Read it before writing
    // anything, so such a line leaves no trace but its errors.
    const firstQuoted = src[pos] === Q;
    if (firstQuoted) readQuoted();
    else readUnquoted(pos);
    const firstEmpty = !firstQuoted && fe === fs && built === null;

    if (firstEmpty && ended !== COMMA) continue;

    if (header && !haveColumns) {
      cols.byte(0x5b);
      emitQuotedField(cols);
      let count = 1;
      while (ended === COMMA) {
        cols.byte(C);
        const q = src[pos] === Q;
        if (q) readQuoted();
        else readUnquoted(pos);
        emitQuotedField(cols);
        count++;
      }
      cols.byte(0x5d);
      width = count;
      haveColumns = true;
      continue;
    }

    if (rowCount > 0) rows.byte(C);
    else rows.byte(0x5b);
    rows.byte(0x5b);
    emitQuotedField(rows);
    let count = 1;
    let extras = null;
    while (ended === COMMA) {
      const q = src[pos] === Q;
      if (q) readQuoted();
      else readUnquoted(pos);
      if (width < 0 || count < width) {
        rows.byte(C);
        emitQuotedField(rows);
      } else {
        if (extras === null) extras = [];
        extras.push(
          built !== null ? built.toString('utf8') : src.toString('utf8', fs, fe)
        );
      }
      count++;
    }

    if (width < 0) width = count;

    if (count < width) {
      pushErr('short_row', ',"fields":' + count);
      for (let i = count; i < width; i++) {
        rows.need(3);
        rows.b[rows.n++] = C;
        rows.b[rows.n++] = Q;
        rows.b[rows.n++] = Q;
      }
    } else if (extras !== null) {
      let extra = '[';
      for (let i = 0; i < extras.length; i++) {
        if (i > 0) extra += ',';
        extra += JSON.stringify(extras[i]);
      }
      pushErr('long_row', ',"extra":' + extra + ']');
    }

    rows.byte(0x5d);
    rowCount++;
    rowIndex++;
  }

  if (rowCount > 0) rows.byte(0x5d);

  const head = Buffer.from(
    '{"columns":' + (header ? (haveColumns ? cols.b.toString('utf8', 0, cols.n) : '[]') : 'null') + ',"rows":',
    'utf8'
  );
  const errBody = Buffer.from(errs.length === 0 ? '[]' : '[' + errs.join(',') + ']', 'utf8');
  return Buffer.concat([
    head,
    rowCount > 0 ? rows.b.subarray(0, rows.n) : Buffer.from('[]'),
    Buffer.from(',"errors":'),
    errBody,
    Buffer.from('}'),
  ]);
}

export function answerJson(input) {
  return answerBuffer(input).toString('utf8');
}

export function run(input) {
  return JSON.parse(answerBuffer(input).toString('utf8'));
}
