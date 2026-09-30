/* ui/am-import.js - pipa impor XML Alight Motion (data-driven, tanpa renderer).
 *
 * Berkas ini TIDAK menggambar apa pun. Isinya murni pembacaan + normalisasi
 * XML jadi model kanonik, supaya lapisan UI bisa menampilkan ringkasan hasil
 * impor (ukuran, fps, durasi, jumlah layer/efek, apa yang tidak didukung)
 * tanpa menyentuh renderer maupun timeline.
 *
 * API (window.AMImport):
 *   importXML(text, nama)      -> { scene, report, project }
 *   importXMLSafe(text, nama)  -> { error } | { scene, report, project }
 *   assessText / assessProject -> ringkasan + capability tanpa proyek penuh
 *   normalizeProject / normalize-> model kanonik + pembantu normalisasi satuan
 *   report.format / summary / classify, formatTime, list
 *   scene / graftScene / graftLayer / graftEfek, internal
 *
 * Konvensi waktu (penting, tidak boleh dibalik):
 *   - startTime/endTime layer, totalTime scene  -> MILIDETIK
 *   - t pada <kf>                              -> DETIK di Alight Motion.
 *     Renderer memang memberi waktu dalam detik ke interpolator (lihat
 *     pemanggilan ((nowMs - layer.startTime) / 0x3e8) di bundel), jadi `t`
 *     tidak boleh diubah. Setiap kf menyimpan:
 *        t     -> apa adanya (dipakai renderer)
 *        rawT  -> nilai asli dari XML
 *        t     -> FRAKSI durasi elemen (0 = awal klip, 1 = akhir klip;
 *                 nilai bisa < 0 / > 1 bila animasi keluar dari klip)
 *        tMs   -> null kecuali durasi elemennya diketahui
 *        unit  -> "fraksi" (default) atau "ms" (hanya bila |t| >= 10000)
 *     Tidak ada resampling, tidak ada pengurutan ulang nilai.
 *
 * Blok di antara penanda CORE:BEGIN / CORE:END disalin PERSIS ke bundel studio
 * oleh tools/patch-app.js (bagian "C-IMPORT") supaya kedua sisi tidak pernah
 * berbeda.
 */
/* ==== AM-IMPORT-CORE:BEGIN ==== */
function amIModul() {
    'use strict';

    /* ============ 1. akses atribut & elemen (case-insensitive) ============ */
    var _peta = new WeakMap();

    function petaAt(el) {
        if (!el || typeof el.getAttribute !== 'function') return null;
        var p = _peta.get(el);
        if (p) return p;
        p = Object.create(null);
        var daftar = null, i, k;
        /* getAttributeNames() (DOM modern) lalu NamedNodeMap `attributes`
           (DOM lama / shim). Dua-duanya Opsional; kalau tidak ada, `at()`
           masih jatuh ke getAttribute satu-per-satu lewat pemanggil. */
        if (typeof el.getAttributeNames === 'function') {
            try { daftar = el.getAttributeNames(); } catch (e) { daftar = null; }
        }
        if (daftar) {
            for (i = 0; i < daftar.length; i++) {
                k = String(daftar[i]).toLowerCase();
                if (p[k] === undefined) p[k] = el.getAttribute(daftar[i]);
            }
        } else if (el.attributes) {
            var a = el.attributes;
            for (i = 0; i < a.length; i++) {
                k = String(a[i].name).toLowerCase();
                if (p[k] === undefined) p[k] = a[i].value;
            }
        }
        _peta.set(el, p);
        return p;
    }
    /* Pembaca atribut yang mengabaikan besar-kecil huruf. */
    function at(el, nama) {
        var p = petaAt(el);
        if (!p) return null;
        if (typeof nama === 'string') {
            var s = nama.toLowerCase();
            if (p[s] === undefined || p[s] === null) {
                var langsung = el.getAttribute(nama);
                return langsung === null || langsung === undefined ? null : langsung;
            }
            return p[s];
        }
        for (var i = 0; i < nama.length; i++) {
            var k = String(nama[i]).toLowerCase();
            if (p[k] !== undefined && p[k] !== null) return p[k];
            var v = el.getAttribute(nama[i]);
            if (v !== null && v !== undefined) return v;
        }
        return null;
    }
    /* Semua atribut apa adanya, kunci sudah lowercase. */
    function semuaAt(el) {
        var p = petaAt(el), o = {};
        if (!p) return o;
        for (var k in p) o[k] = p[k];
        return o;
    }
    function tagEl(el) { return el && el.tagName ? String(el.tagName) : ''; }
    function kids(el) { return el && el.children ? Array.prototype.slice.call(el.children) : []; }
    function anak(el, nama) {
        var want = String(nama).toLowerCase(), c = kids(el);
        for (var i = 0; i < c.length; i++) if (String(c[i].tagName || '').toLowerCase() === want) return c[i];
        return null;
    }
    function anakSemua(el, nama) {
        var want = String(nama).toLowerCase(), c = kids(el), out = [];
        for (var i = 0; i < c.length; i++) if (String(c[i].tagName || '').toLowerCase() === want) out.push(c[i]);
        return out;
    }
    /* Anak yang tagNYA tidak ada di daftar `dikenal`. */
    function anakLain(el, dikenal) {
        var c = kids(el), out = [];
        for (var i = 0; i < c.length; i++) {
            if (dikenal.indexOf(String(c[i].tagName || '').toLowerCase()) >= 0) continue;
            out.push(c[i]);
        }
        return out;
    }
    /* Pencarian hybrid: anak <nama value="..">  LALU  atribut <nama>/<namaValue>. */
    function nilai(el, nama, def) {
        var a = anak(el, nama);
        if (a) {
            var v = at(a, ['value', 'val']);
            if (v !== null) return v;
            var tc = a.textContent;
            if (tc !== null && String(tc).trim() !== '') return tc;
            return def;
        }
        var x = at(el, [nama, nama + 'Value']);
        return x === null ? def : x;
    }
    function potong(s, n) {
        s = String(s === null || s === undefined ? '' : s);
        return s.length > n ? s.slice(0, n) : s;
    }
    /* Simpan satu elemen mentah apa adanya (batas kedalaman & panjang teks). */
    function simpanAnak(el, dalam) {
        var o = { kind: 'element', tag: tagEl(el), attrs: semuaAt(el), text: potong(el.textContent || '', 4000), children: [] };
        var d = dalam || 0;
        if (d < 4) { var c = kids(el); for (var i = 0; i < c.length; i++) o.children.push(simpanAnak(c[i], d + 1)); }
        return o;
    }
    function simpanAtrib(el, nama, isi) {
        return { kind: 'attribute', name: nama, value: isi, tag: tagEl(el) };
    }
    function nol(n) { var a = []; for (var i = 0; i < n; i++) a.push(0); return a; }
    function kanalKosong(v) { return { value: (v || []).slice(), kfs: [] }; }
    /* ============ 2. normalizer skalar ============ */
    var RE_NUM = /^[-+]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][-+]?[0-9]+)?/;
    /* String angka (boleh diikuti karakter lain) -> number, atau `def`. */
    function num(v, def) {
        if (v === null || v === undefined) return def;
        if (typeof v === 'number') return isFinite(v) ? v : def;
        var s = String(v).trim();
        if (!s) return def;
        var m = RE_NUM.exec(s);
        if (!m) return def;
        var n = parseFloat(m[0]);
        return isFinite(n) ? n : def;
    }
    var RE_DURASI = /([0-9]*\.?[0-9]+)\s*(msec|milliseconds|ms|seconds|second|secs|sec|minutes|minute|min|menit|hours|hour|hr|jam|m|s)/gi;
    /* Durasi: angka polos = ms; yang bersatuan ("1m30s", "18.699s") dihitung.
       Bentuk jam "mm:ss" / "hh:mm:ss" juga diterima (detik). */
    function ms(v, def) {
        if (v === null || v === undefined) return def;
        var s = String(v).trim();
        if (!s) return def;
        if (s.indexOf(':') >= 0 && /^[0-9:.]+$/.test(s)) {
            var jam = s.split(':'), okJam = true, totJam = 0;
            for (var q = 0; q < jam.length; q++) {
                var nj = parseFloat(jam[q]);
                if (!isFinite(nj)) { okJam = false; break; }
                totJam = totJam * 60 + nj;
            }
            if (okJam) return totJam * 1000;
        }
        var tot = null, m;
        RE_DURASI.lastIndex = 0;
        while ((m = RE_DURASI.exec(s))) {
            var n = parseFloat(m[1]);
            if (!isFinite(n)) continue;
            var u = m[2].toLowerCase();
            var f = (u === 'h' || u === 'hr' || u === 'jam' || u === 'hour' || u === 'hours') ? 3600000
                : (u === 'm' || u === 'min' || u === 'menit' || u === 'minute' || u === 'minutes') ? 60000
                    : (u === 's' || u === 'sec' || u === 'secs' || u === 'seconds' || u === 'second') ? 1000 : 1;
            tot = (tot === null ? 0 : tot) + n * f;
        }
        if (tot !== null) return tot;
        return num(s, def);
    }
    /* fps: "30" | "29.97" | "30000/1001" (pecahan) | "30000" (= fps x 1000). */
    function fps(v, def) {
        if (v === null || v === undefined) return def;
        var s = String(v).trim();
        if (!s) return def;
        var fr = /^([-+]?[0-9]*\.?[0-9]+)\s*\/\s*([0-9]*\.?[0-9]+)$/.exec(s);
        if (fr) {
            var d = parseFloat(fr[2]);
            if (d) { var q = parseFloat(fr[1]) / d; if (isFinite(q) && q > 0) return q; }
        }
        var x = num(s, NaN);
        if (!isFinite(x) || x <= 0) return def;
        return x > 1000 ? x / 1000 : x;
    }
    /* Vektor: "360.0,640.0,0.0" / "360 640" / array / angka tunggal. */
    function vec(v, n, def) {
        var out = [], i, p;
        n = Math.max(1, n | 0);
        for (i = 0; i < n; i++) out.push(def && def[i] !== undefined ? def[i] : 0);
        if (v === null || v === undefined) return out;
        if (typeof v === 'number') { for (i = 0; i < n; i++) out[i] = v; return out; }
        if (Array.isArray(v)) { for (i = 0; i < n; i++) { p = num(v[i], null); if (p !== null) out[i] = p; } return out; }
        var parts = String(v).trim().split(/[,\s;]+/);
        for (i = 0; i < n; i++) { p = num(parts[i], null); if (p !== null) out[i] = p; }
        return out;
    }
    /* "#rgb" | "#rrggbb" | "#aarrggbb" -> [r,g,b,a] 0..1 (urutan ARGB). */
    function hex(v) {
        if (v === null || v === undefined) return [0, 0, 0, 1];
        var s = String(v).trim().replace(/^#/, '');
        if (s.length === 3) s = s.split('').map(function (c) { return c + c; }).join('');
        if (s.length === 6) s = 'ff' + s;
        if (s.length !== 8) return [0, 0, 0, 1];
        var p = [0, 2, 4, 6].map(function (i) { return parseInt(s.substr(i, 2), 16) / 255; });
        return [p[1], p[2], p[3], p[0]];
    }
    /* Warna: heksadesimal ATAU daftar angka "r,g,b(,a)". */
    function warna(v) {
        if (v === null || v === undefined || String(v).trim() === '') return [0, 0, 0, 1];
        var s = String(v).trim();
        if (s.charAt(0) === '#') return hex(s);
        if (/[0-9]/.test(s)) {
            var c = vec(s, 4, [0, 0, 0, 1]);
            return [c[0], c[1], c[2], c[3]];
        }
        return hex(s);
    }
    function boolv(v, def) {
        if (v === null || v === undefined) return def;
        var s = String(v).trim().toLowerCase();
        if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
        if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
        return def;
    }
    /* Enum: peta nama->nilai; yang tidak ada dipetakan ke `def` + dicatat. */
    function enums(v, peta, def, konteks, ket) {
        if (v === null || v === undefined || String(v).trim() === '') {
            return { value: def, raw: v === null ? null : v, unknown: false };
        }
        var k = String(v).trim().toLowerCase();
        if (Object.prototype.hasOwnProperty.call(peta, k)) return { value: peta[k], raw: v, unknown: false };
        sebagian(konteks, ket || k);
        return { value: def, raw: v, unknown: true };
    }
    /* ============ 3. waktu kf: satuan = FRAKSI durasi elemen ============ */
    /* Bukti (diukur dari XML ekspor AM asli, bukan dugaan):
       - renderer mengevaluasi kanal dengan RASIO (t-startTime)/(endTime-startTime);
       - klon-klon klip berdurasi berbeda punya kf@t yang PERSIS berskala dengan
         rasio durasinya (uji 9 keyframe: 4,2386 vs 2115/499 ms, selisih < 0,2 %);
       - <bookmark t> di berkas yang sama memakai milidetik (satuan per atribut).
       Jadi t = 0 di awal elemen dan t = 1 di akhir elemen; nilai di luar 0..1
       berarti animasi keluar dari klip (sah). tMs hanya diisi bila durasi
       elemen diketahui. Penyelamat defensif: |t| >= 10000 dianggap milidetik. */
    var KF_AMBANG_MS = 10000;
    function waktuKf(t, durasiMs) {
        var n = num(t, null);
        if (n === null) {
            sebagian('kf.t', 'nilai t tidak terbaca: "' + potong(t, 24) + '"');
            return { raw: t === undefined ? null : t, t: 0, ms: null, unit: 'unknown', durasiMs: durasiMs || null };
        }
        var D = (typeof durasiMs === 'number' && durasiMs > 0) ? durasiMs : null;
        if (Math.abs(n) >= KF_AMBANG_MS) {
            sebagian('kf.t', '|t|=' + n + ' >= ' + KF_AMBANG_MS + ' - diasumsikan milidetik');
            return { raw: t, t: D ? n / D : n, ms: D ? n : null, unit: 'ms', durasiMs: D };
        }
        return { raw: t, t: n, ms: D ? n * D : null, unit: 'fraksi', durasiMs: D };
    }
function cmpKf(a, b) { return a.t - b.t; }

    /* ============ 4. blend mode ============ */
    /* Lima mode kanonik yang diminta. Alias yang secara harfiah berarti
       "normal"/"add" ikut dipetakan. Nilai lain TIDAK dipaksa jadi normal
       pada jalur renderer: renderer punya petanya sendiri (Ns + la), jadi
       nilainya dipertahankan agar gambar tidak berubah. Pada representasi
       kanonik nilainya menjadi "normal" + dicatat sebagai partial. */
    var BLEND_KANONIK = { normal: 'normal', multiply: 'multiply', screen: 'screen', overlay: 'overlay', add: 'add' };
    var BLEND_ALIAS = { 'no-blend': 'normal', 'none': 'normal', 'normal-blend': 'normal', 'linear-add': 'add', 'plus': 'add', lighter: 'add' };
    /* Nilai yang dikenal renderer (salinan daftar Ns + la di bundel). */
    var BLEND_APPS = ('mask mask-fill mask-exclude exclude multiply screen add plus linear-dodge overlay ' +
        'soft-overlay soft-light hard-light linear-light vivid-light pin-light darken lighten difference ' +
        'exclusion color-dodge color-burn linear-burn subtract divide normal').split(' ');
    function blend(v) {
        var s = v === null || v === undefined ? '' : String(v).trim().toLowerCase();
        if (!s) return { raw: v === null ? null : v, value: 'normal', canonical: 'normal', appKnown: true, unknown: false };
        if (BLEND_KANONIK[s] !== undefined) {
            return { raw: v, value: BLEND_KANONIK[s], canonical: BLEND_KANONIK[s], appKnown: true, unknown: false, canonicalised: true };
        }
        if (BLEND_ALIAS[s] !== undefined) {
            return { raw: v, value: BLEND_ALIAS[s], canonical: BLEND_ALIAS[s], appKnown: true, unknown: false, canonicalised: true };
        }
        if (BLEND_APPS.indexOf(s) >= 0) {
            return { raw: v, value: s, canonical: 'normal', appKnown: true, unknown: false, canonicalised: false };
        }
        return { raw: v, value: 'normal', canonical: 'normal', appKnown: false, unknown: true };
    }

    /* ============ 5. pengumpul capability ============ */
    var cap = null;
    function buka() {
        cap = {
            supported: [], partial: [], unsupported: [],
            _s: Object.create(null), _p: Object.create(null), _u: Object.create(null)
        };
        return cap;
    }
    var BUCKET = { s: 'supported', p: 'partial', u: 'unsupported' };
    /* Catatan = "kunci" atau "kunci - keterangan". Kunci SELALU ikut supaya
       daftar laporan tidak pernah kosong hanya karena keterangan kosong. */
    function cat(bucket, kunci, ket) {
        if (!cap) buka();
        if (!kunci) return;
        var nama = BUCKET[bucket], arr = cap[nama], seen = cap['_' + bucket];
        var teks = ket ? kunci + ' - ' + ket : kunci;
        if (seen[kunci]) { if (arr.indexOf(teks) < 0) arr.push(teks); return; }
        seen[kunci] = 1;
        arr.push(teks);
    }
    function dukung(kunci, ket) { cat('s', kunci, ket); }
    function sebagian(kunci, ket) { cat('p', kunci, ket); }
    function tidak(kunci, ket) { cat('u', kunci, ket); }
    function capability() {
        if (!cap) buka();
        return { supported: cap.supported.slice(), partial: cap.partial.slice(), unsupported: cap.unsupported.slice() };
    }
    /* ============ 6. tipe param & channel ============ */
    var TIPE_PARAM = {
        float: 1, int: 1, time: 1, angle: 1, string: 1, enum: 1, selector: 1, spinner: 1, slider: 1,
        bool: 1, switch: 1, color: 1, vec2: 2, point: 2, size: 2, offset: 2, vector: 2,
        vec3: 3, xyz: 3, 'hue-disc': 3, mat3: 3,
        vec4: 4, orient: 4, mat4: 4, texture: 0, 'float[]': 0, 'int[]': 0, 'vec2[]': 0, 'vec3[]': 0
    };
    function tipeWarna(el) { return String(at(el, ['type', 'dataType']) || '').trim().toLowerCase() === 'color'; }
    function tipeBool(el) {
        var t = String(at(el, ['type', 'dataType']) || '').trim().toLowerCase();
        return t === 'bool' || t === 'switch';
    }
    function kfBaca(el, n, def) {
        var c = anakSemua(el, 'kf'), out = [];
        var isW = tipeWarna(el), isB = tipeBool(el);
        for (var i = 0; i < c.length; i++) {
            var w = waktuKf(at(c[i], 't'));
            var v;
            if (isW) v = warna(at(c[i], ['v', 'value']));
            else if (isB) v = [boolv(at(c[i], ['v', 'value']), false) ? 1 : 0];
            else v = vec(at(c[i], ['v', 'value']), n, def);
            out.push({ t: w.t, rawT: w.raw, tMs: w.ms, unit: w.unit, v: v, e: at(c[i], 'e') || null });
        }
        out.sort(cmpKf);
        return out;
    }
    function kfWarna(el) {
        var c = anakSemua(el, 'kf'), out = [];
        for (var i = 0; i < c.length; i++) {
            var w = waktuKf(at(c[i], 't'));
            out.push({ t: w.t, rawT: w.raw, tMs: w.ms, unit: w.unit, v: warna(at(c[i], ['v', 'value'])), e: at(c[i], 'e') || null });
        }
        out.sort(cmpKf);
        return out;
    }
    function kfBool(el) {
        var c = anakSemua(el, 'kf'), out = [];
        for (var i = 0; i < c.length; i++) {
            var w = waktuKf(at(c[i], 't'));
            out.push({ t: w.t, rawT: w.raw, tMs: w.ms, unit: w.unit, v: [boolv(at(c[i], ['v', 'value']), false) ? 1 : 0], e: at(c[i], 'e') || null });
        }
        out.sort(cmpKf);
        return out;
    }
    /* Channel generik: { value:[..], kfs:[{t,rawT,tMs,unit,v,e}] } */
    function bacaKanal(el, n, def) {
        if (!el) return kanalKosong(def || []);
        n = Math.max(1, n | 0);
        var d = def && def.length ? def : nol(n);
        var kfs = kfBaca(el, n, d);
        var vAwal = at(el, ['value', 'val']);
        var value;
        if (vAwal !== null) value = tipeWarna(el) ? warna(vAwal) : vec(vAwal, n, d);
        else if (kfs.length) value = kfs[0].v.slice();
        else value = d.slice();
        for (var i = 0; i < n; i++) if (value[i] === undefined) value[i] = d[i] !== undefined ? d[i] : 0;
        if (vAwal === null && !kfs.length) sebagian('channel.value', '<' + tagEl(el) + '> tanpa value maupun kf - memakai bawaan');
        if (kfs.length) dukung('kf.t');
        return { value: value, kfs: kfs };
    }
    function bacaKanalTyped(el, t, n, def) {
        if (t === 'color') return { value: warna(at(el, 'value')), kfs: kfWarna(el) };
        if (t === 'bool' || t === 'switch') return { value: [boolv(at(el, 'value'), false) ? 1 : 0], kfs: kfBool(el) };
        if (n === undefined || n === null) {
            var d = TIPE_PARAM[t];
            n = d === undefined ? 1 : (d || 1);
        }
        return bacaKanal(el, n, def || nol(n));
    }
    var TRANSFORM_DEF = {
        location: [3, [0, 0, 0]], scale: [2, [1, 1]], rotation: [1, [0]], opacity: [1, [1]], pivot: [2, [0, 0]]
    };
    function bacaTransform(el) {
        var T = {
            location: kanalKosong([0, 0, 0]), scale: kanalKosong([1, 1]), rotation: kanalKosong([0]),
            opacity: kanalKosong([1]), pivot: kanalKosong([0, 0])
        };
        if (!el) return T;
        var c = kids(el);
        for (var i = 0; i < c.length; i++) {
            var t = String(c[i].tagName || '').toLowerCase();
            var sp = TRANSFORM_DEF[t];
            if (!sp) {
                sebagian('transform.child.' + t, '<' + c[i].tagName + '> di dalam <transform> tidak dikenali');
                continue;
            }
            T[t] = bacaKanal(c[i], sp[0], sp[1]);
            dukung('transform.' + t);
        }
        return T;
    }
    /* ============ 7. efek & param (termasuk node param bersarang) ============ */
    var WRAP_PARAM = ['params', 'param', 'properties', 'group', 'groups', 'propertylist'];
    function bacaParams(el) { return kumpulkanParam(el, 0); }
    function kumpulkanParam(el, kedalaman) {
        var out = [], c = kids(el);
        if (kedalaman > 6) { sebagian('effect.param.depth', 'kedalaman param > 6 dipangkas'); return out; }
        for (var i = 0; i < c.length; i++) {
            var ch = c[i], t = String(ch.tagName || '').toLowerCase();
            if (t === 'kf' || t === 'stop') continue;
            if (WRAP_PARAM.indexOf(t) >= 0) { out = out.concat(kumpulkanParam(ch, kedalaman + 1)); continue; }
            out.push(bacaParam(ch));
        }
        return out;
    }
    function bacaParam(el) {
        var nama = at(el, ['name', 'id']);
        var id = nama === null ? '' : String(nama);
        var t = String(at(el, ['type', 'dataType']) || '').trim().toLowerCase();
        var P = { id: id, name: id, type: t || 'unknown', tag: tagEl(el), channel: null, kfs: [], partial: false, raw: null };
        if (TIPE_PARAM[t] === undefined) {
            P.partial = true;
            P.raw = { kind: 'element', tag: tagEl(el), attrs: semuaAt(el), text: potong(el.textContent || '', 200), children: [] };
            P.channel = bacaKanalTyped(el, t, 1, [0]);
            sebagian('effect.param.type', 'tipe param "' + (t || '(kosong)') + '" (id "' + id + '") dipertahankan mentah');
        } else {
            dukung('effect.param.' + t);
            P.channel = bacaKanalTyped(el, t, TIPE_PARAM[t] || 1);
        }
        P.kfs = P.channel ? P.channel.kfs : [];
        return P;
    }
    function bacaEfek(el) {
        var id = String(at(el, ['id', 'name']) || '');
        var E = {
            id: id,
            shortId: id ? id.split('.').pop() : '',
            name: String(at(el, ['name', 'label', 'title']) || id || ''),
            type: String(at(el, ['type', 'kind']) || ''),
            locallyApplied: boolv(at(el, 'locallyApplied'), true),
            hidden: boolv(at(el, 'hidden'), false),
            disabled: boolv(at(el, 'disabled'), false),
            params: bacaParams(el),
            unsupported: [], partial: false,
            raw: { kind: 'element', tag: tagEl(el), attrs: semuaAt(el), text: '', children: [] }
        };
        return graftEfek(E, el);
    }
    /* Dipakai juga oleh jalur bundel (ws()) untuk melengkapi efek yang sudah
       ada: menangkap id/name/type, flag locallyApplied/hidden/disabled,
       params[] (tak dikenal -> partial), dan anak yang tak dikenali. */
    function graftEfek(E, el) {
        if (!E || !el) return E;
        if (E.name === undefined || E.name === null) E.name = String(at(el, ['name', 'label', 'title']) || E.id || '');
        if (E.type === undefined || E.type === null) E.type = String(at(el, ['type', 'kind']) || '');
        if (E.locallyApplied === undefined) E.locallyApplied = boolv(at(el, 'locallyApplied'), true);
        if (E.hidden === undefined) E.hidden = boolv(at(el, 'hidden'), false);
        if (E.disabled === undefined) E.disabled = boolv(at(el, 'disabled'), false);
        if (!E.raw) E.raw = { kind: 'element', tag: tagEl(el), attrs: semuaAt(el), text: '', children: [] };
        if (!E.params) E.params = bacaParams(el);
        if (!E.unsupported) {
            E.unsupported = [];
            var lain = anakLain(el, ['property', 'params', 'param', 'properties', 'kf']);
            for (var i = 0; i < lain.length; i++) {
                E.unsupported.push(simpanAnak(lain[i]));
                E.partial = true;
                tidak('effect.child.' + String(lain[i].tagName || '').toLowerCase(),
                    '<' + lain[i].tagName + '> di dalam <effect> tidak dikenali');
            }
        }
        if (E.params.length) dukung('effect.params');
        if (E.disabled) sebagian('effect.disabled', 'efek ' + (E.id || E.name) + ' dimatikan di XML');
        if (!E.locallyApplied) sebagian('effect.locallyApplied', 'efek ' + (E.id || E.name) + ' tidak diterapkan lokal');
        return E;
    }
    function graftParam(P, el) {
        if (!P || !el) return P;
        if (P.type === undefined || P.type === null) P.type = String(at(el, ['type', 'dataType']) || '').trim().toLowerCase() || 'unknown';
        if (P.name === undefined || P.name === null) P.name = P.id || '';
        if (TIPE_PARAM[P.type] === undefined) {
            P.partial = true;
            if (!P.raw) P.raw = { kind: 'element', tag: tagEl(el), attrs: semuaAt(el), text: potong(el.textContent || '', 200), children: [] };
            sebagian('effect.param.type', 'tipe param "' + (P.type || '(kosong)') + '" (id "' + (P.id || '') + '") dipertahankan mentah');
        } else {
            dukung('effect.param.' + P.type);
        }
        return P;
    }
    /* ============ 8. isi layer (mask/text/shape/video/audio) ============ */
    function bacaGradien(el) {
        var G = {
            type: String(at(el, 'type') || 'linear'),
            startColor: warna(at(el, 'startColor')), endColor: warna(at(el, 'endColor')),
            start: vec(at(el, 'start'), 2, [0, 0]), end: vec(at(el, 'end'), 2, [0, 0]),
            radius: vec(at(el, 'radius'), 2, [0, 0]), stops: []
        };
        var st = anakSemua(el, 'stop');
        for (var i = 0; i < st.length; i++) {
            G.stops.push({ t: num(at(st[i], 't'), 0), color: warna(at(st[i], ['color', 'value'])), raw: semuaAt(st[i]) });
        }
        dukung('layer.gradient');
        return G;
    }
    /* Path disimpan sebagai string `d` apa adanya; renderer punya parser
       sendiri (Ks/vs) dan tidak boleh disentuh. */
    function bacaPath(el) { dukung('layer.path'); return { d: String(at(el, 'd') || ''), raw: semuaAt(el) }; }
    function bacaPathStroke(el) {
        return {
            enabled: boolv(at(el, 'enabled'), true), direction: String(at(el, 'direction') || 'centered'),
            endSize: num(at(el, 'end-size'), 1), color: warna(nilai(el, 'color', '')),
            size: num(nilai(el, 'size', ''), 0), raw: semuaAt(el)
        };
    }
    function bacaBorder(el) {
        return {
            direction: String(at(el, 'direction') || 'outside'), color: warna(nilai(el, 'color', '')),
            size: num(nilai(el, 'size', ''), 0), raw: semuaAt(el)
        };
    }
    function bacaShadow(el) {
        return {
            enabled: boolv(at(el, 'enabled'), true), direction: String(at(el, 'direction') || 'outside'),
            offset: vec(nilai(el, 'offset', ''), 2, [0, 0]), color: warna(nilai(el, 'color', '')),
            blur: num(nilai(el, 'blur', ''), 0), raw: semuaAt(el)
        };
    }
    function bacaGlow(el) {
        /* glow luar/dalam: radius, alpha, hardness, warna, mode campur */
        return {
            enabled: boolv(at(el, 'enabled'), true),
            direction: String(at(el, 'direction') || 'outside'),
            size: num(nilai(el, 'size', ''), 0),
            color: warna(nilai(el, 'color', '')),
            opacity: num(nilai(el, 'opacity', ''), 0.75),
            hardness: num(nilai(el, 'hardness', ''), 0.5),
            raw: semuaAt(el)
        };
    }
    /* Daftar semua dekorasi tepi lapisan (dipakai pemutar saat menggambar teks). */
    function catatDekorasi(L, tag, el) {
        if (String(tagEl(el)).toLowerCase() !== 'text') return;
        var daftar = L.content.dekorasi || (L.content.dekorasi = []);
        var satu = { tag: tag, enabled: boolv(at(el, 'enabled'), true), attrs: semuaAt(el) };
        if (tag === 'path-stroke') {
            var uk = anak(el, 'size'), wr = anak(el, 'color');
            satu.size = uk ? num(at(uk, 'value'), 0) : 0;
            satu.color = wr ? warna(at(wr, 'value')) : null;
        }
        daftar.push(satu);
    }
    function bacaMask(el) {
        dukung('layer.mask');
        return {
            type: String(at(el, 'type') || ''), mode: String(at(el, 'mode') || ''),
            enabled: boolv(at(el, 'enabled'), true), attrs: semuaAt(el),
            children: anakLain(el, []).map(function (x) { return simpanAnak(x, 1); })
        };
    }
    function bacaTitik(v) {
        var out = [];
        if (v === null || v === undefined) return out;
        var s = String(v).split(';');
        for (var i = 0; i < s.length; i++) {
            var seg = s[i].trim();
            if (!seg) continue;
            var p = vec(seg, 3, [0, 0, 1]);
            if (!isFinite(p[0]) || !isFinite(p[1])) continue;
            out.push([p[0], p[1], p[2] === undefined ? 1 : p[2]]);
        }
        return out;
    }
    function bacaStroke(el) {
        return {
            color: warna(at(el, 'color')), width: num(at(el, 'width'), 0),
            type: String(at(el, 'type') || 'pen'), points: bacaTitik(at(el, 'points')), raw: semuaAt(el)
        };
    }
    function jenisLayer(el, L) {
        var t = String(tagEl(el)).toLowerCase();
        if (t === 'text') return 'text';
        if (t === 'audio') return 'audio';
        if (t === 'camera') return 'camera';
        if (t === 'group') return 'group';
        if (t === 'embedscene') return 'scene';
        if (t === 'nullobj') return 'null';
        if (t === 'drawing') return 'drawing';
        if (t === 'lottie') return 'lottie';
        var ft = String((L && L.fillType) || at(el, ['fillType']) || '').toLowerCase();
        if (ft === 'media' || ft === 'video') return 'video';
        if (ft === 'image' || ft === 'photo') return 'image';
        if (ft === 'intrinsic' || at(el, ['fillVideo']) || at(el, ['fillImage'])) {
            return at(el, ['fillVideo']) ? 'video' : (at(el, ['fillImage']) ? 'image' : 'shape');
        }
        return 'shape';
    }
    var LAYER_TAG = {
        shape: 'shape', text: 'text', embedscene: 'scene', group: 'group', nullobj: 'null',
        camera: 'camera', audio: 'audio', drawing: 'drawing', image: 'image', video: 'video',
        media: 'media', lottie: 'lottie'
    };
    /* Anak layer yang dikenali; SELAIN itu masuk layer.unsupported[]. */
    var LAYER_ANAK = ['content', 'transform', 'filltype', 'fillcolor', 'gradient', 'path', 'path-stroke',
        'border', 'shadow', 'glow', 'gain', 'mask', 'mask-fill', 'effect', 'stroke', 'fov', 'property', 'scene'];
    function bacaProperty(el, L) {
        var nama = String(at(el, 'name') || '');
        if (!nama) { sebagian('layer.property', '<property> tanpa atribut name'); return; }
        var t = String(at(el, 'type') || '').trim().toLowerCase();
        if (TIPE_PARAM[t] === undefined) {
            L.shapeProps[nama] = {
                dataType: t || 'unknown', channel: bacaKanalTyped(el, t, 1, [0]),
                partial: true, raw: { kind: 'element', tag: tagEl(el), attrs: semuaAt(el), text: '', children: [] }
            };
            sebagian('layer.property.type', 'tipe "' + (t || '(kosong)') + '" untuk property "' + nama + '" dipertahankan mentah');
            return;
        }
        dukung('layer.property.' + t);
        if (nama === 'size') L.size = bacaKanalTyped(el, t, 2, [0, 0]);
        else if (nama === 'cornerRadius') L.cornerRadius = num(at(el, 'value'), 0);
        else if (nama === 'blendMode' || nama === 'blending' || nama === 'blend') {
            var b = blend(at(el, 'value'));
            L.blendMode = b.value; L.blendModeRaw = b.raw; L.blendModeCanonical = b.canonical;
            if (b.unknown) tidak('layer.blendMode', 'blend "' + b.raw + '" tidak dikenal -> normal');
        }
        else if (nama === 'startAngle') L.startAngle = bacaKanalTyped(el, t, 1, [0]);
        else if (nama === 'endAngle') L.endAngle = bacaKanalTyped(el, t, 1, [360]);
        L.shapeProps[nama] = { dataType: t, channel: bacaKanalTyped(el, t) };
    }
    /* ============ 9. layer (urutan XML dipertahankan, TIDAK diurutkan) ============ */
    function bacaLayer(el, order) {
        var L = {
            order: order | 0,
            tag: tagEl(el),
            id: String(at(el, 'id') || ''),
            label: String(at(el, ['label', 'name', 'title']) || ''),
            parentId: String(at(el, ['parent', 'parentId']) || ''),
            childIds: [], parentMissing: false,
            startTime: ms(at(el, ['startTime', 'start', 'in']), 0),
            endTime: ms(at(el, ['endTime', 'end', 'out']), 0),
            inTime: ms(at(el, 'inTime'), 0),
            outTime: ms(at(el, 'outTime'), 0),
            src: String(at(el, 'src') || ''),
            hidden: boolv(at(el, 'hidden'), false),
            speed: num(at(el, 'speed'), 1),
            link: String(at(el, 'link') || ''),
            shapeType: String(at(el, 's') || '').trim(),
            fillType: String(nilai(el, 'fillType', '') || ''),
            fillColor: warna(nilai(el, 'fillColor', '')),
            fillImage: String(at(el, 'fillImage') || ''),
            fillVideo: String(at(el, 'fillVideo') || ''),
            mediaFillMode: String(at(el, 'mediaFillMode') || 'fill'),
            transform: bacaTransform(anak(el, 'transform')),
            size: kanalKosong([100, 100]),
            cornerRadius: 0, fov: 0,
            gradient: null, path: null, pathStroke: null, border: null,
            strokes: [], effects: [], children: [], scene: null,
            shapeProps: {}, textContent: '',
            content: {}, raw: null, unsupported: []
        };
        if (L.endTime <= L.startTime) L.endTime = L.startTime + 1;
        var b0 = blend(at(el, ['blending', 'blendMode', 'blend']));
        L.blendMode = b0.value; L.blendModeRaw = b0.raw; L.blendModeCanonical = b0.canonical;
        var c = kids(el);
        for (var i = 0; i < c.length; i++) {
            var ch = c[i], t = String(ch.tagName || '').toLowerCase();
            if (t === 'content') { L.textContent = ch.textContent || ''; continue; }
            if (t === 'transform') continue;
            if (t === 'filltype') {
                var ft = at(ch, 'value'); if (ft) L.fillType = ft;
                var fc = anak(ch, 'fillcolor'); if (fc) L.fillColor = warna(at(fc, 'value'));
                continue;
            }
            if (t === 'fillcolor') { L.fillColor = warna(at(ch, 'value')); continue; }
            if (t === 'gradient') { L.gradient = bacaGradien(ch); continue; }
            if (t === 'path') { L.path = bacaPath(ch); continue; }
            if (t === 'path-stroke') { L.pathStroke = bacaPathStroke(ch); catatDekorasi(L, 'path-stroke', ch); continue; }
            if (t === 'border') { L.border = bacaBorder(ch); catatDekorasi(L, 'border', ch); continue; }
            if (t === 'shadow') { L.content.shadow = bacaShadow(ch); catatDekorasi(L, 'shadow', ch); continue; }
            if (t === 'glow') { (L.content.glows = L.content.glows || []).push(bacaGlow(ch)); catatDekorasi(L, 'glow', ch); continue; }
            if (t === 'gain') { L.content.gain = bacaKanal(ch, 1, [0]); continue; }
            if (t === 'mask' || t === 'mask-fill') { L.content.mask = bacaMask(ch); continue; }
            if (t === 'effect') { L.effects.push(bacaEfek(ch)); continue; }
            if (t === 'stroke') {
                if (String(tagEl(el)).toLowerCase() === 'drawing') L.strokes.push(bacaStroke(ch));
                else tidak('layer.stroke', '<stroke> di luar <drawing> - tidak digambar');
                continue;
            }
            if (t === 'fov') {
                var fv = num(at(ch, 'value'), null);
                if (fv !== null && fv > 0) L.fov = fv;
                continue;
            }
            if (t === 'property') { bacaProperty(ch, L); continue; }
            if (t === 'scene') { L.scene = bacaScene(ch, ''); continue; }
            if (LAYER_TAG[t]) {
                /* Renderer hanya menempel anak layer pada <group>. Model
                   kanonik tetap mencatatnya; selisihnya diberi tahu. */
                if (String(tagEl(el)).toLowerCase() !== 'group') {
                    sebagian('layer.children.nonGroup', '<' + ch.tagName + '> di dalam <' + tagEl(el) + '> tidak dirender sebagai anak');
                }
                L.children.push(bacaLayer(ch, L.children.length));
                continue;
            }
            L.unsupported.push(simpanAnak(ch));
            tidak('layer.child.' + t, '<' + ch.tagName + '> di dalam <' + tagEl(el) + '> tidak dikenali');
        }
        L.content.kind = jenisLayer(el, L);
        L.content.text = L.textContent;
        L.content.media = {
            src: L.src, uri: String(at(el, 'uri') || ''), video: L.fillVideo, image: L.fillImage,
            type: String(at(el, 'type') || ''), fillMode: L.mediaFillMode
        };
        L.content.fill = {
            type: L.fillType, color: L.fillColor, image: L.fillImage, video: L.fillVideo, mode: L.mediaFillMode
        };
        L.content.font = {
            size: num(at(el, 'size'), 18), family: String(at(el, 'font') || ''),
            wrapWidth: num(at(el, 'wrapWidth'), 0), align: String(at(el, 'align') || 'center')
        };
        L.raw = { kind: 'element', tag: tagEl(el), attrs: semuaAt(el), text: '', children: [] };
        return graftLayer(L, el, L.order);
    }
    /* Melengkapi layer yang sudah dibangun pemanggil (jalur bundel: Pn()).
       Tidak menyentuh `children` (dipakai renderer) dan tidak mengubah
       urutan; tautan parent disimpan sebagai ID agar bebas siklus. */
    function graftLayer(L, el, order) {
        if (!L || !el) return L;
        if (order !== undefined && order !== null) L.order = order | 0;
        if (L.order === undefined) L.order = 0;
        if (!L.raw) L.raw = { kind: 'element', tag: tagEl(el), attrs: semuaAt(el), text: '', children: [] };
        if (!L.content) L.content = {};
        if (L.content.kind === undefined) L.content.kind = jenisLayer(el, L);
        if (L.content.text === undefined) L.content.text = L.textContent || '';
        if (L.parentId === undefined || L.parentId === null) L.parentId = String(at(el, ['parent', 'parentId']) || '');
        if (!L.childIds) L.childIds = [];
        if (!L.content.media) {
            L.content.media = {
                src: L.src || String(at(el, 'src') || ''), uri: String(at(el, 'uri') || ''),
                video: L.fillVideo || String(at(el, 'fillVideo') || ''),
                image: L.fillImage || String(at(el, 'fillImage') || ''),
                type: String(at(el, 'type') || ''), fillMode: L.mediaFillMode || String(at(el, 'mediaFillMode') || 'fill')
            };
        }
        if (!L.content.fill) {
            L.content.fill = {
                type: L.fillType || String(at(el, ['fillType']) || ''), color: L.fillColor || [0, 0, 0, 1],
                image: L.fillImage || '', video: L.fillVideo || '', mode: L.mediaFillMode || 'fill'
            };
        }
        if (!L.content.font) {
            L.content.font = {
                size: num(at(el, 'size'), L.fontSize === undefined ? 18 : L.fontSize),
                family: L.font || String(at(el, 'font') || ''),
                wrapWidth: num(at(el, 'wrapWidth'), L.wrapWidth || 0),
                align: L.align || String(at(el, 'align') || 'center')
            };
        }
        if (!L.content.shadow) { var shd = anak(el, 'shadow'); if (shd) L.content.shadow = bacaShadow(shd); }
        if (!L.content.gain) { var gn = anak(el, 'gain'); if (gn) L.content.gain = bacaKanal(gn, 1, [0]); }
        if (!L.content.mask) { var mk = anak(el, 'mask') || anak(el, 'mask-fill'); if (mk) L.content.mask = bacaMask(mk); }

        var bSrc = at(el, ['blending', 'blendMode', 'blend']);
        if (bSrc === null) {
            var pp = anak(el, 'property');
            if (pp && /^(blend|blending|blendmode)$/i.test(String(at(pp, 'name') || ''))) bSrc = at(pp, 'value');
        }
        var b = blend(bSrc);
        L.blendModeRaw = bSrc;
        L.blendModeCanonical = b.canonical;
        L.blendMode = b.value;
        if (b.unknown) tidak('layer.blendMode', 'blend "' + bSrc + '" tidak dikenal -> normal');
        else if (bSrc !== null && b.canonical !== String(bSrc).trim().toLowerCase()) {
            sebagian('layer.blendMode', 'blend "' + bSrc + '" -> "' + b.canonical + '" pada model kanonik');
        }

        if (!L.unsupported) L.unsupported = [];
        var lain = anakLain(el, LAYER_ANAK);
        for (var i = 0; i < lain.length; i++) {
            var t2 = String(lain[i].tagName || '').toLowerCase();
            if (LAYER_TAG[t2]) continue;                 /* anak layer -> children, bukan unsupported */
            L.unsupported.push(simpanAnak(lain[i]));
            tidak('layer.child.' + t2, '<' + lain[i].tagName + '> di dalam <' + tagEl(el) + '> tidak dikenali');
        }
        dukung('layer.' + L.content.kind);
        return L;
    }
    /* ============ 10. akar scene: rantai fallback ============ */
    var AKAR_W = ['width', 'w', 'compositionWidth', 'exportWidth', 'videoWidth'];
    var AKAR_H = ['height', 'h', 'compositionHeight', 'exportHeight', 'videoHeight'];
    var AKAR_FPS = ['fps', 'frameRate', 'framerate', 'frame_rate', 'exportFps', 'framesPerSecond'];
    var AKAR_T = ['totalTime', 'duration', 'durationMs', 'exportDuration', 'totalDuration', 'length'];
    var META_AKAR = ['title', 'bgcolor', 'amver', 'ffver', 'retime', 'retimeAdaptFPS', 'precompose',
        'exportWidth', 'exportHeight', 'modifiedTime', 'am', 'amplatform', 'templateLink', 'orientation'];
    var AKAR_BAWAAN = { width: 1080, height: 1920, fps: 30, totalTime: 0 };
    /* Atribut akar yang dianggap "dikenali"; sisanya dicatat apa adanya. */
    var AKAR_KNOWN = (function () {
        var s = {};
        var tambah = function (a) { for (var i = 0; i < a.length; i++) s[String(a[i]).toLowerCase()] = 1; };
        tambah(META_AKAR); tambah(AKAR_W); tambah(AKAR_H); tambah(AKAR_FPS); tambah(AKAR_T);
        return s;
    })();
    /* Bentuk murni: hanya menghitung, TIDAK menulis ke scene mana pun.
       Jalur bundel memakainya lewat graftScene() supaya width/height/fps/
       totalTime milik renderer tidak pernah ditimpa. */
    function akarInfo(el) {
        var vW = at(el, AKAR_W), vH = at(el, AKAR_H), vF = at(el, AKAR_FPS), vT = at(el, AKAR_T);
        var w = num(vW, null), h = num(vH, null);
        var f = fps(vF, null), d = ms(vT, null);
        var fb = [];
        if (w === null || w <= 0) { w = AKAR_BAWAAN.width; fb.push('width'); } else dukung('scene.width');
        if (h === null || h <= 0) { h = AKAR_BAWAAN.height; fb.push('height'); } else dukung('scene.height');
        if (f === null) { f = AKAR_BAWAAN.fps; fb.push('fps'); } else dukung('scene.fps');
        if (d === null || d < 0) { d = AKAR_BAWAAN.totalTime; fb.push('totalTime'); } else dukung('scene.totalTime');
        var info = {
            width: w, height: h, fps: f, totalTime: d, durationMs: d, fallbacks: fb,
            aspectRatio: h > 0 ? w / h : 0, rawWidth: vW, rawHeight: vH, rawFps: vF, rawTotalTime: vT
        };
        /* HANYA untuk laporan. TIDAK PERNAH dipakai logika apa pun:
           kanvas tetap w x h apa adanya, tidak ada pembulatan, tidak ada
           pernyataan "portrait berarti vertical" yang memengaruhi apa pun. */
        info.orientation = w > h ? 'landscape' : (h > w ? 'portrait' : 'square');
        for (var i = 0; i < fb.length; i++) sebagian('scene.' + fb[i], 'tidak ada di XML - memakai bawaan ' + AKAR_BAWAAN[fb[i]]);
        if (vF !== null && String(vF).indexOf('/') >= 0) dukung('scene.fps.pecahan');
        if (vF !== null && num(vF, null) > 1000) dukung('scene.fps.millis');
        return info;
    }
    function akarAt(el, S) {
        var info = akarInfo(el);
        S.width = info.width; S.height = info.height; S.fps = info.fps;
        S.totalTime = info.totalTime; S.durationMs = info.totalTime;
        S.fallbacks = info.fallbacks;
        S.aspectRatio = info.aspectRatio; S.orientation = info.orientation;
        S.rawWidth = info.rawWidth; S.rawHeight = info.rawHeight;
        S.rawFps = info.rawFps; S.rawTotalTime = info.rawTotalTime;
        if (S.bgcolor === undefined || S.bgcolor === null) S.bgcolor = [0, 0, 0, 1];
        dukung('scene.bgcolor');
        dukung('scene.title');
        return S;
    }
    function metaAt(el) {
        var m = {};
        for (var i = 0; i < META_AKAR.length; i++) {
            var v = at(el, META_AKAR[i]);
            if (v !== null) m[META_AKAR[i]] = v;
        }
        m.amverNum = num(m.amver, null);
        m.ffverNum = num(m.ffver, null);
        m.exportWidthNum = num(m.exportWidth, null);
        m.exportHeightNum = num(m.exportHeight, null);
        m.raw = semuaAt(el);
        return m;
    }
    function bacaMedia(el) {
        var dur = num(at(el, 'duration'), 0);
        /* duration media di AM ditulis dalam NANODETIK. Ambang 1e7 dipilih
           supaya nilai ms yang wajar (video < ~2,7 jam) tidak salah tebak. */
        var perkira = dur > 1e7;
        dukung('scene.media');
        return {
            uri: String(at(el, 'uri') || ''), type: String(at(el, 'type') || ''),
            filename: String(at(el, 'filename') || ''), title: String(at(el, 'title') || ''),
            duration: dur, durationMs: perkira ? dur / 1e6 : dur,
            durationUnit: perkira ? 'ns->ms(perkiraan)' : 'ms',
            width: num(at(el, 'width'), 0), height: num(at(el, 'height'), 0),
            size: num(at(el, 'size'), 0), fps: fps(at(el, 'fps'), 0),
            orientation: num(at(el, 'orientation'), null),
            raw: { kind: 'element', tag: tagEl(el), attrs: semuaAt(el), text: '', children: [] }
        };
    }
    function bacaAudio(el) {
        dukung('scene.audio');
        return {
            id: String(at(el, 'id') || ''), label: String(at(el, ['label', 'name']) || ''),
            src: String(at(el, ['src', 'uri']) || ''),
            startTime: ms(at(el, 'startTime'), 0), endTime: ms(at(el, 'endTime'), 0),
            inTime: ms(at(el, 'inTime'), 0), outTime: ms(at(el, 'outTime'), 0),
            volume: num(nilai(el, 'volume', ''), 1),
            raw: { kind: 'element', tag: tagEl(el), attrs: semuaAt(el), text: '', children: [] }
        };
    }
    function bacaScene(el, nama) {
        var S = {
            nama: nama || '', filename: nama || '',
            title: String(at(el, ['title', 'name']) || ''),
            width: 0, height: 0, fps: 0, totalTime: 0, durationMs: 0,
            aspectRatio: 0, orientation: 'square',
            bgcolor: warna(at(el, ['bgcolor', 'background'])),
            media: [], audio: [], bookmarks: [], layers: [],
            raw: null, unsupported: [], metadata: null, fallbacks: []
        };
        akarAt(el, S);
        var c = kids(el);
        for (var i = 0; i < c.length; i++) {
            var ch = c[i], t = String(ch.tagName || '').toLowerCase();
            if (t === 'media') { S.media.push(bacaMedia(ch)); continue; }
            if (t === 'audio') { S.audio.push(bacaAudio(ch)); S.layers.push(bacaLayer(ch, S.layers.length)); continue; }
            if (t === 'bookmark') { S.bookmarks.push(ms(at(ch, 't'), 0)); dukung('scene.bookmark'); continue; }
            if (LAYER_TAG[t] && t !== 'media') { S.layers.push(bacaLayer(ch, S.layers.length)); continue; }
            S.unsupported.push(simpanAnak(ch));
            tidak('scene.child.' + t, '<' + ch.tagName + '> di root scene tidak dikenali');
        }
        var semuaAtAkar = semuaAt(el);
        for (var a in semuaAtAkar) {
            if (AKAR_KNOWN[a]) continue;
            S.unsupported.push(simpanAtrib(el, a, semuaAtAkar[a]));
            sebagian('scene.attr.' + a, 'atribut akar "' + a + '" dipertahankan di scene.raw.attrs');
        }
        S.raw = { kind: 'element', tag: tagEl(el), attrs: semuaAtAkar, text: '', children: [] };
        S.metadata = metaAt(el);
        tautkan(S);
        return S;
    }
    /* Tautan parent: disimpan sebagai ID (bukan objek) supaya bebas siklus
       dan aman di-JSON-kan. `children` milik renderer tidak boleh disentuh.
       `petaId` opsional = Map milik renderer (scene.layerById). */
    function tautkan(S, petaId) {
        var semua = [], peta = Object.create(null);
        (function jelajah(s) {
            var ls = (s && s.layers) || [];
            for (var i = 0; i < ls.length; i++) {
                semua.push(ls[i]);
                ls[i].order = i;                 /* urutan XML, tidak pernah diurutkan ulang */
                jelajah(ls[i]);
                if (ls[i].scene) jelajah(ls[i].scene);
            }
        })(S);
        for (var j = 0; j < semua.length; j++) if (semua[j].id) peta[semua[j].id] = semua[j];
        for (var k = 0; k < semua.length; k++) {
            var L = semua[k];
            if (!L.parentId) continue;
            var p = peta[L.parentId];
            if ((!p || p === L) && petaId && typeof petaId["get"] === "function") p = petaId["get"](L.parentId) || null;
            if (!p || p === L) {
                L.parentMissing = true;
                sebagian('layer.parent', 'parent "' + L.parentId + '" tidak ditemukan');
                continue;
            }
            if (!p.childIds) p.childIds = [];
            if (p.childIds.indexOf(L.id) < 0) p.childIds.push(L.id);
            dukung('layer.parent');
        }
        return semua.length;
    }
    /* Dipakai jalur bundel: lengkapi scene yang sudah dibangun Yi().
       SANGAT penting: width/height/fps/totalTime milik renderer TIDAK pernah
       ditimpa. Informasi akar hanya disimpan terpisah (raw*, fallbacks,
       orientation, metadata) untuk laporan. */
    function graftScene(S, el) {
        if (!S || !el) return S;
        var info = akarInfo(el);
        S.fallbacks = info.fallbacks;
        S.rawWidth = info.rawWidth; S.rawHeight = info.rawHeight;
        S.rawFps = info.rawFps; S.rawTotalTime = info.rawTotalTime;
        S.aspectRatio = info.aspectRatio; S.orientation = info.orientation;
        S.metadata = metaAt(el);
        S.raw = { kind: 'element', tag: tagEl(el), attrs: semuaAt(el), text: '', children: [] };
        if (!S.unsupported) {
            S.unsupported = [];
            var semuaAtAkar = semuaAt(el);
            for (var a in semuaAtAkar) {
                if (AKAR_KNOWN[a]) continue;
                S.unsupported.push(simpanAtrib(el, a, semuaAtAkar[a]));
                sebagian('scene.attr.' + a, 'atribut akar "' + a + '" dipertahankan di scene.raw.attrs');
            }
        }
        if (S.durationMs === undefined) S.durationMs = S.totalTime;
        return S;
    }
    /* ============ 11. laporan, model kanonik, format teks ============ */
    function hitung(S) {
        var h = { layers: 0, effects: 0, params: 0, keyframes: 0, media: 0, audio: 0, bookmarks: 0, kinds: {} };
        (function j(s) {
            var ls = (s && s.layers) || [];
            for (var i = 0; i < ls.length; i++) {
                var L = ls[i];
                h.layers++;
                var k = (L.content && L.content.kind) || L.tag || 'unknown';
                h.kinds[k] = (h.kinds[k] || 0) + 1;
                var ef = L.effects || [];
                for (var j2 = 0; j2 < ef.length; j2++) {
                    h.effects++;
                    var ps = ef[j2].params || [];
                    for (var p = 0; p < ps.length; p++) {
                        h.params++;
                        h.keyframes += ((ps[p].channel && ps[p].channel.kfs) || ps[p].kfs || []).length;
                    }
                }
                if (L.scene) j(L.scene);
                j(L);
            }
        })(S);
        h.media = (S.media || []).length;
        h.audio = (S.audio || []).length;
        h.bookmarks = (S.bookmarks || []).length;
        /* motion.py: keyframe dihitung dari SELURUH kanal yang dianimasikan
           (transform, size, sudut, gain, property bentuk, stroke, path) —
           sebelumnya hanya parameter efek, sehingga angkanya jauh lebih kecil
           dari isi XML sebenarnya. */
        var kfSemua = 0;
        function cacahKanal(ch, d) {
            if (!ch || d > 4) return;
            if (Array.isArray(ch)) { for (var i = 0; i < ch.length; i++) cacahKanal(ch[i], d + 1); return; }
            if (typeof ch !== 'object') return;
            if (Array.isArray(ch.kfs)) { kfSemua += ch.kfs.length; return; }
            for (var n in ch) {
                if (n === 'scene' || n === 'layers' || n === 'children' || n === 'effects'
                    || n === 'parent' || n === 'parentLayer' || n === 'raw') continue;
                cacahKanal(ch[n], d + 1);
            }
        }
        (function jalanSemua(s) {
            var ls = (s && s.layers) || [];
            for (var i = 0; i < ls.length; i++) {
                var L = ls[i];
                for (var n2 in L) {
                    if (n2 === 'scene' || n2 === 'effects' || n2 === 'raw' || n2 === 'parentLayer') continue;
                    cacahKanal(L[n2], 0);
                }
                var ef = L.effects || [];
                for (var e = 0; e < ef.length; e++) {
                    var ps = ef[e].params || [];
                    for (var p = 0; p < ps.length; p++) cacahKanal(ps[p].channel || ps[p], 0);
                }
                if (L.scene) jalanSemua(L.scene);
            }
            var au = (s && s.audio) || [];
            for (var a = 0; a < au.length; a++) cacahKanal(au[a], 0);
        })(S);
        h.keyframes = kfSemua;
        return h;
    }
    function laporan(S, nama) {
        if (!cap) buka();
        var c = capability();
        var h = hitung(S);
        var R = {
            nama: nama || (S && S.filename) || '',
            w: S.width, h: S.height, aspect: S.aspectRatio, orientation: S.orientation,
            fps: S.fps, fpsRaw: S.rawFps === undefined ? null : S.rawFps,
            widthRaw: S.rawWidth === undefined ? null : S.rawWidth,
            heightRaw: S.rawHeight === undefined ? null : S.rawHeight,
            totalTimeRaw: S.rawTotalTime === undefined ? null : S.rawTotalTime,
            durationMs: S.totalTime,
            frames: Math.round(S.totalTime / 1000 * S.fps),
            layers: h.layers, effects: h.effects, params: h.params, keyframes: h.keyframes,
            media: h.media, audio: h.audio, bookmarks: h.bookmarks, kinds: h.kinds,
            fallbacks: S.fallbacks || [],
            capability: c,
            supported: c.supported, partial: c.partial, unsupported: c.unsupported
        };
        return { report: R, capability: c, hitung: h };
    }
    function kanonKfs(list) {
        return (list || []).map(function (f) {
            var w = waktuKf(f && f.rawT !== undefined && f.rawT !== null ? f.rawT : (f ? f.t : null));
            return { tMs: w.ms, rawT: w.raw, unit: w.unit, v: f ? f.v : null, e: f && f.e !== undefined ? f.e : null };
        });
    }
    function kanonKanal(K) {
        if (!K) return null;
        return { value: K.value || [], kfs: kanonKfs(K.kfs || []) };
    }
    function kanonTransform(T) {
        if (!T) return null;
        var o = {};
        for (var k in T) if (Object.prototype.hasOwnProperty.call(T, k)) o[k] = kanonKanal(T[k]);
        return o;
    }
    function kanonParam(P) {
        return {
            id: P.id === undefined ? '' : P.id,
            name: P.name || P.id || '',
            type: P.type || P.dataType || 'unknown',
            value: P.channel ? P.channel.value : (P.value === undefined ? null : P.value),
            kfs: kanonKfs(P.channel ? P.channel.kfs : P.kfs),
            partial: !!P.partial,
            raw: P.raw || null
        };
    }
    function kanonEfek(E) {
        return {
            id: E.id || '', shortId: E.shortId || E.id || '',
            name: E.name || E.id || '', type: E.type || '',
            locallyApplied: E.locallyApplied !== false, hidden: !!E.hidden, disabled: !!E.disabled,
            params: (E.params || []).map(kanonParam),
            unsupported: E.unsupported || [], partial: !!E.partial
        };
    }
    function kanonLayer(L) {
        var C = L.content || {};
        return {
            order: L.order | 0, tag: L.tag || '', kind: C.kind || L.tag || 'unknown',
            id: L.id || '', label: L.label || '',
            parentId: L.parentId || '', childIds: (L.childIds || []).slice(),
            parentMissing: !!L.parentMissing,
            startTime: L.startTime || 0, endTime: L.endTime || 0,
            durationMs: (L.endTime || 0) - (L.startTime || 0),
            inTime: L.inTime || 0, outTime: L.outTime || 0,
            hidden: !!L.hidden, speed: L.speed === undefined ? 1 : L.speed, link: L.link || '',
            blendMode: L.blendMode || 'normal',
            blendModeCanonical: L.blendModeCanonical || L.blendMode || 'normal',
            blendModeRaw: L.blendModeRaw === undefined ? null : L.blendModeRaw,
            shapeType: L.shapeType || '', cornerRadius: L.cornerRadius || 0, fov: L.fov || 0,
            transform: kanonTransform(L.transform),
            size: kanonKanal(L.size),
            fill: C.fill || null,
            text: C.text !== undefined ? C.text : (L.textContent || ''),
            font: C.font || null,
            media: C.media || null,
            mask: C.mask || null,
            shadow: C.shadow || null,
            gain: kanonKanal(C.gain),
            gradient: L.gradient || null, path: L.path || null, pathStroke: L.pathStroke || null,
            border: L.border || null, strokes: L.strokes || [],
            startAngle: kanonKanal(L.startAngle), endAngle: kanonKanal(L.endAngle),
            shapeProps: L.shapeProps || {},
            effects: (L.effects || []).map(kanonEfek),
            children: (L.children || []).map(kanonLayer),
            scene: L.scene ? kanonScene(L.scene) : null,
            unsupported: L.unsupported || [],
            raw: L.raw || null
        };
    }
    function kanonScene(S) {
        return {
            composition: {
                width: S.width, height: S.height, fps: S.fps,
                durationMs: S.totalTime, aspect: S.aspectRatio, orientation: S.orientation,
                title: S.title || '', bgcolor: S.bgcolor || [0, 0, 0, 1]
            },
            layers: (S.layers || []).map(kanonLayer),
            assets: {
                media: (S.media || []).map(function (m) {
                    return { uri: m.uri, type: m.type, filename: m.filename, title: m.title, durationMs: m.durationMs, durationUnit: m.durationUnit, width: m.width, height: m.height, size: m.size, fps: m.fps };
                }),
                audio: (S.audio || []).map(function (a) {
                    return { id: a.id, label: a.label, src: a.src, startTime: a.startTime, endTime: a.endTime, inTime: a.inTime, outTime: a.outTime, volume: a.volume };
                }),
                bookmarks: (S.bookmarks || []).slice()
            },
            metadata: S.metadata || {},
            fallbacks: S.fallbacks || [],
            unsupported: S.unsupported || [],
            raw: S.raw || null
        };
    }
    function proyek(S, nama) {
        var c = capability();
        var P = kanonScene(S);
        P.version = 1;
        P.filename = nama || (S && S.filename) || '';
        P.capability = c;
        P.report = laporan(S, nama).report;
        return P;
    }
    /* Pengklasifikasi dari model kanonik saja (tanpa pengumpul langsung).
       Dipakai UI untuk assess file yang belum diimpor atau yang kanesional
       datang dari luar. */
    function klasifikasi(P) {
        var s = [], p = [], u = [], seenS = {}, seenP = {}, seenU = {};
        var tambah = function (arr, seen, kunci, ket) {
            if (!seen[kunci]) { seen[kunci] = 1; arr.push(ket ? kunci + ' - ' + ket : kunci); }
        };
        if (!P || !P.composition) return { supported: s, partial: p, unsupported: u };
        var C = P.composition;
        tambah(s, seenS, 'composition', C.width + 'x' + C.height + ' @' + C.fps + 'fps');
        (P.fallbacks || []).forEach(function (f) { tambah(p, seenP, 'composition.' + f, 'memakai bawaan'); });
        (function layer(L) {
            tambah(s, seenS, 'layer.' + (L.kind || L.tag));
            if (L.blendModeRaw !== null && L.blendModeRaw !== undefined &&
                L.blendModeCanonical && String(L.blendModeRaw).trim().toLowerCase() !== L.blendModeCanonical) {
                tambah(p, seenP, 'layer.blendMode', String(L.blendModeRaw) + ' -> ' + L.blendModeCanonical);
            }
            (L.effects || []).forEach(function (E) {
                tambah(s, seenS, 'effect', E.id);
                if (E.partial) tambah(p, seenP, 'effect.partial', E.id);
                (E.params || []).forEach(function (Pr) {
                    if (Pr.partial) tambah(p, seenP, 'effect.param.type', (Pr.id || '?') + ':' + Pr.type);
                    else tambah(s, seenS, 'effect.param.' + Pr.type, Pr.id || '');
                });
                (E.unsupported || []).forEach(function (X) { tambah(u, seenU, 'effect.child.' + String(X.tag || '').toLowerCase()); });
            });
            (L.unsupported || []).forEach(function (X) { tambah(u, seenU, 'layer.child.' + String(X.tag || '').toLowerCase()); });
            (L.children || []).forEach(layer);
            if (L.scene) (L.scene.layers || []).forEach(layer);
        });
        (function semua(L) {
            if (!L) return;
            layer(L);
            (L.children || []).forEach(semua);
            if (L.scene) (L.scene.layers || []).forEach(semua);
        });
        P.layers.forEach(function (L) { semua(L); });
        return { supported: s, partial: p, unsupported: u };
    }
    /* ============ 12. entry XML -> kanonik ============ */
    function cariScene(doc) {
        var root = doc.documentElement;
        if (root && String(root.tagName || '').toLowerCase() === 'scene') return root;
        var s = doc.getElementsByTagName('scene');
        return s && s.length ? s[0] : null;
    }
    function pesanParsererror(doc) {
        var pe = null;
        try { pe = doc.getElementsByTagName('parsererror'); } catch (e) { pe = null; }
        if (!pe || !pe.length) return null;
        var t = '';
        try { t = pe[0].textContent || ''; } catch (e) { t = ''; }
        t = String(t).replace(/\s+/g, ' ').trim();
        return t.length > 240 ? t.slice(0, 240) + '...' : t;
    }
    /* Pipa lengkap: teks XML -> { scene, report, project }.
       Dilempar Error (bukan return null) supaya kegagalan terlihat terang. */
    function imporTeks(text, nama) {
        var label = nama || 'XML';
        if (typeof text !== 'string' || !text.trim()) throw new Error(label + ': teks XML kosong.');
        if (typeof DOMParser !== 'function') throw new Error(label + ': DOMParser tidak tersedia (harus dijalankan di browser).');
        var doc = new DOMParser().parseFromString(text, 'text/xml');
        var galat = pesanParsererror(doc);
        if (galat !== null) throw new Error(label + ': XML tidak valid' + (galat ? ' - ' + galat : '.'));
        var root = cariScene(doc);
        if (!root) throw new Error(label + ': tidak menemukan elemen <scene>.');
        buka();
        var S = bacaScene(root, nama);
        var L = laporan(S, nama);
        return { scene: S, report: L.report, capability: L.capability, project: proyek(S, nama) };
    }
    /* Versi yang tidak melempar: untuk pratinjau / UI. */
    function imporAman(text, nama) {
        try { return imporTeks(text, nama); }
        catch (e) { return { error: String(e && e.message || e), scene: null, report: null, capability: capability(), project: null }; }
    }

    /* ============ 13. format laporan (teks) ============ */
    function fmtNum(n, desimal) {
        if (n === null || n === undefined || !isFinite(n)) return '-';
        var d = desimal === undefined ? 0 : desimal;
        var f = Math.pow(10, d);
        return String(Math.round(n * f) / f);
    }
    function barisDaftar(judul, arr, batas) {
        if (!arr || !arr.length) return judul + ': (tidak ada)';
        var a = arr.slice(0, batas || arr.length);
        var s = judul + ' (' + arr.length + '): ' + a.join('; ');
        if (arr.length > a.length) s += ' ... (+' + (arr.length - a.length) + ' lagi)';
        return s;
    }
    function formatLaporan(R) {
        if (!R) return '(laporan kosong)';
        var b = [];
        b.push('Impor: ' + (R.nama || '(tanpa nama)'));
        b.push('  komposisi : ' + R.w + ' x ' + R.h + '   rasio ' + fmtNum(R.aspect, 4) + '  (' + (R.orientation || '-') + ')');
        b.push('  fps        : ' + fmtNum(R.fps, 3) + (R.fpsRaw !== null && R.fpsRaw !== undefined ? '   dari XML "' + R.fpsRaw + '"' : ''));
        b.push('  durasi     : ' + R.durationMs + ' ms = ' + fmtNum(R.durationMs / 1000, 3) + ' s = ' + R.frames + ' frame');
        if (R.fallbacks && R.fallbacks.length) b.push('  bawaan    : ' + R.fallbacks.join(', ') + ' (tidak ada di XML)');
        b.push('  isi        : ' + R.layers + ' layer, ' + R.effects + ' efek, ' + R.params + ' param, ' +
            R.keyframes + ' keyframe, ' + R.media + ' media, ' + R.audio + ' audio, ' + R.bookmarks + ' bookmark');
        if (R.kinds) {
            var k = [];
            for (var key in R.kinds) k.push(key + '=' + R.kinds[key]);
            if (k.length) b.push('  jenis      : ' + k.join(', '));
        }
        b.push(barisDaftar('  didukung   ', R.supported, 24));
        if (R.partial && R.partial.length) b.push(barisDaftar('  sebagian   ', R.partial, 12));
        if (R.unsupported && R.unsupported.length) b.push(barisDaftar('  TIDAK didukung', R.unsupported, 12));
        else b.push('  TIDAK didukung: (tidak ada)');
        return b.join('\n');
    }
    function ringkas(R) {
        if (!R) return '-';
        return R.w + 'x' + R.h + ' @' + fmtNum(R.fps, 3) + 'fps / ' + fmtNum(R.durationMs / 1000, 2) + 's / ' +
            R.layers + ' layer / ' + R.effects + ' efek / ' +
            (R.unsupported && R.unsupported.length ? R.unsupported.length + ' tak didukung' : ((R.partial && R.partial.length) ? R.partial.length + ' sebagian' : 'semua didukung'));
    }
    /* ============ 14. API internal (dipakai core & jalur bundel) ============ */
    return {
        /* normalizer */
        num: num, ms: ms, fps: fps, vec: vec, warna: warna, boolv: boolv, enums: enums, nilai: nilai,
        waktuKf: waktuKf, blend: blend, hex: hex, nol: nol, potong: potong,
        /* reader */
        buka: buka, capability: capability, dukung: dukung, sebagian: sebagian, tidak: tidak,
        bacaScene: bacaScene, bacaLayer: bacaLayer, bacaEfek: bacaEfek, bacaParams: bacaParams,
        bacaKanal: bacaKanal, bacaKanalTyped: bacaKanalTyped, bacaTransform: bacaTransform,
        /* graft: melengkapi objek yang sudah dibangun pemanggil (bundel) */
        graftScene: graftScene, graftLayer: graftLayer, graftEfek: graftEfek, graftParam: graftParam,
        tautkan: tautkan, akarInfo: akarInfo,
        /* keluaran */
        laporan: laporan, hitung: hitung, proyek: proyek,
        kanonScene: kanonScene, kanonLayer: kanonLayer, kanonKanal: kanonKanal, kanonKfs: kanonKfs,
        formatLaporan: formatLaporan, ringkas: ringkas, klasifikasi: klasifikasi,
        /* entry */
        imporTeks: imporTeks, imporAman: imporAman
    };
}
/* ==== AM-IMPORT-CORE:END ==== */

(function (global) {
    'use strict';
    var amI = amIModul();
    var API_VERSION = 1;
    function pad2(n) { return n < 10 ? '0' + n : String(n); }
    function fmtWaktu(msTotal) {
        var s = Math.max(0, Math.round((msTotal || 0) / 1000));
        var j = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), d = s % 60;
        return (j ? j + ':' + pad2(m) : String(m)) + ':' + pad2(d);
    }
    var AMImport = {
        version: API_VERSION,
        /* --- API utama --- */
        importXML: function (text, nama) { return amI.imporTeks(text, nama || 'XML'); },
        importXMLSafe: function (text, nama) { return amI.imporAman(text, nama || 'XML'); },
        /* --- analisis --- */
        assessText: function (text, nama) {
            var R = amI.imporAman(text, nama || 'XML');
            if (R.error) return { ok: false, error: R.error };
            return { ok: true, nama: nama || '', report: R.report, capability: R.capability, summary: amI.ringkas(R.report) };
        },
        assessProject: function (project) {
            var k = amI.klasifikasi(project);
            return { supported: k.supported, partial: k.partial, unsupported: k.unsupported };
        },
        normalizeProject: function (obj) {
            if (obj && typeof obj.normalize === 'function') return obj.normalize();
            if (obj && obj.composition) return obj;
            return null;
        },
        /* --- laporan --- */
        formatReport: function (R) { return amI.formatLaporan(R); },
        reportSummary: function (R) { return amI.ringkas(R); },
        formatTime: fmtWaktu,
        list: function (opts) {
            var o = opts || {}, kosong = { files: [], total: 0 };
            if (o && Array.isArray(o.files)) {
                var out = [];
                for (var i = 0; i < o.files.length; i++) {
                    var f = o.files[i], nama = typeof f === 'string' ? f : (f && f.name) || '';
                    var a = amI.imporAman(f && f.text !== undefined ? f.text : '', nama);
                    if (a.error) { out.push({ file: nama, ok: false, error: a.error }); continue; }
                    out.push({ file: nama, ok: true, summary: amI.ringkas(a.report), report: a.report, project: a.project });
                }
                kosong.files = out;
                kosong.total = out.filter(function (x) { return x.ok; }).length;
                return kosong;
            }
            return kosong;
        },
        report: {
            format: amI.formatLaporan,
            summary: amI.ringkas,
            classify: amI.klasifikasi
        },
        /* --- normalizer yang sering dipakai UI --- */
        normalize: {
            ms: amI.ms, fps: amI.fps, num: amI.num, vec: amI.vec,
            color: amI.warna, bool: amI.boolv, keyframeTime: amI.waktuKf, blend: amI.blend
        },
        /* --- akses data --- */
        scene: amI.bacaScene,
        graftScene: amI.graftScene, graftLayer: amI.graftLayer, graftEfek: amI.graftEfek,
        /* --- internals untuk jalur bundel & uji --- */
        internal: amI,
        _internal: amI
    };
    var host = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null);
    if (host) {
        host.AMImport = AMImport;
        if (!host.AM_UI__) host.AM_UI__ = {};
        if (!host.AM_UI__.amimport) host.AM_UI__.amimport = AMImport;
    }
    if (typeof module !== 'undefined' && module.exports) module.exports = AMImport;
    if (typeof globalThis !== 'undefined' && !globalThis.AMImport) globalThis.AMImport = AMImport;
    if (typeof window !== 'undefined' && !window.AMImport) window.AMImport = AMImport;
    if (typeof window !== 'undefined' && !window.AMImportDone) {
        window.AMImportDone = true;
        if (window.console && typeof window.console.log === 'function') {
            window.console.log('[am-import] siap - AMImport v' + API_VERSION + ' (laporan = teks/xml/capability)');
        }
    }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
