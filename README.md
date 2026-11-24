# LightDesktop

> **Eski ve büyük sabit disklerde (HDD) ve tüm disklerde donmayan, fotoğraf ve videoları saniyeler içinde ayıklamanızı sağlayan hızlı ve hafif Windows 10 / 11 dosya gezgini.**

[![LightDesktop.exe İndir](https://img.shields.io/badge/%E2%AC%87%EF%B8%8F_LightDesktop.exe_%C4%B0ndir-Son_S%C3%BCr%C3%BCm_Windows_x64-0078d4?style=for-the-badge)](https://github.com/mertctnkaya/lightdesktop/releases/latest/download/LightDesktop.exe) [![Tüm Sürümler](https://img.shields.io/badge/%F0%9F%93%A6_T%C3%BCm_S%C3%BCr%C3%BCmler-Releases-2b2d31?style=for-the-badge)](https://github.com/mertctnkaya/lightdesktop/releases/latest)

Klasik Windows Dosya Gezgini, binlerce fotoğraf veya videonun bulunduğu büyük disklerde her dosyayı aynı anda okumaya çalıştığı için sık sık kilitlenir, "Yanıt Vermiyor" hatası verir veya yavaşlar. **LightDesktop**, diski yormadan yalnızca ekranda gördüğünüz kadarını okuyarak bu sorunu tamamen ortadan kaldırır; günlük dosya düzenleme, fotoğraf/video eleme ve disk temizliği işlerinizi tek bir pencerede hızlandırır.

---

## İndirme ve Kurulum

### Seçenek 1: Hazır Tek Dosya Kurulumu (Önerilen — Kurulum Gerektirmez)

Hiçbir ek program yüklemeden doğrudan kullanmak için:

1. Doğrudan **[LightDesktop.exe (Son Sürüm)](https://github.com/mertctnkaya/lightdesktop/releases/latest/download/LightDesktop.exe)** dosyasını indirin (veya sağ taraftaki **[Releases (Sürümler)](https://github.com/mertctnkaya/lightdesktop/releases/latest)** sayfasından indirin).
2. Çift tıklayıp çalıştırın.
   - _Not: İlk açılışta uygulama yaklaşık 1 saniye boyunca kendi çalışma dosyalarını hazırlar; sonraki tüm açılışlarda anında açılır._
3. İlk açılışta gelen **Hızlı Kurulum Sihirbazı** (veya **⚙️ Ayarlar → Windows Entegrasyonu**) üzerinden tek tıkla:
   - Uygulamayı sabit bir konuma kurabilir (indirdiğiniz dosyayı silseniz bile çalışmaya devam eder),
   - Masaüstü ve **Başlat Menüsü** kısayoluyla birlikte her klasörde **"LightDesktop ile Aç"** sağ tık menüsü ve **`Ctrl + Alt + E`** hızlı açma kısayolu oluşturabilir,
   - Dilerseniz klasörleri doğrudan **LightDesktop ile açılacak şekilde** varsayılan dosya gezgini yapabilirsiniz (tek tıkla istediğiniz an Windows Gezgini'ne geri dönebilirsiniz).

> **Sistem Gereksinimleri:** Windows 10 veya Windows 11 (64-bit). Bilgisayarınızda Edge tarayıcısı kaldırılmış olsa bile çalışır; gerekirse sisteminizdeki Chrome/Brave veya varsayılan tarayıcı üzerinden otomatik olarak açılır.

### Seçenek 2: Kaynak Koddan Çalıştırma ve Derleme (Geliştiriciler İçin)

1. Bilgisayarınızda **Node.js (v22 veya üzeri)** kurulu olmalıdır.
2. Bu depoyu indirin veya klonlayın (5S modüler mimaride `src/backend/`, `src/indexer/`, `src/public/{modals,css,js}/` ve `scripts/host/` klasörlerine ayrılmıştır; sıfır NPM bağımlılığı, RAM statik önbelleği ve bloklamayan hızlı açılış ön-ısıtması ile çalışır):
   ```bat
   git clone https://github.com/mertctnkaya/lightdesktop.git
   cd lightdesktop
   ```
3. **`Baslat-LightDesktop.bat`** dosyasına çift tıklayarak canlı geliştirme modunda açabilirsiniz.
4. Tek dosyalık taşınabilir `.exe` paketini derlemek için **`Derle-LightDesktop-EXE.bat`** dosyasına çift tıklayın (derleme öncesi otomatik `node scripts\verify-5s.js` doğrulaması çalışır ve çıktı `dist\LightDesktop.exe` olarak oluşturulur).

---

## Günlük Hayattaki Hangi Sorunları Çözer ve Neler Sunar?

### 1. Büyük Disklerde Donmadan ve Beklemeden Gezinme

- **Disk Dostu Okuma:** Bir klasöre girdiğinizde içeriklerin tamamını arka planda tarayıp diski kilitlemez. On binlerce dosyalık klasörler bile saniyeler içinde açılır.
- **8 Farklı Görünüm Modu:** Detaylı Liste, Sıkışık Liste, 3 Sütunlu Kompakt Liste, Döşemeler, Küçük/Orta/Büyük Kapaklar ve Çok Büyük Galeri arasında anında geçiş yapabilirsiniz.
- **Akıllı Küçük Resim (Thumbnail) Kontrolü:** Kapak resimlerinin ne zaman yükleneceğini siz seçersiniz:
  - **Kapalı:** Sıfır bekleme, yalnızca ikonlar.
  - **Sadece Seçililer:** Yalnızca üzerine tıkladığınız öğelerin kapağı yüklenir.
  - **Ekrandakiler:** Sadece o an ekranda görünen medya dosyaları sırayla yüklenir.
  - **Tüm Klasör:** İstediğiniz klasördeki tüm kapakları sırayla önbelleğe alır (dilediğiniz an durdurulabilir).
  - _Ayrıca kapaklar kapalıyken bile herhangi bir satırdaki **👁️** simgesine tıklayarak sadece o dosyanın önizleme kapağını yükletebilirsiniz._
- **Sıfır Kurulumla Video & Fotoğraf Kapağı `(v1.1.0)`:** Bilgisayarda FFmpeg kurulu olmasa bile yerleşik Windows Shell desteği sayesinde video ve fotoğraf kapaklarını ek kurulum gerektirmeden üretir.
- **Hover Video Storyboard (`🎞️ Sahne Gezme`):** Büyük kapak görünümlerinde fareyi bir video kartının üstünde ~350 ms beklettiğinizde 5 sahne karesi otomatik olarak sırayla oynatılır; fareyi sağa sola kaydırarak kareler arasında anlık gezinebilirsiniz (SSD'de tek seferlik önbelleklenir).
- **Sürüklenebilir Sütunlar & Başlık Filtresi `(v1.1.0)`:** Liste görünümünde `Ad`, `Değiştirme tarihi`, `Tür` ve `Boyut` sütun genişliklerini sürükleyerek ayarlayabilir (çift tıkla sıfırlanır) ve her sütunun yanındaki `▾` okundan Windows tarzı hızlı filtre/sıralama yapabilirsiniz.
- **Klasöre Özel Görünüm Hafızası `(v1.1.0)`:** Her klasör için seçtiğiniz görünüm modu (liste, kapak vb.) klasör bazında otomatik hatırlanır.

### 2. Binlerce Fotoğraf ve Videoyu Tek Tuşla Hızlıca Ayıklama (QuickLook & Eleme)

Harici bir fotoğraf veya video oynatıcı açıp kapatma derdini bitirir:

- Herhangi bir dosyada **`Space` (Boşluk)** tuşuna bastığınızda veya fotoğraf, GIF, video, **PDF**, **metin/kod** dosyalarına **çift tıkladığınızda** (Ayarlar'dan değiştirilebilir) ekranın %70'inden fazlasını kaplayan büyük dahili önizleme penceresi açılır; dilediğiniz an üstteki **Varsayılan Uygulamada Aç** düğmesine de geçebilirsiniz.
- **Dahili PDF, Metin, Kod & Markdown Editörü:** PDF dosyalarını doğrudan dahili okuyucuda açabilir; `.txt`, `.log`, `.json`, `.csv`, `.xml`, `.yaml`, `.ini`, uzantısız proje dosyalarını (`Makefile`, `Dockerfile`, `LICENSE`, `.env` vb.) ve kaynak kod dosyalarını (`js`, `ts`, `py`, `cs`, `html`, `css`, `sql`, `ps1` vb.) koyu temalı metin editöründe düzenleyip **`Ctrl+S`** ile kaydedebilirsiniz. `.md` dosyaları zengin **Markdown Önizleme** modunda açılır (tek tıkla düzenlemeye geçilebilir); `.json` dosyalarında **Biçimlendir**, `.csv/.tsv` dosyalarında **Tablo Görünümü** bulunur.
- **Dahili ZIP Arşiv Yöneticisi (Açma, Ayıklama & Sıkıştırma):** `.zip` dosyalarına çift tıklayarak veya sağ tıktan açılan pencerede arşiv içindeki dosya/klasörleri arayabilir, **checkbox / `Ctrl` / `Shift`** ile tekil veya toplu seçip yalnızca seçtiklerinizi ayıklayabilir ya da sağ menüden tek tıkla **Buraya Ayıkla / Klasöre Ayıkla / ZIP Olarak Sıkıştır** işlemlerini yapabilirsiniz.
- **Videodan Kare Kare İlerleme (`,` / `.`), Kare Yakalama (`S`) & Kayıpsız Kırpma (`✂️ Kırp`):** Video izlerken **`⏮ Kare`** / **`Kare ⏭`** düğmeleri veya **`,` / `.`** tuşlarıyla kare kare (`Shift` ile 5'er kare) geri/ileri gidebilir; **`S`** tuşu veya **`📸 Kare Al`** ile tam o kareyi yüksek çözünürlükte JPEG olarak (videonun yanına ya da Ayarlar → **Yollar & Kayıt Konumları** bölümünden seçtiğiniz özel klasöre) kaydedebilirsiniz. **`✂️ Kırp`** ile görsel zaman çizelgesinden **A–B** tutamaçlarını sürükleyerek (ve **`▶ Seçimi Oynat`** ile önizleyerek) FFmpeg üzerinden yeniden kodlamadan (`-c copy`) orijinal dosyaya dokunmadan saniyeler içinde yeni kırpılmış klip oluşturabilirsiniz; kırpılan videoların varsayılan kayıt klasörünü de Ayarlar'dan seçebilirsiniz.
- **Tek Tuşla Karar Ver ve Sonrakine Geç:**
  - Beğendiklerinizi **`B`** tuşuyla **Sepet**'e atın; otomatik olarak bir sonraki fotoğraf/videoya geçer. (Önizlemedeyken **`Sepette ✓`** butonuna veya **`B`** tuşuna basarak öğeyi sepetten çıkarabilirsiniz `(v1.1.0)`.)
  - İstemeyeceklerinizi **`Del`** tuşuyla anında Geri Dönüşüm Kutusu'na gönderin (hiç beklemeden ekrandan düşer ve hemen sıradaki dosyaya geçer).
- **Yakınlaştırma, Parlaklık ve Ses Hafızası:**
  - Hem fotoğraf hem de videolarda yakınlaştırma (`+` / `-` / `0`) ve sürükleyerek inceleme yapabilirsiniz.
  - Karanlık çıkan çekimleri incelemek için önizleme içindeki **parlaklık kaydırıcısını** kullanabilirsiniz.
  - Video sesini kıstığınızda veya kapattığınızda sonraki videolarda da ses tercihiniz hatırlanır.
- **Sepette Olduğunu Anında Görün:** Sepete eklediğiniz fotoğraf, video ve klasörlerin sol alt köşesinde küçük sepet/onay rozeti görünür; aynı şekilde önizleme penceresinde de o dosyanın sepette olup olmadığı belli olur.
- **✨ Önizlemeden Benzerlerini Bul `(v1.1.0)`:** Önizleme penceresindeki **✨ Benzerlerini Bul** düğmesiyle o dosya ile aynı saatte/günde çekilen veya benzer isimli tüm dosyaları anında listeleyebilirsiniz.

### 3. Klasör Gezerken Dosya Toplama: Toplama Sepeti (`🧺 Sepet`)

Farklı farklı klasörlerden seçeceğiniz fotoğraf, belge veya videoları tek tek kopyalayıp yapıştırmak zorunda değilsiniz:

- Gezdiğiniz her klasörde seçtiğiniz dosyaları **`B`** tuşuyla veya sağ tıkla **Sepet**'e atın.
- İster ana pencerede ister **Çift Panel** içinde hedef klasöre gidin.
- Sağ tık menüsünden veya tek tıkla **"Sepettekileri Buraya Taşı"** / **"Buraya Kopyala"** diyerek tüm seçtiklerinizi tek seferde hedefe aktarın. (Sürükle-bırakla taşıdığınız öğeler sepetten otomatik olarak temizlenir.)

### 4. Çift Panel (`F3`), Masaüstü Sürükle-Bırak ve Güvenli Transfer

- **`F3`** tuşuyla ekranın sağında bağımsız bir hedef klasör paneli açılır.
- **Sağ Panelde Seçim, Fareyle Kutulu Seçim & Kısayollar `(v1.1.0)`:** Sağ panelde tekli/çoklu (`Ctrl` / `Shift`) seçim yapabilir, fareyle sürükleyerek mavi seçim kutusuyla toplu seçebilir, sağ tık menüsü ve tüm klavye kısayollarını (`Space`, `Ctrl+A/C/X/V`, `Del`, `F2`, `B`, `↑/↓`, `Alt+Enter`) doğrudan sağ panelde kullanabilirsiniz.
- Sol taraftan sağ panele (veya soldaki klasör ağacına) sürükleyip bırakarak taşıma yapabilir, **`Ctrl`** basılı tutarak kopyalayabilirsiniz.
- **Çift Yönlü Masaüstü Sürükle-Bırak & Windows Pano Uyumu `(v1.1.0)`:** LightDesktop'tan Windows Masaüstü'ne veya diğer uygulamalara dosya sürükleyip bırakabilir, dışarıdan LightDesktop klasörlerine dosya bırakabilirsiniz. Uygulama içindeki `Ctrl+C` / `Ctrl+X` / `Ctrl+V` işlemleri Windows dosya panosuyla doğrudan uyumlu çalışır.
- **Akıllı Disk Kuralı `(v1.1.0)`:** Aynı disk içine sürükle-bırak yaparken otomatik **taşıma**, farklı diske (ör. HDD'den Masaüstü'ne) sürüklerken kaynak dosyayı silmeden otomatik **kopyalama** uygulanır (`Ctrl` = Kopyala, `Shift` = Taşı).
- **🕒 Son Erişilen Yollar `(v1.1.0)`:** Sol kenar çubuğunda _Cihazlar ve Sürücüler_ üstünde açılır kapanır liste halinde son dosya taşıdığınız veya kopyaladığınız 15 hedef klasör tutulur; doğrudan üzerine sürükle-bırakla ya da sağ tık **Gönder** menüsüyle tek hamlede dosya aktarabilirsiniz.
- **🧲 Geçici Yüzen Raf (`Ctrl+Shift+S`):** Dosya sürüklemeye başlayınca sağ altta otomatik açılan **Geçici Raf**'a farklı klasörlerden seçtiğiniz dosyaları park edebilir, hedef klasöre geçince **Tümünü Sürükle** ya da tek tıkla **Buraya Taşı / Kopyala** diyerek aktarabilirsiniz.
- **Transfer Doğrulama:** Başka bir diske dosya taşırken kaynak dosyanın silinmeden önce hedefe eksiksiz yazıldığı otomatik olarak kontrol edilir. Büyük işlemlerde alttaki ilerleme çubuğundan anlık hızı görebilir, işlemi duraklatabilir veya iptal edebilirsiniz.

### 5. Gelişmiş Aralık Seçimi, Akıllı Filtre (`🎯 Aralık & Filtre`) ve Benzerlerini Bul

_"IMG_1050 ile IMG_1420 arasını seç"_, _"100 MB'tan büyük videoları bul"_ veya _"Sadece kopya (1), (2) dosyalarını ayır"_ gibi karmaşık seçimleri tek ekranda halledin:

- İsim / kalıp arama, dosya adındaki sayı aralığı (`1050` – `1420`), boyut aralığı (`KB / MB / GB`), tarih aralığı, tür (video, fotoğraf, arşiv, belge, ses) ve satır sırası aralığı ile filtreleyin.
- Eşleşenleri tek tıkla seçin, sepete atın, yeni klasöre taşıyın veya temizleyin.
- **✨ İlişkili ve Benzer Dosyaları Bul `(v1.1.0)`:** Araç çubuğundan, sağ tık menüsünden veya Hızlı Önizleme içinden tek tıkla seçili dosyanın hem değiştirilme tarihine hem de dosya adındaki çekim tarihine göre **±1 saat**, **aynı gün**, **±3 gün**, **aynı ay** veya **benzer ad** modlarında bu klasörde, diskte ya da tüm indekslenmiş disklerde eşleşen diğer dosyaları tek listede toplayabilirsiniz.
- **✨ Kaydedilmiş Akıllı Klasörler (Sanal Görünüm):** Sol kenar çubuğundaki _Akıllı Klasörler_ bölümünde hazır sanal görünümler (*Son 7 Gün Videoları*, *500 MB+ Büyük Dosyalar*, *Bu Ay Fotoğrafları*) bulunur; Gelişmiş Filtre Stüdyosu'ndaki **💾 Akıllı Klasör Kaydet** ile kendi kalıcı sanal klasörlerinizi ekleyebilirsiniz.
- **⌘ Akıllı Komut & Hızlı Gezinti Paleti (`Ctrl+K`):** Tek kutudan tüm uygulama eylemlerine, disklere/kısayollara anında ulaşabilir ve `> 100mb video`, `bugün` gibi tek satır sorgularla filtre uygulayabilirsiniz.

### 6. Dağınık Telefon / Kamera Yedeklerini Tek Tıkla Düzenleme (`📅 Tarihle Klasörle`)

- Binlerce karışık fotoğraf ve videonun olduğu bir klasörde **Tarihle Klasörle** butonuna bastığınızda önce size dosyaların nasıl ayrılacağını gösteren bir **önizleme** sunar.
- **Kopyala / Taşı Seçeneği, Hedef Seçimi & Düzenli Çıktı Klasörü `(v1.1.0)`:** İşlem öncesinde dosyaların **kopyalanarak** (orijinaller yerinde kalarak) mı yoksa **taşınarak** mı ayrıştırılacağını ve çıktının **güncel konuma** mı yoksa **seçeceğiniz başka bir klasöre** mi (`📂 Gözat...` veya `◫ Sağ Panel`) oluşturulacağını seçebilirsiniz.
- Onayladığınızda dosyaları doğrudan klasöre dağıtmak yerine **`[Klasör adı] Tarihle Ayrıştırıldı`** ana klasörü altında **`Yıl\Yıl-Ay`** (örneğin `Captures Tarihle Ayrıştırıldı\2025\2025-08`) yapısına otomatik olarak yerleştirir.

### 7. Disk Alanı Analizi, Klasör Boyutları ve Kopya Dosya Bulucu

- **Akıllı Tarama Önbelleği & Yeniden Tarama Önerisi:** Disk Analizi, Kopya Bulucu ve Klasör Boyutları bir kez çalıştıktan sonra SSD'de önbelleklenir ve sonraki açılışlarda diski yormadan **anında** açılır. Klasörlerde değişiklik algılandığında üst şeritte otomatik olarak **yeniden tarama önerisi** gösterilir (`Shift` + `📏 Boyutlar` veya **Canlı Tara** ile zorla güncellenebilir).
- **Klasör Boyutları (`📏 Boyutlar`):** Klasör açılışını yavaşlatmamak için yalnızca siz istediğinizde alt klasörlerin gerçek boyutlarını hesaplar ve büyükten küçüğe sıralar.
- **Disk İndeksleme (`⚡ İndeksle`) ve Anlık Arama:** Seçtiğiniz diski diski yormadan hızlıca dizine ekler; böylece _"Bu Klasör"_, _"Bu Disk"_ veya _"Tüm Diskler"_ kapsamında milisaniyeler içinde arama yapabilirsiniz.
- **Disk Analizi (`📊 Analiz`):** Hangi dosya türlerinin diskinizi doldurduğunu, en büyük dosyaları ve en çok yer kaplayan klasörleri gösterir.
- **Birebir Kopya Bulucu:** Gereksiz yer kaplayan birebir kopya dosyaları güvenli kontrollerle tespit eder (sistem ve program dosyalarını otomatik korur). **Yazılım Projesi Koruması (`💻 Yazılım projelerini koru` — varsayılan açık)** sayesinde `.git`, `package.json`, Capacitor/Android `assets/`, `dist/` ve `build/` gibi proje varlıkları (logo, ikon, derleme çıktıları vb.) otomatik korunur ve kaç proje dosyasının hariç tutulduğu size bildirilir (isterseniz tek tıkla kapatabilirsiniz). Tüm fazlaları topluca çöpe atabileceğiniz gibi **`Ctrl+Tık` / `Shift+Tık`** ile tekil veya aralık seçip **`Del`** / sağ tık ya da satır üzerindeki hover **`🗑️` (Çöpe At) / `👁️` (Önizle)** butonlarıyla kontrollü biçimde temizleyebilirsiniz; silinen dosyalar listeden ve grup sayaçlarından anında düşer.

### 8. Güvenli Silme, Dahili Geri Dönüşüm Kutusu ve Geri Alma (`Ctrl+Z`)

- Yanlışlıkla sildiğiniz, yeniden adlandırdığınız, taşıdığınız veya yeni klasöre koyduğunuz işlemleri **`Ctrl+Z`** ile geri alabilirsiniz.
- Normal silme (`Del`) dosyaları her zaman **Windows Geri Dönüşüm Kutusu**'na gönderir. Uygulama içindeki **🗑️ Geri Dönüşüm Kutusu** görünümünden sildiklerinizi tek tek veya topluca geri yükleyebilirsiniz. (Kalıcı silme yalnızca siz özellikle **`Shift+Del`** veya sağ tıktan **Kalıcı Sil** dediğinizde çalışır.)
- **Gizli 30 Günlük Koruma Kasası (`Ctrl+,` → Ayarlar):** Ayarlar'dan korunan klasör yolları belirleyebilirsiniz; bu klasörlerden **`Shift+Del`** ile kalıcı silinen veya **Çöp Kutusu'ndan kalıcı silinen/boşaltılan** öğeler kullanıcıya normal silinmiş gibi gösterilir ama gizli kasada **30 gün** boyunca saklanır ve yalnızca Ayarlar içinden geri yüklenebilir (listedeki dışındaki diğer tüm yollar doğrudan kalıcı silinir).

### 9. Özellikler, Toplu Adlandırma ve Ayarlar Merkezi (`Ctrl+,`)

- **Toplu Yeniden Adlandırma (`F2`):** Birden fazla dosya seçiliyken `F2` tuşuna basarsanız desen/sıra numaralı toplu isimlendirme açılır.
- **Özellikler (`Alt+Enter`):** Tekli veya çoklu seçilen dosya ve klasörlerin toplam gerçek boyutunu, dosya sayısını ve tarihlerini gösterir; `Konum` ve `Tam Yol` satırları seçilebilir ve tek tıkla kopyalanabilir `(v1.1.0)`.
- **Windows Sistem Entegrasyonu & Kurulum Sihirbazı `(v1.1.0)`:** İlk kurulum sihirbazı veya Ayarlar üzerinden tek tıkla sabit konuma kurulum (`%LOCALAPPDATA%\LightDesktop`), Masaüstü/Başlat menüsü kısayolu (`Ctrl+Alt+E`), klasör sağ tık menüsü, sistem tepsisinde arka planda hazır bekleme (`--background`) ve istendiğinde Windows Gezgini'ne tek tıkla geri döndürülebilen **Varsayılan Klasör Gezgini** modu yönetilebilir (`Denetim Masası` gibi sanal sistem klasörleri otomatik olarak Windows Gezgini'nde açılır).
- **Ayarlar Merkezi (`⚙️ Ayarlar`):** Varsayılan görünüm modu, varsayılan kapak yükleme modu, kenar çubuğu genişliği, silme onayı, yeni sekme başlangıç konumu, görsel parlaklık ve önizleme tercihleri gibi pek çok ayarı kendinize göre özelleştirebilirsiniz. Tüm konum seçimlerinde (`Gözat...` / `Korunan Klasör Ekle`) arka plana düşmeyen koyu temalı **dahili hızlı klasör seçici** kullanılır.
- **Hata ve Teşhis Merkezi (`⚠️ Hatalar`):** Beklenmedik bir sorun yaşarsanız uygulama mümkün olan her durumda çalışmayı sürdürür (bozuk indeks veritabanı otomatik onarılır); log/hata satırları mouse ile doğrudan seçilebilir ve **🩺 Teşhis Raporu Kopyala** ile tek tıkla paylaşılabilir ayrıntılı hata raporu hazırlanır `(v1.1.0)`.

---

## Temel Kısayollar

| Kısayol                                  | İşlev                                                                     |
| :--------------------------------------- | :------------------------------------------------------------------------ |
| **`Space`**                              | Seçili dosya için Hızlı Önizleme (QuickLook) aç / kapat                   |
| **`,` / `.`** _(Video Önizlemede)_       | Önceki / Sonraki video karesine adım at (`Shift`: 5'er kare atla)         |
| **`S`** _(Önizlemede)_                   | Videonun o anki karesini tam çözünürlüklü JPEG olarak kaydet              |
| **`B`**                                  | Seçilileri **Sepet**'e ekle / çıkar (önizlemede ekler ve sonrakine geçer) |
| **`Ctrl+K`**                             | **Akıllı Komut & Hızlı Gezinti Paleti**'ni aç                             |
| **`Ctrl+Shift+S`**                       | **Geçici Yüzen Raf**'ı aç / kapat                                         |
| **`Del` / `Shift+Del`**                  | Geri Dönüşüm Kutusu'na taşı / Kalıcı olarak sil                           |
| **`Ctrl+Z`**                             | Son dosya işlemini geri al                                                |
| **`F3`**                                 | **Çift Panel**'i aç / kapat                                               |
| **`Alt+Enter`**                          | Seçili dosya veya klasörlerin Özellikler / Boyut penceresini aç           |
| **`F2`**                                 | Yeniden adlandır (çoklu seçimde toplu adlandırma)                         |
| **`Ctrl+T` / `Ctrl+W`**                  | Yeni sekme aç / aktif sekmeyi kapat                                       |
| **`Ctrl+Shift+N`**                       | Yeni klasör oluştur                                                       |
| **`Ctrl+F` / `Ctrl+L`**                  | Arama kutusuna / adres çubuğuna odaklan                                   |
| **`Ctrl+A`**                             | Listedeki tüm öğeleri seç                                                 |
| **`Ctrl+C` / `Ctrl+X` / `Ctrl+V`**       | Kopyala / Kes / Yapıştır                                                  |
| **`Ctrl+,`**                             | Ayarlar Merkezi'ni aç                                                     |
| **`Alt+←` / `Alt+→` / Fare Yan Tuşları** | Klasör geçmişinde geri / ileri git                                        |
| **`Backspace` / `Alt+↑`**                | Üst klasöre çık                                                           |
| **`F5`**                                 | Klasörü yenile                                                            |
