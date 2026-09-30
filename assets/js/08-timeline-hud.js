
/* ── AM Preset Player: UI v2 runtime ────────────────────────────────────────
   Lapisan tampilan/perbaikan presisi yang TIDAK menyentuh mesin:
     1. penyelaras timebase  — playhead/kap/penanda digeser agar 0s benar-benar
        sejajar dengan titik nol penggaris dan awal blok layer (offset 0 px);
     2. garis grid waktu     — mengikuti skala penggaris yang sedang dipakai;
     3. chip kinerja         — fps + waktu bingkai, ringan (satu rAF);
     4. chip waktu kursor    — waktu di bawah tetikus saat menyusuri penggaris;
     5. pintasan papan tik   — memakai tombol yang sudah ada (tidak menambah
        jalur logika baru di mesin).
   Semua dibungkus try/catch: bila ada yang tidak tersedia, UI lama tetap jalan.
   ────────────────────────────────────────────────────────────────────────── */
(function () {
    'use strict';
    if (window.__AMUI2 && window.__AMUI2.siap) return;

    var VERSI = 'v2';
    var $ = function (s, r) { return (r || document).querySelector(s); };
    var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
    var angka = function (v) { var n = parseFloat(v); return isFinite(n) ? n : 0; };

    var S = { tLap: 0, trekLap: null, isiLap: null,
        geometri: null,       // {pps, durasiMs, origin, delta, tanda}
        chipFps: null, chipMs: null, chipKursor: null,
        bingkai: 0, msTerakhir: 0, jendela: [], jendelaMs: [], bobot: 0,
        tTerakhir: 0, pasang: {}, tunda: 0, siap: false
    };

    /* ─────────────────── 1. penyelaras timebase ─────────────────── */
    /* Mesin menghitung:  playhead.left = De + t·pps   (De konstan di bundel)
       sedangkan blok layer duduk setelah kolom label selebar --tl-label.
       Kalau --tl-label ≠ De, playhead meleset dari waktu sebenarnya.
       Di sini selisih itu diukur dari DOM (tanpa membaca internal mesin) dan
       dikompensasi lewat satu variabel CSS: tidak ada properti mesin yang
       ditimpa, dan kalau suatu saat nilainya sama, koreksinya otomatis 0. */
    function kanvasZero(){var c=$('#timeline-ruler-canvas');return c?c.getBoundingClientRect().left:0;}
    function ukurGeometri() {
        var inner = $('#timeline-inner'),
            area = $('#timeline-tracks .tl-canvas-area'),
            play = $('#tl-playhead'),
            kanvas = $('#timeline-ruler-canvas'),
            seek = $('#seek'),
            zoom = $('#tl-zoom');
        if (!inner || !area || !kanvas || !seek) return null;

        var pps = (zoom ? angka(zoom.value) : 3) / 100;         /* mesin: xt() = we/100 */
        if (!(pps > 0)) pps = 0.03;
        var durasiMs = angka(seek.max) || 1;
        var ri = inner.getBoundingClientRect(), ra = area.getBoundingClientRect();
        var origin = ra.left - ri.left;                          /* px: titik nol konten */

        /* De mesin = posisi kiri playhead dikurangi waktu sekarang */
        var delta = null;
        if (play && play.style.left) {
            var de = 180; // shared De engine coordinate; independent of asynchronous seek updates
            delta = origin - de;
            if (Math.abs(delta) < 0.75) delta = 0;                /* sudah sejajar */
        }
        return { pps: pps, durasiMs: durasiMs, origin: origin, delta: delta, tanda: [pps, durasiMs, Math.round(origin)].join('|') };
    }

    function pasangGeometri(g, paksa) {
        if (!g) return;
        if (!paksa && S.geometri && S.geometri.tanda === g.tanda) return;
        S.geometri = g;
        var akar = document.documentElement;
        if (g.delta !== null) akar.style.setProperty('--amx-tl-delta', g.delta.toFixed(2) + 'px');
        akar.style.setProperty('--amx-origin-x', g.origin.toFixed(2) + 'px');

        /* garis grid: tangga yang sama dengan penggaris mesin (48 px minimum) */
        var tangga = [100, 200, 500, 1000, 2000, 5000, 10000, 30000, 60000];
        var besar = 60000;
        for (var i = 0; i < tangga.length; i++) if (tangga[i] * g.pps >= 56) { besar = tangga[i]; break; }
        var kecil = besar / 5;
        akar.style.setProperty('--amx-grid-a', 'linear-gradient(90deg, rgba(255,255,255,.055) 0 1px, transparent 1px 100%)');
        akar.style.setProperty('--amx-grid-b', 'linear-gradient(90deg, rgba(255,255,255,.02) 0 1px, transparent 1px 100%)');
        akar.style.setProperty('--amx-grid-sa', (besar * g.pps).toFixed(2) + 'px 100%');
        akar.style.setProperty('--amx-grid-sb', (kecil * g.pps).toFixed(2) + 'px 100%');
    }

    /* ─────────────────── 2. chip kinerja ─────────────────── */
    function bangunHud() {
        var bar = $('.top-actions');
        if (!bar || $('#amuiHud')) return;
        var kotak = document.createElement('div');
        kotak.id = 'amuiHud';
        kotak.setAttribute('role', 'status');
        kotak.innerHTML =
            '<span class="amui-chip" id="amuiFps" title="Bingkai per detik saat ini (diukur di halaman ini)"><i class="amui-dot"></i><b>–</b> fps</span>' +
            '<span class="amui-chip" id="amuiMs" title="Waktu gambar per bingkai (rata-rata 1 detik terakhir)"><b>–</b> ms</span>';
        var pengaturan = $('#openSettings');
        if (pengaturan) bar.insertBefore(kotak, pengaturan); else bar.appendChild(kotak);
        S.chipFps = $('#amuiFps');
        S.chipMs = $('#amuiMs');
    }

    function detak(t) {
        /* satu loop untuk semuanya: ukur bingkai + selaraskan UI (ringan) */
        if (S.tTerakhir) {
            var dt = t - S.tTerakhir;
            if (dt > 0 && dt < 500) {
                S.jendela.push(dt);
                S.jendelaMs.push(dt);
                if (dt > 40) S.bobot++;
                if (S.jendela.length > 60) S.jendela.shift();
            }
        }
        S.tTerakhir = t;
        S.bingkai++;

        /* penyelaras UI: 4× per detik cukup, dan hanya saat perlu */
        if (!S.tunda || t - S.tunda > 250) {
            S.tunda = t;
            try {
                pasangGeometri(ukurGeometri());
                segarkanRingkasan();
                var rata = 0, n = S.jendelaMs.length;
                for (var i = 0; i < n; i++) rata += S.jendelaMs[i];
                rata = n ? rata / n : 0;
                if (S.chipFps) {
                    var fps = rata > 0 ? Math.min(240, Math.round(1000 / rata)) : 0;
                    S.chipFps.className = 'amui-chip' + (fps >= 50 ? ' ok' : (fps >= 24 ? '' : ' warn'));
                    $('b', S.chipFps).textContent = fps ? fps : '–';
                }
                if (S.chipMs) {
                    S.chipMs.title = 'Waktu gambar per bingkai · bingkai berat (>40 ms): ' + S.bobot;
                    $('b', S.chipMs).textContent = rata ? rata.toFixed(1) : '–';
                    S.chipMs.className = 'amui-chip' + (rata && rata <= 20 ? ' ok' : (rata <= 34 ? '' : ' warn'));
                }
                S.jendelaMs = [];
            } catch (e) { }
        }
        requestAnimationFrame(detak);
    }

    /* ─────────────────── 3. chip waktu kursor di penggaris ─────────────────── */
    function bangunChipKursor() {
        var ruler = $('#timeline-ruler');
        if (!ruler || ruler.__amuiKursor) return;
        ruler.__amuiKursor = 1;
        var chip = document.createElement('div');
        chip.id = 'amuiWaktu';
        chip.setAttribute('style', [
            'position:fixed', 'z-index:2147482000', 'pointer-events:none', 'display:none',
            'padding:2px 6px', 'border-radius:5px', 'background:rgba(12,15,19,.94)',
            'border:1px solid #2a323b', 'color:#e9edf2', 'font:600 10.5px/1.5 ui-monospace,Menlo,monospace',
            'box-shadow:0 6px 16px rgba(0,0,0,.5)'
        ].join(';'));
        document.body.appendChild(chip);
        S.chipKursor = chip;

        ruler.addEventListener('pointermove', function (e) {
            try {
                var g = ukurGeometri();
                if (!g) return;
                var r = ruler.getBoundingClientRect();
                var zero=kanvasZero();var p=e.clientX-zero;
                if (p < 0) { chip.style.display = 'none'; return; }
                var ms = Math.max(0, p / g.pps);
                chip.textContent = ms >= 60000
                    ? Math.floor(ms / 60000) + 'm' + String(Math.round((ms % 60000) / 1000)).padStart(2, '0') + 's'
                    : (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + 's';
                chip.style.display = 'block';
                chip.style.left = Math.min(innerWidth-76,e.clientX+10) + 'px';
                chip.style.top = (r.top - 22) + 'px';
            } catch (err) { }
        }, { passive: true });
        ruler.addEventListener('pointerleave', function () { chip.style.display = 'none'; }, { passive: true });
        ruler.addEventListener('pointerdown', function () { chip.style.display = 'none'; }, { passive: true });
    }

    /* ─────────────────── 4. pintasan papan tik (pelengkap saja) ─────────────────── */
    /* PENTING: mesin SUDAH punya peta tombol sendiri yang lengkap dan presisi
       (Space putar · ←/→ 1 bingkai · Shift+←/→ 1 detik · Home/End · B penanda ·
       N penanda berikut · F muat layar · R ke awal · M bisu · L loop · +/− zoom).
       Karena itu lapisan ini TIDAK menggandakan tombol-tombol tersebut: dulu
       penggandaan membuat aksi terjadi dua kali (putar lalu langsung jeda).
       Yang ditambahkan hanya tombol yang belum ada di mesin. */
    function onKey(e) {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        var t = e.target, tag = (t && t.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button' || (t && t.isContentEditable)) return;
        if (e.defaultPrevented) return;
        var k = e.key;
        /* 1..5: pindah tab panel (mesin tidak memakai angka) */
        if (k >= '1' && k <= '5') {
            var tab = $$('.tab-btn')[Number(k) - 1];
            if (tab) { e.preventDefault(); tab.click(); }
            return;
        }
        /* H: gulir timeline ke posisi pemutaran sekarang */
        if (k === 'h' || k === 'H') {
            e.preventDefault();
            var b = $('#tl-here');
            if (b) b.click();
            return;
        }
    }

    /* ─────────────────── 6. ringkasan inspektur (saat belum ada pilihan) ─── */
    function bangunRingkasan() {
        var info = $('#layer-info');
        if (!info || $('#amuInfo')) return;
        var kotak = document.createElement('div');
        kotak.id = 'amuInfo';
        kotak.className = 'amx-keep';
        kotak.innerHTML =
            '<div class="amu-h">Komposisi</div>' +
            '<div class="amu-grid">' +
            '<div><div class="amu-k">Resolusi</div><div class="amu-v" id="amuRes">–</div></div>' +
            '<div><div class="amu-k">Durasi</div><div class="amu-v" id="amuDur">–</div></div>' +
            '<div><div class="amu-k">FPS proyek</div><div class="amu-v" id="amuFps">–</div></div>' +
            '<div><div class="amu-k">Lapisan</div><div class="amu-v" id="amuLap">–</div></div>' +
            '</div>' ;
        info.insertBefore(kotak, info.firstChild);
    }

    function segarkanRingkasan() {
        var kotak = $('#amuInfo');
        if (!kotak) return;
        /* disembunyikan begitu ada lapisan terpilih (inspektur transform tampil) */
        var adaPilihan = !!document.querySelector('.tl-block.tl-selected, .tl-label.sel, .st-row.st-sel');
        kotak.style.display = adaPilihan ? 'none' : '';
        if (adaPilihan) return;
        var st = null;
        try { st = window.AM && window.AM.getState ? window.AM.getState() : null; } catch (e) { }
        if (!st) return;
        var set = function (id, teks) { var e = $('#' + id); if (e && e.textContent !== teks) e.textContent = teks; };
        set('amuRes', st.width + '×' + st.height);
        set('amuDur', (st.durationMs / 1000).toFixed(2) + 's');
        set('amuFps', String(st.fps));
        /* hitung lapisan: maksimum 1× per detik dan hanya saat kotak ringkasan tampak
           (hemat untuk proyek besar; sebelumnya querySelectorAll tiap 250 ms) */
        var kini = (window.performance && performance.now) ? performance.now() : Date.now();
        if (!S.tLap || kini - S.tLap > 1000) {
            S.tLap = kini;
            var trek = $('#timeline-tracks') || document;
            if (trek !== S.trekLap) { S.trekLap = trek; S.isiLap = trek.querySelectorAll('.tl-block'); }
            set('amuLap', String((S.isiLap || { length: 0 }).length));
        }
    }

    /* ─────────────────── 5. pemasangan ─────────────────── */
    function segarkan(paksa) {
        try {
            var g = ukurGeometri();
            pasangGeometri(g, !!paksa);
        } catch (e) { }
    }

    function siapkan() {
        if (S.siap) return;
        try {
            document.body.setAttribute('data-amui', VERSI);
            bangunHud();
            bangunChipKursor();
            bangunRingkasan();
            segarkan(true);
            if (!S.pasang.tombol) {
                S.pasang.tombol = 1;
                document.addEventListener('keydown', onKey, false);
                window.addEventListener('resize', function () { segarkan(true); }, { passive: true });
                document.addEventListener('visibilitychange', function () { S.tTerakhir = 0; S.jendela = []; S.jendelaMs = []; }, { passive: true });
                /* baris/zoom/durasi berubah → ukur ulang (hemat: hanya penanda) */
                var wrap = $('#timeline-wrap');
                if (wrap && window.ResizeObserver) {
                    var ro = new ResizeObserver(function () { segarkan(true); });
                    ro.observe(wrap);
                }
                ['#tl-zoom', '#seek'].forEach(function (sel) {
                    var el = $(sel);
                    if (el) el.addEventListener('input', function () { segarkan(true); }, { passive: true });
                });
            }
        } catch (e) { }
        S.siap = true;
        window.__AMUI2 = {
            versi: VERSI, siap: true, segarkan: segarkan,
            geometri: function () { return S.geometri; }
        };
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', siapkan);
    else siapkan();
    /* mesin membangun ulang baris setelah impor: pastikan hidangan tetap ada */
    window.addEventListener('load', function () { setTimeout(siapkan, 400); }, { once: true });
    try { requestAnimationFrame(detak); } catch (e) { }
})();

/* ══════════════════════════════════════════════════════════════════════════
   M23 — kualitas pratinjau >=1080p adaptif (bagian tampilan)
   ──────────────────────────────────────────────────────────────────────────
   Pilihan di #quality artinya:
     · "Otomatis"  → target awal >=1080p per perangkat (devicePixelRatio ×
                     tinggi jendela), lalu mesin boleh menurun/menaikkan sendiri
                     ("Turunkan kualitas otomatis saat ngelag" menyala);
     · nilai tetap (1080/1440/2160/…) → dikunci apa adanya: penurunan otomatis
                     dimatikan supaya pilihan pengguna tidak dilawan mesin.
   Semua lewat saklar bawaan mesin (#autoQuality), jadi tidak ada perilaku
   render yang diubah diam-diam.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
    function sinkronMutu() {
        var q = document.getElementById('quality');
        var aq = document.getElementById('autoQuality');
        if (!q || !aq) return;
        var mauAuto = (String(q.value) === 'auto' || String(q.value) === '');
        if (!!aq.checked !== mauAuto) {
            aq.checked = mauAuto;
            aq.dispatchEvent(new Event('change', { bubbles: true }));
        }
        var l = document.getElementById('resLabel');
        if (l && mauAuto && !l.dataset.am23) {
            l.dataset.am23 = '1';
            l.title = 'Kualitas pratinjau otomatis: mulai >=1080p, menyesuaikan perangkat';
        }
    }
    function pasang() {
        if (!document.getElementById('quality')) return;
        sinkronMutu();
        try { window.__amMutuSinkron = sinkronMutu; } catch (e) { }
    }
    /* delegasi: tetap bekerja walau mesin membangun ulang barisnya sesudah impor */
    document.addEventListener('change', function (e) {
        var t = e && e.target;
        if (t && t.id === 'quality') sinkronMutu();
    }, true);
    /* panel dibangun ulang setelah impor: ikut menyesuaikan lagi */
    try {
        var amati = new MutationObserver(function () { pasang(); });
        var mulai = function () {
            var panel = document.getElementById('view') ? document.body : document.body;
            if (panel) amati.observe(panel, { childList: true, subtree: true });
            pasang();
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mulai);
        else mulai();
    } catch (e) {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pasang);
        else pasang();
    }
    window.addEventListener('load', function () { setTimeout(pasang, 500); }, { once: true });
})();

