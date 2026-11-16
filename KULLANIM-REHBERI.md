# LightDesktop — Özellikler ve Etkin Kullanım Rehberi

> **LightDesktop**, özellikle büyük mekanik sabit disklerde (HDD) Windows Gezgini'nin donmasına (`0x154` / disk kilitlenmesi) yol açan paralel ön-okumayı ortadan kaldırmak için sıfır harici bağımlılıkla tasarlanmış ultra hafif dosya gezgini ve arşiv yönetim aracıdır.

---

## 1. Temel Mimari: Neden Hızlı ve HDD Dostu?

- **Sıfır Ön-Okuma (Zero-Preload):** Bir klasörü açtığınızda yalnızca dosya adları, boyutlar ve tarihler (`opendir` + küçük gruplarla `stat`) okunur. Dosya içerikleri veya kapak resimleri siz istemedikçe kesinlikle okunmaz.
- **Sıralı Kuyruk (`Concurrency = 1`):** Aynı anda disk kafasını farklı noktalara sıçratan paralel okuma/yazma yapılmaz. Kapak üretimi, klasör boyutu taraması ve kopyalama/taşıma işlemleri tek sıradan yürür.
- **Hızlı SSD Önbellek:** Arama indeksi (SQLite), üretilen kapak resimleri (`thumbs`), ve pencere konum/boyut ayarları yavaş HDD yerine hızlı sistem diskinizdeki `%LOCALAPPDATA%\LightDesktopCache` klasöründe tutulur.
- **60 FPS Sanal Liste (Virtual Scroller):** Klasörde 50.000 dosya olsa bile ekranda yalnızca o an görünür olan satır/kartlar DOM'a çizilir.
- **Pencere Hafızası & Hata Günlüğü:** Pencereyi en son bıraktığınız konum ve boyut kaydedilir (`window-bounds.json`); [Baslat-LightDesktop.bat](file:///c:/Users/mrtcn/Desktop/yaz%C4%B1l%C4%B1m/lightdesktop/Baslat-LightDesktop.bat) veya sunucu tarafında oluşabilecek hatalar kök klasördeki `logs.txt` dosyasına kaydedilir.

---

## 2. Özellikler ve Detayları

### A. Gezinme, Sekmeler, Sol Ağaç ve Seçim
- **Çoklu Sekme:** Üst çubuktaki `+` veya `Ctrl+T` ile yeni sekme açabilir, `Ctrl+W` ile kapatabilirsiniz.
- **Bu Bilgisayar & Hızlı Erişim:** Sol menüdeki **Bu bilgisayar** düğmesi, sürücü kartları (doluluk çubuklarıyla) ve Masaüstü / İndirilenler / Belgeler / Resimler / Müzikler / Videolar kısayolları ile anında geçiş sağlar.
- **Açılır Sol Klasör Ağacı:** Sol menüdeki `Masaüstü`, `Sabitlenenler` veya sürücülerin (`C:`, `D:`, `E:`) solundaki `›` okuna basarak alt klasörleri içeriden açabilir, bulunduğunuz klasörden dosya/klasörleri doğrudan sol ağaçtaki istediğiniz alt klasörün üzerine sürükleyip bırakabilirsiniz.
- **Fare Yan Tuşları (Mouse 4 / 5):** Farenizin yan ileri-geri tuşlarıyla klasör geçmişinde gezinebilirsiniz.
- **Lasto (Kutu) Seçimi & Aralık Seçimi:**
  - Liste boşluğundan fareyi basılı tutup sürükleyerek mavi seçim kutusuyla birden fazla öğeyi seçebilirsiniz (`Ctrl` veya `Shift` ile mevcut seçime ekleme yapılır).
  - İlk öğeye tıklayıp `Shift` basılı tutarak son öğeye tıkladığınızda aradaki tüm öğeler seçilir.

### B. Görünüm Modları ve Akıllı Kapak (Thumbnail) Sistemi
Sağdaki görünüm seçiciden 8 farklı görünüm kullanabilirsiniz:
- `☰ Detaylı Liste` ve `≡ Sıkışık Liste`
- `☷ Kompakt Liste` (3 sütunlu yoğun görünüm)
- `▤ Döşemeler (Tiles)`
- `⊞ Küçük / Orta / Büyük Kapaklar`
- `🖼️ Çok Büyük Galeri` (dosya boyutu ve tarih alt bilgisiyle)

**Kapak Yükleme Modları (HDD Korumalı):**
1. **Kapaklar: Kapalı (0 Yük):** Hiç kapak yüklenmez, yalnızca ikonlar görünür.
2. **Kapaklar: Sadece Seçililer:** Yalnızca seçtiğiniz fotoğraf/videoların kapağını sırayla yükler.
3. **Kapaklar: Ekrandakiler (Sıralı):** O an ekranda görünen medya dosyalarının kapağını tek tek üretir; sayfayı kaydırdığınızda eski istekleri iptal edip yeni görünenlere geçer.
4. **Kapaklar: Tüm Klasör (Sıralı):** Klasördeki tüm medya dosyalarını sırayla önbelleğe alır (istenirse `⏹` butonuyla durdurulabilir).
- **Tekil Göz (`👁️`) Butonu:** Kapaklar kapalıyken bile yalnızca merak ettiğiniz tek bir fotoğraf/videonun kapağını yüklemek veya önizlemek için satırdaki `👁️` ikonuna basabilirsiniz.

### C. Hızlı Önizleme (QuickLook) ve Hızlı Eleme (Triage)
Bir dosya seçiliyken `Space` (Boşluk) tuşuna bastığınızda harici program açmadan anında önizleme penceresi açılır:
- **Fotoğraf & Video Yakınlaştırma:** `+` / `-` / `0` veya araç çubuğundaki `🔍+`, `100%`, `🔍−` butonlarıyla hem fotoğraflarda hem de videolarda yakınlaştırma ve kaydırma yapabilirsiniz.
- **Hızlı Eleme (Triage):**
  - `B` (veya `🧺 Sepete (B)`): Aktif dosyayı **Toplama Sepeti**'ne ekler ve otomatik olarak **bir sonraki dosyaya** geçer.
  - `Del` / `Shift+Del` (veya `🗑️ Sil`): Aktif dosyayı Geri Dönüşüm Kutusu'na (veya `Shift+Del` ile kalıcı olarak) siler ve otomatik olarak **bir sonraki dosyaya** geçer.
  - `◀ Önceki` / `Sonraki ▶` (veya `←` / `→` ok tuşları) ile klasördeki medyalar arasında geçiş yapabilirsiniz.

### D. Çift Panel (`F3`) ve Doğrulamalı Güvenli Transfer
- **Çift Panel (`◫ Çift Panel (F3)`):** Ekranın sağ tarafında bağımsız bir hedef klasör paneli açılır (kendi geri/yukarı/yenile, adres çubuğu, hızlı disk/klasör seçici ve `+ Klasör` butonuna sahiptir).
- **Doğrudan Aktarım:** Sol listeden seçtiğiniz dosyaları sağ panele sürükleyip bırakabilir (`Ctrl` basılı tutarsanız **kopyalar**, normal bırakırsanız **taşır**) veya sağ paneldeki `➡ Seçilileri Taşı` / `📋 Kopyala` butonlarını kullanabilirsiniz.
- **Güvenli Doğrulama:**
  - Kopyalama bittikten sonra hedef dosya boyutu ile kaynak dosya boyutu otomatik doğrulanır.
  - Farklı sürücüler arası (`D:` → `E:` gibi) **taşıma** işlemlerinde, kaynak dosya silinmeden önce hem boyut hem de dosyanın başı ve sonundan **64 KB SHA-1** özeti karşılaştırılır; eşleşmezse kaynak dosya kesinlikle silinmez.
- **Kuyruk Kontrolü:** Alt çubukta anlık aktarım hızı (`MB/s`), ilerleme yüzdesi, duraklat (`⏸`) ve iptal (`✕`) kontrolleri yer alır.

### E. Gelişmiş Filtre & Aralık Seçim Stüdyosu (`🎯 Aralık & Filtre`)
Klasör içinde karmaşık kurallarla anında seçim veya filtreleme yapmanızı sağlar:
- **Hazır Şablonlar:** `IMG_*`, `VID_*`, `Videolar >100MB`, `Kopya (1)(2)`, `Bugün`, `Temizle`.
- **İsim / Joker / RegExp:** `*.mp4` gibi joker veya `RegExp` kutusunu işaretleyerek `^IMG_2023.*` gibi düzenli ifadeler.
- **Dosya Adındaki Numara Aralığı:** Örneğin `IMG_1050.jpg` ile `IMG_1420.jpg` arasını seçmek için başlangıç `1050`, bitiş `1420`.
- **Tarih & Boyut Aralığı:** Değiştirme tarihi ve `KB / MB / GB` cinsinden min-max boyut aralığı.
- **Kategori & Uzantı:** Videolar, Fotoğraflar, Arşivler, Belgeler, Ses, Sadece Klasörler veya virgülle ayrılmış uzantılar (`.mp4,.jpg`).
- **Satır Sırası Aralığı:** Sıralı listedeki örneğin `1.` ile `500.` satır arasını seçme.
- **Tek Tıkla İşlem:** `✓ Eşleşenleri Seç`, `🔍 Sadece Eşleşenleri Göster`, `🧺 Sepete At`, `📁 Yeni Klasöre Taşı`, `📋 Kopyala`, `🗑️ Sil`.

### F. Toplama Sepeti (`🧺 Sepet`)
Farklı farklı klasörleri gezerken beğendiğiniz veya taşıyacağınız dosyaları tek yerde biriktirmenizi sağlar:
- Herhangi bir klasörde dosya seçip `B` tuşuna basarak (veya sağ tık menüsünden) sepete atın.
- Başka bir klasöre/diske geçin.
- Sağ üstten `🧺 Sepet` çekmecesini açıp `📥 Tümünü Buraya Taşı` veya `📋 Buraya Kopyala` ile hepsini tek seferde hedef klasöre aktarın.

### G. İsteğe Bağlı Klasör Boyutu (`📏 Boyutlar`)
- Klasör açılışını yavaşlatmamak için klasör boyutları başlangıçta boş bırakılır; yalnızca `📏 Boyutlar` butonuna bastığınızda alt klasörlerin boyutları **sıralı (`Concurrency = 1`)** olarak hesaplanır.
- Hesaplama bitince liste otomatik **Boyut (Büyükten Küçüğe `▼`)** sıralanır ve boyutlar **tüm görünüm modlarında** (Liste, Kompakt, Döşeme ve Kapak Kartları) gösterilir.
- İşlem sırasında buton `⏹️ Boyut İptal` haline gelir; tekrar basarsanız, başka klasöre/sekmeye geçerseniz veya sekmeyi kapatırsanız tarama anında iptal edilir.

### H. Tarihe Göre Klasörle (`📅 Tarihle Klasörle`)
- Bulunduğunuz klasördeki dosyaların değiştirme/oluşturma tarihine göre `YYYY\YYYY-MM` (ör. `2025\2025-08`) alt klasörlerine ayrılması için önce **önizleme (dry-run)** gösterir, onaylarsanız tüm dosyaları aynı disk içinde anında (`rename` ile kopyalama yapmadan) ilgili yıl/ay klasörlerine taşır.

### İ. İndeksleme (`⚡ İndeksle`), Disk Analizi (`📊 Analiz`) ve Kopya Bulucu (`🧬`)
- **İndeksle Ne Yapar?** Dosyaların içeriğine veya kapaklarına dokunmadan yalnızca meta verilerini (ad, yol, uzantı, tür, boyut, tarih) SSD'deki SQLite veritabanına kaydeder. Sistem/çöp klasörlerini (`$recycle.bin`, `winsxs`, `node_modules`, `.git` vb.) atlar ve her 20 klasörde `15 ms` nefes molası vererek HDD'yi yormaz. İstediğiniz zaman durdurabilirsiniz.
- **Arama Kapsamı:** Üst arama çubuğunda `Bu Klasör`, `Bu Disk` veya `Tüm İndeks` seçilebilir. Kurulursa Everything CLI (`es.exe`) veya dahili SQLite indeksi üzerinden milisaniyeler içinde arama yapar.
- **Neler Dolduruyor? (`📊 Analiz`):** Seçilen disk veya klasörü kategorilere (Videolar, Fotoğraflar, Arşivler, Belgeler, Ses, Uygulamalar, Kod, Diğer) böler, **En Büyük 100 Dosya** ve **En Büyük Alt Klasörler** listesini çıkarır.
- **Birebir Kopya Bulucu (`🧬 Kopya Dosyaları Bul`):** Analiz ekranındayken önce SQLite'ta aynı boyuttaki dosyaları 0 disk okumasıyla gruplar, ardından `Concurrency = 1` ile dosyanın başı ve sonundan toplam **32 KB SHA-1** kontrolü yaparak kesin kopyaları ve kurtarılacak alanı listeler.

### J. Masaüstü Kısayolu ve Windows Sağ Tık Menüsü
- Üst bardaki kurulum düğmesiyle masaüstüne **LightDesktop** kısayolu ve Windows Explorer sağ tık menüsüne **"LightDesktop ile Aç"** seçeneği eklenir; herhangi bir klasöre sağ tıklayıp doğrudan o klasörü LightDesktop içinde açabilirsiniz.

---

## 3. Klavye ve Fare Kısayolları

| Kısayol | İşlev |
| :--- | :--- |
| `Space` | Seçili dosyada **QuickLook** önizleme aç / kapat |
| `B` | Seçili dosyaları **Toplama Sepeti**'ne ekle/çıkar (QuickLook'ta ekler ve sonrakine geçer) |
| `F3` | **Çift Panel** görünümünü aç / kapat |
| `Ctrl+F` | Arama kutusuna odaklan |
| `Ctrl+L` | Adres çubuğuna odaklan |
| `Ctrl+T` / `Ctrl+W` | Yeni sekme aç / aktif sekmeyi kapat |
| `Ctrl+Shift+N` | Yeni klasör oluştur |
| `Ctrl+A` | Görünür öğelerin tümünü seç |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | Kopyala / Kes / Yapıştır |
| `F2` | Yeniden adlandır (çoklu seçimde toplu adlandırma açılır) |
| `Del` / `Shift+Del` | Çöpe taşı / Kalıcı sil (QuickLook'ta siler ve sonrakine geçer) |
| `Enter` / Çift Tık | Klasöre gir / Dosyayı varsayılan uygulamada aç |
| `Backspace` / `Alt+↑` | Üst klasöre çık |
| `Alt+←` / `Alt+→` / Mouse 4-5 | Geçmişte geri / ileri git |
| `F5` | Klasörü diskten yenile |
| QuickLook: `+` / `-` / `0` | Fotoğraf ve videolarda yakınlaştır / uzaklaştır / %100 sıfırla |

---

## 4. En Efektif Nasıl Kullanılır? (Örnek İş Akışları)

1. **Binlerce Fotoğraf/Video İçinden Hızlı Eleme:**
   - Klasöre girin → Görünümü `Kapaklar: Kapalı` bırakın (anında açılır) → İlk fotoğrafta `Space` basın.
   - `→` ile geçin; saklamak/ayırmak istediklerinize `B` basın (sepete gider ve sonrakine geçer), çöpleri `Del` ile silin.
   - Sonunda hedef klasöre geçip Sepet'ten `📥 Tümünü Buraya Taşı` deyin.
2. **Karışık Telefon / Kamera Yedeğini Düzenleme:**
   - Yedek klasörünü açın → `📅 Tarihle Klasörle` butonuna basın → Çıkan önizlemeyi onaylayın; binlerce dosya saniyeler içinde `2024\2024-07` gibi yıl/ay klasörlerine ayrılır.
3. **HDD'de Yer Açma & Kopya Temizliği:**
   - İlk kez **Bu bilgisayar** ekranından diskinizin altında `⚡ İndeksle` çalıştırın (arka planda yavaş tempoda bitirir).
   - Ardından `📊 Analiz` → `🧬 Kopya Dosyaları Bul` ile hem en büyük gereksiz dosyaları hem de birebir kopyaları bulup temizleyin.
   - Alt klasörlerin hangisinin ne kadar yer tuttuğunu görmek istediğinizde `📏 Boyutlar` ile sıralı hesaplayıp `Boyut ▼` listesini inceleyin.
4. **Karmaşık Toplu Ayıklama (`Aralık & Filtre` + `Çift Panel`):**
   - `F3` ile sağda hedef klasörü açın.
   - Solda `🎯 Aralık & Filtre` ile örneğin `IMG_1200`–`IMG_1450` veya `> 100 MB` videoları seçtirin (`✓ Eşleşenleri Seç`).
   - Sağ paneldeki `➡ Seçilileri Taşı` ile tek tıkla (ve farklı diskse 64 KB SHA-1 doğrulamasıyla) taşıyın.
