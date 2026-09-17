/* Worship Slides engine — client-side port of slidegen.py.
   Reads .docx, edits ProPresenter .pro protobuf, clones slides to fit content.
   Works in the browser (attaches to window.WS) and in Node (module.exports). */
(function (root) {
  "use strict";

  // ---------------- protobuf: round-trip-safe generic tree ----------------
  function readVarint(b, i) {
    let r = 0, s = 0, c;
    do { c = b[i++]; r += (c & 0x7f) * Math.pow(2, s); s += 7; } while (c & 0x80);
    return [r, i];
  }
  function writeVarint(n, out) {
    for (;;) { let c = n & 0x7f; n = Math.floor(n / 128); if (n) out.push(c | 0x80); else { out.push(c); return; } }
  }
  function F(num, wt, val) { return { num, wt, val }; }

  function parse(b) {
    const fields = []; let i = 0; const n = b.length;
    while (i < n) {
      let tag; [tag, i] = readVarint(b, i);
      const num = Math.floor(tag / 8), wt = tag & 7;
      if (wt === 0) { let v; [v, i] = readVarint(b, i); fields.push(F(num, wt, v)); }
      else if (wt === 1) { fields.push(F(num, wt, b.slice(i, i + 8))); i += 8; }
      else if (wt === 5) { fields.push(F(num, wt, b.slice(i, i + 4))); i += 4; }
      else if (wt === 2) {
        let ln; [ln, i] = readVarint(b, i);
        const raw = b.slice(i, i + ln); i += ln;
        if (i > n) throw new Error("overrun");
        const sub = tryParse(raw);
        fields.push(F(num, wt, sub !== null ? sub : raw));
      } else throw new Error("wire " + wt);
    }
    if (i !== n) throw new Error("trailing");
    return fields;
  }
  function tryParse(raw) {
    if (raw.length === 0) return null;
    try { const f = parse(raw); if (bytesEqual(serialize(f), raw)) return f; } catch (e) {}
    return null;
  }
  function serialize(fields) {
    const out = [];
    for (const f of fields) {
      writeVarint(f.num * 8 + f.wt, out);
      if (f.wt === 0) writeVarint(f.val, out);
      else if (f.wt === 1 || f.wt === 5) for (const x of f.val) out.push(x);
      else if (f.wt === 2) {
        const raw = Array.isArray(f.val) ? serialize(f.val) : f.val;
        writeVarint(raw.length, out);
        for (const x of raw) out.push(x);
      }
    }
    return Uint8Array.from(out);
  }
  function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // ---------------- latin1 / cp1252 / RTF ----------------
  function toLatin1(str) { const a = new Uint8Array(str.length); for (let i = 0; i < str.length; i++) a[i] = str.charCodeAt(i) & 0xff; return a; }
  function fromLatin1(b) { let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; }
  function startsWithRtf(b) { // b is Uint8Array: {\rtf1
    const m = [0x7b, 0x5c, 0x72, 0x74, 0x66, 0x31];
    if (b.length < 6) return false;
    for (let i = 0; i < 6; i++) if (b[i] !== m[i]) return false;
    return true;
  }
  function containsCf2(b) { // search for \cf2
    const m = [0x5c, 0x63, 0x66, 0x32];
    outer: for (let i = 0; i + 4 <= b.length; i++) { for (let j = 0; j < 4; j++) if (b[i + j] !== m[j]) continue outer; return true; }
    return false;
  }
  // Windows-1252 punctuation that isn't plain Latin-1
  const CP1252 = { 0x20ac:0x80,0x201a:0x82,0x0192:0x83,0x201e:0x84,0x2026:0x85,0x2020:0x86,0x2021:0x87,
    0x02c6:0x88,0x2030:0x89,0x0160:0x8a,0x2039:0x8b,0x0152:0x8c,0x017d:0x8e,0x2018:0x91,0x2019:0x92,
    0x201c:0x93,0x201d:0x94,0x2022:0x95,0x2013:0x96,0x2014:0x97,0x02dc:0x98,0x2122:0x99,0x0161:0x9a,
    0x203a:0x9b,0x0153:0x9c,0x017e:0x9e,0x0178:0x9f };
  function rtfEscape(s) {
    let o = "";
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      if (ch === "\\" || ch === "{" || ch === "}") o += "\\" + ch;
      else if (ch === "\n") o += "\\line ";
      else if (cp < 128) o += ch;
      else {
        let byte = null;
        if (cp >= 0xa0 && cp <= 0xff) byte = cp;
        else if (CP1252[cp] != null) byte = CP1252[cp];
        if (byte == null) o += "?";
        else o += "\\'" + byte.toString(16).padStart(2, "0");
      }
    }
    return o;
  }
  const CTRL = /(?:\s|\\[a-zA-Z]+-?\d* ?)*/y;
  function rtfSplit(blob) {
    const t = fromLatin1(blob);
    const i = t.lastIndexOf("\\cf2");
    if (i < 0) return null;
    let j = i + 4;
    CTRL.lastIndex = j;
    const m = CTRL.exec(t);
    const textStart = m ? CTRL.lastIndex : j;
    return [t.slice(0, textStart), "}"];
  }

  // ---------------- tree helpers ----------------
  const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
  function isBytes(v) { return v instanceof Uint8Array; }
  function cloneField(f) {
    if (f.wt === 2 && Array.isArray(f.val)) return F(f.num, f.wt, f.val.map(cloneField));
    return F(f.num, f.wt, isBytes(f.val) ? f.val.slice() : f.val);
  }
  function newUuid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID().toUpperCase();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0, v = c === "x" ? r : (r & 0x3 | 0x8); return v.toString(16);
    }).toUpperCase();
  }
  function remapUuids(field) {
    const map = {};
    (function visit(fields) {
      for (const f of fields) {
        if (f.wt === 2 && isBytes(f.val)) {
          const t = fromLatin1(f.val);
          if (UUID_RE.test(t)) { if (!map[t]) map[t] = newUuid(); f.val = toLatin1(map[t]); }
        } else if (f.wt === 2 && Array.isArray(f.val)) visit(f.val);
      }
    })(field.val);
    return map;
  }
  function fieldBytes(f) {
    // Raw bytes even if the parser decoded a scalar as a sub-message (UUID strings
    // can look like valid protobuf).
    if (isBytes(f.val)) return f.val;
    if (Array.isArray(f.val)) return serialize(f.val);
    return new Uint8Array(0);
  }
  function cueId(cue) {
    for (const f of cue.val) if (f.num === 1 && Array.isArray(f.val))
      for (const g of f.val) if (g.num === 1 && g.wt === 2) return fromLatin1(fieldBytes(g));
    return null;
  }
  function allRtf(field, out) {
    if (field.wt === 2 && isBytes(field.val)) { if (startsWithRtf(field.val)) out.push(field); }
    else if (field.wt === 2 && Array.isArray(field.val)) for (const g of field.val) allRtf(g, out);
  }
  function findRtf(field) {
    const b = []; allRtf(field, b);
    for (const x of b) if (containsCf2(x.val)) return x;
    return b.length ? b[0] : null;
  }
  function hasTextRtf(cue) { const b = []; allRtf(cue, b); return b.some(x => containsCf2(x.val)); }
  function holdsRtfDirectly(msg) {
    return msg.some(h => h.num === 5 && h.wt === 2 && isBytes(h.val) && startsWithRtf(h.val));
  }
  function stripTextElements(field) {
    // Remove the whole text-box element (frame + text object) so a blank slide
    // is truly empty. The element is the node whose direct child is the text object.
    if (!(field.wt === 2 && Array.isArray(field.val))) return;
    field.val = field.val.filter(f => {
      if (f.wt === 2 && Array.isArray(f.val) &&
          f.val.some(g => g.wt === 2 && Array.isArray(g.val) && holdsRtfDirectly(g.val)))
        return false;                      // drop the entire element
      stripTextElements(f);
      return true;
    });
  }
  function clearCaps(fields) {
    // Remove capitalization so text renders as written: the base capitalization
    // (Attributes field 2) and every per-run custom_attributes override (Attributes
    // field 13) that carries its own capitalization (field 2). custom_attributes are
    // nested inside the Attributes message (field 3 of Text), not at the Text level.
    const isText = fields.some(f => f.num === 5 && f.wt === 2 && isBytes(f.val) && startsWithRtf(f.val));
    if (isText) for (const f of fields) {
      if (f.num === 3 && f.wt === 2 && Array.isArray(f.val)) {
        f.val = f.val.filter(g => {
          if (g.num === 2 && g.wt === 0) return false;                       // base capitalization
          if (g.num === 13 && g.wt === 2 && Array.isArray(g.val) && g.val.some(h => h.num === 2))
            return false;                                                     // a capitalization run
          return true;
        });
      }
    }
    for (const f of fields) if (f.wt === 2 && Array.isArray(f.val)) clearCaps(f.val);
  }
  function setText(cue, text) {
    const leaf = findRtf(cue); if (!leaf) return false;
    const parts = rtfSplit(leaf.val); if (!parts) return false;
    leaf.val = toLatin1(parts[0] + rtfEscape(text) + parts[1]);
    return true;
  }
  function entryUuid(e) {
    if (e.num !== 2 || !Array.isArray(e.val)) return null;
    for (const h of e.val) if (h.num === 1 && h.wt === 2) return fromLatin1(fieldBytes(h));
    return null;
  }
  function orderList(tree) {
    const ids = new Set(tree.filter(f => f.num === 13).map(cueId));
    let best = null, bestN = -1;
    for (const f of tree) if (f.num === 12 && Array.isArray(f.val)) {
      const n = f.val.filter(e => ids.has(entryUuid(e))).length;
      if (n > bestN) { bestN = n; best = f; }
    }
    return best;
  }
  function orderEntryFor(ol, cid) { for (const e of ol.val) if (entryUuid(e) === cid) return e; return null; }
  function makeOrderEntry(proto, cid) {
    const e = cloneField(proto);
    for (const h of e.val) if (h.num === 1 && h.wt === 2) h.val = toLatin1(cid);
    return e;
  }

  // ---------------- strip backgrounds (port of make_slides.strip_backgrounds) ----------------
  const MEDIA_EXT = [".mp4", ".mov", ".png", ".jpg", ".jpeg", ".m4v", ".heic"];
  function endsWithMedia(b) { const t = fromLatin1(b).toLowerCase(); return MEDIA_EXT.some(x => t.endsWith(x)); }
  function stripBackgrounds(tree) {
    let removed = 0;
    for (const cue of tree) {
      if (cue.num !== 13 || !Array.isArray(cue.val)) continue;
      const nc = [];
      for (const f of cue.val) {
        if (f.num === 2 && f.wt === 2 && isBytes(f.val) && endsWithMedia(f.val)) { f.val = new Uint8Array(0); removed++; nc.push(f); continue; }
        if (f.num === 10 && Array.isArray(f.val)) {
          if (f.val.some(g => g.num === 20)) { removed++; continue; }   // media action
          f.val = f.val.filter(g => !(g.num === 3 && g.wt === 2));      // background reference
        }
        nc.push(f);
      }
      cue.val = nc;
    }
    return removed;
  }

  // ---------------- element builder ----------------
  function buildElement(templateBytes, chunks, introHint, name, leadingBlank, blanksBefore, blankAfterEach) {
    blanksBefore = blanksBefore || new Set();
    const tree = parse(templateBytes);
    if (name) for (const f of tree) if (f.num === 3 && f.wt === 2) { f.val = toLatin1(name); break; }
    const cues = tree.filter(f => f.num === 13);
    const ol = orderList(tree);
    const orderedIds = ol.val.map(entryUuid).filter(Boolean);
    const byId = {}; for (const c of cues) byId[cueId(c)] = c;

    let introCue = null, proto = null;
    for (const cid of orderedIds) {
      const c = byId[cid]; if (!c) continue;
      const leaf = findRtf(c); const txt = leaf ? fromLatin1(leaf.val) : "";
      if (introHint && introCue === null && txt.toLowerCase().includes(introHint.toLowerCase())) introCue = c;
      else if (proto === null && hasTextRtf(c)) proto = c;
    }
    if (!proto) proto = cues.find(hasTextRtf);
    const protoEntry = orderEntryFor(ol, cueId(proto));

    const newCues = [], newOrder = [ol.val[0]];
    const makeBlank = () => { const c = cloneField(proto); remapUuids(c); stripTextElements(c); return c; };
    const push = (cue, entry) => { newCues.push(cue); newOrder.push(entry || makeOrderEntry(protoEntry, cueId(cue))); };
    if (leadingBlank) push(makeBlank());
    if (introCue) push(introCue, orderEntryFor(ol, cueId(introCue)));
    chunks.forEach((ch, k) => {
      if (blanksBefore.has(k)) push(makeBlank());
      const c = cloneField(proto); remapUuids(c); setText(c, ch); push(c);
      if (blankAfterEach) push(makeBlank());
    });
    ol.val = newOrder;
    for (const c of newCues) clearCaps(c.val);   // render exactly as written

    const result = []; let inserted = false;
    for (const f of tree) {
      if (f.num === 13) { if (!inserted) { result.push(...newCues); inserted = true; } }
      else result.push(f);
    }
    let out = serialize(result);
    const t2 = parse(out); stripBackgrounds(t2); out = serialize(t2);
    return out;
  }

  // ---------------- docx -> paragraphs ----------------
  async function docxParagraphs(arrayBuffer, JSZipRef) {
    const zip = await JSZipRef.loadAsync(arrayBuffer);
    const xml = await zip.file("word/document.xml").async("string");
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const paras = [];
    const pEls = doc.getElementsByTagNameNS(W, "p");
    for (const p of pEls) {
      let text = "";
      (function walk(node) {
        for (const ch of node.childNodes) {
          if (ch.nodeType !== 1) continue;
          const ln = ch.localName;
          if (ln === "t") text += ch.textContent;
          else if (ln === "br" || ln === "cr") text += "\n";
          else if (ln === "tab") text += "\t";
          else walk(ch);
        }
      })(p);
      const t = text.trim();
      if (t) paras.push(t);
    }
    return paras;
  }

  // ---------------- liturgy parsing + chunkers ----------------
  const HEADINGS = { "call to worship": "call_to_worship", "prayer of confession": "confession",
    "assurance of pardon": "assurance", "prayer of illumination": "illumination" };
  const SCRIPT_REF = /(psalm|psalms|lesson|\b[1-3]?\s?[A-Z][a-z]+\s+\d+:\d+)/i;
  const TRANSLATION = /\b(CEB|NIV|ESV|NRSV|KJV|NLT|MSG|NASB|RSV)\b/;
  function isScriptureHeading(t) {
    if (t.length > 60) return false;
    return SCRIPT_REF.test(t) && (TRANSLATION.test(t) || t.includes(":") || /lesson/i.test(t));
  }
  function parseLiturgy(paras) {
    const sections = {}, scriptures = [];
    let cur = null;
    for (const t of paras) {
      const low = t.toLowerCase().replace(/:$/, "");
      if (HEADINGS[low]) { const k = HEADINGS[low]; sections[k] = sections[k] || []; cur = sections[k]; continue; }
      if (isScriptureHeading(t)) { scriptures.push([t, []]); cur = scriptures[scriptures.length - 1][1]; continue; }
      if (cur) cur.push(t);
    }
    return { sections, scriptures };
  }
  function parseSermon(paras, clusterWords) {
    // Returns {texts, blanks}: a blank precedes a slide when >= clusterWords of
    // preaching separates it from the previous slide. clusterWords=0 disables.
    const re = /^\s*SLIDE\s*\d+\s*-\s*(.+)$/i;
    const texts = [], blanks = new Set(); let buf = 0;
    for (const t of paras) {
      const m = t.match(re);
      if (m) {
        if (texts.length && clusterWords && buf >= clusterWords) blanks.add(texts.length);
        texts.push(m[1].trim()); buf = 0;
      } else buf += t.split(/\s+/).filter(Boolean).length;
    }
    return { texts, blanks };
  }
  function sentencePack(text, maxlen) {
    const sents = (text.match(/[^.!?]*[.!?]+|\S[^.!?]*$/g) || []).map(s => s.trim()).filter(Boolean);
    const out = []; let cur = "";
    for (const s of sents) {
      if (cur && cur.length + 1 + s.length > maxlen) { out.push(cur); cur = s; }
      else cur = (cur + " " + s).trim();
    }
    if (cur) out.push(cur);
    return out;
  }
  function chunkProse(paras, maxlen) { const o = []; for (const p of (paras || [])) o.push(...sentencePack(p, maxlen)); return o; }

  function cleanRef(ref) { return ref.replace(/^\s*(nt|ot)\s+lesson\s*[-–:]*\s*/i, "").trim(); }

  // Parse pasted Bible-Gateway text into [{n, text}]. Robust to the reference
  // header, section headings and footnotes: it keeps the longest run of
  // consecutive verse numbers, so stray numbers (like "James 3") are ignored.
  function parseScripture(raw) {
    let text = raw.split(/\n\s*(?:Footnotes|Cross references)\b/i)[0]; // drop footnote tail
    text = text.replace(/\[[A-Za-z0-9]+\]/g, " ");                      // footnote markers [a]
    // keep newlines: they, and sentence punctuation, mark a real verse boundary
    const BOUND = new Set([".", "?", "!", ":", ";", '"', "”", "’", "'", ")", "]", "\n"]);
    const re = /(\d{1,3})(?=\s*["“'(A-Za-z])/g;
    const cands = []; let m;
    while ((m = re.exec(text))) {
      let k = m.index - 1; while (k >= 0 && text[k] === " ") k--;      // preceding non-space char
      const boundary = k < 0 || BOUND.has(text[k]);
      cands.push({ n: parseInt(m[1], 10), s: m.index, e: m.index + m[1].length, boundary });
    }
    // longest ascending-consecutive run, preferring boundary candidates
    function longestRun(list) {
      let best = [];
      for (let i = 0; i < list.length; i++) {
        const run = [list[i]]; let exp = list[i].n + 1;
        for (let j = i + 1; j < list.length; j++) if (list[j].n === exp) { run.push(list[j]); exp++; }
        if (run.length > best.length) best = run;
      }
      return best;
    }
    let best = longestRun(cands.filter(c => c.boundary));
    if (best.length < 2) best = longestRun(cands);                     // fallback if no punctuation
    const verses = [];
    for (let i = 0; i < best.length; i++) {
      const start = best[i].e, end = i + 1 < best.length ? best[i + 1].s : text.length;
      const t = text.slice(start, end).replace(/\s+/g, " ").trim();
      if (t) verses.push({ n: best[i].n, text: t });
    }
    return verses;
  }

  // Build a scripture .pro from pasted text: one verse per slide, verse number
  // prefixed, with a leading blank.
  function buildScripture(templateBytes, rawText, name) {
    const verses = parseScripture(rawText);
    const slides = verses.map(v => v.n + " " + v.text);
    return { bytes: buildElement(templateBytes, slides, null, name || "Scripture Reading", true, null), count: slides.length };
  }

  // Build every element from parsed docs. opts: {prayerMax, ctwMax}
  function generateAll(liturgyParas, sermonParas, templates, opts) {
    opts = opts || {};
    const prayerMax = opts.prayerMax || 200;
    const lead = opts.leadingBlank !== false;               // leading blank on by default
    const clusterWords = opts.clusterWords != null ? opts.clusterWords : 150;
    const { sections, scriptures } = parseLiturgy(liturgyParas);
    const files = [];
    const ctw = sections.call_to_worship || [];
    if (ctw.length) files.push({ name: "Call to Worship.pro",
      bytes: buildElement(templates.confession, ctw.slice(), null, "Call to Worship", lead, null) });
    let conf = chunkProse(sections.confession, prayerMax).concat(chunkProse(sections.assurance, prayerMax));
    if (conf.length) files.push({ name: "Prayer of Confession.pro",
      bytes: buildElement(templates.confession, conf, "Join us", "Prayer of Confession", lead, null) });
    if (sermonParas && sermonParas.length) {
      const afterEach = opts.blankAfterEach === true;
      const { texts, blanks } = parseSermon(sermonParas, afterEach ? 0 : clusterWords);
      if (texts.length) files.push({ name: "Sermon.pro",
        bytes: buildElement(templates.sermon, texts, null, "Sermon", lead, blanks, afterEach) });
    }
    const nt = scriptures.find(s => /lesson/i.test(s[0]));
    const scriptureRef = nt ? cleanRef(nt[0]) : (scriptures.length ? cleanRef(scriptures[0][0]) : null);
    return { files, scriptureRef };
  }

  root.WS = { parse, serialize, buildElement, stripBackgrounds, docxParagraphs, parseLiturgy,
    parseSermon, generateAll, parseScripture, buildScripture, cueId, findRtf, orderList,
    entryUuid, rtfSplit, fromLatin1 };
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));

if (typeof module !== "undefined" && module.exports) module.exports = (typeof globalThis !== "undefined" ? globalThis : this).WS;
