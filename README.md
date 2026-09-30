# AM Preset Player — M37

## Pasang di GitHub Pages
1. Unggah seluruh isi ZIP ke root repository, termasuk `index.html`, `.nojekyll`, dan semua folder aset.
2. Settings → Pages → Deploy from a branch → main → / (root).
3. Buka URL Pages. Tidak perlu instalasi atau build.

## Perubahan
- Jalur render utama M29 kembali: pass layer/efek, komposisi grup bersarang, dan presentasi frame. Pipeline GPU alternatif M34 dan cache frame preview M30 tidak dipakai.
- Perbaikan kompatibilitas M35 tetap: teks, pemetaan media berdasarkan nama file, karantina gambar rusak, slot kosong yang dapat diisi, dan shader. Pembersihan program/tekstur serta perbaikan state GL tetap dipertahankan; ini bukan salinan penuh aplikasi M29.
- Default 720p, tape speed dengan perubahan pitch alami pada preview/ekspor, timeline, kontrol editor, FPS/ms, dan gizmo fullscreen tetap ada.
- Link Alight Motion (termasuk kode alight.link), pemilihan proyek dalam paket, XML Google Drive, serta audio Drive dikembalikan.
- Tidak ada launcher atau server lokal di paket.

## Penting: status impor link
Resolver disetel ke **https://am.zervida.my.id**, layanan online yang dipilih.

**Impor link dari GitHub Pages masih terhalang CORS pada layanan tersebut saat pengujian 30 September 2026.** Endpoint merespons dari klien HTTP, tetapi browser lintas origin tidak dapat membaca responsnya. UI dan integrasi sudah dipulihkan, bukan berarti kendala layanan sudah selesai.

Pemilik layanan perlu mengizinkan origin Pages pada API, unduhan media, dan respons galat. Contoh header untuk endpoint publik tanpa kredensial:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, HEAD, OPTIONS
Access-Control-Allow-Headers: Range
Access-Control-Expose-Headers: Content-Disposition, Content-Length, Content-Range, Accept-Ranges
```

Alternatif: gunakan resolver/proxy milik sendiri dengan kontrak API yang sama, lalu ubah `assets/js/resolver-config.js`. Jangan memakai `mode: no-cors`: responsnya tidak dapat dibaca JavaScript. Paket ini tidak mengirim link ke proxy publik pihak ketiga.

Kontrak API:
- `GET /api/project-xml?url=...&project=...` → `{xml, xmlName, media:[{name,url,mime}], projects:[{name,title}]}`. `project` opsional.
- `GET /api/drive-xml?url=...` → `{xml,name}`.
- `GET /api/drive-media?url=...&kind=audio&start=0&end=0` → berkas audio.
- `GET /api/proxy?url=...` → media dari origin eksternal.

URL media relatif ditafsirkan terhadap origin resolver, bukan origin Pages. Media eksternal diarahkan melalui proxy resolver. Link gagal menampilkan pesan galat, bukan memuat contoh sebagai pengganti.

## Pengujian
Chromium + software WebGL (SwiftShader):
- 315 definisi efek diperiksa: 297 diterima (269 shader, 26 animator, 2 native teks); 18 native tetap belum didukung, termasuk `drawing.progress`. `wipe2` tetap ada dan lolos.
- Grup bersarang, transparansi, teks, dan stres 84 pass efek pada 720p: tidak ada galat WebGL. Ini bukan jaminan FPS pada perangkat pengguna.
- Ekspor video, tape 0.5×/1×/1.5×, video/gizmo fullscreen mobile, timeline, dan media invalid diuji.
- Alur impor link, media relatif, pilihan proyek, Drive XML/audio, dan penanganan galat diuji dengan **respons API simulasi**. Uji layanan asli terpisah menunjukkan kendala CORS di atas; impor link produksi end-to-end belum lulus.

Lisensi: `licenses/NOTICE.md`.
