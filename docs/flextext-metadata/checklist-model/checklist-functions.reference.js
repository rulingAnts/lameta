// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// REFERENCE EXTRACT — not imported by the app. These are the pure functions of Seth's corpus checklist
// (a single-page app kept in a private repository), copied verbatim on 2026-10-09 so this fork can
// port them to a TypeScript module (docs/flextext-metadata/PLAN.md §4). They read a global `S.data`
// (the dataset) and `S.targetId` (the selected target), and constants such as DONE / IN_PROGRESS
// that the original defines elsewhere: the port makes the dataset and target PARAMETERS.
// The seed these operate on is ./seed.json (seedVersion 3).

const FX_DONE_BAR = 0.95;    // ≥95% of the units carrying a line counts as done

function stepState(t, id){
  const v = t.steps ? t.steps[id] : undefined;
  if (v === true) return DONE;
  if (v === false || v === undefined || v === null) return NOT_STARTED;
  return Number(v) || NOT_STARTED;
}

const isDone = (t, id) => stepState(t, id) === DONE;
const isPart = (t, id) => stepState(t, id) === IN_PROGRESS;
function ensureDefinitions(d){
  // An import may legitimately carry only `texts` — nobody should have to
  // reproduce the genre tree by hand. Backfill anything missing from the seed.
  const filled = [];
  for (const k of ['steps','genres','facets','targets']){
    if (!Array.isArray(d[k]) || !d[k].length){ d[k] = structuredClone(SEED[k]); filled.push(k); }
  }
  if (!d.project) d.project = { language:'', iso:'', variety:'', wordsPerPage:250 };
  if (!d.checklistState) d.checklistState = {};
  if (!Array.isArray(d.people)) d.people = [];
  if (!Array.isArray(d.customFields)) d.customFields = [];
  if (!Array.isArray(d.stimuli)) d.stimuli = structuredClone(SEED.stimuli || []);
  if (!d.ui) d.ui = {};
  for (const t of d.texts || []){
    if (t.speakerId && !t.authorId){ t.authorId = t.speakerId; delete t.speakerId; }
  }
  if (typeof d.seedVersion !== 'number') d.seedVersion = SEED.seedVersion;
  for (const t of d.texts || []){
    t.genres = Array.isArray(t.genres) ? t.genres : [];
    t.facets = t.facets || {};
    t.satisfies = Array.isArray(t.satisfies) ? t.satisfies : [];
    t.steps = t.steps || {};
    t.custom = t.custom || {};
    if (!t.status) t.status = 'active';
    if (!t.id) t.id = uid();
  }
  return filled;
}

function migrateSteps(d){
  let changed = false;
  for (const t of d.texts || []){
    if (!t.steps) { t.steps = {}; continue; }
    for (const k of Object.keys(t.steps)){
      const v = t.steps[k];
      if (v === true) { t.steps[k] = DONE; changed = true; }
      else if (v === false) { delete t.steps[k]; changed = true; }
    }
  }
  return changed;
}

function blankData(name){
  return {
    schemaVersion: 1,
    seedVersion: SEED.seedVersion,
    name: name || 'Corpus record',
    updatedAt: new Date().toISOString(),
    project: { language:'', iso:'', variety:'', wordsPerPage:250 },
    steps: structuredClone(SEED.steps),
    genres: structuredClone(SEED.genres),
    facets: structuredClone(SEED.facets),
    targets: structuredClone(SEED.targets),
    texts: [],
    checklistState: {}
  };
}

function qTokenize(src){
  const out = []; let i = 0;
  const isWord = c => /[^\s()]/.test(c);
  while (i < src.length){
    const c = src[i];
    if (/\s/.test(c)){ i++; continue; }
    if (c === '(' || c === ')'){ out.push({t:c}); i++; continue; }
    let buf = '', quoted = false;
    while (i < src.length && (quoted || isWord(src[i]))){
      const ch = src[i];
      if (ch === '"'){ quoted = !quoted; i++; continue; }
      if (ch === '/' && !quoted){                 // /regex/flags — may contain spaces
        let j = i + 1, esc = false;
        while (j < src.length && (esc || src[j] !== '/')){ esc = !esc && src[j] === '\\'; j++; }
        if (j < src.length){
          let k = j + 1; while (k < src.length && /[a-z]/i.test(src[k])) k++;
          buf += src.slice(i, k); i = k; continue;
        }
      }
      buf += ch; i++;
    }
    if (!buf) { i++; continue; }
    const up = buf.toUpperCase();
    if (up === 'AND' || buf === '&&') out.push({t:'AND'});
    else if (up === 'OR' || buf === '||') out.push({t:'OR'});
    else if (up === 'NOT' || buf === '!') out.push({t:'NOT'});
    else out.push({t:'W', v:buf});
  }
  return out;
}

function qFieldValue(t, name){
  switch ((name||'').toLowerCase()){
    case 'genre': case 'tag':        return (t.genres || []).join(' ');
    case 'author': case 'narrator':  return personName(t.authorId);
    case 'transcriber':              return personName(t.transcriberId);
    case 'translator': case 'backtranslator': case 'back-translator':
                                     return personName(t.backTranslatorId);
    case 'person': case 'name':      return ROLES.map(([k]) => personName(t[k])).join('').trim();
    case 'source':                   return (t.facets || {}).source || '';
    case 'stimulus': case 'prompt':  return (t.facets || {}).stimulus || '';
    case 'status':                   return t.status || '';
    case 'title':                    return `${t.title || ''}${t.titleLwc || ''}`;
    case 'abbrev':                   return t.abbrev || '';
    case 'notes':                    return t.notes || '';
    case 'date': case 'year':        return t.date || t.year || '';
    case 'words':                    return t.wordCount == null ? '' : String(t.wordCount);
    case 'sent': case 'sentences':   return t.sentenceCount == null ? '' : String(t.sentenceCount);
    case 'speaker':                  return personName(t.authorId);
    case 'titlelwc': case 'title-lwc': return t.titleLwc || '';
    case 'village':                  return t.village || '';
    case 'purpose':                  return t.purpose || '';
    case 'elicitation':              return t.elicitation || '';
    case 'audience':                 return [t.audienceType, t.audienceSize, t.audienceResponse]
                                              .filter(v => v != null && v !== '').join(' ');
    case 'duration':                 return t.durationSec == null ? '' : String(t.durationSec);
    case 'archiveid': case 'archive':return t.archiveId || '';
    case 'datatype':                 return t.dataType || '';
    case 'primary': case 'primarygenre': return t.primaryGenre || '';
    case 'satisfies':                return (t.satisfies || []).join(' ');
    case 'consenthold': case 'hold': return t.consentHold ? (t.consentHold.reason || 'held') : '';
    default: {
      // Facets are user-definable, so resolve by name at query time: this makes
      // modality:, addressee:, medium:, access: and anything added later work
      // without touching the parser.
      const want = (name || '').toLowerCase();
      const cf = customFields().find(x => x.id.toLowerCase() === want || cfSlug(x) === want);
      if (cf) return cfText(t, cf);
      const f = (S.data.facets || []).find(x => x.id.toLowerCase() === (name||'').toLowerCase());
      if (f) return (t.facets || {})[f.id] || '';
      return '';
    }
  }
}

function qClause(word){
  const c = word.indexOf(':');
  if (c < 0){                                    // bare word — search the obvious text
    const m = qMatcher(word);
    return t => m.test([t.title, t.titleLwc, t.abbrev, t.notes,
      personName(t.authorId), personName(t.transcriberId), personName(t.backTranslatorId)].join(' '));
  }
  const field = word.slice(0, c).toLowerCase(), val = word.slice(c + 1);

  // empty:author  ·  none:stimulus  ·  any:transcriber
  if (field === 'empty' || field === 'none' || field === 'unset') return t => qIsEmpty(t, val);
  if (field === 'any' || field === 'has')                          return t => !qIsEmpty(t, val);

  // A bare "author:" used to compile to an empty regex, which matches every
  // text — useless, and quietly wrong. Read it as "has any value" instead.
  const VALUELESS = new Set(['untagged','held','natural','prompted']);
  if (val === '' && !VALUELESS.has(field)) return t => !qIsEmpty(t, field);

  const numeric = (get) => {
    const m = val.match(/^(>=|<=|>|<|=)?\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) return () => false;
    const op = m[1] || '=', n = Number(m[2]);
    return t => { const v = Number(get(t)); if (Number.isNaN(v)) return false;
      return op === '>' ? v > n : op === '<' ? v < n : op === '>=' ? v >= n
           : op === '<=' ? v <= n : v === n; };
  };

  switch (field){
    case 'genre': case 'tag': {
      const node = G.byId().get(val);
      if (node){ const sub = G.subtree(val); return t => (t.genres||[]).some(g => sub.has(g)); }
      const m = qMatcher(val);                   // otherwise match id or label, incl. subtree
      const ids = S.data.genres.filter(g => m.test(g.id) || m.test(g.label)).map(g => g.id);
      const all = new Set(ids.flatMap(id => [...G.subtree(id)]));
      return t => (t.genres||[]).some(g => all.has(g));
    }
    case 'untagged': return t => !(t.genres||[]).length;
    case 'step': case 'state': {
      const [id, want] = val.split(/(?:!=|=)/);
      const neg = val.includes('!=');
      const wantState = want === undefined ? 2 : Q_STATE[String(want).toLowerCase()];
      const m = qMatcher(id);
      const ids = S.data.steps.filter(st => m.test(st.id) || m.test(st.label)).map(st => st.id);
      if (!ids.length) return () => false;
      return t => { const hit = ids.some(k => stepState(t, k) === wantState); return neg ? !hit : hit; };
    }
    case 'author': case 'narrator':    { const m = qMatcher(val); return t => m.test(personName(t.authorId)); }
    case 'transcriber':                { const m = qMatcher(val); return t => m.test(personName(t.transcriberId)); }
    case 'translator': case 'backtranslator': case 'back-translator':
                                       { const m = qMatcher(val); return t => m.test(personName(t.backTranslatorId)); }
    case 'person': case 'name':        { const m = qMatcher(val);
      return t => ROLES.some(([k]) => m.test(personName(t[k]))); }
    case 'source':                     { const m = qMatcher(val); return t => m.test((t.facets||{}).source || ''); }
    case 'stimulus': case 'prompt':    { const m = qMatcher(val);
      return t => m.test(stimulusLabel((t.facets||{}).stimulus)) || m.test((t.facets||{}).stimulus || ''); }
    case 'natural':                    return t => /natural/i.test((t.facets||{}).source || '');
    case 'prompted':                   return t => /prompt|elicit/i.test((t.facets||{}).source || '');
    case 'status':                     { const m = qMatcher(val); return t => m.test(t.status || 'active'); }
    case 'title':                      { const m = qMatcher(val); return t => m.test(`${t.title||''} ${t.titleLwc||''}`); }
    case 'abbrev':                     { const m = qMatcher(val); return t => m.test(t.abbrev || ''); }
    case 'notes':                      { const m = qMatcher(val); return t => m.test(t.notes || ''); }
    case 'date': case 'year':          { const m = qMatcher(val); return t => m.test(`${t.date||''} ${t.year||''}`); }
    case 'words':                      return numeric(t => t.wordCount);
    case 'sent': case 'sentences':     return numeric(t => t.sentenceCount);
    case 'held':                       return t => !!t.consentHold;
    case 'facet': {                    // facet:modality=Dialogue
      const [fk, fv] = val.split('=');
      const m = qMatcher(fv ?? '');
      return t => Object.entries(t.facets || {}).some(([k, v]) =>
        k.toLowerCase() === (fk||'').toLowerCase() && (fv === undefined || m.test(v)));
    }
    default: {
      // a facet id, a user's own field, or anything else qFieldValue knows
      // about, matches directly. Custom fields have to be listed here as well as
      // in qFieldValue: empty:/any: go through qFieldValue alone, but a
      // value match lands here, and an unlisted field is quietly demoted to a
      // full-text search that can never match.
      const known = (S.data.facets || []).some(x => x.id.toLowerCase() === field)
        || customFields().some(x => x.id.toLowerCase() === field || cfSlug(x) === field)
        || ['titlelwc','village','purpose','elicitation','audience','duration',
            'archiveid','archive','datatype','primary','primarygenre','satisfies',
            'consenthold','hold'].includes(field);
      if (known){ const m = qMatcher(val); return t => m.test(qFieldValue(t, field)); }
      const m = qMatcher(word);                  // otherwise treat the whole token as text
      return t => m.test([t.title, t.abbrev, t.notes].join(' '));
    }
  }
}

function qParse(src){
  const tk = qTokenize(src); let i = 0;
  const peek = () => tk[i];
  function factor(){
    if (peek() && peek().t === 'NOT'){ i++; const f = factor(); return t => !f(t); }
    if (peek() && peek().t === '('){ i++; const e = expr();
      if (peek() && peek().t === ')') i++; else throw new Error('missing )');
      return e; }
    const w = tk[i++]; if (!w || w.t !== 'W') throw new Error('unexpected ' + (w ? w.t : 'end'));
    return qClause(w.v);
  }
  function term(){
    let left = factor();
    while (peek() && (peek().t === 'W' || peek().t === '(' || peek().t === 'AND' || peek().t === 'NOT')){
      if (peek().t === 'AND') i++;
      if (!peek() || peek().t === 'OR' || peek().t === ')') break;
      const right = factor(); const l = left; left = t => l(t) && right(t);
    }
    return left;
  }
  function expr(){
    let left = term();
    while (peek() && peek().t === 'OR'){ i++; const right = term(); const l = left; left = t => l(t) || right(t); }
    return left;
  }
  if (!tk.length) return null;
  const fn = expr();
  if (i < tk.length) throw new Error('unexpected ' + (tk[i].v || tk[i].t));
  return fn;
}

const cfSlug  = f => String(f.label || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const cfValue = (t, f) => (t.custom || {}

const G = {
  byId(){ const m = new Map(); for (const g of S.data.genres) m.set(g.id, g); return m; },
  children(id){ return S.data.genres.filter(g => g.parent === id); },
  roots(){ return S.data.genres.filter(g => g.parent === null); },
  subtree(id){ const out = new Set([id]); const walk = p => G.children(p).forEach(c => { out.add(c.id); walk(c.id); }); walk(id); return out; },
  depth(g){ let d = 0, cur = g; const m = G.byId(); while (cur && cur.parent){ d++; cur = m.get(cur.parent); } return d; },
  ordered(){ // depth-first, stable
    const out = []; const walk = (p, d) => G.children(p).forEach(c => { out.push([c, d]); walk(c.id, d+1); });
    G.roots().forEach(r => { out.push([r, 0]); walk(r.id, 1); }); return out;
  }
};

function textsIn(genreId){
  const sub = G.subtree(genreId);
  return S.data.texts.filter(t => t.status !== 'withdrawn' && t.genres.some(g => sub.has(g)));
}

const hasAll = (t, steps) => (steps || []).every(s => isDone(t, s));

function inScope(t, scope){
  if (!scope) return true;
  if (scope.genre){ const sub = G.subtree(scope.genre); if (!t.genres.some(g => sub.has(g))) return false; }
  if (scope.minSentences && !(Number(t.sentenceCount) >= scope.minSentences)) return false;
  return true;
}

function requiredSteps(){
  const set = new Set();
  for (const r of target().rules || []) (r.requiredSteps || []).forEach(s => set.add(s));
  return set;
}

function visibleSteps(){
  const req = requiredSteps();
  return S.data.steps
    .filter(s => !s.hidden || req.has(s.id))
    .sort((a,b) => a.order - b.order);
}

function stepLabel(s){
  const a = s.aliases && s.aliases[target().id];
  return a || s.label;
}

function evalRule(r){
  const req = r.requiredSteps || [];
  if (r.kind === 'count'){
    const pool = activeTexts().filter(t => inScope(t, r.scope));
    const n = pool.filter(t => req.length ? hasAll(t, req) : true).length;
    return { kind:'count', n, min:r.min, met: r.min == null ? n > 0 : n >= r.min,
             text: r.min == null ? `${n} texts` : `${n} / ${r.min}` };
  }
  if (r.kind === 'eachChild'){
    const nodes = (r.childrenOfRoots ? G.roots().flatMap(x => G.children(x.id)) : G.children(r.childrenOf))
      .filter(g => !r.onlyIfOccurs || g.occurs !== false);
    const rows = nodes.map(g => {
      const n = textsIn(g.id).filter(t => req.length ? hasAll(t, req) : true).length;
      return { g, n, ok: n >= r.minEach };
    });
    const met = rows.filter(x => x.ok).length;
    return { kind:'eachChild', rows, min:r.minEach, met: met === rows.length && rows.length > 0,
             text: `${met} of ${rows.length} genres met` };
  }
  if (r.kind === 'named'){
    // A named requirement is satisfied by whatever the user could actually
    // record: the stimulus facet (the natural way to say "this IS the Pear
    // Film"), the item's stated alternatives, a matching title, or an explicit
    // satisfies[] link. Matching only on satisfies[] made the rule unreachable,
    // because nothing in the interface sets that field.
    const rows = (r.items || []).slice().sort((a,b)=>a.order-b.order).map(it => {
      const label = (it.label || '').toLowerCase();
      const alts  = (it.alternatives || []).map(a => a.toLowerCase());
      // Rank candidates rather than taking the first hit: an exact stimulus
      // must beat a stated alternative, or asking for 2a would happily settle
      // for the 1a sitting earlier in the list.
      const rank = x => {
        if ((x.satisfies || []).includes(it.id)) return [0, 'linked'];
        const stim = (x.facets || {}).stimulus;
        if (stim){
          const sl = stimulusLabel(stim).toLowerCase();
          if (stim === it.id || sl === label) return [1, null];
          if (alts.includes(sl)) return [2, stimulusLabel(stim)];
        }
        const ti = (x.title || '').toLowerCase();
        if (ti && label && ti.includes(label)) return [3, 'title'];
        const ai = alts.findIndex(a => ti && ti.includes(a));
        if (ai >= 0) return [4, it.alternatives[ai]];
        return null;
      };
      let t = null, via = null, bestRank = Infinity;
      for (const x of activeTexts()){
        const r2 = rank(x);
        if (r2 && r2[0] < bestRank){ bestRank = r2[0]; t = x; via = r2[1]; if (bestRank === 0) break; }
      }
      return { it, t, via, done: !!t, steps: t ? req.filter(s => isDone(t, s)).length : 0 };
    });
    const met = rows.filter(x => x.done).length;
    return { kind:'named', rows, met: met === rows.length, text:`${met} / ${rows.length}` };
  }
  if (r.kind === 'coverage'){
    const rows = (r.items || []).map(id => {
      const g = G.byId().get(id);
      return { id, label: g ? genreLabel(g) : id, n: g ? textsIn(id).length : 0 };
    });
    const covered = rows.filter(x => x.n > 0).length;
    return { kind:'coverage', rows, met: r.min == null ? covered > 0 : covered >= r.min,
             text: `${covered} of ${rows.length} covered` };
  }
  if (r.kind === 'quantity'){
    const wpp = Number(S.data.project.wordsPerPage) || 250;
    const words = activeTexts().reduce((a,t) => a + (Number(t[r.field]) || 0), 0);
    const pages = Math.round(words / wpp);
    return { kind:'quantity', n:pages, min:r.min, words, met: r.min == null ? pages > 0 : pages >= r.min,
             text: r.min == null ? `${pages} ${r.unit}s` : `${pages} / ${r.min} ${r.unit}s`,
             sub: `${words.toLocaleString()} words ÷ ${wpp}` };
  }
  if (r.kind === 'checklist'){
    const st = S.data.checklistState || {};
    const rows = (r.items || []).map(it => ({ it, done: !!st[it.id] }));
    const met = rows.filter(x => x.done).length;
    return { kind:'checklist', rows, met: met === rows.length, text:`${met} / ${rows.length}` };
  }
  return { kind:'?', text:'—', met:false };
}

function quotaFor(genreId){
  let need = null;
  for (const r of target().rules || []){
    if (r.kind === 'eachChild'){
      const nodes = (r.childrenOfRoots ? G.roots().flatMap(x => G.children(x.id)) : G.children(r.childrenOf))
        .filter(g => !r.onlyIfOccurs || g.occurs !== false);
      if (nodes.some(g => g.id === genreId)) need = Math.max(need ?? 0, r.minEach);
    }
    if (r.kind === 'count' && r.scope && r.scope.genre === genreId && r.min != null)
      need = Math.max(need ?? 0, r.min);
  }
  return need;
}

function parseFlexText(xml){
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('That file is not valid XML.');
  const its = [...doc.getElementsByTagName('interlinear-text')];
  if (!its.length)
    throw new Error('No <interlinear-text> elements in that file, so it is not a FLExText export.');

  let vern = '';
  const declared = [...doc.getElementsByTagName('language')]
    .find(l => l.getAttribute('vernacular') === 'true');
  if (declared) vern = declared.getAttribute('lang') || '';

  // What the file actually contains, gathered before anything is interpreted.
  const has = { baseline:false, wordGloss:false, morphemes:false, morphGloss:false, freeTrans:false };
  const glossLangs = new Set(), ftLangs = new Set(), baselineLangs = new Set();

  const texts = its.map((it, i) => {
    const phrases = [...it.getElementsByTagName('phrase')];
    const words = [...it.getElementsByTagName('word')];
    const realWords = words.filter(w => fxKids(w,'txt').some(x => fxText(x)));
    realWords.forEach(w => fxKids(w,'txt').filter(fxText).forEach(x => baselineLangs.add(fxLang(x)||'?')));
    if (realWords.length) has.baseline = true;

    const perWord = realWords.map(w => {
      const gl = fxKids(w,'gls').filter(x => fxText(x));
      gl.forEach(x => { glossLangs.add(fxLang(x)||'?'); has.wordGloss = true; });
      const morphs = [...w.getElementsByTagName('morph')];
      if (morphs.length) has.morphemes = true;
      const mg = morphs.some(m => fxKids(m,'gls').some(x => fxText(x)));
      if (mg) has.morphGloss = true;
      return { glossLangs: gl.map(x => fxLang(x)||'?'), morphGlossed: mg };
    });
    const perPhrase = phrases.map(ph => {
      const g = fxKids(ph,'gls').filter(x => fxText(x));
      g.forEach(x => { ftLangs.add(fxLang(x)||'?'); has.freeTrans = true; });
      return { ftLangs: g.map(x => fxLang(x)||'?'),
               transcribed: [...ph.getElementsByTagName('word')]
                 .some(w => fxKids(w,'txt').some(x => fxText(x))) };
    });

    return {
      guid: it.getAttribute('guid') || '',
      title: fxPick(it,'title',vern) || `Untitled text ${i+1}`,
      titleLwc: (() => { const a = fxKids(it,'title').filter(x => fxText(x) && fxLang(x) !== vern);
                         return a.length ? fxText(a[0]) : ''; })(),
      abbrev: fxPick(it,'title-abbreviation',vern),
      source: fxPick(it,'source',vern),
      comment: fxPick(it,'comment',vern),
      wordCount: realWords.length,
      sentenceCount: phrases.length,
      perWord, perPhrase,
    };
  });
  return { vern, texts, has,
           langs: { baseline:[...baselineLangs], gloss:[...glossLangs], ft:[...ftLangs] } };
}

const fxCode = c => (c || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '').slice(0, 12) || 'x';

// Which pair of steps a given analysis writing system feeds.
function fxStepIds(code, role){
  if (role === 'lwc') return { gloss:'gloss-lwc', ft:'ft-lwc' };
  if (role === 'en')  return { gloss:'gloss-en',  ft:'ft-en'  };
  if (role === 'own'){ const c = fxCode(code); return { gloss:`gloss-${c}`, ft:`ft-${c}` }; }
  return null;                                   // 'ignore'
}

function fxExtraSteps(roles){
  return Object.entries(roles).filter(([, r]) => r === 'own').flatMap(([code]) => {
    const c = fxCode(code);
    return [{ id:`gloss-${c}`, label:`Gloss (${code})`, full:`Word gloss in ${code}` },
            { id:`ft-${c}`,    label:`FT (${code})`,    full:`Free translation in ${code}` }];
  });
}

function fxAddSteps(data, roles){
  const extra = fxExtraSteps(roles).filter(st => !data.steps.some(x => x.id === st.id));
  if (!extra.length) return [];
  let at = data.steps.findIndex(x => x.id === 'ft-en');
  at = at < 0 ? data.steps.length : at + 1;
  for (const st of extra) data.steps.splice(at++, 0, { ...st, hidden:false });
  data.steps.forEach((x, i) => { x.order = i; });
  return extra.map(x => x.id);
}

function fxSteps(t, roles){
  const steps = { flex: DONE };          // it came out of FLEx, so it is in FLEx
  const nw = t.perWord.length, np = t.perPhrase.length;
  // Two writing systems can be pointed at the same step; take the better of them.
  const set = (id, c) => {
    const v = c >= FX_DONE_BAR ? DONE : c > 0 ? IN_PROGRESS : NOT_STARTED;
    if (v && (steps[id] || NOT_STARTED) < v) steps[id] = v;
  };
  if (np) set('transcribe', t.perPhrase.filter(p => p.transcribed).length / np);
  for (const [code, role] of Object.entries(roles)){
    const ids = fxStepIds(code, role); if (!ids) continue;
    if (nw) set(ids.gloss, t.perWord.filter(w => w.glossLangs.includes(code)).length / nw);
    if (np) set(ids.ft,    t.perPhrase.filter(p => p.ftLangs.includes(code)).length / np);
  }
  if (nw) set('morph', t.perWord.filter(w => w.morphGlossed).length / nw);
  return steps;
}

function fxMatch(t, existing){
  if (t.guid){ const g = existing.find(x => x.flexGuid === t.guid); if (g) return g; }
  const a = fxNorm(t.abbrev);
  if (a){ const m = existing.find(x => fxNorm(x.abbrev) === a); if (m) return m; }
  const n = fxNorm(t.title);
  return n ? existing.find(x => fxNorm(x.title) === n) : undefined;
}

function fxApplyTo(target, t, roles){
  target.steps = target.steps || {};
  for (const [k, v] of Object.entries(fxSteps(t, roles)))
    if (stepState(target, k) < v) target.steps[k] = v;
  if (t.guid && !target.flexGuid) target.flexGuid = t.guid;
  for (const [k, v] of [['abbrev', t.abbrev], ['titleLwc', t.titleLwc],
                        ['wordCount', t.wordCount], ['sentenceCount', t.sentenceCount]])
    if (v !== '' && v != null && !target[k]) target[k] = v;
  const note = [t.source && `source: ${t.source}`, t.comment].filter(Boolean).join(' · ');
  if (note && !(target.notes || '').includes(note))
    target.notes = [target.notes, note].filter(Boolean).join('\n');
}
