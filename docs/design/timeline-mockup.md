# Okuma penceresi — maket ve tasarım kararları

`timeline-mockup.html` tek dosyalık, tıklanabilir maket. Tarayıcıda doğrudan açılır;
dış kaynak yüklemez, tüm veri sentetiktir (uydurma kullanıcılar, `example.invalid`
alan adları, gömülü SVG görseller). Üstteki kesikli şerit ("Maket · üründe yok")
yalnızca maketin denetimleridir: durum (akış / kısa akış / hazırlanıyor / boş /
hata) ve sütun genişliği (640 / 414 / 360). Tema düğmesi ise ürünün parçasıdır.

## Akış

```
[Yeni akış topla] → Hazırlanıyor (adımlar) → Akış: üst bilgi → N kart → Bitti (döküm + Yeni akış topla)
                                          ↘ Hata (Tekrar dene)   ↘ Boş (Bitti, gösterilen 0)
```

Sonsuz kaydırma yok: akışın sonu bir sayfa sonu değil, bir **Bitti** ekranı.

## Kararlar

1. **Puan kartın baş rolü değil.** Kartta sayı ya da rozet yok; sıra zaten okuma
   değerini anlatıyor ve akışın başındaki tek satır bunu söylüyor ("Okuma
   değerine göre sıralı — en değerli üstte"). Puanlar kartın altındaki
   "Neden burada?" bağlantısının arkasında: Scorer'ın gerekçesi + sözcükle düzey
   ("Yüksek", "Çok düşük") + parantezde sayı + sıra. Neden: okur gönderiyi
   okumaya geliyor, puanı değil. Ama "bu neden burada?" sorusu meşru ve
   güveni artırıyor; cevabı bir tık uzakta.
2. **Doğrulama, içerikten sonra bir bant.** Metin/medya/alıntı/bağlantıdan sonra,
   etkileşim satırından önce. Kapalıyken: ikon + etiket + iddianın ilk satırı;
   açılınca: iddianın tamamı, temkinli açıklama, Verifier gerekçesi, kaynak
   bağlantıları (alan adıyla). Renk tek başına anlam taşımıyor; her durumun
   ikonu ve metni farklı.

   | Durum (`verdict`) | Etiket                         | Görünüm                 | Sabit açıklama                                                             |
   | ----------------- | ------------------------------ | ----------------------- | -------------------------------------------------------------------------- |
   | `supported`       | Doğrulandı                     | yeşil bant, ✓           | Bulunan kaynaklar bu iddiayı destekliyor.                                  |
   | `contradicted`    | Kaynaklarla çelişiyor          | amber bant, ⚠           | …çelişiyor. Bu kesin bir hüküm değil; kaynaklara bakıp kendin değerlendir. |
   | `unverifiable`    | Doğrulanamadı                  | gri bant, ?             | …kaynak bulunamadı. Bu, iddianın yanlış olduğu anlamına gelmez.            |
   | (yeni)            | Doğrulanmadı · kontrole değmez | bantsız, soluk satır, – | yalnız gerekçe                                                             |

   "Yanlış" sözcüğü bilinçli olarak yok: LLM doğrulaması yanılabilir ve
   ürün aşırı iddia etmemeli (`VerdictSchema` yorumuyla aynı ilke). Kırmızı
   değil amber: alarm değil, dikkat.

3. **Medya tam boy.** Tek görsel kırpılmaz: kendi en-boy oranında, sütun
   genişliğinde; çok uzun dikey görsel `min(80vh, 720px)` ile sınırlanır ve
   kenarları zeminle doldurulur (kırpma yok). 2/3/4'lü ızgara X gibi 16:9
   kutuda kırpılır; tıklayınca ışık kutusunda kırpılmamış hâli + alt metin,
   ←/→ ile gezilir. Her görselde "ALT" çipi alt metni gösterir. Video:
   poster + ortada oynat düğmesi + süre çipi, oynarken alt denetim çubuğu.
   GIF: "GIF" çipi + durdur düğmesi; `prefers-reduced-motion` açıksa durmuş
   başlar.
4. **Sonluluk görünür.** Yapışkan üst bilgide tarih başlığı, "N gönderi · ≈ M dk
   okuma · T gönderiden seçildi", sağda "3 / 10" sayacı ve ince ilerleme
   çubuğu; sonda "Bitti" ekranında bir **döküm**: Taranan − Reklam − Tekrar −
   Clickbait − Yargılanamayan medya − Eşik altı = Gösterilen. Döküm biçimi,
   elenenleri göstermeden "neler gitti" sorusunu tek bakışta cevaplıyor ve
   sayıların toplandığını kanıtlıyor. Elenen ve yalnız-medya gönderiler
   akışta hiç görünmez.
5. **Kısa akış dürüstçe kısa biter.** Eşiği geçen gönderi hedeften azsa
   (patron kararı: okuma tabanı, dolmazsa kısa biter) üstte bilgi şeridi:
   "Bugün yalnız 4 gönderi eşiği geçti (hedef 10)… eşik düşürülmedi." Eksik
   kalan sayı dökümde "Eşik altı"na eklenir. Hiç gönderi yoksa doğrudan Bitti
   ekranı ("Bugün okumaya değer bir gönderi çıkmadı. Bu da bir sonuç.").

Diğer: uzun metin 10 satırda kesilir, "Devamını oku" aynı yerde açar (sayfa
değişmez). Etkileşim sayıları sade: yalnız gösterim, tıklanamaz, gri, kısaltılmış
(`1,8 B`); 380px altında görüntülenme sayısı gizlenir. Yeniden paylaşımlar
"@x yeniden paylaştı" satırıyla. Profil fotoğrafı yerine baş harf avatarı
(şemada avatar URL'si yok — aşağıya bakın).

## Token'lar

Mevcut masaüstü penceresinin dilinden: `system-ui`, odak rengi `#0b57d0`, yeşil
`#1c7c3c` ailesi. Tümü `:root` değişkeni; koyu tema
`prefers-color-scheme` + `data-theme` ile.

| Token                       | Açık                  | Koyu                  | Not                                                    |
| --------------------------- | --------------------- | --------------------- | ------------------------------------------------------ |
| `--bg`                      | `#ffffff`             | `#0e1116`             |                                                        |
| `--surface` / `--surface-2` | `#f5f7f8` / `#eceff1` | `#161b22` / `#1e252e` | panel, iskelet                                         |
| `--text`                    | `#0f1419`             | `#e7e9ea`             |                                                        |
| `--muted`                   | `#536471`             | `#9aa5b1`             | bg üzerinde 6,1:1 / 7,6:1 (surface üzerinde 5,7 / 6,9) |
| `--border`                  | `#d5dde2`             | `#2f3640`             | dekoratif                                              |
| `--accent` / `--focus`      | `#0b57d0`             | `#8ab4f8`             | bağlantı + odak; 6,4:1 / 9,0:1                         |
| `--ok` on `--ok-bg`         | `#176934` / `#e7f4eb` | `#72d39c` / `#12261b` | 6,0:1 / 8,7:1                                          |
| `--warn` on `--warn-bg`     | `#8a4b00` / `#fdf1e0` | `#f2b45a` / `#2b1f0d` | 6,1:1 / 8,8:1                                          |
| `--info` on `--info-bg`     | `#3f4f5e` / `#edf1f4` | `#b8c3ce` / `#1e252e` | 7,4:1 / 8,6:1                                          |

Boşluk `--s1..--s7` = 4/8/12/16/24/32/48 px. Köşe: medya ve kart içi kutular 16px
(dar sütunda 12px), bant/panel 12px, düğme hap. Yazı: gövde 15px/1.45, meta
14px, küçük 13px. Avatar 40px. İçerik sütunu `--col: 640px`.

## Duyarlılık

Düzen `.app` kabının **genişliğine** göre değişir (container query), pencereye
göre değil; böylece aynı HTML Electron okuma penceresinde, mobilde ve dar bir
yan panelde aynı davranır.

- ≥ 481px kap: 16px yan boşluk, 640px sütun, ortalanmış.
- ≤ 480px: 12px yan boşluk, avatar–içerik arası 8px, medya köşesi 12px, başlık 16px.
- ≤ 380px: görüntülenme sayısı gizlenir; alt bilgi iki satıra kırılabilir.
- Hiçbir genişlikte yatay kaydırma yok (360'ta ölçüldü).

## Erişilebilirlik (uygulayan doğrulasın)

- Akış `role="feed"`; her kart `article`, `tabindex=0`,
  `aria-posinset/aria-setsize`, adı yazar, açıklaması metin.
- Klavye: Tab sırası kart içinde yazar → Devamını oku → medya → ALT → alıntı →
  bağlantı kartı → doğrulama → Neden burada? → X'te aç. **J/K** kartlar arası
  (son karttan sonra Bitti), ışık kutusunda **←/→** ve **Esc**.
- Açılır her şey `button[aria-expanded][aria-controls]`. Işık kutusu `<dialog>`
  (`showModal`), kapanınca odak tetikleyen düğmeye döner.
- Görsel düğmesinin adı = alt metin + "büyüt (2/4)". Video oynat düğmesinin
  adı süre + alt metni içerir. Dekoratif ikonlar `aria-hidden`.
- Odak halkası 2px `--focus`, her iki temada ≥3:1. Dokunma hedefleri ≥ 28px
  (bağlantı düğmeleri), ana düğmeler 44px.
- `prefers-reduced-motion`: animasyon/geçiş yok, GIF durmuş başlar.
- Dil: belge `lang="tr"`, her gönderi metni kendi `lang`'ı ile (İngilizce
  gönderiler doğru telaffuz edilir).

## Durumlar

| Durum                           | Ne görünür                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Akış                            | üst bilgi + giriş satırı + N kart + Bitti                                                                            |
| Kısa akış                       | + üstte bilgi şeridi, dökümde eksik kısım "Eşik altı"nda                                                             |
| Hazırlanıyor                    | adım listesi (Toplandı ✓ → Ayrıldı ✓ → Claude puanlıyor ◌ → Doğrulama –), 3 iskelet kart, "pencereyi kapatabilirsin" |
| Boş                             | doğrudan Bitti ekranı, Gösterilen 0                                                                                  |
| Hata                            | ⚠, düz dilde neden, "toplanan gönderiler duruyor", Tekrar dene + Yeni akış topla, katlanır teknik ayrıntı            |
| Görsel yüklenemedi (maket dışı) | hücre `--media-bg` zemininde kalır, alt metin görünür; kart düzeni kaymaz (genişlik/yükseklik önceden bilinmeli)     |

## Renderer'a devredilecek bileşenler

| Bileşen                        | Girdi (core)                                                  | Not                                                     |
| ------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------- |
| `ReadingWindow`                | `RankedPost[]`, döküm sayıları, `capturedAt`                  | Electron'da ayrı pencere; kap genişliğiyle duyarlı      |
| `TimelineHeader`               | tarih, N, tahmini süre, taranan                               | yapışkan; ilerleme sayacı + tema düğmesi                |
| `PostCard`                     | `RankedPost`                                                  | `article` + feed rolü                                   |
| `PostHeader`                   | `authorName`, `authorHandle`, `authorVerified`, `publishedAt` | göreli zaman, `title`'da mutlak                         |
| `PostText`                     | `text`, `lang`                                                | 600+ karakterde 10 satır kesme                          |
| `MediaGrid`                    | `media[]` (photo)                                             | 1 = tam boy, 2/3/4 = 16:9 ızgara                        |
| `VideoPlayer` / `GifPlayer`    | `media[]` (video/gif)                                         | poster, süre, hareket azaltma                           |
| `Lightbox`                     | gönderinin görselleri                                         | `<dialog>`, ←/→/Esc                                     |
| `QuoteCard`                    | `quoted`                                                      | ↳, 6 satır kesme                                        |
| `LinkCard`                     | `media[type=link]` + kart verisi                              | başlık/görsel yoksa yalnız alan adı + URL'li sade satır |
| `VerificationBand`             | `verification`                                                | 4 durum, açılır panel                                   |
| `WhyPanel`                     | `score`                                                       | gerekçe + düzey sözcüğü + sayı                          |
| `EngagementRow`                | `metrics`                                                     | `Intl` compact, salt gösterim                           |
| `DoneScreen` + `Tally`         | döküm sayıları                                                | "Yeni akış topla"                                       |
| `PreparingState`, `ErrorState` | hat aşaması / hata                                            |                                                         |

## Şema boşlukları (renderer başlamadan core'da karar gerekir)

- **Medya boyutu yok.** `PostMedia`'da `width/height` yok; tam boy görsel ve
  ızgara için yükleme öncesi en-boy oranı şart (yoksa düzen zıplar). X'te
  `original_info.width/height` var. Video için `durationMs` ve poster URL'si
  (`media_url_https`) ile oynatılabilir varyant (`video_info.variants`) de lazım.
- **Avatar yok.** Yazar profil görseli şemada yok; maket baş harf kullanıyor.
- **Bağlantı kartı verisi yok.** `link` medyası yalnız URL; başlık/görsel
  `card.legacy.binding_values`'tan gelebilir ama çoğu zaman yalnız `rest_id`
  var → sade alan adı satırı yedeği gerekli.
- **Alıntının yazar adı/zamanı/medyası yok.** `quoted` yalnız
  `id/authorHandle/text`; maketteki ad ve zaman için genişletilmeli.
- **"Doğrulanmadı (değmez)" durumu yok.** `VerdictSchema` üç değerli; hat şu an
  iddia varsa her zaman doğruluyor. Bu durum istenirse ya yeni bir verdict ya
  da "iddia var ama doğrulanmadı" bayrağı gerekir.
- **Çelişkili gönderiler akışta yok.** `runPipeline` `contradicted` olanı atıp
  aşağıdan yedekliyor; rozet istenirse bu kural değişmeli (ya da dökümde
  "Kaynaklarla çelişen" satırı olarak sayılmalı).
- **Döküm sayıları.** `RunMetrics`'te yalnız `postsIn/AfterHardFilter/Selected`
  var; reklam/tekrar/clickbait/yalnız-medya/eşik altı ayrı sayılmalı.

## CSP notu

Ürün penceresi şu anki desktop CSP'sine (`default-src 'none'`) gerçek medya için
`img-src https://pbs.twimg.com`, `media-src https://video.twimg.com` eklemeli;
başka alan adı açılmaz. Avatar eklenirse aynı `pbs.twimg.com` altında.
