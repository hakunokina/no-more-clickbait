# Üç kart türü — maket ve tasarım kararları

`timeline-cards-mockup.html` tek dosyalık, tıklanabilir maket. Tarayıcıda
doğrudan açılır; dış kaynak yüklemez, tüm veri sentetiktir (uydurma
kullanıcılar, `example.invalid` alan adları, gömülü SVG görseller, marka
logosu yok). Üstteki kesikli şerit ("Maket · üründe yok") yalnız maketin
denetimleridir: durum (karışık akış / yalnız X / kısa akış / hazırlanıyor /
boş / hata) ve sütun genişliği (640 / 414 / 360). Tema düğmesi ürünün
parçasıdır.

Bu maket **aynı okuma penceresinin** üç kart türünü yan yana gösterir.
Üst bilgi, ilerleme çubuğu/sayacı, Bitti ekranı, tema ve genişlik
`timeline-mockup.md`'den aynen; bu belge yalnız yeni olanı yazar. Aynı
şekilde X kartı (`renderPost`) onaylı maketten **aynen** alındı: fark
yalnız imza (`mixed` bayrağı) ve karışık akışta kartın başına gelen
kaynak satırının yeniden paylaşım satırını içine alması (bölüm 2).

## Akış

```
Karışık akış: üst bilgi → giriş satırı (kaynaklar sayılır) → 14 kart
   (X · Instagram · genel, tek sıralama) → Bitti (döküm kaynak kırılımlı)
Yalnız X: aynı pencere, kaynak satırı yok, döküm eski hâliyle
```

## Kart anatomileri

### X kartı (değişmez)

`timeline-mockup.md` bölüm 1–5. Karışık akışta başına kaynak satırı gelir,
başka hiçbir şey değişmez.

### Instagram kartı

```
[camera] Instagram                                 ← kaynak satırı (yalnız karışık akışta)
(AV) handle ✓ ve ortak-yazar · 6 sa                ← yazar satırı (40px avatar, ad değil handle)
     [Ücretli ortaklık · Marka] / [Konum]          ← alt satır, varsa
┌──────────────────────────────────────────────┐
│  medya (tam sütun genişliği, 4:5–1,91:1)      │  carousel: n/N çipi, ‹ ›, noktalar
└──────────────────────────────────────────────┘
handle Caption metni… (3 satırda "Devamını oku")
[doğrulama bandı]                                   ← X ile aynı bileşen
♡ 8,4 B   💬 212        Neden burada?  Instagram'da aç ↗
```

Reel aynı iskelette: 9:16 çerçeve (≤576px, ortalı, `--media-bg` zemin),
"Reel" etiketi, oynat + süre çipi; sayılarda oynatma sayısı ayrıca.

### Genel kart (Reddit + özel siteler)

```
[r/] r/bilim · u/yazar · 4 sa                      ← yer satırı (topluluk ya da site adı)
BAŞLIK 17px/700 (kesilmez)  [Etiket]      [küçük  ]  ← görsel sağda 88px (360'ta 72px)
kısa metin / özet (4 satırda "Devamını oku")
⛓ dergi.example.invalid                            ← alan adı satırı (bağlantı hedefi)
[doğrulama bandı]
↑ 4,2 B   💬 380         Neden burada?  Kaynağa git ↗
```

## Kararlar

1. **Tek sıralama, tek okuma değeri.** Üç tür aynı listede okuma değerine
   göre durur; kaynağa göre gruplama yok. Neden: ürünün sözü "en değerli
   üstte"; kaynak bloğu konursa sıra anlamını yitirir ve kullanıcı üç ayrı
   akışı okumak zorunda kalır.
2. **Kaynak ayrımı kart başında küçük bir satır.** X ve Instagram'da 16px
   işaret + kaynak adı (X'te yeniden paylaşımı da taşır, ikinci satır
   eklenmez). Yalnız akışta birden çok kaynak varsa gösterilir — tek
   kaynaklı akışta her karta aynı etiketi basmak gürültüdür (makette
   "Yalnız X" durumunda satır yoktur). **Genel karta ayrı satır konmaz:**
   yer satırı (`r/bilim`, "Kuzey Gazetesi") zaten kaynağı söylüyor; ikinci
   bir "Reddit" etiketi aynı bilgiyi tekrar eder. Ekran okuyucu için yer
   satırının başına gizli "Reddit," öneki eklenir.
3. **Instagram tanıdık ama ürünün diliyle.** Tanınması için: handle baş
   rolde, medya tam genişlik ve X'ten büyük oran (4:5–1,91:1), caption
   medyanın altında `handle metin…` biçiminde, carousel'de sayaç + nokta.
   Vazgeçilenler: beğen/kaydet düğmeleri (ürün etkileşim taşımıyor —
   sayılar X'teki gibi salt gösterim), çift tıklama etkileşimi, Instagram
   gradyanı/logosu (public repo; `camera` çizgi ikonu kullanılır),
   otomatik oynatma ("hazırlıklı akış" ilkesi ve hareket azaltmayla
   çelişir).
4. **IG medyasına kırpma yok (patron onayı beklenebilir).** X kartının
   onaylı kuralı "görsel tam boy, kırpma yok" IG'ye de uygulandı: ilk kare
   oranı 4:5 ile 1,91:1 aralığına kıstırılır, karenin yüksekliği 576px ile
   sınırlıdır, görsel `contain` ile `--media-bg` dolgusu üzerinde durur;
   kırpılmamış hâli zaten budur, tıklayınca ışık kutusu açılır. Reel'de
   9:16 posterlikte `cover` kabul edildi: video posteri bilgiyi taşıyan
   kare değil, oynayınca gerçek çerçeve görünür. Instagram'ın tanıdık
   kenardan kenara kırpması istenirse bu kararın bilinçli bozulması
   gerekir — lider/patron kararı; maket bunu yapmıyor.
5. **Carousel IG'nin, erişilebilirlik ürünün.** Kaydırma (dokunma/iz
   paneli, `scroll-snap`) + 32px ok düğmeleri + `n/N` yazı çipi + noktalar
   (salt görsel, `aria-hidden`). Klavye asıl yol oklardır; görünmeyen
   karenin düğmeleri `inert` (Tab sırasına girmez), ok düğmesi tıklamasında
   `aria-live` "Görsel n / N" duyurur, uçta gizlenen ok odaktaysa odak
   karşı oka geçer. Görseli büyütmek = X'teki aynı ışık kutusu (←/→).
6. **Genel kartta başlık baş rolde, görsel küçük.** Genel kaynağın özü
   bağlantıdır ve clickbait başlıkta yaşar: başlık 17px/700, **hiçbir
   varyantta kesilmez** (kesilen başlık, kullanıcının yargısını ürüne
   değil merak boşluğuna bırakır — ürünün çözdüğü sorun budur). Görsel
   varsayılan olarak sağda 88px küçük görsel: başlık+özeti itmez, kart
   taranabilir kalır; tıklanınca ışık kutusunda aslı açılır. Tek istisna:
   `kind=image` — görselin kendisi içerikse (Reddit fotoğraf gönderisi)
   X'teki tam boy medya bileşeni kullanılır.
7. **Alan adı her zaman görünür.** Bağlantının nereye gittiği tıklanmadan
   önce okunur (clickbait'e karşı ikinci savunma): Reddit bağlantı
   gönderisinde dış alan adı (`linkUrl`), özel sitede öğenin kendi alan
   adı. Kural: Reddit'in kendi metin/görsel gönderisinde satır yoktur
   (reddit.com zaten yer satırından belli) — tekrar eklemez.
8. **Üç türde de sıra aynı:** içerik → doğrulama bandı → alt bilgi.
   `VerificationBand`, `WhyPanel`, `EngagementRow`, ışık kutusu ve
   "Devamını oku" üç türde **aynı** bileşen ve aynı dil; yalnız
   etkileşim sözlüğü kaynaktan gelir (X: yanıt/yeniden paylaşım/beğeni/
   görüntülenme; IG: beğeni/yorum/oynatma; genel: puan ↑/yorum).
   Açılış bağlantısı kaynak adıyla: "X'te aç" / "Instagram'da aç" /
   "Kaynağa git" (genel bir bağlantı metni "aç" neyin açılacağını
   söylemezdi).
9. **Etkileşim sayıları her türde sade ve tıklanamaz.** Yoksa satır yok —
   özel sitede sahte "0 yorum" yazılmaz, puan ↑ 0 ise gösterilir
   (Reddit'te 0 ve negatif puan anlamlıdır; negatif `−312` yazılır).
10. **Döküm karışık akışta kaynak kırılımını söyler.** "Taranan" satırının
    altında `X 150 · Instagram 40 · Reddit 40 · …` — kullanıcı hangi
    kaynağın ne verdiğini Bitti ekranında görür; kart başına ayrıca etiket
    gerekmiyor. Kaynağı olmayan (toplamada 0 çeken) kaynak listede
    sayılmaz, yokluğu toplama hatası sayılır ve hata durumunda yazılır.

Ayrıca: IG zaman bilgisi yazar satırındadır (X'le aynı yere inmesi için;
IG'de caption altında olsaydı akışta kartlar arasında göz zıplardı).
Ücretli ortaklık etiketi konumla aynı alt satıra iner ama ayrı sözlükte
("Ücretli ortaklık · Değirmen Un") — reklam şeffaflığı genelde de aynı:
`promoted=true` olan öğe akışa hiç girmez (mevcut hat kuralı), ücretli
ortaklık ise reklam değildir ve etiketiyle gösterilir.

## Token'lar ve ölçüler (maket)

Tümü `timeline-mockup.md` token'larından. Yeni token **üç**:

| Token | Değer | Kullanım |
| --- | --- | --- |
| `--fs-title` | 1.0625rem (17px) / 1.3 / 700 | yalnız genel kart başlığı |
| `--thumb` | 88px (≤380px: 72px) | genel kart küçük görseli, köşe `--r-box` |
| `--reel-h` | `min(80vh, 640px)` → makette 576px ölçülüyor | reel çerçeve yüksekliği |

Kaynak satırı: 13px/600 `--muted` (her iki temada ≥5,7:1, `--muted`'in
onaylı kontrastı), işaret 16×16, köşe 4px, zemin `--muted` üzerinde metin
rengi `--bg` (salt dekoratif; anlamı yanında metin taşır).
Site rozeti: 40×40, köşe 10px, harf 800 — kişi avatarından (yuvarlak)
bilinçli ayrılır: yuvarlak = kişi, köşeli = site/topluluk; favicon
şemada yok (aşağıda istek 3).
Etiket (flair): 12px/600 `--muted`, `--border` çerçeveli hap, başlığın
son kelimesine bitişik (başlık bloğundan ayrı satır kaplamaz).

### Varyant tablosu (IG)

| `kind` / durum | Medya | Not |
| --- | --- | --- |
| tek kare | ilk kare oranı kıstırılmış, `contain`, ALT çipi | |
| carousel (n≥2) | snap track + sayaç + oklar + noktalar | video karesi varsa poster + oynat, dönmez |
| reel | 9:16, ≤576px, ortalı, "Reel" + süre çipi | oynatınca X `VideoPlayer` denetimleri |
| caption ≤180 kr / 3 satır | tam gösterilir | üstü "Devamını oku" (yerinde açılır) |
| caption boş | metinsiz kart | `mediaOnly` kuralıyla zaten akışta olmamalı — olursa caption satırı yok |

### Varyant tablosu (genel)

| Durum | Düzen |
| --- | --- |
| başlık + metin + görsel | başlık, metin, 88px görsel sağda |
| başlık + görsel, metin yok | aynı; metin satırı yok |
| başlık + metin, görsel yok | tam genişlik metin (4 satır kesme) |
| `kind=image` | tam boy medya başlığın altında (`MediaGrid`) |
| başlık + bağlantı yalnız | en kısa kart: yer + başlık + alan adı + alt bilgi |
| başlıksız (yalnız metin) | metin başlığa çıkar (`aria-labelledby` yer satırına) |
| uzun başlık | kesilmez, sarar; etiket başlığın sonuna eklenir |
| zaman yok | meta satırında yalnız yazar; yazar da yoksa satır yok |

## Duyarlılık

Kural eskisi gibi `.app` **kabı** genişliğine göre (`timeline-mockup.md`).
Yeni davranışlar:

- ≤480px: IG medyası kenardan kenara kaynaşır (`margin-inline: -12px`,
  köşesiz) — IG'nin mobil alışkanlığı; X ve genel kart kenar boşluğunu
  korur (medya zaten iç sütuna hizalı). Genel kart gövde aralığı 8px.
- ≤380px: küçük görsel 72px; görüntülenme/oynatma sayısı gizlenir
  (`data-k="views"` kuralı reel'e de uygulanır).
- Carousel okları her genişlikte görünür (dokunmada kaydırma zaten var;
  ok gizlenirse klavyede yol kalmaz).
- Hiçbir genişlikte yatay taşma yok (640/414/360 ve koyu temada ölçüldü).

## Erişilebilirlik (uygulayan doğrulasın)

X maketindeki kurallar aynen geçerli; ekler:

- Her kart `article` + `aria-posinset/setsize`; adı: IG'de yazar satırı,
  genelde başlık (başlıksızda yer satırı), açıklaması caption/metin.
- Kaynak satırı metni ekran okuyucuda "Kaynak: Instagram"; genel kartta
  yer satırı "Reddit, r/bilim". İşaretler/rozet `aria-hidden`.
- Klavye sırası (IG): yazar → ortak yazar → medya (büyüt) → ALT → carousel
  okları → Devamını oku → doğrulama → Neden burada? → Instagram'da aç.
  (Genel): küçük görsel/büyük medya → alan adı → Devamını oku → doğrulama
  → Neden burada? → Kaynağa git. **J/K** kartlar arası (üç türde aynı).
- Carousel: `role="group" aria-roledescription="carousel"`, her kare
  `aria-label="n / N"`, görünmeyen kare `inert`, sayaç `aria-hidden`
  (duyuru `aria-live` ile ayrıca), noktalar `aria-hidden`.
- Dokunma hedefleri: ok düğmeleri 32px, ALT çipi 24px (fotoğraf üstü
  ikincil hedef; aslı medya düğmesinin adı alt metni içerir), alan adı
  satırı 28px, bağlantı düğmeleri ≥28px, ana düğmeler 44px.
- `prefers-reduced-motion`: carousel kayması ani (`behavior:"auto"`),
  reel/video otomatik başlamaz (hiç başlamıyor — poster + oynat).
- Her metin parçası kendi `lang`'ıyla (caption, başlık, metin) — şema
  isteği 1/5'e bağlı; yoksa `lang="und"`.
- Kontrast: yeni renk yok; 17px/700 başlık `--text`; etiket `--muted`
  (12px — bilgi taşımayan tamamlayıcı, aynısı ekran okuyucuda "Etiket:"
  önekiyle).

## Durumlar

| Durum | Ne görünür |
| --- | --- |
| Karışık akış | kaynak satırları + kaynaklı giriş + kırılımlı döküm |
| Yalnız X | kaynak satırı yok, eski görünüm birebir |
| Kısa akış | mevcut bilgi şeridi değişmez |
| Hazırlanıyor / boş / hata | mevcut ekranlar; hatada hangi kaynağın toplanamadığı teknik ayrıntıya yazılır, toplanan kaynakların akışı yine de teslim edilirse şeritte söylenir — yoksa `error` hâli (renderer kararı, bkz. istek 8) |
| IG medyası yüklenemedi | çerçeve `--media-bg` + alt metin; carousel'de o kare sayaçtan düşmez (`n/N` bozulmaz), kare kayması yok |
| Genel görsel yüklenemedi | 88px kutu `--media-bg`'de durur, başlık kaymaz (en-boy önceden gerekli, istek 2) |
| Uzun handle/başlık/alan adı | handle ve alan adı `…`; başlık asla kesilmez, kırılır |

## Renderer'a devredilecek bileşenler (yeni/değişen)

Eskiler (`timeline-mockup.md`) aynen; ekler:

| Bileşen | Girdi (core) | Not |
| --- | --- | --- |
| `SourceLine` | `platform`, `repostedBy?`, karışık mı | yalnız >1 platformlu dokümanda |
| `IgCard` | `InstagramPost` | `renderCard` `platformOf` ile dağıtır |
| `IgAuthorRow` | yazar, `paidPartnership?`, `location?`, `coauthors?` | handle + alt satır |
| `IgMedia` | `kind`, `media[]` | tek kare oranı ilk karedir |
| `Carousel` | `InstagramMedia[]` | yukarıdaki klavye/odak kuralları zorunlu |
| `ReelPlayer` | video media | `VideoPlayer`'ın 9:16 varyantı; ayrı oyuncu yazma |
| `IgCaption` | `caption`, `lang` | 180 kr / 3 satır kesme |
| `GenericCard` | `GenericItem` | Reddit/özel ayrımı yalnız sözlükte |
| `PlaceRow` | `community`/`siteName`, `author?`, `publishedAt?` | site rozeti (favicon yoksa harf) |
| `GenericTitle` | `title`, `flair?`, `lang` | kesme yok |
| `Thumb` | `image` | `kind=image` değilse; yoksa düzen tek sütun |
| `DomainLine` | `domain`, `linkUrl?`, `url` | Reddit self gönderide gizli |
| `Tally` (değişik) | `bySource` | 1 kaynakta eski metin |

## Core şema istekleri (Kernel-1 #1377'ye)

Mevcut `InstagramPost`/`GenericItem` alanları yukarıda yeterli; eksikler
(render için gerekli olanlar ★, makette sentetik dolduruldu):

1. ★ **Dil iki türde de yok.** `InstagramPost.lang`, `GenericItem.lang`
   (`Post.lang` biçiminde, `"und"` kabul). Ekran okuyucu telaffuzu +
   başlık/caption için.
2. ★ **`GenericItem.image` alt metni ve kaynak "görsel içeriğin kendisi
   mi" bilgisi.** `image.altText` (yoksa başlık alt metin yerine
   kullanılamaz; katı kural) ve `kind: "link"|"text"|"image"|"video"` —
   88px küçük görsel / tam boy medya ayrımı bu alana bakıyor; en-boy'a
   bakarak tahmin etme (yanlış sınıflar).
3. ★ **Favicon/site ikonu.** `siteIconUrl?` (özel site + Reddit topluluk
   ikonu). Yoksa harf rozeti yedek, ama her sitede harf = ayırt
   edilemezlik; topluluk ikonu Reddit tanınırlığının yarısı.
4. ★ **Reddit bağlantısının kendisi.** `GenericItem.url` Reddit başlığı
   mı, dış bağlantı mı ayırt edilemiyor: `linkUrl?` (dış hedef) gerekli —
   alan adı satırı ve "Kaynağa git" iki ayrı hedefe gider (başlık →
   konu sayfası; alan adı satırı → dış bağlantı). Ayrıca `flair?`,
   `communityUrl?`/`authorUrl?` (yer satırı bağlantısı istenirse) ve
   `editedAt?` (gösterilmiyor, bilgi olarak not).
5. ★ **IG ayrıntıları:** `coauthors?: string[]` (ortak gönderi),
   `location?` (+ istenirse `locationId`), `paidPartnership?: string`
   (marka adı; `promoted`'tan ayrı — bkz. karar 10 altı),
   carousel içinde video karesi için `InstagramMedia` zaten
   `type/videoUrl/durationMs/altText` taşıyor — sorun yok; **video
   posteri kırpma bilgisi** (`cover` merkez noktası) IG vermezse
   merkez kırpma kabul, şemada alan açma.
6. **Medya boyutu zorunluluğu.** `InstagramMedia.width/height` ve
   `GenericItem.image.width/height` şu an isteğe bağlı; bağlayıcı
   dolduramıyorsa renderer 1:1'e (IG) / 3:2'ye (genel) düşer ve düzen
   zıplar — toplama kuralı olarak zorunlu yapmak daha doğru; karar
   Kernel'in.
7. ★ **Kaynak başına huni sayıları.** `RunMetrics.bySource: { label,
   in }[]` (yalnız "Taranan" kırılımı yeterli; elenme nedenleri
   kaynak bazında **gösterilmiyor** — döküm kalabalıklaşırdı, kullanıcıya
   faydası yok).
8. **Kısmi başarı durumu.** Kaynakların biri toplanamadı ama akış
   üretildi ise TimelineDoc bunu taşıyabilmeli (`status` yanında
   `missingSources?: string[]` önerilir; renderer üst bilgi şeridine
   "Instagram toplanamadı" yazar). Hepsi başarısızsa mevcut `error`.
9. **Veri temizliği (şema değil kural):** alanlar güvenilmez içerik —
   `title`/`caption`/`siteName` uzunluk sınırı şema (zod) tarafında tanımlı olmalı
   (renderer'a ceza olarak uzunluk kırpması yaptırma; başlık kesmiyoruz,
   sınırı bağlayıcı koyar), `domain` core'da URL'den türetilmeli
   (sayfadan okunan alan adı metnine güvenme).

## CSP notu

Okuma penceresi CSP'sine IG/Reddit CDN alan adları **eklenmez**; genel
siteler için zaten kararlaştırıldığı gibi masaüstü indirip `nmc-img://`
ile sunar (#1963 notu). IG medya URL'leri imzalı ve süreli — indirme
zorunlu; renderer indirme başarısızsa yukarıdaki "yüklenemedi"
durumunu gösterir.
