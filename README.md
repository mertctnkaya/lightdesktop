# LightDesktop

> **Eski ve büyük sabit disklerde (HDD) ve tüm disklerde donmayan, fotoğraf ve videoları saniyeler içinde ayıklamanızı sağlayan hızlı ve hafif Windows 10 / 11 dosya gezgini.**

Klasik Windows Dosya Gezgini, binlerce fotoğraf veya videonun bulunduğu büyük disklerde her dosyayı aynı anda okumaya çalıştığı için sık sık kilitlenir, "Yanıt Vermiyor" hatası verir veya yavaşlar. **LightDesktop**, diski yormadan yalnızca ekranda gördüğünüz kadarını okuyarak bu sorunu tamamen ortadan kaldırır; günlük dosya düzenleme, fotoğraf/video eleme ve disk temizliği işlerinizi tek bir pencerede hızlandırır.

---

## İndirme ve Kurulum

### Seçenek 1: Hazır Tek Dosya Kurulumu (Önerilen — Kurulum Gerektirmez)

Hiçbir ek program yüklemeden doğrudan kullanmak için:

1. Sağ taraftaki **Releases (Sürümler)** bölümünden en güncel **`LightDesktop.exe`** dosyasını indirin.
2. Çift tıklayıp çalıştırın.
   - _Not: İlk açılışta uygulama yaklaşık 1 saniye boyunca kendi çalışma dosyalarını hazırlar; sonraki tüm açılışlarda anında açılır._
3. İlk açılışta gelen **Hızlı Kurulum Sihirbazı** (veya **⚙️ Ayarlar → Windows Entegrasyonu**) üzerinden tek tıkla:
   - Uygulamayı sabit bir konuma kurabilir (indirdiğiniz dosyayı silseniz bile çalışmaya devam eder),
   - Masaüstü ve **Başlat Menüsü** kısayoluyla birlikte her klasörde **"LightDesktop ile Aç"** sağ tık menüsü ve **`Ctrl + Alt + E`** hızlı açma kısayolu oluşturabilir,
   - Dilerseniz klasörleri doğrudan **LightDesktop ile açılacak şekilde** varsayılan dosya gezgini yapabilirsiniz (tek tıkla istediğiniz an Windows Gezgini'ne geri dönebilirsiniz).

> **Sistem Gereksinimleri:** Windows 10 veya Windows 11 (64-bit). Bilgisayarınızda Edge tarayıcısı kaldırılmış olsa bile çalışır; gerekirse sisteminizdeki Chrome/Brave veya varsayılan tarayıcı üzerinden otomatik olarak açılır.

### Seçenek 2: Kaynak Koddan Çalıştırma ve Derleme (Geliştiriciler İçin)

1. Bilgisayarınızda **Node.js (v22 veya üzeri)** kurulu olmalıdır.
2. Bu depoyu indirin veya klonlayın (`src/` içinde kaynak kodlar, `scripts/` içinde çalıştırma/derleme betikleri bulunur):
   ```bat
   git clone https://github.com/mertctnkaya/lightdesktop.git
   cd lightdesktop
   ```
3. **`Baslat-LightDesktop.bat`** dosyasına çift tıklayarak canlı geliştirme modunda açabilirsiniz.
4. Tek dosyalık taşınabilir `.exe` paketini derlemek için **`Derle-LightDesktop-EXE.bat`** dosyasına çift tıklayın (çıktı `dist\LightDesktop.exe` olarak oluşturulur).

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

### 2. Binlerce Fotoğraf ve Videoyu Tek Tuşla Hızlıca Ayıklama (QuickLook & Eleme)

Harici bir fotoğraf veya video oynatıcı açıp kapatma derdini bitirir:

- Herhangi bir dosyada **`Space` (Boşluk)** tuşuna bastığınızda anında önizleme penceresi açılır.
- **Tek Tuşla Karar Ver ve Sonrakine Geç:**
  - Beğendiklerinizi **`B`** tuşuyla **Sepet**'e atın; otomatik olarak bir sonraki fotoğraf/videoya geçer.
  - İstemeyeceklerinizi **`Del`** tuşuyla anında Geri Dönüşüm Kutusu'na gönderin (hiç beklemeden ekrandan düşer ve hemen sıradaki dosyaya geçer).
- **Yakınlaştırma, Parlaklık ve Ses Hafızası:**
  - Hem fotoğraf hem de videolarda yakınlaştırma (`+` / `-` / `0`) ve sürükleyerek inceleme yapabilirsiniz.
  - Karanlık çıkan çekimleri incelemek için önizleme içindeki **parlaklık kaydırıcısını** kullanabilirsiniz.
  - Video sesini kıstığınızda veya kapattığınızda sonraki videolarda da ses tercihiniz hatırlanır.
- **Sepette Olduğunu Anında Görün:** Sepete eklediğiniz fotoğraf, video ve klasörlerin sol alt köşesinde küçük sepet/onay rozeti görünür; aynı şekilde önizleme penceresinde de o dosyanın sepette olup olmadığı belli olur.

### 3. Klasör Gezerken Dosya Toplama: Toplama Sepeti (`🧺 Sepet`)

Farklı farklı klasörlerden seçeceğiniz fotoğraf, belge veya videoları tek tek kopyalayıp yapıştırmak zorunda değilsiniz:

- Gezdiğiniz her klasörde seçtiğiniz dosyaları **`B`** tuşuyla veya sağ tıkla **Sepet**'e atın.
- İster ana pencerede ister **Çift Panel** içinde hedef klasöre gidin.
- Sağ tık menüsünden veya tek tıkla **"Sepettekileri Buraya Taşı"** / **"Buraya Kopyala"** diyerek tüm seçtiklerinizi tek seferde hedefe aktarın. (Sürükle-bırakla taşıdığınız öğeler sepetten otomatik olarak temizlenir.)

### 4. Çift Panel (`F3`) ve Güvenli Transfer

- **`F3`** tuşuyla ekranın sağında bağımsız bir hedef klasör paneli açılır.
- Sol taraftan sağ panele (veya soldaki klasör ağacına) sürükleyip bırakarak taşıma yapabilir, **`Ctrl`** basılı tutarak kopyalayabilirsiniz.
- **Transfer Doğrulama:** Başka bir diske dosya taşırken kaynak dosyanın silinmeden önce hedefe eksiksiz yazıldığı otomatik olarak kontrol edilir. Büyük işlemlerde alttaki ilerleme çubuğundan anlık hızı görebilir, işlemi duraklatabilir veya iptal edebilirsiniz.

### 5. Gelişmiş Aralık Seçimi ve Akıllı Filtre (`🎯 Aralık & Filtre`)

_"IMG_1050 ile IMG_1420 arasını seç"_, _"100 MB'tan büyük videoları bul"_ veya _"Sadece kopya (1), (2) dosyalarını ayır"_ gibi karmaşık seçimleri tek ekranda halledin:

- İsim / kalıp arama, dosya adındaki sayı aralığı (`1050` – `1420`), boyut aralığı (`KB / MB / GB`), tarih aralığı, tür (video, fotoğraf, arşiv, belge, ses) ve satır sırası aralığı ile filtreleyin.
- Eşleşenleri tek tıkla seçin, sepete atın, yeni klasöre taşıyın veya temizleyin.

### 6. Dağınık Telefon / Kamera Yedeklerini Tek Tıkla Düzenleme (`📅 Tarihle Klasörle`)

- Binlerce karışık fotoğraf ve videonun olduğu bir klasörde **Tarihle Klasörle** butonuna bastığınızda önce size dosyaların nasıl ayrılacağını gösteren bir **önizleme** sunar.
- Onayladığınızda dosyaları aynı disk içinde beklemeden **`Yıl\Yıl-Ay`** (örneğin `2025\2025-08`) klasörlerine otomatik olarak yerleştirir.

### 7. Disk Alanı Analizi, Klasör Boyutları ve Kopya Dosya Bulucu

- **Klasör Boyutları (`📏 Boyutlar`):** Klasör açılışını yavaşlatmamak için yalnızca siz istediğinizde alt klasörlerin gerçek boyutlarını hesaplar ve büyükten küçüğe sıralar.
- **Disk İndeksleme (`⚡ İndeksle`) ve Anlık Arama:** Seçtiğiniz diski diski yormadan hızlıca dizine ekler; böylece _"Bu Klasör"_, _"Bu Disk"_ veya _"Tüm Diskler"_ kapsamında milisaniyeler içinde arama yapabilirsiniz.
- **Disk Analizi (`📊 Analiz`):** Hangi dosya türlerinin diskinizi doldurduğunu, en büyük dosyaları ve en çok yer kaplayan klasörleri gösterir.
- **Birebir Kopya Bulucu:** Gereksiz yer kaplayan birebir kopya dosyaları güvenli kontrollerle tespit edip temizlemenizi sağlar (sistem ve program dosyalarını otomatik olarak korur).

### 8. Güvenli Silme, Dahili Geri Dönüşüm Kutusu ve Geri Alma (`Ctrl+Z`)

- Yanlışlıkla sildiğiniz, yeniden adlandırdığınız, taşıdığınız veya yeni klasöre koyduğunuz işlemleri **`Ctrl+Z`** ile geri alabilirsiniz.
- Normal silme (`Del`) dosyaları her zaman **Windows Geri Dönüşüm Kutusu**'na gönderir. Uygulama içindeki **🗑️ Geri Dönüşüm Kutusu** görünümünden sildiklerinizi tek tek veya topluca geri yükleyebilirsiniz. (Kalıcı silme yalnızca siz özellikle **`Shift+Del`** veya sağ tıktan **Kalıcı Sil** dediğinizde çalışır.)

### 9. Özellikler, Toplu Adlandırma ve Ayarlar Merkezi (`Ctrl+,`)

- **Toplu Yeniden Adlandırma (`F2`):** Birden fazla dosya seçiliyken `F2` tuşuna basarsanız desen/sıra numaralı toplu isimlendirme açılır.
- **Özellikler (`Alt+Enter`):** Tekli veya çoklu seçilen dosya ve klasörlerin toplam gerçek boyutunu, dosya sayısını ve tarihlerini gösterir.
- **Ayarlar Merkezi (`⚙️ Ayarlar`):** Varsayılan görünüm modu, varsayılan kapak yükleme modu, kenar çubuğu genişliği, silme onayı, yeni sekme başlangıç konumu, görsel parlaklık ve önizleme tercihleri gibi pek çok ayarı kendinize göre özelleştirebilirsiniz.
- **Hata ve Teşhis Merkezi (`⚠️ Hatalar`):** Beklenmedik bir sorun yaşarsanız uygulama mümkün olan her durumda çalışmayı sürdürür ve tek tıkla kopyalanabilir ayrıntılı hata raporu hazırlar.

---

## Temel Kısayollar

| Kısayol                                  | İşlev                                                                     |
| :--------------------------------------- | :------------------------------------------------------------------------ |
| **`Space`**                              | Seçili dosya için Hızlı Önizleme (QuickLook) aç / kapat                   |
| **`B`**                                  | Seçilileri **Sepet**'e ekle / çıkar (önizlemede ekler ve sonrakine geçer) |
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
