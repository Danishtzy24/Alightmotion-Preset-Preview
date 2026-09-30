/* ═══════════════════════════════════════════════════════════════════════════
   ui/editor-ui.js — lapisan interaksi "studio" untuk AM Preset Player.

   Aturan main (msg 8):
   • TIDAK ada id/kelas/DOM milik bundel yang diubah, dipindah, atau dihapus.
     Semua yang di sini adalah elemen TAMBAHAN (kelas berawalan `amx-`).
   • Mesin preset & perilaku rendering tidak disentuh. Kotak seleksi digambar di
     kanvas overlay sendiri; kanvas pratinjau (#view) tidak pernah ditulisi.
   • Geometri layer diambil dari mesin lewat window.__AMUI.geo (jembatan pasif
     yang dipasang patch-app.js) — jadi posisi kotak selalu sama dengan yang
     benar-benar digambar, termasuk hasil animasi.

   Yang dikerjakan berkas ini:
     1. keadaan seleksi (satu / banyak), titik jangkar, hover
     2. kanvas overlay: bingkai tipis, gagang sudut/tepi, nama layer, titik poros
     3. sinkronisasi 4 arah: kanvas ↔ timeline ↔ pohon scene ↔ inspektur
     4. papan ketik: Ctrl/Cmd+A · Esc · Del/Backspace (sembunyikan) · Ctrl/Cmd+D (info)
     5. bilah pratinjau mengambang: Fit · zoom −/+ · layar penuh · snap
     6. bilah kontekstual di dekat seleksi
     7. inspektur: ringkasan multi-pilih + "Transform (terukur dari mesin)"

   Catatan kinerja: rAF hanya hidup saat ada seleksi DAN (sedang diputar atau
   ada hover). Tidak ada polling; semua penulisan DOM dikumpulkan per bingkai.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
    "use strict";
    if (window.__AMX_LOADED) return;
    window.__AMX_LOADED = true;

    var $ = function (s, r) { return (r || document).querySelector(s); };
    var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
    /* Geometri = catatan dari bingkai mesin TERAKHIR yang benar-benar digambar.
       Catatan lama (lapisan yang tidak digambar pada bingkai itu) DIBUANG —
       kalau tidak, gizmo bisa menampilkan kotak basi dari waktu sebelumnya.
       `pass` naik per catatan, jadi kesegaran dinilai dari stempel waktu. */
    var EM = {};
    /* ── waktu playhead & keaktifan layer ────────────────────────────────────
       Seleksi ≠ aktif. Sebuah layer bisa tetap terpilih sementara playhead sudah
       keluar dari rentang waktunya; gizmo-nya HARUS hilang saat itu. Dua syarat
       dipakai bersama (yang pertama sudah menjadi bukti kuat, yang kedua bikin
       semantiknya eksplisit dan tahan saat penanda bingkai tidak tersedia):

         1. geometri berasal dari bingkai render TERAKHIR (mesin hanya menggambar
            layer yang aktif pada waktu itu) — lihat penanda `f`;
         2. rentang waktu layer sendiri (startTime..endTime) memuat playhead.
            Hanya untuk layer tingkat-atas: anak scene bersarang memakai basis
            waktu scene-nya sendiri, jadi keaktifannya cukup dari syarat 1. */
    /* Waktu acuan = waktu animasi bingkai yang TERAKHIR DILUKIS (diambil dari
       catatan geometri), bukan nilai #seek — nilai itu bisa sejalan satu bingkai
       di depan geometri yang sedang tampil. Dipakai supaya keputusan
       "aktif/tidak" selalu konsisten dengan bingkai yang dilihat pengguna. */
    var frameMs = null, tCacheV = null, tCacheN = NaN;
    function bingkaiMs() { return frameMs; }
    function playheadMs() {
        var se = $("#seek");
        if (!se || se.value == null || se.value === "") return null;
        var v = se.value;
        if (v === tCacheV) return tCacheN;
        var n = parseFloat(v);
        tCacheV = v; tCacheN = isFinite(n) ? n : null;
        return tCacheN;
    }
    function aktifPadaWaktu(g, tMs) {
        if (g.nest) return true;                        /* anak scene: syarat 1 saja */
        if (g.st == null || g.et == null || tMs == null) return true;
        return tMs >= g.st - 1 && tMs <= g.et + 1;
    }
    function geoMap() {
        var am = window.__AMUI;
        if (!am || !am.geo) return EM;
        /* Bingkai render terbaru = nomor bingkai tertinggi yang tercatat.
           Catatan dari bingkai lama dibuang; kalau penanda bingkai tidak ada
           (bundel lama), jatuh ke jendela waktu sebagai cadangan. */
        var fMax = -1, tMax = am.t || 0, k2;   /* eslint-disable-line */
        for (k2 in am.geo) { var g2 = am.geo[k2]; if (g2 && g2.f != null && g2.f > fMax) fMax = g2.f; }
        /* waktu bingkai terakhir (satu lintasan): dipakai untuk uji keaktifan */
        var tmFrame = null;
        for (k2 in am.geo) { var g3 = am.geo[k2]; if (g3 && g3.f === fMax && g3.tm != null) { tmFrame = g3.tm; break; } }
        frameMs = tmFrame;
        var tNow = tmFrame != null ? tmFrame : playheadMs();
        var out = null;
        for (var k in am.geo) {
            var g = am.geo[k];
            if (!g || !g.w || g.a0 == null) continue;
            var segar = (fMax >= 0 && g.f != null)
                ? (g.f >= fMax)
                : (g.t == null || tMax - g.t <= 12);
            if (segar && aktifPadaWaktu(g, tNow)) { (out || (out = {}))[k] = g; }
        }
        return out || EM;
    }

    /* ── keadaan ─────────────────────────────────────────────────────────── */
    /* Saklar QA: halaman yang sama tanpa lapisan UI (?ui=0) — dipakai untuk
       mengukur biaya lapisan ini secara jujur (A/B), bukan untuk produksi. */
    if (/[?&]ui=0(&|$)/.test(location.search)) { window.__AMUI_OFF = 1; return; }

    var S = {
        sel: [],            // urutan terpilih (id string)
        anchor: null,       // id terakhir yang dipilih → dipakai inspektur
        hover: null,
        snap: true,
        zoom: 1,
        playing: false,
        raf: 0,
        dirty: true,
        notice: "",
        noticeUntil: 0,
        lastInsp: 0,
    };

    var COLOR = {};
    /* keadaan editor (satu sumber): fps & resolusi komposisi, mode layar penuh */
    S.fps = 30; S.shortEdge = null; S.render = 720; S.tandaProyek = null;
    S.pref = null; S.prefSiap = false; S.ubahManual = false; S.percobaanPref = 0; S.kompW = null; S.kompH = null; S.proyekSe = null; S.fs = 0; S.fsMute = false;         // id → warna (dibaca dari petak warna di timeline)
    /* ── keadaan tambahan untuk komposisi hasil impor ──
         S.fpsManual     → fps diubah lewat panel (langkah bingkai ikut)
         S.expPilih      → #expRes/#expFps sudah disentuh pengguna (jangan ditimpa)
         S.expTulis      → penanda: perubahan di bawah datang dari kita sendiri
         S.tlZoomManual  → zoom timeline sudah diubah pengguna
         S.rulerOtomatis → klik #tl-fit berikutnya datang dari kita (bukan pengguna) */
S.fpsManual = false; S.expPilih = false; S.expTulis = 0;
S.tlZoomManual = false; S.rulerOtomatis = 0;
/* DOCK dideklarasikan di sini (bukan di blok DAPUR bawah) karena boot() →
   buildUI() → dockBangun() berjalan sebelum eksekusi mencapai bawah berkas;
   var yang belum dieksekusi = undefined → DOCK.siap meledak dan window.AMX
   tidak pernah terbentuk. */
var DOCK_KEY = "amDock.v1", DOCK_MIN = 160, DOCK_MAX = 520, DOCK_DEF = 300;
var DOCK = { h: DOCK_DEF, elemen: false, geser: 0, geserPx: 0, y0: 0, h0: 0, siap: 0 };

    /* ── komposisi ────────────────────────────────────────────────────────────
       SATU SUMBER untuk pratinjau · timeline · gizmo · ekspor.
       Prioritas nilai (tidak ada angka yang dipaksa):
         1. XML hasil impor  — window.__AMImport.project  (bentuk bebas)
         2. state mesin      — window.AM.getState()
         3. cadangan 1080 × 1920 @ 30 fps — HANYA kalau 1 dan 2 sama-sama kosong
       Resolusi dipakai apa adanya: tidak ada 512×512, tidak ada 1920×1080,
       tidak ada kasus khusus per rasio. Potret/lanskap/persegi hanya berbeda
       di sisi pendeknya, dan itu sudah tertangani rumus fit di bagian syncOverlay.
       ────────────────────────────────────────────────────────────────────────── */
    var KOMP_CADANGAN = { w: 1080, h: 1920, fps: 30, durasiMs: 0, judul: "", asal: "cadangan" };
    var KOMP = null;
    var LENCANA_TEKS = null;

    function angka(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
    /* nama kunci yang mungkin dipakai importer untuk satu nilai */
    function nilaiDari(o, nama) {
        if (!o || typeof o !== "object") return 0;
        for (var i = 0; i < nama.length; i++) { var n = angka(o[nama[i]]); if (n) return n; }
        return 0;
    }
    var KUNCI_W = ["w", "width", "pxW", "lebar"];
    var KUNCI_H = ["h", "height", "pxH", "tinggi"];
    var KUNCI_FPS = ["fps", "frameRate", "frame_rate", "rate"];
    var KUNCI_DUR = ["durasiMs", "durationMs", "totalTime", "total_time", "duration", "durasi"];
    /* tempat ukuran komposisi bisa bersembunyi di dalam objek impor */
    function anakDari(p) {
        return [p, p && p.scene, p && p.size, p && p.canvas, p && p.meta,
                p && p.info, p && p.project, p && p.header];
    }
    function dariXML() {
        var im = window.__AMImport || window.AMImport;
        var p = im && (im.project || im);
        if (!p || typeof p !== "object") return null;
        var s = anakDari(p), w = 0, h = 0, i, fps = 0, dur = 0, judul = "";
        for (i = 0; i < s.length && !(w > 0 && h > 0); i++) { w = nilaiDari(s[i], KUNCI_W); h = nilaiDari(s[i], KUNCI_H); }
        if (!(w > 0 && h > 0)) return null;              /* impor tanpa ukuran → andalkan state mesin */
        for (i = 0; i < s.length && !(fps > 0); i++) fps = nilaiDari(s[i], KUNCI_FPS);
        for (i = 0; i < s.length && !(dur > 0); i++) dur = nilaiDari(s[i], KUNCI_DUR);
        for (i = 0; i < s.length && !judul; i++) {
            var t = s[i] && (s[i].title || s[i].name || s[i].label);
            if (t) judul = String(t);
        }
        /* durasi dalam detik (kecil dari 1000) tetap diterima → ms.
           Nilai yang tak masuk akal (mis. satuan lain) diabaikan supaya
           rentang #seek tidak meledak; durasi lalu diambil dari state mesin. */
        if (dur > 0 && dur < 1000) dur *= 1000;
        if (dur > 86400000) dur = 0;                       /* > 24 jam → bukan milidetik */
        return {
            w: w, h: h,
            fps: (fps > 0 && fps <= 240) ? Math.round(fps) : 0,
            durasiMs: Math.round(dur), judul: judul, asal: "xml"
        };
    }
    function hitungKomposisi() {
        const active=window.__AMRenderer?.scene;if(active&&active.width>0&&active.height>0)return {w:active.width,h:active.height,fps:active.fps||30,durasiMs:active.totalTime||0,judul:active.title||"",asal:"mesin-aktif"};
        var k = { w: 0, h: 0, fps: 0, durasiMs: 0, judul: "", asal: "" };
        var x = dariXML(), pr = kondisiProyek();
        if (x) { k.w = x.w; k.h = x.h; k.fps = x.fps; k.durasiMs = x.durasiMs; k.judul = x.judul; k.asal = "xml"; }
        if (pr) {                                       /* mesin melengkap apa yang kurang */
            if (!k.w) { k.w = pr.w; k.h = pr.h; k.asal = k.asal || "mesin"; }
            if (!k.fps) k.fps = pr.fps;
            if (!k.durasiMs) k.durasiMs = pr.durasiMs;
            if (!k.judul) k.judul = pr.judul;
            if (!k.asal) k.asal = "mesin";
        }
        if (!(k.w > 0 && k.h > 0)) { k.w = KOMP_CADANGAN.w; k.h = KOMP_CADANGAN.h; k.asal = k.asal || KOMP_CADANGAN.asal; }
        if (!(k.fps > 0)) k.fps = KOMP_CADANGAN.fps;
        k.durasiMs = k.durasiMs > 0 ? Math.round(k.durasiMs) : 0;
        return k;
    }
    /* di-cache supaya pembacaan per-bingkai tetap murah; cache di-refresh hanya
       oleh sinkronKeProyek() yang memanggil hitungKomposisi() secara langsung */
    function komposisi() { const r=window.__AMRenderer?.scene;if(!KOMP || (r&&(KOMP.w!==r.width||KOMP.h!==r.height||KOMP.fps!==r.fps||KOMP.durasiMs!==r.totalTime||KOMP.judul!==(r.title||""))))KOMP=hitungKomposisi();return KOMP;}
    function tandaKomposisi() {
        var k = komposisi();
        return k.w + "x" + k.h + "@" + k.fps + "#" + k.durasiMs + "|" + k.asal;
    }
    /* fps untuk langkah bingkai & pembacaan waktu: pilihan panel tetap menang */
    function fpsProyek() {
        if (S.fpsManual && S.fps > 0) return S.fps;
        var k = komposisi();
        return (k.fps > 0 ? k.fps : (S.fps || 30));
    }

    /* ---- tanda tangan impor: objek baru ATAU isi berubah di tempat ---- */
    function tandaIsi(p) {
        if (p == null) return "-";
        if (typeof p === "string") return "s" + p.length + ":" + p.slice(0, 48);
        if (typeof p !== "object") return "?";
        var s = anakDari(p), w = 0, h = 0, f = 0, d = 0, i;
        for (i = 0; i < s.length; i++) {
            if (!w) w = nilaiDari(s[i], KUNCI_W);
            if (!h) h = nilaiDari(s[i], KUNCI_H);
            if (!f) f = nilaiDari(s[i], KUNCI_FPS);
            if (!d) d = nilaiDari(s[i], KUNCI_DUR);
        }
        return w + "x" + h + "@" + f + "#" + d;
    }
    function tandaImpor() {
        var im = window.__AMImport;
        if (!im) return "tanpa-impor";
        return tandaIsi(im.project) + "+" + jumlahTidakDidukung();
    }

    /* ---- fitur native tak didukung: SATU BARIS di layar, rincian ke konsol ---- */
    function daftarTidakDidukung() {
        var im = window.__AMImport;
        var u = im && im.report && im.report.unsupported;
        if (!u || typeof u !== "object") return null;
        if (typeof u.length === "number") return u;                    /* array / array-like */
        for (var kk in u) return u;                                    /* peta: satu kunci = satu fitur */
        return null;
    }
    function jumlahTidakDidukung() {
        var u = daftarTidakDidukung();
        if (!u) return 0;
        if (typeof u.length === "number") return u.length;
        var n = 0, kk; for (kk in u) { if (Object.prototype.hasOwnProperty.call(u, kk)) n++; }
        return n;
    }
    function perbaruiLencana() {
        if (!UI.lencana) return;
        var n = jumlahTidakDidukung();
        if (!n) {                                    /* disembunyikan lagi begitu impor bersih */
            if (LENCANA_TEKS) { LENCANA_TEKS = ""; UI.lencana.classList.remove("show"); UI.lencana.textContent = ""; }
            return;
        }
        var t = n + " efek tidak didukung · sisa lapisan tetap dirender";
        if (t === LENCANA_TEKS) return;              /* teks sama → jangan sentuh DOM */
        LENCANA_TEKS = t;
        UI.lencana.textContent = t;
        UI.lencana.classList.add("show");
        try { console.info("[AMX] " + n + " fitur native tidak didukung:", daftarTidakDidukung()); } catch (e) { }
    }

    /* ── util ────────────────────────────────────────────────────────────── */
    function keyOf(el) { return el && el.getAttribute ? (el.getAttribute("data-key") || null) : null; }

    function trackOf(key) {
        return $('.tl-label[data-key="' + key + '"]');
    }
    function rowOf(key) {
        return $('.st-row[data-key="' + key + '"]');
    }
    function blockOf(key) {
        return $('.tl-block[data-key="' + key + '"]');
    }
    /* semua lapisan pada tampilan sekarang: gabungan timeline + pohon scene
       (urutan mengikuti timeline, karena itulah yang dilihat pengguna). */
    function allKeys() {
        var out = [], seen = {};
        $$(".tl-label[data-key]").forEach(function (l) {
            var k = keyOf(l);
            if (k && !seen[k]) { seen[k] = 1; out.push(k); }
        });
        $$("#scene-tree-list .st-row[data-key]").forEach(function (r) {
            var k = keyOf(r);
            if (k && !seen[k]) { seen[k] = 1; out.push(k); }
        });
        return out;
    }
    function nameOf(key) {
        var l = trackOf(key) || rowOf(key);
        if (!l) return key;
        var n = $(".st-name", l) || $("span:not(.tl-thumb):not(.tl-count)", l);
        var t = (n ? n.textContent : l.getAttribute("title") || key).trim();
        return t || key;
    }
    function colorOf(key) {
        if (COLOR[key]) return COLOR[key];
        var b = blockOf(key) || rowOf(key);
        var dot = rowOf(key) ? $(".li-dot, .st-icon", rowOf(key)) : null;
        var c = "";
        try {
            if (dot) c = getComputedStyle(dot).backgroundColor;
            if ((!c || c === "rgba(0, 0, 0, 0)") && b) c = getComputedStyle(b).backgroundColor;
        } catch (e) { c = ""; }
        if (!c || c === "rgba(0, 0, 0, 0)") c = "#8a8f98";
        COLOR[key] = c;
        return c;
    }

    /* kedalaman baris di pohon scene (jumlah garis indentasi) */
    function depthOf(row) {
        var ind = $(".st-indent", row);
        return ind ? ind.querySelectorAll(".st-indent-line").length : 0;
    }
    /* keturunan sebuah baris (untuk grup/scene: kotak = gabungan anak-anaknya) */
    /* Kerangka pohon dibangun SEKALI per lukis: sebelumnya tiap lapisan terpilih
       menjalankan query DOM sendiri (48 lapisan = 48 query/frame). */
    var FR = null;
    function frameTree() {
        var rows = $$("#scene-tree-list .st-row[data-key]");
        var keys = new Array(rows.length), depth = new Array(rows.length), idx = {};
        for (var i = 0; i < rows.length; i++) {
            keys[i] = keyOf(rows[i]);
            depth[i] = depthOf(rows[i]);
            idx[keys[i]] = i;
        }
        return { rows: rows, keys: keys, depth: depth, idx: idx };
    }
    function subKeys(key) {
        var fr = FR || (FR = frameTree());
        var i = fr.idx[key];
        if (i == null) return [];
        var d = fr.depth[i], out = [];
        for (var j = i + 1; j < fr.keys.length; j++) {
            if (fr.depth[j] <= d) break;
            out.push(fr.keys[j]);
        }
        return out;
    }

    /* ── geometri → kotak di ruang kanvas (px) ───────────────────────────── */
    /* ── geometri kotak seleksi ──────────────────────────────────────────────
       Sumber data: g.a0..a5 = matriks affine DUNIA layer pada bingkai terakhir,
       persis yang dipakai renderer untuk menempatkan layer (sudah termasuk
       kamera, pivot, skala tak-seragam, rotasi, dan rantai induk/grup):
           X = a0*cx + a2*cy + a4 ,  Y = a1*cx + a3*cy + a5
       Titik lokal layer berpusat di (0,0), jadi keempat sudutnya dihitung dari
       (±sw/2, ±sh/2) — bukan dari kotak yang disimpan saat seleksi. */
    var CX4 = [-1, 1, 1, -1], CY4 = [-1, -1, 1, 1];
    var QX = [0, 0, 0, 0], QY = [0, 0, 0, 0];      /* dipakai ulang, tanpa alokasi per bingkai */
    function corners(g) {                          /* isi QX/QY; TL,TR,BR,BL (px ruang kerja) */
        var hw = (g.sw || 0) / 2, hh = (g.sh || 0) / 2;
        var a0 = g.a0, a1 = g.a1, a2 = g.a2, a3 = g.a3, a4 = g.a4, a5 = g.a5;
        for (var i = 0; i < 4; i++) {
            var cx = CX4[i] * hw, cy = CY4[i] * hh;
            QX[i] = a0 * cx + a2 * cy + a4;
            QY[i] = a1 * cx + a3 * cy + a5;
        }
        return 4;
    }
    function quad(g) {                             /* salinan sudut (dipakai debug/uji saja) */
        if (!g || g.a0 == null) return [];
        corners(g);
        return [[QX[0], QY[0]], [QX[1], QY[1]], [QX[2], QY[2]], [QX[3], QY[3]]];
    }
    /* pembalik: titik kanvas (px) → (u,v) lokal layer, keduanya 0..1 */
    function toUV(g, x, y, scale) {
        if (!g || g.a0 == null || !scale) return null;
        var wx = x / scale - g.a4, wy = y / scale - g.a5;
        var det = g.a0 * g.a3 - g.a2 * g.a1;
        if (Math.abs(det) < 1e-9) return null;
        var cx = (wx * g.a3 - wy * g.a2) / det, cy = (wy * g.a0 - wx * g.a1) / det;
        return [g.sw ? cx / g.sw + .5 : .5, g.sh ? cy / g.sh + .5 : .5];
    }
    function boxOf(key) {                          /* gabungan (grup ikut anaknya) */
        var gm = geoMap(), keys = [key].concat(subKeys(key));
        var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, ada = false;
        for (var i = 0; i < keys.length; i++) {
            var g = gm[keys[i]];
            if (!g || g.a0 == null) continue;
            ada = true;
            corners(g);
            for (var c = 0; c < 4; c++) {
                if (QX[c] < x0) x0 = QX[c]; if (QX[c] > x1) x1 = QX[c];
                if (QY[c] < y0) y0 = QY[c]; if (QY[c] > y1) y1 = QY[c];
            }
        }
        if (!ada) return null;
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }

    /* ── elemen tambahan ─────────────────────────────────────────────────── */
    var UI = {};
    /* Klik di UI kami tidak boleh sampai ke listener #stage milik aplikasi,
       yang membalik putar/jeda. Penjaga dipasang sekali per wadah. */
    function shield(el) {
        if (!el || el.__amxShield) return el;
        el.__amxShield = 1;
        ["click", "dblclick"].forEach(function (ev) {
            el.addEventListener(ev, function (e) { e.stopPropagation(); }, false);
        });
        return el;
    }
    function buildUI() {
        var stage = $("#stage");
        if (!stage) return false;
        if (!UI.ov || !document.body.contains(UI.ov)) {
            UI.ov = document.createElement("canvas");
            UI.ov.className = "amx-overlay";
            UI.ov.setAttribute("aria-hidden", "true");
            stage.appendChild(UI.ov);
            UI.ctx = shield(document.createElement("div"));
            UI.ctx.className = "amx-ctx";
            UI.ctx.setAttribute("role", "toolbar");
            UI.ctx.setAttribute("aria-label", "Aksi seleksi");
            stage.appendChild(UI.ctx);
        }
        if (!UI.bar || !document.body.contains(UI.bar)) {
            UI.bar = shield(document.createElement("div"));
            UI.bar.className = "amx-bar";
            UI.bar.setAttribute("role", "toolbar");
            UI.bar.setAttribute("aria-label", "Alat pratinjau");
            UI.bar.innerHTML =
                '<button class="amx-btn" data-a="fit" title="Muat pratinjau ke ukuran panggung (F)">Fit</button>' +
                '<span class="amx-sep"></span>' +
                '<button class="amx-btn" data-a="out" aria-label="Perkecil pratinjau" title="Perkecil">−</button>' +
                '<span class="amx-zoomval" data-amx-zoom>100%</span>' +
                '<button class="amx-btn" data-a="in" aria-label="Perbesar pratinjau" title="Perbesar">+</button>' +
                '<span class="amx-sep"></span>' +
                '<button class="amx-btn" data-a="full" aria-label="Layar penuh" title="Layar penuh"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M16 21h3a2 2 0 0 0 2-2v-3M8 21H5a2 2 0 0 1-2-2v-3"/></svg></button>' +
                '<button class="amx-btn on" data-a="snap" aria-pressed="true" title="Snap penanda: ruler menempel ke beat terdekat dalam 6 px">Snap</button>' +
                '<span class="amx-sep"></span>' +
                '<button class="amx-btn" data-a="comp" aria-expanded="false" title="Resolusi &amp; FPS proyek">Komposisi</button>';
            stage.appendChild(UI.bar);
        }
        if (!UI.status || !document.body.contains(UI.status)) {
            UI.drawer = shield(document.createElement("button"));
            UI.drawer.type = "button";
            UI.drawer.className = "amx-drawer-btn";
            UI.drawer.setAttribute("aria-label", "Buka/tutup panel");
            UI.drawer.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3.5h12M2 8h12M2 12.5h12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg><span>Panel</span>';
            UI.scrim = shield(document.createElement("div"));
            UI.scrim.className = "amx-scrim";
            UI.status = shield(document.createElement("div"));
            UI.status.className = "amx-status";
            /* Lencana dukungan: SATU BARIS, di pojok yang berlawanan dengan
               .amx-status (kiri bawah) supaya tidak pernah bertumpuk. Elemen
               terpisah — isi .amx-status milik pengguna tidak boleh ditimpa. */
            UI.lencana = shield(document.createElement("div"));
            UI.lencana.className = "amx-status amx-badge";
            UI.lencana.setAttribute("role", "status");
            /* Gaya .amx-status berasal dari preset.html (di luar jangkauan edit),
               jadi penempatan lencana ditulis inline: pojok kanan bawah, satu
               baris, melebar seperlunya, tidak pernah menutupi .amx-status. */
            UI.lencana.style.cssText = "left:auto;right:14px;max-width:calc(100% - 28px);white-space:nowrap;overflow:hidden";
            LENCANA_TEKS = null;            /* elemen baru → isi ulang di bawah */
            stage.appendChild(UI.status);
            stage.appendChild(UI.lencana);
            stage.appendChild(UI.drawer);
            var app = $("#app");
            if (app) app.appendChild(UI.scrim);
        }
        var info = $("#layer-info");
        if (info && (!UI.multi || !document.body.contains(UI.multi))) {
            UI.multi = document.createElement("div");
            UI.multi.className = "amx-multi amx-keep";
            info.insertBefore(UI.multi, info.firstChild);
        }
        dockBangun();
        exportTutup();            /* tombol Tutup hasil export (lihat bawah) */
        perbaruiLencana();          /* aman dipanggil berulang: teks sama → DOM tak disentuh */
        return true;
    }

    /* ── seleksi ─────────────────────────────────────────────────────────── */
    function setSel(list, anchor) {
        var uniq = [], seen = {};
        (list || []).forEach(function (k) { if (k && !seen[k]) { seen[k] = 1; uniq.push(k); } });
        S.sel = uniq;
        S.anchor = anchor && seen[anchor] ? anchor : (uniq[uniq.length - 1] || null);
        S.dirty = true;
    }
    function select(k) { setSel(k ? [k] : [], k); paint(); }
    function toggle(k) {
        var i = S.sel.indexOf(k);
        if (i >= 0) { S.sel.splice(i, 1); S.anchor = S.sel[S.sel.length - 1] || null; }
        else { S.sel.push(k); S.anchor = k; }
        S.dirty = true; paint();
    }
    function extend(k) {
        var keys = allKeys(), a = S.sel.length ? keys.indexOf(S.anchor) : -1, b = keys.indexOf(k);
        if (a < 0 || b < 0) return select(k);
        var anchor=S.anchor, lo = Math.min(a, b), hi = Math.max(a, b), out = [];
        for (var i = lo; i <= hi; i++) if (out.indexOf(keys[i]) < 0) out.push(keys[i]);
        setSel(out, anchor); paint();
    }
    function selectAll() {
        var keys = allKeys();
        if (!keys.length) return;
        setSel(keys, keys[0]);
        var nGeo = keys.filter(function (k) { return geoMap()[k]; }).length;
        flash(keys.length + " lapisan dipilih" + (nGeo < keys.length ? " · " + nGeo + " tampak di kanvas" : ""), 2400);
        paint();
    }
    function clearSel() { setSel([], null); paint(); }

    /* memberi tahu aplikasi layer mana yang "aktif" (agar inspektur bawaan ikut) */
    var driving = false;
    function drive(key) {
        if (driving || !key) return;
        var row = rowOf(key) || trackOf(key);
        if (!row) return;
        var appSel = keyOf($(".st-row.st-sel") || $(".tl-label.sel"));
        if (appSel === key) return;
        driving = true;
        try { row.dispatchEvent(new MouseEvent("click", { bubbles: true })); } catch (e) { }
        driving = false;
    }

    /* ── lukis keadaan ke DOM ────────────────────────────────────────────── */
    function paint() {
        FR = frameTree();
        var selSet = {};
        S.sel.forEach(function (k) { selSet[k] = 1; });

        $$(".amx-sel").forEach(function (el) {
            var k = keyOf(el);
            if (!k || !selSet[k]) el.classList.remove("amx-sel");
        });
        S.sel.forEach(function (k) {
            var l = trackOf(k);
            if (l) {
                l.classList.add("amx-sel");
                var tr = l.closest(".tl-track");
                if (tr) tr.classList.add("amx-sel");
            }
            var b = blockOf(k); if (b) b.classList.add("amx-sel");
            var r = rowOf(k); if (r) r.classList.add("amx-sel");
            ["tl-sub-label", "tl-sub-block"].forEach(function (c) {
                $$("." + c + '[data-key="' + k + '"]').forEach(function (e) { e.classList.add("amx-sel"); });
            });
        });

        var hk = S.hover;
        $$(".amx-hover").forEach(function (el) { if (keyOf(el) !== hk) el.classList.remove("amx-hover"); });
        if (hk && !selSet[hk]) {
            var l = trackOf(hk) || rowOf(hk);
            if (l) { l.classList.add("amx-hover"); var t = l.closest(".tl-track"); if (t) t.classList.add("amx-hover"); }
        }

        var info = $("#layer-info");
        if (info) info.classList.toggle("amx-multi-on", S.sel.length > 1);

        renderStatus();
        renderMulti();
        renderInspector();
        draw();
        follow();
    }

    function renderStatus() {
        if (!UI.status) return;
        var txt = "";
        if (S.sel.length === 1) txt = '<span class="amx-chip"><i style="background:' + colorOf(S.anchor) + '"></i>' + esc(nameOf(S.anchor)) + "</span>";
        else if (S.sel.length > 1) txt = '<span class="amx-chip">' + S.sel.length + " lapisan</span><span>Ctrl+A pilih semua · Esc lepas</span>";
        if (S.notice && performance.now() < S.noticeUntil) txt = '<span class="amx-chip">info</span><span>' + esc(S.notice) + "</span>";
        UI.status.innerHTML = txt;
        UI.status.classList.toggle("show", !!txt);
    }
    function flash(msg, ms) {
        S.notice = msg; S.noticeUntil = performance.now() + (ms || 1800);
        renderStatus();
        setTimeout(function () { if (performance.now() > S.noticeUntil) renderStatus(); }, (ms || 1800) + 40);
    }
    function esc(s) {
        return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
    }

    /* ringkasan multi-pilih di inspektur */
    function renderMulti() {
        if (!UI.multi) return;
        if (S.sel.length < 2) { UI.multi.innerHTML = ""; UI.multi.style.display = "none"; return; }
        UI.multi.style.display = "flex";
        var chips = S.sel.slice(0, 8).map(function (k) {
            return '<span class="amx-chip"><i style="background:' + colorOf(k) + '"></i>' + esc(short(nameOf(k))) + "</span>";
        }).join("");
        if (S.sel.length > 8) chips += '<span class="amx-chip">+' + (S.sel.length - 8) + "</span>";
        UI.multi.innerHTML =
            '<div class="amx-multi-head">Beberapa Lapisan<span class="amx-n">' + S.sel.length + "</span></div>" +
            '<div class="amx-multi-sub">Semua lapisan terpilih ditandai di kanvas, timeline, dan pohon scene. ' +
            "Pratinjau tetap berjalan; operasi ubah isi preset tidak tersedia di player ini.</div>" +
            '<div class="amx-multi-acts">' +
            '<button class="amx-pill" data-amx="hide">Sembunyikan semua</button>' +
            '<button class="amx-pill" data-amx="show">Tampilkan semua</button>' +
            '<button class="amx-pill" data-amx="focus">Fokus di timeline</button>' +
            '<button class="amx-pill" data-amx="clear">Bersihkan pilihan</button>' +
            "</div>" +
            '<div class="amx-multi-sub" style="font-family:var(--mono);font-size:.6rem;line-height:1.7">' + chips + "</div>";
    }
    function short(s) { s = String(s); return s.length > 18 ? s.slice(0, 17) + "…" : s; }

    /* inspektur: nilai nyata dari mesin (bukan angka karangan) */
    function renderInspector() {
        var info = $("#layer-info");
        if (!info || S.sel.length !== 1) { if (UI.insp) { UI.insp.remove(); UI.insp = null; } return; }
        var key = S.anchor, g = geoMap()[key];
        if (!UI.insp || !document.body.contains(UI.insp)) {
            UI.insp = document.createElement("div");
            UI.insp.className = "amx-sec amx-keep";
        }
        /* di ATAS info bawaan aplikasi: nilai terukur adalah hal pertama yang dicari */
        if (info.firstElementChild !== UI.insp) info.insertBefore(UI.insp, info.firstChild);
        var rows = [];
        var tag = (rowOf(key) ? $(".st-tag", rowOf(key)) : null);
        var head = '<div class="amx-sec-head">Transform — dari properti mesin</div>';
        var tf = g && g.tf ? g.tf : null;
        var prop = function (p, n) {
            var o = tf && tf[p];
            if (!o) return null;
            var v = o.value;
            var arr = Array.isArray(v) ? v : (v == null ? [] : [v]);
            var kfs = 0;
            try { kfs = Array.isArray(o.kfs) ? o.kfs.length : (Array.isArray(o.keyframes) ? o.keyframes.length : 0); } catch (e) { kfs = 0; }
            return { arr: arr.map(function (x) { return +(+x).toFixed(3); }).slice(0, n || 4), kfs: kfs };
        };
        var loc = prop("location", 3), scl = prop("scale", 3), rot = prop("rotation", 2),
            opa = prop("opacity", 2), piv = prop("pivot", 3);
        if (loc) rows.push(row("Posisi", loc.arr.join(" , ") + kfTag(loc.kfs)));
        if (scl) rows.push(row("Skala", scl.arr.slice(0, 2).join(" × ") + kfTag(scl.kfs)));
        if (rot) rows.push(row("Rotasi", (rot.arr[0] || 0).toFixed(2) + "°" + kfTag(rot.kfs)));
        if (opa) rows.push(row("Opasitas", (opa.arr[0] * 100).toFixed(0) + "%" + kfTag(opa.kfs)));
        if (piv) rows.push(row("Poros", piv.arr.slice(0, 2).join(" , ") + kfTag(piv.kfs)));

        if (g) {
            /* pusat = titik (0,0) lokal layer lewat matriks dunia yang sama
               dengan gizmo (dulu memakai rumus kotak tersimpan → NaN) */
            var cx = g.a0 != null ? g.a4 : NaN, cy = g.a0 != null ? g.a5 : NaN;
            rows.push(row("Pusat (kanvas)", px(cx) + " , " + px(cy), true));
            rows.push(row("Kotak layar", px(g.sw) + " × " + px(g.sh), true));
            if (g.st != null && g.et != null) rows.push(row("Rentang", s(g.st) + " → " + s(g.et)));
        } else {
            rows.push(row("Kanvas", "belum digambar pada bingkai ini", true));
        }
        var blk = blockOf(key), kft = blk ? (blk.getAttribute("title") || "") : "";
        if (kft) rows.push(row("Keyframe", esc(kft.replace(/^[0-9]+ - /, ""))));
        rows.push(row("Efek", g && g.fxn != null ? String(g.fxn) : "—"));
        /* ── Metadata: identitas & posisi di struktur (baca-saja) ── */
        var fr = FR || (FR = frameTree());
        var mi = fr.idx[key], mrows = [];
        mrows.push(row("ID", key + kfTag(0)));
        if (mi != null) {
            mrows.push(row("Posisi pohon", (mi + 1) + " / " + fr.keys.length));
            mrows.push(row("Kedalaman", String(fr.depth[mi])));
        }
        if (g && g.nch != null) mrows.push(row("Anak", String(g.nch)));
        if (g && g.fxn != null) mrows.push(row("Efek", String(g.fxn)));
        var th = (blk && blk.querySelector) ? blk.querySelector(".tl-thumb img, .tl-thumb video, .tl-thumb canvas") : null;
        var src = "";
        if (th) {
            var ttl = blk.querySelector(".tl-thumb");
            src = (th.tagName === "IMG" && th.getAttribute("src"))
                ? String(th.getAttribute("src")).split("/").pop()
                : ((ttl && ttl.getAttribute("title")) || th.tagName.toLowerCase());
        }
        if (src) mrows.push(row("Media", esc(src)));
        /* baris yang tidak terbaca ditulis apa adanya supaya tidak menipu */
        UI.insp.innerHTML =
            head + rows.join("") +
            '<div class="amx-sec-head amx-2">Metadata — identitas &amp; struktur</div>' +
            mrows.join("") +
            '<div class="amx-row"><span>Jenis</span><span>' + (tag ? esc(tag.textContent.trim()) : "—") + "</span></div>" +
            '<div class="amx-row"><span>Nama</span><span>' + esc(nameOf(key)) + "</span></div>" +
            '<div class="amx-row"><span></span><span class="amx-mute">dibaca langsung dari objek layer mesin · baca-saja</span></div>';
    }
    function row(label, val, live) {
        return '<div class="amx-row' + (live ? " amx-live" : "") + '"><span>' + label + "</span><span>" + val + "</span></div>";
    }
    function px(n) { return (Math.round(n * 100) / 100).toFixed(2); }
    function kfTag(n) { return n > 1 ? "  ◆" + n : ""; }
    function s(ms) { return (ms / 1000).toFixed(2) + "s"; }

    /* gulirkan timeline/pohon ke lapisan terpilih — hanya saat pilihan BERUBAH,
       supaya tidak melawan guliran pengguna. */
    function follow() {
        if (!S.anchor || S.anchor === S.lastFollow) return;
        S.lastFollow = S.anchor;
        var l = trackOf(S.anchor);
        if (l) {
            var body = $("#timeline-body"), lb = l.getBoundingClientRect(), bb = body ? body.getBoundingClientRect() : null;
            if (bb && (lb.left < bb.left || lb.right > bb.right)) {
                try { l.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (e) { }
            }
        }
        var r = rowOf(S.anchor);
        if (r) {
            var list = $("#scene-tree-list"), rb = r.getBoundingClientRect(), rb2 = list ? list.getBoundingClientRect() : null;
            if (rb2 && (rb.top < rb2.top || rb.bottom > rb2.bottom)) {
                try { r.scrollIntoView({ block: "nearest" }); } catch (e) { }
            }
        }
    }

    /* ── kanvas overlay ──────────────────────────────────────────────────── */
    /* Overlay menutupi SELURUH panggung pratinjau — bukan hanya kanvas komposisi.
       Kalau overlay sebentuk kanvas, gizmo ikut terpotong begitu lapisan keluar
       dari komposisi. Pemetaan kanvas → panggung diturunkan dari rect #view
       (yang SUDAH memperhitungkan zoom CSS / layar penuh), jadi tidak ada
       offset hardcode: ox,oy = asal kanvas di ruang panggung, k = skala px. */
    /* Metrik dipakai ulang antar bingkai. Rect hanya diukur ulang saat ada
       kejadian nyata (resize/scroll/layar penuh/zoom berubah) atau saat ukuran
       panggung memang berubah — bukan tiap bingkai. */
    function metInvalid() { UI.met = null; }
    /* ── FIT: komposisi muat di panggung tanpa dipotong & tanpa diregangkan ──
       scale = min(lebarTersedia / w, tinggiTersedia / h)  →  surat (letterbox).
       Yang dihitung hanya ukuran CSS #view; pemusatannya diserahkan ke tata
       letak (#stage sudah display:grid; place-items:center), jadi tidak ada
       offset hardcode dan tidak ada penyesuaian khusus per rasio. */
    function kotakPanggung(st) {
        var cs = null;
        try { cs = getComputedStyle(st); } catch (e) { }
        return {
            w: Math.max(1, (st.clientWidth || 0) - (cs ? angka(cs.paddingLeft) + angka(cs.paddingRight) : 0)),
            h: Math.max(1, (st.clientHeight || 0) - (cs ? angka(cs.paddingTop) + angka(cs.paddingBottom) : 0))
        };
    }
    function terapkanFit() {
        var v = $("#view"), st = $("#stage");
        if (!v || !st) return null;
        var k = komposisi();
        /* Tanpa proyek sungguhan (nilai cadangan) mesin yang menentukan ukuran
           #view — imposing 1080×1920 di sini hanya akan meregangkan kanvas
           kecil jadi buram. Angka cadangan tetap dipakai untuk timeline & ekspor. */
        if (k.asal === KOMP_CADANGAN.asal) return null;
        var b = kotakPanggung(st);
        var full=document.fullscreenElement===st||st.classList.contains("fs-fokus");var s = Math.min(Math.max(2,b.w-24) / k.w, Math.max(2,b.h-(full?16:innerWidth<=760?100:68)) / k.h);
        if (!(s > 0) || !isFinite(s)) return null;
        var w = Math.max(1, Math.round(k.w * s)), h = Math.max(1, Math.round(k.h * s));
        var tanda = w + "x" + h;
        if (v.__amxFit !== tanda || v.style.width!==w+"px" || v.style.height!==h+"px") {                 /* hanya tulis saat ukurannya benar-benar berubah */
            v.__amxFit = tanda;
            v.style.width = w + "px"; v.style.height = h + "px";
        }
        return { w: w, h: h, s: s, tanda: tanda };
    }
    function syncOverlay(force) {
        var v = $("#view"), stage = $("#stage");
        if (!v || !stage || !UI.ov) return null;
        /* penjaga murah (2 pembacaan properti, tanpa memaksa tata letak) */
        var tanda = stage.clientWidth + "x" + stage.clientHeight + ":" + S.zoom + ":" + UI.ov.width + "x" + UI.ov.height + ":" + tandaKomposisi();
        if (!force && UI.met && UI.met.tanda === tanda) return UI.met;
        var fit = terapkanFit();                   /* komposisi → ukuran CSS #view (dahulu) */
        var r = v.getBoundingClientRect(), sr = stage.getBoundingClientRect();
        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        var w = Math.max(1, Math.round(sr.width)), h = Math.max(1, Math.round(sr.height));
        UI.ov.style.left = "0px";
        UI.ov.style.top = "0px";
        UI.ov.style.width = w + "px";
        UI.ov.style.height = h + "px";
        if (UI.ov.width !== Math.round(w * dpr) || UI.ov.height !== Math.round(h * dpr)) {
            UI.ov.width = Math.round(w * dpr); UI.ov.height = Math.round(h * dpr);
        }
        UI.met = { r: r, sr: sr, dpr: dpr, w: w, h: h, tanda: tanda, fit: fit,
                   vw: r.width, vh: r.height,
                   ox: r.left - sr.left, oy: r.top - sr.top };
        return UI.met;
    }
    /* px-layar per unit RUANG KERJA. Sumbernya komposisi (lewat fit di atas);
       faktor ruang-kerja → komposisi diambil dari catatan geometri (g.w), jadi
       kotak tetap tepat walau mesin sedang merender pada resolusi kerja lain
       (kualitas pratinjau, ekspor, atau kanvas yang baru dialokasikan).
       Aljabarnya: (vw/komposisi.w) × (komposisi.w/g.w) === vw/g.w */
    function skalaPeta(vwPx, g) {
        var k = komposisi();
        if (!(vwPx > 0) || !(k.w > 0)) return 0;
        var per = (g && g.w > 0) ? (k.w / g.w) : 1;
        return (vwPx / k.w) * per;
    }

    function draw() {
        if(window.__AMGizmoOff){if(UI.ov && !UI.ov.__off){UI.ov.getContext("2d").clearRect(0,0,UI.ov.width,UI.ov.height);UI.ov.__off=true;}if(UI.ctx)UI.ctx.classList.remove("show");return;}if(UI.ov && UI.ov.__off){UI.ov.__off=false;S.dirty=true;}
        if (S.glHilang) { if (UI.ov) { var c0 = UI.ov.getContext("2d"); if (c0) c0.clearRect(0, 0, UI.ov.width, UI.ov.height); } return; }
        if (!UI.ov) return;
        if(!S.sel.length&&!S.hover&&UI.ov.__kosong===1){placeCtx(null);return;}
        var m = syncOverlay();
        if (!m) return;
        var ctx = UI.ov.getContext("2d");
        ctx.setTransform(m.dpr, 0, 0, m.dpr, 0, 0);
        /* Satu gambar = satu bingkai mesin. Lompat menggambar kalau mesin belum
           menghasilkan bingkai baru dan tidak ada yang berubah (hemat saat diam). */
        var passNow = (window.__AMUI && window.__AMUI.pass) || 0;
        if (!S.dirty && passNow === S.lastPass && UI.ov.__drawn) { placeCtxKeep(); return; }
        S.lastPass = passNow; S.dirty = false;
        UI.ov.__drawn = 1;
        if (window.__AMUI) S.lastDrawMs = Math.round(window.__AMUI.t * 1000) / 1000;
        if (!S.sel.length && !S.hover) {
            if (UI.ov.__kosong !== 1) { ctx.clearRect(0, 0, m.w, m.h); UI.ov.__kosong = 1; }
            placeCtx(null); return;
        }
        UI.ov.__kosong = 0;
        ctx.clearRect(0, 0, m.w, m.h);

        var gm = geoMap();
        var anyG = null;
        for (var kk in gm) { if (gm[kk] && gm[kk].w) { anyG = gm[kk]; break; } }
        /* skala px-kanvas → px-layar diturunkan dari komposisi (lihat skalaPeta) */
        var scale = skalaPeta(m.vw, anyG);
        if (!(scale > 0)) scale = 1;
        var ox = m.ox, oy = m.oy;
        var selSet = {}; S.sel.forEach(function (k) { selSet[k] = 1; });
        var keluar = false;                                   /* ada kotak yang melewati komposisi? */
        var cw = m.vw, ch = m.vh;

        /* hover dulu (di bawah) */
        if (S.hover && !selSet[S.hover]) {
            var b = boxOf(S.hover);
            if (b) {
                var hx = ox + b.x * scale, hy = oy + b.y * scale, hw = b.w * scale, hh = b.h * scale;
                if (hx < ox || hy < oy || hx + hw > ox + cw || hy + hh > oy + ch) keluar = true;
                ctx.save();
                ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
                ctx.strokeStyle = "rgba(231, 234, 238, .55)";
                ctx.strokeRect(hx + .5, hy + .5, hw, hh);
                ctx.restore();
            }
        }

        var first = null;
        S.sel.forEach(function (k, i) {
            var b = boxOf(k);
            if (!b) return;
            var x = ox + b.x * scale, y = oy + b.y * scale, w = b.w * scale, h = b.h * scale;
            if (x < ox || y < oy || x + w > ox + cw || y + h > oy + ch) keluar = true;
            if (!first) first = { x: x, y: y, w: w, h: h, key: k };

            ctx.save();
            ctx.lineWidth = 1;
            ctx.strokeStyle = "#e4643c";
            ctx.strokeRect(x + .5, y + .5, w, h);
            if (S.sel.length > 1) {                       /* multi: tanpa gagang */
                ctx.restore(); return;
            }
            /* gagang sudut + tepi (hanya untuk satu lapisan) */
            var hs = 7, hh = hs / 2, pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h],
            [x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]];
            ctx.fillStyle = "#14171b";
            ctx.strokeStyle = "#e4643c";
            pts.forEach(function (p) {
                ctx.beginPath();
                ctx.rect(Math.round(p[0] - hh) + .5, Math.round(p[1] - hh) + .5, hs, hs);
                ctx.fill(); ctx.stroke();
            });
            /* titik poros */
            var g = gm[k];
            if (g && g.a0 != null) {
                /* poros = titik (0,0) lokal layer lewat matriks dunia — sama persis
                   dengan yang dipakai renderer, bukan rumus kotak tersimpan. */
                var ax = ox + g.a4 * scale, ay = oy + g.a5 * scale;
                ctx.beginPath(); ctx.arc(ax, ay, 4.5, 0, 6.2832); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(ax - 7, ay); ctx.lineTo(ax + 7, ay);
                ctx.moveTo(ax, ay - 7); ctx.lineTo(ax, ay + 7); ctx.stroke();
            }
            /* nama layer di atas kotak */
            /* label di dalam tepi atas kotak — dan hanya kalau tidak bertabrakan
               dengan bilah kontekstual di puncak panggung. Semua hiasan tetap di
               dalam kotak, supaya "oranye di luar kotak" selalu berarti kotak basi. */
            if (h >= 26) {
                var label = nameOf(k);
                ctx.font = "600 10px Inter, system-ui, sans-serif";
                var tw = ctx.measureText(label).width;
                var lw = Math.min(tw + 12, Math.max(40, m.w - Math.max(0, x))) || 40;
                var lx = Math.min(Math.max(2, x), Math.max(2, m.w - lw - 2));
                /* kalau tepi atas kotak berada di bawah bilah kontekstual, label
                   pindah ke tepi bawah (tetap DI DALAM kotak) supaya tidak bertumpuk */
                var ly = (y < 64) ? (y + h - 16) : (y + 2);
                ctx.fillStyle = "rgba(20, 23, 27, .92)";
                ctx.fillRect(lx, ly, lw, 14);
                ctx.strokeStyle = "rgba(228, 100, 60, .7)";
                ctx.strokeRect(lx + .5, ly + .5, lw, 14);
                ctx.fillStyle = "#e7eaee";
                ctx.fillText(short(label), lx + 6, ly + 10.5);
            }
            ctx.restore();
        });

        /* Kalau ada bagian yang keluar dari komposisi, tampilkan batas kanvas
           supaya jelas mana yang di luar bingkai — gizmo-nya sendiri tetap utuh. */
        if (keluar) {
            ctx.save();
            ctx.setLineDash([2, 4]);
            ctx.lineWidth = 1;
            ctx.strokeStyle = "rgba(231, 234, 238, .18)";
            ctx.strokeRect(ox + .5, oy + .5, cw, ch);
            ctx.restore();
        }
        /* jejak sinkronisasi (baca-saja): stempel geometri yang benar-benar dipakai
           bingkai ini + waktu gambarnya → dipakai uji untuk mengukur jeda. */
        var gA = gm[S.anchor];
        /* Jeda diukur SAAT MENGGAMBAR: berapa umur geometri mesin ketika kotak
           dilukis. Angka ini tidak bergantung kapan penguji mengambil contoh. */
        S.dbg = { key: S.anchor, stamp: gA ? gA.t : null, at: performance.now(),
                  lag: gA && gA.t != null ? performance.now() - gA.t : null, frame: gA ? gA.f : null };

        placeCtx(first);
    }

    /* bilah kontekstual mengikuti seleksi (di dalam panggung) */
    /* Dipanggil pada bingkai yang dilewati: biarkan bilah di posisinya
       (tidak ada kerja DOM sama sekali). */
    function placeCtxKeep() { }

    var ctxAt = { x: 0, y: 0, sig: "", w: 0 };
    function placeCtx(box) {if(UI.ctx&&UI.ctx.hasChildNodes())UI.ctx.replaceChildren();}

    /* ── hover & klik di kanvas ──────────────────────────────────────────── */
    function hitTest(clientX, clientY) {
        var v = $("#view");
        if (!v) return null;
        var r = v.getBoundingClientRect();
        if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return null;
        var gm = geoMap(), keys = allKeys(), best = null, bestN = -1, sc = null;
        for (var i = keys.length - 1; i >= 0; i--) {
            var g = gm[keys[i]];
            if (!g || g.a0 == null) continue;
            if (sc == null) sc = skalaPeta(r.width, g);
            if (!(sc > 0)) continue;
            var uv = toUV(g, clientX - r.left, clientY - r.top, sc);
            if (!uv) continue;
            if (uv[0] >= 0 && uv[0] <= 1 && uv[1] >= 0 && uv[1] <= 1) {
                /* paling atas = yang terakhir digambar mesin (n terbesar) */
                var n = (g.n || 0) + i * 1e-6;
                if (n > bestN) { bestN = n; best = keys[i]; }
            }
        }
        return best;
    }

    /* Aplikasi membalik putar/jeda lewat listener `click` pada #stage
       (abaikan #stageBusy & .stage-btn). Supaya kanvas bisa dipakai menyeleksi
       TANPA mematikan perilaku pemutar, kita menangkap `click` di fase CAPTURE
       pada #stage: kalau klik itu memang untuk memilih, propagasinya dihentikan
       (listener bawaan tidak jalan); kalau bukan, dibiarkan apa adanya. */
    function onStageClick(e) {
        if (e.button && e.button !== 0) return;
        var t = e.target;
        if (t.closest && (t.closest("#stageBusy") || t.closest(".stage-btn"))) return;   /* kontrol bawaan aplikasi */
        if (t.closest && t.closest(".amx-bar, .amx-ctx, .amx-status")) return;           /* UI kita sendiri */
        var multi = e.shiftKey || e.ctrlKey || e.metaKey;
        var hint = t.closest ? t.closest(".stage-hint") : null;
        if (hint && !multi) return;                         /* lingkaran putar bawaan: tetap memutar */
        if (t !== $("#view") && !hint) return;              /* di luar kanvas: perilaku bawaan */
        if (!multi && S.playing) return;                    /* saat memutar: klik = jeda (bawaan) */
        e.preventDefault();
        e.stopPropagation();
        var k = hitTest(e.clientX, e.clientY);
        if (!k) { clearSel(); return; }
        if (e.ctrlKey || e.metaKey) toggle(k);
        else if (e.shiftKey) extend(k);
        else select(k);
        /* Aplikasi hanya mengenal SATU lapisan terpilih, jadi sinkronisasi ke
           seleksi internalnya hanya dilakukan untuk pilihan tunggal — kalau tidak,
           multi-pilihan kita (Ctrl/Shift+klik) akan langsung dipangkas. */
        if (!multi && S.sel.length === 1 && S.sel[0] === k) drive(k);
    }

    function onStagePointerMove(e) {
        if(window.__AMGizmoOff)return;
        var now=performance.now();if(now-(S.hoverAt||0)<50)return;S.hoverAt=now;
        if (S.playing || S.sel.length) { if (S.hover) { S.hover = null; S.dirty = true; } return; }
        var hit = e.target === $("#view") ? hitTest(e.clientX, e.clientY) : null;
        if (hit !== S.hover) {
            S.hover = hit;
            $$(".amx-hover").forEach(function (el) { if (keyOf(el) !== hit) el.classList.remove("amx-hover"); });
            if (hit) {
                var l = trackOf(hit) || rowOf(hit);
                if (l) { l.classList.add("amx-hover"); var t = l.closest(".tl-track"); if (t) t.classList.add("amx-hover"); }
            }
            S.dirty = true;
            kick();
        }
    }

    /* klik di timeline / pohon scene */
    function onRowClick(e) {
        var el = e.target.closest ? e.target.closest(".tl-label[data-key], .tl-block[data-key], .st-row[data-key]") : null;
        if (!el) return;
        if (e.target.closest(".tl-eye, .tl-chev, .st-eye, .st-chevron, .st-open-btn")) return;
        var k = keyOf(el);
        if (!k) return;
        if (e.ctrlKey || e.metaKey) { toggle(k); }
        else if (e.shiftKey) { extend(k); }
        else { select(k); return; }                        /* biarkan aplikasi menangani klik biasa */
        kick();
    }

    /* ── aksi nyata (memakai kontrol bawaan aplikasi) ────────────────────── */
    function act(name, key) {
        if (name === "play") S.pulihIdle = 0;
        var k = key || S.anchor;
        if (name === "clear") { clearSel(); return; }
        if (name === "zoomfit" || name === "fit") { setZoom(1); return; }
        if (name === "focus") {
            var l = trackOf(k);
            if (l) {
                l.scrollIntoView({ block: "nearest", inline: "nearest" });
                var r = rowOf(k); if (r) r.scrollIntoView({ block: "nearest" });
                flash("Disorot: " + nameOf(k));
            }
            return;
        }
        if (name === "vis") { toggleVis(S.sel.length > 1 ? S.sel : [k], null); return; }
        if (name === "show") { toggleVis(S.sel, true); return; }
        if (name === "hide") { toggleVis(S.sel, false); return; }
        if (name === "zoomto") { zoomTo(k); return; }
        if (name === "isolate") { isolateSel(); return; }
        if (name === "copy") { copySel(); return; }
    }
    /* tombol mata milik aplikasi untuk sebuah lapisan (timeline, cadangan pohon) */
    function eyeOf(k) {
        return trackOf(k) ? $(".tl-eye", trackOf(k)) : (rowOf(k) ? $(".st-eye", rowOf(k)) : null);
    }
    /* Isolasi: sembunyikan semua KECUALI yang terpilih, lalu kembalikan keadaan
       semula. Bekerja lewat tombol mata bawaan aplikasi, jadi tidak mengubah isi preset. */
    var ISOL = null;
    function isolateSel() {
        var all = allKeys();
        if (!all.length) return;
        if (ISOL) {
            var was = ISOL; ISOL = null;
            toggleVis(all.filter(function (k) { return was.indexOf(k) >= 0; }), true);
            toggleVis(all.filter(function (k) { return was.indexOf(k) < 0; }), false);
            flash("Isolasi dibuka — keadaan semula dikembalikan");
            return;
        }
        var visible = all.filter(function (k) { var e = eyeOf(k); return e && !e.classList.contains("off"); });
        if (!visible.length) { flash("Tidak ada lapisan yang terlihat"); return; }
        ISOL = visible;
        toggleVis(all.filter(function (k) { return S.sel.indexOf(k) < 0; }), false);
        flash("Isolasi: " + S.sel.length + " lapisan terpilih · klik lagi untuk membuka");
    }
    /* Zoom pratinjau supaya kotak lapisan memenuhi panggung (85%) */
    function zoomTo(key) {
        var gm = geoMap(), b = boxOf(key || S.anchor), m = syncOverlay();
        var any = null;
        for (var kk in gm) { if (gm[kk] && gm[kk].w) { any = gm[kk]; break; } }
        if (!b || !m || !any || !b.w || !b.h) { flash("Lapisan tidak terlihat pada bingkai ini"); return; }
        var sc = skalaPeta(m.vw, any);                        /* px kanvas → px layar */
        if (!(sc > 0)) { flash("Lapisan tidak terlihat pada bingkai ini"); return; }
        var z = Math.min(m.w * .85 / (b.w * sc), m.h * .85 / (b.h * sc));
        z = Math.min(4, Math.max(.4, z));
        setZoom(z);
        flash("Zoom ke lapisan: " + Math.round(z * 100) + "%");
    }
    /* Salin identitas lapisan — aksi nyata, tidak mengubah apa pun */
    function copySel() {
        var keys = S.sel.slice();
        if (!keys.length) return;
        var teks = keys.map(function (k) { return k + "\t" + nameOf(k); }).join("\n");
        function done() { flash(keys.length === 1 ? "ID lapisan disalin: " + keys[0] : keys.length + " ID lapisan disalin"); }
        function manual() {
            try {
                var ta = document.createElement("textarea");
                ta.value = teks; ta.setAttribute("readonly", "");
                ta.style.cssText = "position:fixed;left:-9999px;top:0";
                document.body.appendChild(ta); ta.select();
                document.execCommand("copy"); ta.remove(); done();
            } catch (e) { flash("Tidak bisa menyalin di peramban ini"); }
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(teks).then(done, manual);
        } else manual();
    }
    function toggleVis(keys, force) {
        var n = 0;
        keys.forEach(function (k) {
            var eye = eyeOf(k);
            if (!eye) return;
            var off = eye.classList.contains("off");
            var want = force === null ? off : force;
            if (want === !off) return;
            eye.click(); n++;
        });
        if (n) { flash(n + " lapisan " + (force === false ? "disembunyikan" : "ditampilkan")); paint(); }
    }

    /* ── zoom & layar penuh ──────────────────────────────────────────────── */
    function setZoom(z) {
        S.zoom = Math.min(4, Math.max(.4, z));
        var v = $("#view");
        if (v) {
            v.style.transformOrigin = "center center";
            v.style.transform = S.zoom === 1 ? "" : "scale(" + S.zoom + ")";
            metInvalid();
        }
        var lab = $("[data-amx-zoom]");
        if (lab) lab.textContent = Math.round(S.zoom * 100) + "%";
        S.dirty = true; kick();
    }
    function toggleFull() {
        var st = $("#stage");
        try {
            if (document.fullscreenElement) { document.exitFullscreen(); return; }
            var janji = st && st.requestFullscreen ? st.requestFullscreen() : null;
            if (janji && janji.catch) janji.catch(function () { fsFokus(!S.fs); });
        } catch (e) { fsFokus(!S.fs); }
    }
    /* Cadangan bila browser menolak layar penuh: mode putar fokus (kontrol
       yang sama, tanpa fullscreen API) supaya jaminan "layar penuh = mode
       putar" tetap berlaku di semua lingkungan. */
    function fsFokus(on) {
        S.fs = on ? 1 : 0;
        var st = $("#stage");
        if (st) st.classList.toggle("fs-fokus", !!on);
        fsMasukKeluar();
    }

    /* ── snap: playhead menempel ke penanda / keyframe terdekat ─────────── */
    function timeAtX(px) {
        /* konversi px timeline → waktu memakai blok klip yang sebaris */
        var el = document.elementFromPoint(px.x, px.y);
        var tr = el && el.closest ? el.closest(".tl-track") : null;
        if (!tr) return null;
        var lb = tr.querySelector(".tl-label[data-key]");
        var g = lb && geoMap()[keyOf(lb)];
        var blk = tr.querySelector(".tl-block");
        if (!g || !g.st || g.et == null || !blk) return null;
        var area = blk.parentElement, br = blk.getBoundingClientRect(), ar = area.getBoundingClientRect();
        if (!br.width) return null;
        var ratio = (px.x - ar.left) / ar.width;
        return g.st + ratio * (g.et - g.st);
    }
    function tandaiGerak() { S.terakhirGerak = Date.now(); }
    function tandaiLepas() { S.tLepas = Date.now(); S.terakhirGerak = Date.now(); }
    function onSeekInput(e) {
        tandaiGerak(); // Transport seeks are exact. Snap must not silently move audio/beat time.
    }

    /* ── papan ketik (tidak menabrak pintasan bawaan aplikasi) ───────────── */
    function onKey(e) {
        if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
        if (S.fs && e.key === " ") { e.preventDefault(); fsAksi("play"); fsTampilKontrol(); return; }
        if (S.fs && e.key === "Escape") {              /* keluar mode putar */
            e.preventDefault();
            try { if (document.fullscreenElement) document.exitFullscreen(); else fsFokus(false); }
            catch (err) { fsFokus(false); }
            return;
        }
        if (e.key === "," || e.key === ".") { e.preventDefault(); langkahBingkai(e.key === "," ? -1 : 1); return; }
        if (e.defaultPrevented) return;
        var t = e.target, tag = (t && t.tagName || "").toLowerCase();
        if (tag === "input" || tag === "select" || tag === "textarea" || (t && t.isContentEditable)) return;
        var mod = e.ctrlKey || e.metaKey;
        if (mod && (e.key === "a" || e.key === "A")) {
            e.preventDefault(); selectAll(); return;
        }
        if (mod && (e.key === "d" || e.key === "D")) {
            e.preventDefault();
            flash("Duplikat tidak tersedia: player ini tidak mengubah isi preset.", 2600);
            return;
        }
        if (e.key === "Escape") {
            /* Esc: laci dulu (kalau terbuka), lalu lepas pilihan */
            var app = $("#app");
            if (app && app.classList.contains("amx-drawer")) { e.preventDefault(); setDrawer(false); return; }
            clearSel(); return;
        }
        if (e.key === "Delete" || e.key === "Backspace") {
            if (!S.sel.length) return;
            e.preventDefault();
            toggleVis(S.sel.slice(), false);
            flash("Disembunyikan — hapus permanen tidak tersedia di player ini.", 2400);
            return;
        }
        if (e.key === "F2") { e.preventDefault(); act("focus"); return; }
    }

    /* ── pengikut bingkai: hanya saat perlu ──────────────────────────────── */
    /* Satu gambar per bingkai MESIN: mesin memanggil __AMUI.onFrame di akhir
       loop rendernya (patch-app.js), tepat setelah geometri bingkai itu lengkap.
       Jadi gizmo memakai transform yang sama dengan renderer — tanpa loop rAF
       kedua, dan tanpa risiko tertinggal satu bingkai. */
    /* Pemulihan kualitas saat menganggur (§14). Mesin hanya menilai beban saat
       ada bingkai yang digambar, jadi kualitas yang sudah turun saat memutar
       akan tertinggal di bawah selama editor diam. Di sini dinaikkan SATU
       tingkat tiap 1,5 s tanpa gerakan; begitu pengguna bekerja lagi, mesin
       kembali yang memutuskan. Tidak menyentuh resolusi proyek. */
    var TANGGA_RENDER = [960, 640, 480, 360, 270];
    function pulihkanKualitasIdle() {
        if (!(S.render === "auto" || S.render == null)) return false;
        var q = $("#quality");
        if (!q) return false;
        var idx = TANGGA_RENDER.indexOf(Number(q.value));
        if (idx <= 0) return false;
        /* SATU lompatan ke kualitas ideal, bukan bertahap: tiap perubahan
           resolusi berarti kanvas + target GPU dialokasikan ulang, jadi
           serangkaian langkah kecil justru lebih mengganggu daripada sekali
           naik. Mata tetap melihat hasil akhir yang sama (tajam saat diam). */
        var naik = TANGGA_RENDER[Math.max(0, TANGGA_RENDER.indexOf(kualitasIdeal()) === -1 ? idx - 1 : TANGGA_RENDER.indexOf(kualitasIdeal()))];
        if (!naik || naik <= Number(q.value)) return false;
        /* ditunda satu makrotask: biaya ganti resolusi (~30 ms) tidak menempel
           pada bingkai yang sedang berjalan */
        setTimeout(function () {
            if (Number(q.value) >= naik) return;
            q.value = String(naik);
            q.dispatchEvent(new Event("change", { bubbles: true }));
            S.renderNyata = naik;
        }, 0);
        return true;
    }

    /* Pantau transisi ekspor lewat tombolnya (tanpa loop baru): dipakai untuk
       memulihkan keadaan putar sesudah ekspor — posisi playhead sendiri tidak
       pernah disentuh oleh ekspor. */
    function pantauEkspor() {
        var b = $("#expStart");
        if (!b) return;
        var jalan = !!b.disabled;
        if (jalan === S.ekspor) return;
        S.ekspor = jalan;
        if (jalan) {
            S.mainSebelumEkspor = S.playing;
            S.tEksporMulai = Date.now();
        } else {
            if (S.mainSebelumEkspor && !S.playing) act("play");
            var d = S.tEksporMulai ? ((Date.now() - S.tEksporMulai) / 1000).toFixed(1) : null;
            S.tEksporMulai = 0;
            metInvalid(); S.dirty = true; kick();
            if (d && $("#expResult") && $("#expResult").querySelector("a")) flash("Ekspor selesai · " + d + " s");
        }
    }

    function onEngineFrame() {
        if (S.fs) fsSync();
        /* Komposisi dipantau terus-menerus (setiap 4 bingkai): impor baru atau
           state mesin yang berubah langsung terlihat di pratinjau, timeline,
           gizmo, dan ekspor. Mahal hanya kalau tanda tangannya berubah —
           sinkronKeProyek() keluar lebih dulu saat tidak ada apa-apa yang beda. */
        if ((S.hitung = (S.hitung || 0) + 1) % 4 === 0) sinkronKeProyek();
        /* murah: dua pembacaan properti + aritmatika sederhana per bingkai */
        if ((S.hitung || 0) % 10 === 0) pantauEkspor();
        /* Pelaporan: kualitas yang BENAR-BENAR dipakai bisa berubah dari dalam
           mesin (algoritma beban), jadi panel komposisi dibaca ulang dari sini
           supaya yang ditampilkan bukan nilai harapan. */
        if (!S.playing && !S.ekspor) {
            var tenang = Math.max(S.terakhirGerak || 0, S.tLepas || 0);
            if (!S.geser && Date.now() - tenang > 2500 && Date.now() - (S.tPulih || 0) > 2500) {
                S.tPulih = Date.now();
                pulihkanKualitasIdle();
            }
            var qq = $("#quality"), qn2 = qq ? Number(qq.value) : 0;
            if (qn2 && qn2 !== S.renderNyata) { S.renderNyata = qn2; kabarkanKomposisi(); }
        }
        /* Tanpa cek document.hidden: loop ini hanya MENGIKUTI bingkai mesin
           (bukan loop tambahan), jadi kalau mesin berhenti menggambar, kita pun
           berhenti. Di jendela yang disembunyikan, rAF mesin sendiri yang berhenti. */
        draw();
        var now = performance.now();
        if (S.sel.length === 1 && S.playing && now - S.lastInsp > 500) { S.lastInsp = now; renderInspector(); }
    }
    /* Dipakai untuk respons instan (klik/hover/resize) tanpa menunggu bingkai mesin. */
    function kick() {
        if (S.raf) return;
        S.raf = requestAnimationFrame(function () {
            S.raf = 0;
            draw();
            var now = performance.now();
            if (S.sel.length === 1 && S.playing && now - S.lastInsp > 160) { S.lastInsp = now; renderInspector(); }
        });
    }
    /* (tidak ada loop rAF terus-menerus lagi — lihat onEngineFrame) */

    /* window.__AMUI baru dibuat bundel saat render pertama, sedangkan skrip UI
       jalan lebih dulu. Jadi kait dipasang malas + dicoba ulang sebentar
       (berhenti permanen begitu berhasil — bukan polling). */
    var hookedCoba = 0;
    function hookEngine() {
        var am = window.__AMUI;
        if (!am) return false;
        if (!am.__amxHooked) { am.__amxHooked = 1; am.onFrame = onEngineFrame; }
        try { sinkronKeProyek(); } catch (e) { }   /* kait telat (media lambat) → kejar komposisi sekarang */
        return true;
    }
    (function cobaKait() {
        if (hookEngine() || ++hookedCoba > 600) return;   /* 60 dtk: load audio besar bisa lama */
        setTimeout(cobaKait, 100);
    })();
    /* Mesin buka event-driven: preset bawaan bisa selesai jauh setelah UI
       dibangun; sinkron sekali saat mesin siap supaya komposisi tidak macet
       di cadangan. */
    try {
        var am0 = window.AM;
        if (am0 && typeof am0.waitReady === "function") {
            am0.waitReady().then(function () { try { sinkronKeProyek(); } catch (e) { } });
        }
    } catch (e) { }

    /* ── pengikatan ──────────────────────────────────────────────────────── */
    function bind() {
        var stage = $("#stage");
        if (stage && !stage.__amxBound) {
            stage.__amxBound = 1;
            stage.addEventListener("click", onStageClick, true);
            stage.addEventListener("pointermove", onStagePointerMove, false);
        }
        document.addEventListener("click", function (e) {
            var pill = e.target.closest ? e.target.closest("[data-amx]") : null;
            if (pill) {
                var a = pill.getAttribute("data-amx");
                if (a === "hide") toggleVis(S.sel.slice(), false);
                else if (a === "show") toggleVis(S.sel.slice(), true);
                else if (a === "clear") clearSel();
                else if (a === "focus") act("focus", S.anchor);
                return;
            }
            onRowClick(e);
        }, false);
        [UI.bar, UI.ctx].forEach(function (el) {
            if (!el || el.__amxActs) return;
            el.__amxActs = 1;
            el.addEventListener("click", onAmxAction, false);
        });
        document.addEventListener("click",function(e){if(!(e.ctrlKey||e.metaKey||e.shiftKey))return;if(e.target.closest(".tl-eye,.tl-chev,.st-eye,.st-chevron"))return;if(!e.target.closest(".tl-label[data-key],.tl-block[data-key],.st-row[data-key]"))return;e.preventDefault();e.stopImmediatePropagation();onRowClick(e);},true);
        document.addEventListener("pointerdown",function(e){if(e.button!==2)return;var el=e.target.closest(".tl-label[data-key],.tl-block[data-key],.st-row[data-key]");if(!el)return;e.preventDefault();var k=keyOf(el);if(e.ctrlKey||e.metaKey)toggle(k);else if(e.shiftKey)extend(k);else select(k);kick();},true);
        var rightSeen=null;
        document.addEventListener("pointermove",function(e){if(!(e.buttons&2)){rightSeen=null;return;}var el=e.target.closest(".tl-label[data-key],.tl-block[data-key],.st-row[data-key]");if(!el)return;var k=keyOf(el);if(k===rightSeen)return;rightSeen=k;if(e.shiftKey)extend(k);else if(e.ctrlKey||e.metaKey){if(S.sel.indexOf(k)<0)toggle(k);}else select(k);kick();},false);
        document.addEventListener("contextmenu",function(e){if(e.target.closest(".tl-label,.tl-block,.st-row")){e.preventDefault();e.stopImmediatePropagation();}},true);
        document.addEventListener("click", onAmxAction, false);   /* cadangan */
        function onAmxAction(e) {
            var b = e.target.closest ? e.target.closest(".amx-bar .amx-btn, .amx-ctx .amx-btn") : null;
            if (!b || e.__amxHandled) return;
            e.__amxHandled=true;
            var a = b.getAttribute("data-a");
            if (a === "in") setZoom(S.zoom * 1.15);
            else if (a === "out") setZoom(S.zoom / 1.15);
            else if (a === "full") toggleFull();
            else if (a === "comp") bukaKomposisi();
            else if (a === "snap") { S.snap = !S.snap; b.classList.toggle("on", S.snap); b.setAttribute("aria-pressed", String(S.snap)); flash(S.snap ? "Snap aktif" : "Snap nonaktif"); }
            else act(a);
        }
        if (UI.drawer && !UI.drawer.__amxDrawer) {
            UI.drawer.__amxDrawer = 1;
            UI.drawer.addEventListener("click", function () { setDrawer(); });
        }
        if (UI.scrim && !UI.scrim.__amxScrim) {
            UI.scrim.__amxScrim = 1;
            UI.scrim.addEventListener("click", function () { setDrawer(false); });
        }
        /* hover dari baris timeline/pohon juga menandai kotak di kanvas
           (aturan sama seperti hover kanvas: hanya saat diam & tanpa seleksi) */
        [["#timeline-body", ".tl-label[data-key]"], ["#scene-tree-list", ".st-row[data-key]"]].forEach(function (pair) {
            var host = $(pair[0]);
            if (!host || host.__amxHover) return;
            host.__amxHover = 1;
            host.addEventListener("mouseover", function (e) {
                var row = e.target.closest ? e.target.closest(pair[1]) : null;
                var k = row ? keyOf(row) : null;
                if (S.playing || S.sel.length || k === S.hover) return;
                S.hover = k; S.dirty = true; kick();
            }, false);
            host.addEventListener("mouseleave", function () {
                if (S.playing || S.sel.length || !S.hover) return;
                S.hover = null; S.dirty = true; kick();
            }, false);
        });
        document.addEventListener("keydown", onKey, false);
        bangunKomposisi();
        fsBangun();
        if (UI.comp && !UI.comp.__amxKlik) { UI.comp.__amxKlik = 1; UI.comp.addEventListener("click", onKomposisiKlik, false); UI.comp.addEventListener("change", onKomposisiKlik, false); }
        if (UI.fs && !UI.fs.__amxPointer) {
            UI.fs.__amxPointer = 1;
            ["pointerdown", "pointermove", "pointerup", "pointercancel"].forEach(function (ev) {
                UI.fs.addEventListener(ev, onFsPointer, false);
            });
            UI.fs.addEventListener("click", function (e) {
                var b = e.target.closest ? e.target.closest("[data-fs]") : null;
                if (b) fsAksi(b.getAttribute("data-fs"));
                fsTampilKontrol();
            }, false);
            /* Kontrol muncul lagi pada gerakan apa pun; overlay ini tidak
               menangkap pointer (pointer-events: none), jadi didengar dari dokumen. */
            document.addEventListener("pointermove", function () { tandaiGerak(); if (S.fs) fsTampilKontrol(); }, { passive: true });
            document.addEventListener("pointerdown", function () { tandaiGerak(); S.pulihIdle = 0; if (S.fs) fsTampilKontrol(); }, { passive: true });
            document.addEventListener("pointerup", tandaiLepas, { passive: true });
            document.addEventListener("wheel", function () { tandaiGerak(); }, { passive: true, capture: true });
            document.addEventListener("keydown", function () { tandaiGerak(); S.pulihIdle = 0; if (S.fs) fsTampilKontrol(); }, { passive: true });
        }
        var seek = $("#seek");
        if (seek && !seek.__amxSnap) { seek.__amxSnap = 1; seek.addEventListener("input", onSeekInput, false); }
        /* ── preferensi ekspor: pilihan pengguna tidak pernah ditimpa ──
           Default berasal dari komposisi (#expRes = tinggi komposisi,
           #expFps = fps komposisi). Begitu pengguna menyentuh sendiri,
           S.expPilih menguncinya — perubahan komposisi berikutnya hanya
           mengubah angka yang belum dikunci. */
        [["#expRes", "change"], ["#expFps", "change"], ["#expFpsCustom", "change"], ["#expFpsCustom", "input"]].forEach(function (p) {
            var el = $(p[0]);
            if (!el || el.__amxExp) return;
            el.__amxExp = 1;
            el.addEventListener(p[1], function () { if (!S.expTulis) S.expPilih = true; }, false);
        });
        /* ── zoom timeline: setelah pengguna menyentuhnya, penggaris tidak
           lagi dipaksa mengikuti durasi komposisi ── */
        var tzoom = $("#tl-zoom");
        if (tzoom && !tzoom.__amxZoom) {
            tzoom.__amxZoom = 1;
            tzoom.addEventListener("input", function () { if (!S.rulerOtomatis) S.tlZoomManual = true; }, false);
            ["#tl-zoom-in", "#tl-zoom-out", "#tl-fit"].forEach(function (sel) {
                var b = $(sel);
                if (!b || b.__amxZoomBtn) return;
                b.__amxZoomBtn = 1;
                b.addEventListener("click", function () { if (!S.rulerOtomatis) S.tlZoomManual = true; }, false);
            });
        }
        /* ── impor baru: beri mesin-impor kesempatan menulis __AMImport,
           lalu baca ulang komposisi (mesin juga dipantau tiap 4 bingkai) ── */
        ["#impXml", "#impPhoto", "#impPick", "#impReset"].forEach(function (sel) {
            var el = $(sel);
            if (!el || el.__amxImp) return;
            el.__amxImp = 1;
            el.addEventListener("change", function () { setTimeout(function () { sinkronKeProyek(); metInvalid(); S.dirty = true; kick(); }, 250); }, false);
        });
        window.addEventListener("resize", function () { dockTulis(); metInvalid(); S.dirty = true; kick(); }, { passive: true });
        window.addEventListener("scroll", function () { metInvalid(); kick(); }, { passive: true, capture: true });
        document.addEventListener("fullscreenchange", function () {
            metInvalid(); S.dirty = true; kick();
            S.fs = (document.fullscreenElement === $("#stage")) ? 1 : 0;
            fsMasukKeluar();
        });
        window.addEventListener("orientationchange", metInvalid, { passive: true });
        /* ── konteks GPU hilang/pulih (mesin sudah memasang pencegah default di
           kanvasnya; di sini hanya pelaporan + penjagaan agar ekspor tidak
           menghasilkan berkas rusak). Tidak ada loop baru. ── */
        document.addEventListener("amgl-hilang", function () {
            S.glHilang = 1;
            /* Ekspor tidak boleh lanjut: bingkai berikutnya akan hitam dan itu
               "video rusak tanpa pemberitahuan" (§23). Batalkan, lalu laporkan. */
            if (S.ekspor) {
                var b = $("#expCancel");
                if (b) b.click();
                flash("Ekspor dibatalkan: konteks GPU hilang");
            } else {
                flash("Konteks GPU hilang — menunggu pemulihan");
            }
            S.dirty = true; kick();
        });
        document.addEventListener("amgl-pulih", function (e) {
            S.glHilang = 0;
            var d = (e && e.detail) || {};
            metInvalid(); S.dirty = true; kick();
            flash("Konteks GPU pulih · " + (d.efek || 0) + " program efek dibangun ulang");
        });
        if (window.ResizeObserver && $("#stage")) { try { new ResizeObserver(metInvalid).observe($("#stage")); } catch (e) { } }
        document.addEventListener("fullscreenchange", function () { S.dirty = true; setTimeout(kick, 60); });
        /* pengubah status putar (kelas disetel aplikasi) */
        var st = $("#stage");
        if (st && !st.__amxPlay && window.MutationObserver) {
            st.__amxPlay = 1;
            new MutationObserver(function () {
                var p = st.classList.contains("is-playing");
                if (p !== S.playing) { S.playing = p; S.dirty = true; kick(); }
            }).observe(st, { attributes: true, attributeFilter: ["class"] });
        }
        hookEngine();
        /* inspektur & dock dibuat ulang oleh aplikasi → pasang lagi */
        var info = $("#layer-info"), dock = $("#timelineDock");
        if (window.MutationObserver) {
            if (info && !info.__amxObs) {
                info.__amxObs = 1;
                new MutationObserver(function () { COLOR = {}; buildUI(); paint(); }).observe(info, { childList: true });
            }
            if (dock && !dock.__amxObs) {
                dock.__amxObs = 1;
                new MutationObserver(function () { COLOR = {}; buildUI(); paint(); }).observe(dock, { childList: true });
            }
        }
    }

    /* ── mulai ───────────────────────────────────────────────────────────── */
    function boot() {
        if (!buildUI()) return false;
        bind();
        paint();
        kick();
        return true;
    }
    if (!boot()) {
        var n = 0, iv = setInterval(function () {
            if (boot() || ++n > 60) clearInterval(iv);
        }, 250);
    }
    /* panggilan dari bundel (preset selesai dimuat) juga menyegarkan */
    /* laci panel (tablet): murni kelas pada #app, CSS yang menggeser */
    function setDrawer(on) {
        var app = $("#app");
        if (!app) return;
        if (on === undefined) on = !app.classList.contains("amx-drawer");
        app.classList.toggle("amx-drawer", !!on);
        if (UI.drawer) UI.drawer.setAttribute("aria-expanded", String(!!on));
    }
    /* titik di layar (koordinat klien) untuk (u,v) sebuah lapisan.
       Memakai pemetaan yang SAMA dengan draw(): ox/oy + skalaPeta(). */
    function pt(key, u, v) {
        var g = geoMap()[key], m = syncOverlay();
        if (!g || !m || !g.w || g.a0 == null) return null;
        if (u == null) { u = .5; v = .5; }
        var scale = skalaPeta(m.vw, g), r = m.r;
        if (!(scale > 0)) return null;
        var cx = (u - .5) * (g.sw || 0), cy = (v - .5) * (g.sh || 0);
        return {
            x: r.left + (g.a0 * cx + g.a2 * cy + g.a4) * scale,
            y: r.top + (g.a1 * cx + g.a3 * cy + g.a5) * scale,
            scale: scale, box: boxOf(key),
        };
    }
    /* ═══════════════════════════════════════════════════════════════════════
       KOMPOSISI (resolusi + FPS) & PREFERENSI TERSIMPAN
       ---------------------------------------------------------------------
       Tiga hal berbeda dan tidak boleh dicampur:
         · RESOLUSI PROYEK  → rasio & ukuran komposisi (dari proyek/XML),
                              di sini dinyatakan sebagai "sisi pendek" (720/1080/…)
         · KUALITAS PRATINJAU → resolusi render internal saat mengedit (#quality)
         · RESOLUSI EKSPOR   → #expRes (keluaran MP4), selalu penuh
       Preferensi disimpan sebagai SATU objek berversi di localStorage dan
       divalidasi saat dibaca: nilai rusak tidak boleh mematikan editor.
       ═══════════════════════════════════════════════════════════════════════ */
    var PREF_KEY = "amEditorSettings.v29";
    var PREF_VERSI = 1;
    var FS_IDLE = 2400;      /* ms tanpa gerak → kontrol layar penuh meredup */

    /* Setiap angka divalidasi; preferensi rusak tidak boleh menghalangi editor. */
    function sahAngka(n, lo, hi) { n = Number(n); return (n >= lo && n <= hi) ? Math.round(n) : null; }
    function sahSetelan(o) {
        if (!o || typeof o !== "object") return null;
        var fps = sahAngka(o.fps, 1, 240);
        var se = sahAngka(o.shortEdge, 180, 4320);
        var rn = (o.render === "auto" || o.render == null) ? "auto" : sahAngka(o.render, 180, 4320);
        if (fps == null || se == null || rn === null) return null;
        return { fps: fps, shortEdge: se, render: rn };
    }
    function kunciProyek(pr) { return pr ? ((pr.judul || "?") + "|" + pr.w + "x" + pr.h) : null; }
    /* "Proyek" menurut UI = komposisi aktif (impor → mesin → cadangan), bukan
       state mentah mesin. Satu istilah untuk kunci preferensi, catatan, dan API. */
    function proyekAktif() {
        var k = komposisi();
        return { w: k.w, h: k.h, fps: k.fps, durasiMs: k.durasiMs, judul: k.judul, asal: k.asal };
    }

    /* Preferensi = SATU objek berversi. Prioritas: setelan proyek yang sedang
       aktif → setelan terakhir yang dipakai. `belumTerbaca` menandai percobaan
       yang jatuh sebelum storage siap, supaya UI tidak buru-buru menyimpulkan
       "belum ada preferensi". */
    function bacaPref(pr) {
        var raw = null;
        try { raw = localStorage.getItem(PREF_KEY); } catch (e) { return { pref: null, belumTerbaca: true }; }
        if (!raw) return { pref: null, kosong: true };
        var o = null;
        try { o = JSON.parse(raw); } catch (e) { return { pref: null, rusak: true }; }
        if (!o || typeof o !== "object" || o.version !== PREF_VERSI) return { pref: null, rusak: true };
        var kunci = kunciProyek(pr);
        var per = (o.perProyek && typeof o.perProyek === "object") ? o.perProyek : null;
        if (per && kunci && per[kunci]) {
            var p1 = sahSetelan(per[kunci]);
            if (p1) return { pref: p1, kunci: kunci, asal: "proyek ini" };
        }
        var p2 = sahSetelan(o);
        if (p2) return { pref: p2, kunci: kunci, asal: "terakhir" };
        return { pref: null, rusak: true };
    }
    function bacaPrefMentah() { var h = bacaPref(proyekAktif()); return h.pref; }
    function simpanPref() {
        try {
            var lama = null;
            try { lama = JSON.parse(localStorage.getItem(PREF_KEY) || "null"); } catch (e) { lama = null; }
            var per = (lama && lama.version === PREF_VERSI && lama.perProyek && typeof lama.perProyek === "object") ? lama.perProyek : {};
            var kunci = kunciProyek(proyekAktif());
            var setel = { fps: S.fps, shortEdge: S.shortEdge, render: (S.render == null ? "auto" : S.render) };
            if (kunci) per[kunci] = setel;
            var kk = Object.keys(per);
            if (kk.length > 24) { for (var i = 0; i < kk.length - 24; i++) delete per[kk[i]]; }
            localStorage.setItem(PREF_KEY, JSON.stringify({
                version: PREF_VERSI, fps: S.fps, shortEdge: S.shortEdge,
                width: S.kompW, height: S.kompH, render: setel.render,
                perProyek: per, savedAt: Date.now()
            }));
        } catch (e) { }
    }

    /* Keadaan proyek yang sesungguhnya: resolusi & fps dari scene XML.
       Mesin sudah menyediakannya lewat window.AM.getState() — tidak perlu
       sumber kedua, tidak ada angka 30/512 yang ditanam di UI. */
    function kondisiProyek() {
        try {
            var am = window.AM;
            if (!am || !am.getState) return null;
            var st = am.getState();
            if (!st) return null;
            var w = Number(st.width) || 0, h = Number(st.height) || 0;
            var fps = Number(st.fps) || 0;
            if (!(w > 0 && h > 0)) return null;
            return { w: w, h: h, fps: fps > 0 ? fps : 30, durasiMs: Number(st.durationMs) || 0, judul: st.title || "" };
        } catch (e) { return null; }
    }
    /* rasio komposisi diambil dari komposisi aktif (impor → mesin), bukan dari
       ukuran DOM — jadi pratinjau, timeline, dan ekspor satu rasio yang sama. */
    function aspekProyek() {
        var k = komposisi();
        if (k && k.w > 0 && k.h > 0) return k.w / k.h;
        var gm = geoMap();
        for (var kk in gm) if (gm[kk] && gm[kk].w && gm[kk].h) return gm[kk].w / gm[kk].h;
        var v = $("#view");                       /* cadangan terakhir: pratinjau */
        if (v && v.clientWidth && v.clientHeight) return v.clientWidth / v.clientHeight;
        return null;
    }
    /* tinggi kanvas kerja ideal untuk kualitas pratinjau (dibatasi DPR & memori) */
    function kualitasIdeal() {
        var k = komposisi();
        return Math.min(960, Math.max(180, Math.round(k.h || 1280)));
    }
    /* kualitas pratinjau: satu angka, tidak pernah sebesar komposisi penuh */
    function terapkanKualitas(senyap) {
        var q = $("#quality");
        if (!q) return;
        var pilih=S.render==='auto'?'auto':String(Number(S.render)||720);
        if(!Array.from(q.options).some(o=>o.value===pilih))pilih='720';
        if(q.value!==pilih){q.value=pilih;q.dispatchEvent(new Event('change',{bubbles:true}));}
        /* Penurunan kualitas otomatis milik mesin (rr) hanya boleh hidup saat
           pengguna memilih "Otomatis"; memilih angka = kunci kualitas. */
        var aq = $("#autoQuality");
        if (aq) aq.checked = (S.render === "auto" || S.render == null);
        S.renderNyata = pilih;
        if (!senyap) { S.ubahManual = true; simpanPref(); }
        kabarkanKomposisi();
    }
    /* sisi pendek + rasio proyek → ukuran komposisi sebenarnya */
    function ukuranDari(se) {
        var a = aspekProyek() || (16 / 9);
        var w, h;
        if (a >= 1) { h = se; w = Math.round(se * a); }        /* lanskap: tinggi = sisi pendek */
        else { w = se; h = Math.round(se / a); }               /* potret: lebar = sisi pendek */
        return { w: Math.max(2, w), h: Math.max(2, h) };
    }
    /* tinggi ekspor → lebar, memakai rasio komposisi yang sama */
    function lebarDariTinggi(h) {
        var a = aspekProyek() || (16 / 9);
        return Math.max(2, Math.round(h * a));
    }

    function opsinya(sel, nilai) {
        var out = null;
        if (!sel) return null;
        for (var i = 0; i < sel.options.length; i++) if (Number(sel.options[i].value) === nilai) out = sel.options[i].value;
        return out;
    }
    function pilihOpsi(sel, nilai, label) {
        var v = opsinya(sel, Math.round(nilai));
        if (v == null) {                                      /* tambahkan opsi baru bila perlu */
            v = String(Math.round(nilai));
            var o = document.createElement("option");
            o.value = v; o.textContent = label || v;         /* label = dimensi nyata, mis. "1080 × 1920" */
            sel.appendChild(o);
        }
        if (sel.value !== v) { S.expTulis = 1; sel.value = v; S.expTulis = 0; }
        return v;
    }

    /* terapkan resolusi komposisi: ekspor (penuh) + kualitas pratinjau (dibatasi) */
    function terapkanResolusi(se, senyap) {
        se = Math.max(180, Math.min(4320, Math.round(se)));
        var u = ukuranDari(se);
        /* #expRes: default = TINGGI komposisi. Begitu pengguna menyentuh
           sendiri, pilihannya dihormati selamanya (S.expPilih). */
        var exp = $("#expRes");
        if (exp && !S.expPilih) pilihOpsi(exp, u.h, u.w + " × " + u.h);
        S.shortEdge = se; S.kompW = u.w; S.kompH = u.h;
        terapkanKualitas(true);          /* kanvas kerja dijaga tetap kecil */
        if (!senyap) { S.ubahManual = true; simpanPref(); }
        kabarkanKomposisi();
    }
    function terapkanFps(fps, senyap) {
        fps = Math.max(1, Math.min(240, Math.round(fps)));
        var exp = $("#expFps");
        if (exp && !S.expPilih) {
            if (!opsinya(exp, fps)) { exp.value = "custom"; var c = $("#expFpsCustom"); if (c) c.value = String(fps); }
            else exp.value = String(fps);
            S.expTulis = 1; exp.dispatchEvent(new Event("change", { bubbles: true })); S.expTulis = 0;
        }
        /* PENTING: #fpsTarget adalah PLAFON LAJU RENDER PRATINJAU (kenyamanan
           interaksi), bukan fps proyek. Kalau diikat ke fps proyek, proyek 24/25
           fps akan membuat pratinjau bergerak 24/25 kali per detik dan terasa
           tersendat. fps proyek tetap dipakai untuk langkah bingkai timeline
           dan ekspor (#expFps), jadi tidak ada yang berubah di keluaran. */
        var ft = $("#fpsTarget");
        if (ft && ft.value !== "60" && ft.value !== "custom") {
            ft.value = "60";                                /* laju tampilan, bukan fps proyek */
            ft.dispatchEvent(new Event("change", { bubbles: true }));
        }
        S.fps = fps;
        if (!senyap) { S.ubahManual = true; S.fpsManual = true; simpanPref(); }
        kabarkanKomposisi();
    }
    function kabarkanKomposisi() {
        var el = UI.comp; if (!el) return;
        var t = $("[data-comp='ukuran']", el), f = $("[data-comp='fps']", el);
        if (t) t.textContent = S.kompW + " × " + S.kompH;
        if (f) f.textContent = fpsProyek() + " fps";
        /* apa yang AKAN diekspor (bukan hanya default) — supaya pilihan
           pengguna sendiri kelihatan di panel yang sama */
        var ex = $("[data-comp='ekspor']", el), er = $("#expRes"), ef = $("#expFps");
        if (ex) {
            var th = er ? angka(er.value) : 0;
            var teks = th > 0 ? (lebarDariTinggi(th) + "×" + Math.round(th)) : (er ? er.value : "—");
            var ff = ef ? (ef.value === "custom" ? (angka(($("#expFpsCustom") || {}).value) + " (kustom)") : ef.value) : "—";
            ex.textContent = "ekspor " + teks + " · " + ff + " fps";
        }
        var sel = $("[data-comp='res']", el), sfs = $("[data-comp='fpssel']", el);
        if (sel) sel.value = String(S.shortEdge);
        if (sfs) sfs.value = String(S.fps);
        var srn = $("[data-comp='render']", el);
        if (srn) srn.value = (S.render === "auto" || S.render == null) ? "auto" : String(S.render);
        var qv = $("#quality");
        if (qv) S.renderNyata = Number(qv.value) || S.renderNyata;   /* apa yang benar-benar dipakai */
        var wl = $("[data-comp='w']", el), hl = $("[data-comp='h']", el);
        if (wl && document.activeElement !== wl) wl.value = String(S.kompW);
        if (hl && document.activeElement !== hl) hl.value = String(S.kompH);
        S.lastDrawMs = S.lastDrawMs;                           /* tidak memicu render WebGL */
    }
    function bukaKomposisi(buka) {
        if (!UI.comp) return;
        var on = buka == null ? UI.comp.hidden : buka;
        UI.comp.hidden = !on;
        var b = $('[data-a="comp"]', UI.bar);
        if (b) b.setAttribute("aria-expanded", on ? "true" : "false");
    }

    /* Pulihkan preferensi tersimpan — bertahap, karena pembacaan pertama bisa
       jatuh sebelum storage siap. Setelah beberapa percobaan singkat, kalau
       memang belum ada preferensi, UI memakai nilai proyek. */
    function cobaPulihkanPref(paksa) {
        if (S.ubahManual) return true;               /* pilihan aktif pengguna tidak boleh ditimpa */
        if (S.prefSiap && !paksa) return true;
        S.prefSiap = false; S.pref = null;           /* baca ulang: kunci proyek bisa beda tiap tanda */
        var pr = proyekAktif();
        var hasil = bacaPref(pr);
        if (hasil.pref) {
            S.pref = hasil.pref; S.prefAsal = hasil.asal || null; S.prefSiap = true;
            S.render = hasil.pref.render;
            terapkanResolusi(hasil.pref.shortEdge, true);
            terapkanFps(hasil.pref.fps, true);
            terapkanKualitas(true);
            catatCatatan("Komposisi " + pr.w + "×" + pr.h + " · preferensi " + S.prefAsal + " dipulihkan");
            return true;
        }
        S.percobaanPref = (S.percobaanPref || 0) + 1;
        if (hasil.belumTerbaca && S.percobaanPref < 6) return false;
        if (!S.prefSiap) { S.prefSiap = true; if (hasil.rusak) catatCatatan("Preferensi tersimpan tidak sah — dipakai nilai proyek"); }
        return false;
    }
    function catatCatatan(t) {
        var n = UI.comp && $("[data-comp='note']", UI.comp);
        if (n) n.textContent = t;
    }

    /* Timeline mengikuti durasi komposisi. Yang ditulis di sini hanya
       #seek.max milik UI ini — state internal mesin tidak disentuh, sehingga
       pengguna tetap memegang kendali lewat transport & penggaris. */
    function sinkronDurasi() {
        var k = komposisi(), se = $("#seek");
        if (!se || !(k.durasiMs > 0)) return false;
        var ms = Math.round(k.durasiMs);
        if (Math.abs(angka(se.max) - ms) < 1) return false;
        var v = angka(se.value);
        se.max = String(ms);
        if (v > ms) {                                     /* waktu di luar durasi baru → tarik ke akhir */
            se.value = String(ms);
            try { se.dispatchEvent(new Event("input", { bubbles: true })); } catch (e) { }
        }
        return true;
    }
    /* Penggaris mengikuti durasi komposisi lewat tombol in-app "#tl-fit" milik
       aplikasi sendiri (bukan menulis state internal mesin). Kalau pengguna
       sudah menyetel zoom timeline, pilihannya dihormati. */
    function cocokkanRuler() {
        if (S.tlZoomManual || S.rulerOtomatis) return false;
        var b = $("#tl-fit");
        if (!b) return false;
        S.rulerOtomatis = 1;
        try { b.click(); } catch (e) { S.rulerOtomatis = 0; return false; }
        S.rulerOtomatis = 0;
        return true;
    }
    /* Selaraskan seluruh UI dengan komposisi yang SEDANG aktif: pratinjau,
       timeline, gizmo, dan ekspor membaca komposisi yang sama. Dipanggil
       ulang terus-menerus, tapi murah: hanya bekerja kalau tanda tangan
       berubah (impor baru / state mesin berubah). */
    function sinkronKeProyek() {
        KOMP = hitungKomposisi();                  /* kunci: semua pembacaan lain ikut satu nilai */
        var k = KOMP;
        var tanda = tandaKomposisi() + "|" + tandaImpor();
        if (S.tandaProyek === tanda) { perbaruiLencana(); return true; }
        S.proyekW = k.w; S.proyekH = k.h; S.proyekFps = k.fps; S.proyekSe = Math.min(k.w, k.h);
        perbaruiLencana();
        sinkronDurasi();
        if (cocokkanRuler()) { S.dirty = true; metInvalid(); }
        /* Pilihan tersimpan mengikat proyeknya: tiap tanda komposisi baru
           (impor, ganti proyek, selesai load) preferensi dibaca ulang dari
           storage dengan kunci proyek saat itu. Preferensi yang cocok
           diterapkan; kalau tidak ada, dipakai nilai komposisi. Pilihan
           manual aktif (ubahManual) tidak pernah ditimpa. */
        S.fpsManual = false;
        cobaPulihkanPref(true);
        if (!S.prefSiap && !S.ubahManual) return true;      /* belum ada keputusan: coba lagi nanti */
        S.tandaProyek = tanda;
        if (!S.pref && !S.ubahManual) {                      /* tidak ada preferensi → ikut komposisi */
            terapkanResolusi(S.proyekSe, true);
            terapkanFps(k.fps, true);
            catatCatatan("Komposisi " + k.w + "×" + k.h + " · " + k.fps + " fps · " +
                (k.w > k.h ? "lanskap" : "potret") + (k.asal === "xml" ? " · dari impor" : ""));
        } else if (S.pref) {
            catatCatatan("Komposisi " + k.w + "×" + k.h + " · preferensi " + (S.prefAsal || "tersimpan") + " dipulihkan");
        }
        if (S.render == null) S.render = 720;
        terapkanKualitas(true);
        kabarkanKomposisi();
        metInvalid(); S.dirty = true; kick();               /* kotak & pratinjau langsung mengikuti */
        return true;
    }

    function bangunKomposisi() {
        var bar = UI.bar;
        if (!bar || UI.comp) return;
        UI.comp = shield(document.createElement("div"));
        UI.comp.className = "amx-comp";
        UI.comp.hidden = true;
        UI.comp.innerHTML =
            '<div class="amx-comp-h">Komposisi</div>' +
            '<div class="amx-comp-row"><label>Resolusi</label>' +
            '<select data-comp="res" aria-label="Resolusi komposisi">' +
            '<option value="720">720p</option><option value="1080">1080p</option>' +
            '<option value="1440">1440p</option><option value="2160">2160p</option>' +
            '<option value="custom">Kustom…</option></select></div>' +
            '<div class="amx-comp-row amx-comp-kustom" hidden><label>W × H</label>' +
            '<input type="number" data-comp="w" min="16" max="4320" step="1" aria-label="Lebar">' +
            '<span>×</span><input type="number" data-comp="h" min="16" max="4320" step="1" aria-label="Tinggi"></div>' +
            '<div class="amx-comp-row"><label>FPS</label>' +
            '<select data-comp="fpssel" aria-label="FPS proyek">' +
            '<option value="24">24</option><option value="25">25</option><option value="30">30</option>' +
            '<option value="50">50</option><option value="60">60</option><option value="custom">Kustom…</option></select></div>' +
            '<div class="amx-comp-row"><label>Render</label>' +
            '<select data-comp="render" aria-label="Kualitas render pratinjau">' +
            '<option value="auto">Otomatis</option><option value="270">270</option><option value="360">360</option>' +
            '<option value="480">480</option><option value="640">640</option><option value="960">960</option></select>' +
            '<span class="amx-hint" title="Resolusi internal pratinjau saat mengedit. Ekspor selalu penuh.">?</span></div>' +
            '<div class="amx-comp-out"><span data-comp="ukuran">-</span> · <span data-comp="fps">-</span></div>' +
            '<div class="amx-comp-out amx-comp-out-2"><span data-comp="ekspor">-</span></div>' +
            '<div class="amx-comp-note" data-comp="note"></div>';
        bar.appendChild(UI.comp);


        if (S.pref) {
            S.render = S.pref.render;
            terapkanResolusi(S.pref.shortEdge, true);
            terapkanFps(S.pref.fps, true);
        }
        sinkronKeProyek();                       /* komposisi: impor → mesin → cadangan */
        kabarkanKomposisi();
    }

    function onKomposisiKlik(e) {
        var t = e.target;
        if (!UI.comp || !t || !t.closest) return;
        if (t.closest('[data-a="comp"]')) { bukaKomposisi(UI.comp.hidden); return; }
        if (!t.closest(".amx-comp")) return;
        var kustom = $(".amx-comp-kustom", UI.comp);
        var sel = t.closest("select");
        if (sel && sel.getAttribute("data-comp") === "res") {
            if (kustom) kustom.hidden = sel.value !== "custom";
            if (sel.value !== "custom") terapkanResolusi(Number(sel.value));
            return;
        }
        if (sel && sel.getAttribute("data-comp") === "render") {
            S.render = sel.value === "auto" ? "auto" : Number(sel.value);
            terapkanKualitas();
            return;
        }
        if (sel && sel.getAttribute("data-comp") === "fpssel") {
            if (sel.value !== "custom") terapkanFps(Number(sel.value));
            return;
        }
        var inp = t.closest("input[type=number]");
        if (inp) {
            var w = Number(($("[data-comp='w']", UI.comp) || {}).value), h = Number(($("[data-comp='h']", UI.comp) || {}).value);
            if (w >= 16 && w <= 4320 && h >= 16 && h <= 4320) {
                var se = Math.min(w, h);
                terapkanResolusi(se);
                var note2 = $("[data-comp='note']", UI.comp);
                if (note2) note2.textContent = "Rasio mengikuti proyek — ukuran dipakai: " + S.kompW + " × " + S.kompH;
            }
        }
    }

    /* ── langkah per bingkai memakai FPS & durasi komposisi (frame = waktu × fps) ─ */
    function langkahBingkai(arah) {
        var se = $("#seek");
        if (!se) return;
        var fps = fpsProyek();                            /* fps komposisi; pilihan panel tetap menang */
        var t = parseFloat(se.value) || 0;
        var maks = parseFloat(se.max || "0") || 0;        /* = durasi komposisi (sinkronDurasi) */
        var t2 = Math.max(0, Math.min(maks, Math.round(t + arah * (1000 / fps))));
        se.value = String(t2);
        se.dispatchEvent(new Event("input", { bubbles: true }));
        flash(Math.round(t2 / 1000 * fps) + " · " + (1000 / fps).toFixed(1) + " ms/bingkai");
    }

    /* ═══════════════════════════════════════════════════════════════════════
       MODE LAYAR PENUH — kontrol putar yang sesungguhnya
       ---------------------------------------------------------------------
       Satu sumber waktu: #seek (milik mesin). Semua yang di bawah ini hanya
       MEMBACA #seek dan mengirim `input` saat pengguna menyeret — jadi tidak
       ada jam kedua, dan posisi putar tidak pernah berubah karena membuka atau
       menutup layar penuh.
       ═══════════════════════════════════════════════════════════════════════ */
    function dua(ms) {
        var t = Math.max(0, ms || 0), m = Math.floor(t / 60000), s2 = (t % 60000) / 1000;
        return (m < 10 ? "0" : "") + m + ":" + (s2 < 10 ? "0" : "") + s2.toFixed(2);
    }
    function fsBangun() {
        var st = $("#stage");
        if (!st || UI.fs) return;
        UI.fs = shield(document.createElement("div"));
        UI.fs.className = "amx-fs";
        UI.fs.innerHTML =
            '<div class="amx-fs-bar">' +
            '<button class="amx-fsb" data-fs="play" aria-label="Putar atau jeda"></button>' +
            '<span class="amx-fs-t" data-fs="cur">00:00.00</span>' +
            '<div class="amx-fs-track" data-fs="track" role="slider" tabindex="0" aria-label="Posisi putar">' +
            '<div class="amx-fs-fill"></div><div class="amx-fs-knob"></div><div class="amx-fs-tip" hidden></div></div>' +
            '<span class="amx-fs-t" data-fs="dur">00:00.00</span>' +
            '<button class="amx-fsb" data-fs="loop" aria-pressed="true" title="Ulangi otomatis">↻</button>' +
            '<button class="amx-fsb" data-fs="mute" aria-pressed="false" title="Bisukan / nyalakan suara">♪</button>' +
            '<button class="amx-fsb" data-fs="exit" title="Keluar layar penuh (Esc)">✕</button>' +
            '</div>';
        UI.fs.hidden = true;                       /* kontrol hanya hidup di mode putar */
        st.appendChild(UI.fs);
    }
    var fsIdle = 0, fsTerakhir = {};
    function fsTampilKontrol(tetap) {
        if (!UI.fs) return;
        UI.fs.classList.add("tampil");
        UI.fs.classList.remove("idle");
        clearTimeout(fsIdle);
        if (!tetap) fsIdle = setTimeout(function () { if (UI.fs && S.fs) { UI.fs.classList.remove("tampil"); UI.fs.classList.add("idle"); } }, FS_IDLE);
    }
    function fsMasukKeluar() {
        fsBangun();
        if (!UI.fs) return;
        if (S.fs) { UI.fs.hidden = false; fsTampilKontrol(); fsSync(true); }
        else { UI.fs.hidden = true; }
    }
    /* dipanggil sekali per bingkai mesin: hanya menyentuh DOM kalau nilai berubah */
    function fsSync(paksa) {
        if (!UI.fs || !S.fs) return;
        var se = $("#seek");
        if (!se) return;
        var v = parseFloat(se.value) || 0, maks = parseFloat(se.max) || 1;
        var rasio = maks > 0 ? Math.max(0, Math.min(1, v / maks)) : 0;
        if (paksa || rasio !== fsTerakhir.rasio) {
            fsTerakhir.rasio = rasio;
            var f = $(".amx-fs-fill", UI.fs), k = $(".amx-fs-knob", UI.fs);
            if (f) f.style.width = (rasio * 100).toFixed(3) + "%";
            if (k) k.style.left = (rasio * 100).toFixed(3) + "%";
        }
        var tc = dua(v), td = dua(maks);
        if (paksa || tc !== fsTerakhir.tc) { fsTerakhir.tc = tc; var e1 = $('[data-fs="cur"]', UI.fs); if (e1) e1.textContent = tc; }
        if (paksa || td !== fsTerakhir.td) { fsTerakhir.td = td; var e2 = $('[data-fs="dur"]', UI.fs); if (e2) e2.textContent = td; }
        var main = S.playing;
        if (paksa || main !== fsTerakhir.main) {
            fsTerakhir.main = main;
            var pb = $('[data-fs="play"]', UI.fs);
            if (pb) {
                pb.innerHTML = main
                    ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="5" width="3.6" height="14" rx="1"/><rect x="13.4" y="5" width="3.6" height="14" rx="1"/></svg>'
                    : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.2v13.6L19 12z"/></svg>';
                pb.setAttribute("aria-label", main ? "Jeda" : "Putar");
            }
        }
    }
    function fsSeekDariX(cliX) {
        var tr = $('[data-fs="track"]', UI.fs || {});
        var se = $("#seek");
        if (!tr || !se) return;
        var r = tr.getBoundingClientRect();                    /* hanya saat interaksi, bukan per bingkai */
        if (!r.width) return;
        var f = Math.max(0, Math.min(1, (cliX - r.left) / r.width));
        var maks = parseFloat(se.max) || 0;
        se.value = String(Math.round(f * maks));
        se.dispatchEvent(new Event("input", { bubbles: true }));   /* segera: pratinjau + playhead + gizmo */
        var tip = $(".amx-fs-tip", UI.fs);
        if (tip && !tip.hidden) { tip.style.left = (f * 100).toFixed(2) + "%"; tip.textContent = dua(f * maks); }
        fsSync(true);
    }
    function fsAksi(nama) {
        var se = $("#seek");
        if (nama === "play") { var p = $("#play"); if (p) p.click(); fsTampilKontrol(); return; }
        if (nama === "loop") { var l = $("#loopBtn"); if (l) l.click(); var b = $('[data-fs="loop"]', UI.fs); if (b) b.setAttribute("aria-pressed", l && l.classList.contains("on") ? "true" : "false"); return; }
        if (nama === "mute") {
            var b2 = $('[data-fs="mute"]', UI.fs);
            var semua = document.querySelectorAll("audio, video");
            var bisu = !(S.fsMute = !S.fsMute);
            for (var i = 0; i < semua.length; i++) semua[i].muted = S.fsMute;
            if (b2) { b2.setAttribute("aria-pressed", S.fsMute ? "true" : "false"); b2.classList.toggle("on", S.fsMute); }
            return;
        }
        if (nama === "exit") { try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) { } return; }
        if (nama === "mulai" && se) fsSync(true);
    }
    function onFsPointer(e) {
        if (!UI.fs || !S.fs) return;
        var tr = e.target.closest ? e.target.closest('[data-fs="track"]') : null;
        if (e.type === "pointerdown" && tr) {
            try { tr.setPointerCapture(e.pointerId); } catch (err) { }
            S.fsDrag = 1; fsTampilKontrol(true); fsSeekDariX(e.clientX);
            e.preventDefault();
            return;
        }
        if (e.type === "pointermove") {
            if (S.fsDrag) { fsSeekDariX(e.clientX); fsTampilKontrol(true); return; }
            if (tr) {                                          /* tooltip hover */
                var r = tr.getBoundingClientRect();
                var f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
                var tip = $(".amx-fs-tip", UI.fs);
                if (tip) { tip.hidden = false; tip.style.left = (f * 100).toFixed(2) + "%"; tip.textContent = dua(f * (parseFloat($("#seek").max) || 0)); }
                fsTampilKontrol();
            } else { var t2 = $(".amx-fs-tip", UI.fs); if (t2) t2.hidden = true; fsTampilKontrol(); }
            return;
        }
        if (e.type === "pointerup" || e.type === "pointercancel") { S.fsDrag = 0; fsTampilKontrol(); return; }
    }

    /* ═══════════════════════════════════════════════════════════════════════
       DAPUR — dua hal yang boleh diubah pengguna: tinggi dock, dan apakah
       panel elemen (pohon scene) ikut dibuka.
       ───────────────────────────────────────────────────────────────────────
       · Tinggi ditulis ke --dock-h pada :root, bukan gaya inline pada elemen
         dock, sehingga nilai bawaan tiap media query tetap berlaku utuh.
         (Var itu tidak dipakai sama sekali oleh bundel aplikasi.)
       · Panel elemen disembunyikan lewat CSS (display:none) — TIDAK dihapus dari
         DOM — supaya kontrak selector tetap utuh dan pohon scene masih bisa
         dibaca mesin, misalnya untuk shift-klik berurutan.
       · Satu kunci localStorage berversi untuk keduanya; nilai rusak diabaikan.
       ═══════════════════════════════════════════════════════════════════════ */
    /* DOCK_KEY/DOCK/DOCK_MIN/MAX/DEF dideklarasikan di blok keadaan atas
       (state DOCK dipakai boot→buildUI→dockBangun sebelum titik ini). */
    function dockBaca() {
        var o = null;
        try { o = JSON.parse(localStorage.getItem(DOCK_KEY) || "null"); } catch (e) { o = null; }
        if (!o || typeof o !== "object") return;
        if (typeof o.h === "number" && isFinite(o.h)) DOCK.h = Math.max(DOCK_MIN, Math.min(DOCK_MAX, o.h));
        DOCK.elemen = o.elemen === true;
    }
    function dockSimpan() {
        try { localStorage.setItem(DOCK_KEY, JSON.stringify({ v: 1, h: DOCK.h, elemen: DOCK.elemen })); } catch (e) { }
    }
    /* jendela pendek: dock jangan sampai memakan panggung */
    function dockMaks() { return Math.max(DOCK_MIN, Math.min(DOCK_MAX, Math.round((window.innerHeight || 800) * .66))); }
    function dockTulis() {
        var h = Math.max(DOCK_MIN, Math.min(dockMaks(), DOCK.h));
        if (UI.dockTertulis === h) return;
        UI.dockTertulis = h;
        document.documentElement.style.setProperty("--dock-h", h + "px");
        if (UI.grip) UI.grip.setAttribute("aria-valuenow", String(h));
    }
    function dockAtur(n) {
        DOCK.h = Math.max(DOCK_MIN, Math.min(dockMaks(), Math.round(n)));
        dockTulis(); dockSimpan();
        metInvalid(); S.dirty = true; kick();
    }
    function dockPanel() {
        document.body.classList.toggle("amx-elemen", !!DOCK.elemen);
        if (UI.elemen) {
            UI.elemen.classList.toggle("on", !!DOCK.elemen);
            UI.elemen.setAttribute("aria-pressed", String(!!DOCK.elemen));
        }
    }
    function dockMulai(e) {
        if (e.button != null && e.button !== 0) return;
        try { UI.grip.setPointerCapture(e.pointerId); } catch (err) { }
        DOCK.geser = 1; DOCK.geserPx = 0; DOCK.y0 = e.clientY; DOCK.h0 = DOCK.h;
        document.body.classList.add("amx-geser-dock");
        e.preventDefault(); e.stopPropagation();
    }
    function dockGeser(e) {
        if (!DOCK.geser) return;
        DOCK.geserPx += Math.abs(e.clientY - DOCK.y0);
        DOCK.h = Math.max(DOCK_MIN, Math.min(dockMaks(), Math.round(DOCK.h0 + (DOCK.y0 - e.clientY))));
        dockTulis();                    /* belum disimpan: tulis lokalStorage sekali lagi saat lepas */
        metInvalid(); S.dirty = true; kick();
    }
    function dockSelesai(e) {
        if (!DOCK.geser) return;
        DOCK.geser = 0;
        document.body.classList.remove("amx-geser-dock");
        try { UI.grip.releasePointerCapture(e.pointerId); } catch (err) { }
        dockSimpan();
    }
    function dockBawaan(e) {
        if (DOCK.geserPx > 4) { DOCK.geserPx = 0; return; }      /* ini akhir seret, bukan klik ganda */
        e.preventDefault(); e.stopPropagation();
        dockAtur(DOCK_DEF);
        flash("Tinggi dock " + DOCK_DEF + " px");
    }
    function dockTombol(e) {
        var langkah = e.shiftKey ? 48 : 16, n = null;
        if (e.key === "ArrowUp") n = DOCK.h + langkah;
        else if (e.key === "ArrowDown") n = DOCK.h - langkah;
        else if (e.key === "PageUp") n = DOCK.h + 64;
        else if (e.key === "PageDown") n = DOCK.h - 64;
        else if (e.key === "Home") n = DOCK_DEF;
        if (n == null) return;
        e.preventDefault(); e.stopPropagation();
        dockAtur(n);
    }
    /* ── Tombol Tutup hasil export ──────────────────────────────────────
       Murni presentasi, nol sentuh engine: tombol ghost di ujung #expResult
       yang mengosongkan hasil → modal completion tertutup sendiri (aturan
       CSS `#expResult:empty{display:none}`). Hasil baru dari mesin otomatis
       memunculkan modal lagi; observer memasang ulang tombol yang ikut
       terhapus saat hasil dikosongkan. Engine/logic export tidak diubah. */
    function exportTutupPasang() {
        var hasil = $("#expResult");
        if (!hasil || hasil.__amxTutup) return;
        hasil.__amxTutup = 1;
        var pasang = function () {
            if (!hasil.firstChild || $(".amx-exp-tutup", hasil)) return;
            var b = document.createElement("button");
            b.type = "button";
            b.className = "btn ghost amx-exp-tutup";
            b.textContent = "Tutup";
            b.setAttribute("aria-label", "Tutup hasil export");
            b.addEventListener("click", function () {
                hasil.textContent = "";
                S.dirty = true; kick();
            }, false);
            hasil.appendChild(b);
        };
        pasang();
        if (window.MutationObserver) {
            new MutationObserver(function () { pasang(); }).observe(hasil, { childList: true });
        }
    }
    function exportTutup() {
        try { exportTutupPasang(); } catch (e) { }
    }
    function dockBangun() {
        if (!DOCK.siap) { DOCK.siap = 1; dockBaca(); }
        var dock = $("#timelineDock");
        if (dock && (!UI.grip || !document.body.contains(UI.grip))) {
            UI.grip = document.createElement("div");              /* tanpa shield: butuh dblclick */
            UI.grip.className = "amx-dock-grip";
            UI.grip.setAttribute("role", "separator");
            UI.grip.setAttribute("aria-orientation", "horizontal");
            UI.grip.setAttribute("aria-label", "Tinggi dock timeline");
            UI.grip.setAttribute("title", "Seret untuk mengubah tinggi dock · klik ganda untuk " + DOCK_DEF + " px");
            UI.grip.setAttribute("tabindex", "0");
            UI.grip.setAttribute("aria-valuemin", String(DOCK_MIN));
            UI.grip.setAttribute("aria-valuemax", String(DOCK_MAX));
            dock.insertBefore(UI.grip, dock.firstChild);
            UI.grip.addEventListener("pointerdown", dockMulai, false);
            UI.grip.addEventListener("pointermove", dockGeser, false);
            UI.grip.addEventListener("pointerup", dockSelesai, false);
            UI.grip.addEventListener("pointercancel", dockSelesai, false);
            UI.grip.addEventListener("dblclick", dockBawaan, false);
            UI.grip.addEventListener("keydown", dockTombol, false);
        }
        var bar = $(".tl-toolbar");
        if (bar && (!UI.elemen || !document.body.contains(UI.elemen))) {
            UI.elemen = shield(document.createElement("button"));
            UI.elemen.type = "button";
            UI.elemen.className = "btn sm amx-tombol-elemen";
            UI.elemen.innerHTML = '<svg class="i sm" aria-hidden="true"><use href="#i-layers"></use></svg><span>Elemen</span>';
            UI.elemen.setAttribute("aria-pressed", "false");
            UI.elemen.setAttribute("aria-controls", "scene-tree-panel");
            UI.elemen.setAttribute("title", "Tampilkan / sembunyikan panel elemen");
            bar.insertBefore(UI.elemen, $(".tl-zoomctl", bar));   /* skup terakhir kelompok tombol */
            UI.elemen.addEventListener("click", function () {
                DOCK.elemen = !DOCK.elemen;
                dockPanel(); dockSimpan();
                metInvalid(); S.dirty = true; kick();
                flash(DOCK.elemen ? "Panel elemen dibuka" : "Panel elemen disembunyikan");
            }, false);
        }
        dockTulis(); dockPanel();
    }

    window.AMX = {
        select: select, selectAll: selectAll, clear: clearSel, toggle: toggle,
        state: S, pt: pt, box: boxOf, quad: quad,
        /* baca-saja: dipakai uji sinkronisasi gizmo ↔ bingkai mesin */
        debug: function () {
            return {
                pass: (window.__AMUI && window.__AMUI.pass) || 0,
                drawnPass: S.lastPass, drawMs: S.lastDrawMs,
                playing: S.playing, sel: S.sel.length, anchor: S.anchor,
                ov: UI.ov ? { x: UI.ov.clientWidth, y: UI.ov.clientHeight } : null,
                geoFresh: Object.keys(geoMap()).length,
                geoTotal: window.__AMUI ? Object.keys(window.__AMUI.geo).length : 0,
                frame: window.__AMUI ? window.__AMUI.frame : null,
                dbg: S.dbg || null, now: performance.now(),
                tMs: (bingkaiMs() != null ? bingkaiMs() : playheadMs()),
                fps: S.fps || null, shortEdge: S.shortEdge || null, render: S.render, renderNyata: S.renderNyata,
                proyek: S.tandaProyek || null, prefSiap: !!S.prefSiap, ubahManual: !!S.ubahManual,
                kompW: S.kompW || null, kompH: S.kompH || null, fs: !!S.fs,
                /* komposisi aktif (impor → mesin → cadangan) + hasil fit panggung */
                komposisi: (function () { var k = komposisi();
                    return { w: k.w, h: k.h, fps: k.fps, durasiMs: k.durasiMs, asal: k.asal, judul: k.judul }; })(),
                fit: UI.met && UI.met.fit ? UI.met.fit : null,
                tidakDidukung: jumlahTidakDidukung(),
                /* berapa layer terpilih yang AKTIF pada waktu sekarang */
                selAktif: (function () { var gm = geoMap(), n = 0;
                    for (var i = 0; i < S.sel.length; i++) if (gm[S.sel[i]]) n++; return n; })(),
                /* orientasi: panjang vektor sumbu-x dan sumbu-y lokal layer (px ruang kerja) */
                axes: (function () { var g = geoMap()[S.anchor];
                    return g && g.a0 != null ? [Math.hypot(g.a0, g.a1) * (g.sw || 0), Math.hypot(g.a2, g.a3) * (g.sh || 0)] : null; })(),
            };
        },
        /* komposisi & layar penuh (baca/tulis terkendali; sumber tunggal tetap #seek) */
        comp: {
            baca: function () { return { fps: S.fps, shortEdge: S.shortEdge, w: S.kompW, h: S.kompH, render: S.render, renderNyata: S.renderNyata, proyekSe: S.proyekSe, proyek: S.tandaProyek }; },
            /* komposisi yang SEDANG berlaku (baca-saja): pratinjau, timeline,
               gizmo, dan ekspor semuanya diturunkan dari nilai yang sama ini. */
            komposisi: function () { var k = komposisi(); return { w: k.w, h: k.h, fps: k.fps, durasiMs: k.durasiMs, asal: k.asal, judul: k.judul }; },
            fpsProyek: fpsProyek,
            sinkron: sinkronKeProyek,
            setResolusi: function (se) { terapkanResolusi(se); },
            setFps: function (f) { terapkanFps(f); },
            tersimpan: function () {
                var h = bacaPref(proyekAktif());
                return { version: PREF_VERSI, pref: h.pref || null, asal: h.asal || null,
                         kosong: !!h.kosong, rusak: !!h.rusak, kunci: h.kunci || null };
            },
            hapus: function () { try { localStorage.removeItem(PREF_KEY); } catch (e) { } },
            proyek: proyekAktif,
        },
        fs: { buka: function () { toggleFull(); }, keluar: function () { if (document.fullscreenElement) document.exitFullscreen(); }, sinkron: function () { fsSync(true); } },
        /* kotak yang benar-benar digambar untuk sebuah lapisan (termasuk anak grup),
           dalam px layar relatif kanvas overlay — baca-saja, untuk pengujian. */
        boxScreen: function (key) {
            var m = syncOverlay(), b = boxOf(key), gm = geoMap(), any = null;
            if (!m || !b) return null;
            for (var k in gm) { if (gm[k] && gm[k].w) { any = gm[k]; break; } }
            if (!any) return null;
            var sc = skalaPeta(m.vw, any);
            if (!(sc > 0)) return null;
            return { x: m.ox + b.x * sc, y: m.oy + b.y * sc, w: b.w * sc, h: b.h * sc };
        },
        hitAt: function (x, y) { return hitTest(x, y); },   /* baca-saja, untuk pengujian */
        /* dock: baca tinggi yang berlaku, atur tinggi, buka/tutup panel elemen */
        dock: {
            baca: function () { return { h: DOCK.h, maks: dockMaks(), elemen: !!DOCK.elemen, ditulis: UI.dockTertulis || 0 }; },
            atur: function (px) { dockAtur(px); return DOCK.h; },
            panel: function (nyata) {
                if (typeof nyata === "boolean" && nyata !== !!DOCK.elemen) UI.elemen.click();
                return !!DOCK.elemen;
            },
        },
        refresh: function () { COLOR = {}; buildUI(); paint(); },
    };
    ["amx:ready", "amx:preset"].forEach(function (ev) {
        window.addEventListener(ev, function () {
            COLOR = {}; buildUI(); paint();
            sinkronKeProyek(); metInvalid(); S.dirty = true; kick();
        });
    });
})();
