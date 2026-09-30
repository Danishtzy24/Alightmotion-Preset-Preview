(()=>{const catat=()=>{};
    /* ── Penyesuaian AM: kf@t detik -> fraksi durasi layer ────────────────── */
    window.__AMNormalKfXml = function (xml, nama) {
        var mode = String(window.__AM_KF || "fraksi").toLowerCase();
        if (typeof window.__AM_KF !== "string") window.__AM_KF = mode;
        if (typeof xml !== "string" || xml.indexOf("<kf") < 0) return xml;
        var doc;
        try { doc = new DOMParser().parseFromString(xml, "text/xml"); } catch (e) { return xml; }
        if (!doc || doc.getElementsByTagName("parsererror").length || !doc.documentElement) return xml;

        function durasiEl(el) {
            if (!el || el.nodeType !== 1) return 0;
            if (el.getAttribute("startTime") === null || el.getAttribute("endTime") === null) return 0;
            var a = parseFloat(el.getAttribute("startTime")), b = parseFloat(el.getAttribute("endTime"));
            if (!isFinite(a) || !isFinite(b) || !(b > a)) return 0;
            return b - a;
        }
        var semua = doc.documentElement.getElementsByTagName("*"), berdurasi = [], i;
        for (i = 0; i < semua.length; i++) if (durasiEl(semua[i])) berdurasi.push(semua[i]);
        if (durasiEl(doc.documentElement)) berdurasi.push(doc.documentElement);

        var ubah = 0, elemen = 0, lewat = 0, contoh = [];
        for (i = 0; i < berdurasi.length; i++) {
            var el = berdurasi[i], D = durasiEl(el);
            var kfs = el.getElementsByTagName("kf"), milik = [], k;
            for (k = 0; k < kfs.length; k++) {
                var p = kfs[k].parentNode, dekat = null;
                while (p && p.nodeType === 1) { if (durasiEl(p)) { dekat = p; break; } p = p.parentNode; }
                if (dekat === el) milik.push(kfs[k]);
            }
            if (!milik.length) continue;
            var maks = 0, adaMs = false;
            for (k = 0; k < milik.length; k++) {
                var v = parseFloat(milik[k].getAttribute("t"));
                if (!isFinite(v)) continue;
                if (Math.abs(v) > maks) maks = Math.abs(v);
                if (Math.abs(v) >= 10000) adaMs = true;
            }
            var banyakDetik = 0;
            for (k = 0; k < milik.length; k++) {
                var vd = parseFloat(milik[k].getAttribute("t"));
                if (isFinite(vd) && Math.abs(vd) > 1.2) banyakDetik++;
            }
            var miripDetik = banyakDetik >= 0.8 * milik.length && maks <= (D / 1000) * 1.2;
            var satuan;
            if (adaMs) satuan = "ms";                                  /* |t| >= 10000: pasti ms */
            else if (mode === "detik") satuan = (maks > 1.0001 ? "s" : "tidak");
            else if (mode === "auto") satuan = miripDetik ? "s" : "tidak";
            else satuan = "tidak";                                     /* BAWAAN: apa adanya */
            if (satuan === "tidak") { lewat++; continue; }
            var faktor = satuan === "ms" ? D : D / 1000;   /* pembagi menuju fraksi */
            var n = 0;
            for (k = 0; k < milik.length; k++) {
                var vv = parseFloat(milik[k].getAttribute("t"));
                if (!isFinite(vv)) continue;
                var f = vv / faktor;
                milik[k].setAttribute("t", String(f));
                if (contoh.length < 4) contoh.push(Math.round(vv * 100) / 100 + (satuan === "ms" ? "ms" : "s") + "->" + (Math.round(f * 1000) / 1000));
                n++;
            }
            ubah += n; elemen++;
        }
        if (ubah) {
            var infoUbah = { nama: nama, mode: mode, kf: ubah, elemen: elemen, contoh: contoh };
            window.__AMKF_INFO = (window.__AMKF_INFO || []).concat([infoUbah]);
            catat("kf@t dikonversi ke fraksi durasi: " + ubah + " keyframe di " + elemen
                + " elemen (" + (nama || "tanpa nama") + "); contoh " + contoh.join(", "));
            try { return new XMLSerializer().serializeToString(doc); } catch (e) { return xml; }
        }
        window.__AMKF_INFO = (window.__AMKF_INFO || []).concat([{
            nama: nama, mode: mode, kf: 0, elemen: lewat,
            apaAdanya: true, satuan: "fraksi-durasi-elemen"
        }]);
        catat("kf@t dipakai apa adanya sebagai fraksi durasi elemen (satuan asli XML AM): "
            + lewat + " elemen berkeyframe (" + (nama || "tanpa nama") + ")");
        return xml;
    };


const draw=CanvasRenderingContext2D.prototype.drawImage;
CanvasRenderingContext2D.prototype.drawImage=function(source,...args){
 if(source?.tagName==='IMG'&&(!source.complete||!source.naturalWidth||source._m35Failed))return;
 if(source?.tagName==='VIDEO'&&(!source.videoWidth||source.readyState<2))return;
 return draw.call(this,source,...args);
};

})();
