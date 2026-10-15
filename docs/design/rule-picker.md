# Özel site kuralı — canlı sayfa seçicisi ve kural yönetimi

`rule-picker-mockup.html` tek dosyalık, tıklanabilir bir maket. Tarayıcıda doğrudan
açılır; dış kaynak yüklemez, her şey sentetiktir ("Kuzeykent Postası",
`example.invalid` alan adları, gömülü SVG görseller). Üstteki kesikli şerit
("Maket · üründe yok") yalnız maketin denetimleridir: ekran (Ayarlar · Siteler /
Canlı sayfa + seçici), liste (dolu / boş) ve Claude yanıtı (öneri gelir / hata).
Tema düğmesi ürünün parçasıdır; NMC panelini de değiştirir, yabancı siteyi değiştirmez.

Dil ve token'lar `timeline-mockup.md` ile aynı. Maket Türkçe; mevcut Options
sayfası İngilizce (bkz. Açık sorular).

## Akış

```
Options › Siteler › [Site ekle]
  → URL (+ doğrulama) → kalıp önerisi (yalnız bu sayfa / bölüm/* / tüm site)
  → [İzin ver ve sayfayı aç]  (tarayıcının site izni penceresi)
  → GERÇEK sekme açılır, sağ altta NMC paneli:
        [Claude'dan öner]                      [Kendim seç]
          ↓ iskelet → yerel claude                ↓
          Öneri sayfada vurgulanır  ──[Düzelt]──→ Seçici: tıkla → rol seç
          [Kabul et ve önizle]                    ↑/↓ geniş/dar · "bu değil" · Çıkar
          ↘ hata: [Tekrar dene] [Kendim seç]      ↓ (kart + başlık|metin hazır)
  → Önizleme çekmecesi: ilk 5 öğe, okuma penceresi kartıyla aynı + kural ayarları
  → [Kaydet] → "Kural kaydedildi" → [Ayarlara dön] (yeni satır vurgulu)

Options › Siteler › satır: Etkin · Yeniden seç · Dışa aktar · Sil (Geri al)
  durum: Çalışıyor / Az öğe / Kural bozuldu (0 öğe) + Yeniden seç / İzin gerekiyor / Kapalı
```

Maketi denemek için: **Site ekle** (kayıtlı adres önerilir; aynı adres "zaten bir
kural var" der, sonuna `/yerel` ekle) → **Kendim seç** → bir haber başlığına tıkla →
**Başlık** (kart ve bağlantı kendiliğinden bulunur) → "Sponsorlu" bir karta tıkla →
**Bu kart değil** → bir özetin sonundaki "Abone olun…" → **Çıkar** → özet →
**Metin** → **Önizle** → **Kaydet**. Klavyeyle: **Kendim seç** sonrası odak imleç
kutusunda; `↓` ilk kart, `Enter` rol penceresi, `1` İçerik kartı, `↓/→` alt/kardeş öğe.

## Kararlar ve gerekçeleri

1. **Seçim gerçek sayfada, yeniden çizilmiş kopyada değil** (patron/lider kararı).
   Kullanıcı sayfayı her gün gördüğü hâliyle tanır; reklam ve abonelik kutusu
   da gerçek yerinde durur. NMC yalnız üstte bir katman ekler ve sayfanın
   DOM'una/stiline dokunmaz: vurgular, perdeler ve etiketler ayrı bir sabit
   katmanda, öğelerin `getBoundingClientRect` konumuna çizilir. "Çıkar" denen
   öğe bile sayfada değiştirilmez, üstüne çizgili perde konur. Gerekçe: seçici
   sayfayı bozarsa (sınıf ekleme, stil değiştirme) seçtiği şeyi de değiştirir.

2. **Önce kart, sonra alanlar — ama sıra zorunlu değil.** Kural "tekrar eden
   kutu + içindeki alanlar" demek; alan seçicileri karta göreli. Kullanıcı
   doğrudan başlığa tıklarsa kart, tekrar eden en yakın ata (aynı ebeveynde
   ≥ 3 eş kardeş) olarak bulunur ve bildirilir. Başlığın içinde bağlantı varsa
   "Bağlantı" da kendiliğinden alınır. Gerekçe: tipik bir haber sayfasında
   kullanıcı 1–2 tıkla işe yarar bir kurala ulaşır; ilk tıkta "önce kartı seç"
   hatası almaz.

3. **Genelleştirme görünür.** Kart seçilince benzerlerinin hepsi kesikli halkayla
   ve sıra numarasıyla vurgulanır; ilk kartta rol etiketleri adıyla, diğerlerinde
   yalnız harfiyle. Panel her alan için kapsama gösterir (`Yazar · 7/8`). Gerekçe:
   kullanıcı "kaç öğe gelecek, hangisi eksik" sorusunu kaydetmeden önce görür.

4. **"Bu değil" bir öğeyi değil bir özelliği dışlar.** Bir öğenin kimliği sonraki
   çekimlerde yoktur; kurala ancak seçici yazılabilir. Dışlanan kartın içinde olup
   diğer kartların en fazla üçte birinde bulunan sınıf aranır → `:has(.sınıf)`;
   kaç kartın birlikte gittiği söylenir ("2 kart dışlandı — hepsinde “Sponsorlu”
   var") ve **Geri al** sunulur. Ayırt edici özellik yoksa dürüstçe söylenir:
   "dışlama yalnız bu sayfada görünür, kurala yazılamaz" (panelde amber).

5. **"Çıkar" bağlama göre üç şey yapar**, panel hangisini yaptığını söyler:
   kart seçicisine uyan öğe → kart dışlama (4. madde); kartın içindeki parça →
   tüm kartlarda alan metninden ayıklanır (`exclude.within`, ör. "Abone olun,
   devamını okuyun →"); kart dışındaki öğe → "zaten okunmuyor" geri bildirimi
   (yalnız görsel; kurala yazılmaz). Gerekçe: patronun "reklamlı yerleri seçer"
   isteği iki farklı ihtiyacı kapsıyor — reklam kartı ve kart içi gürültü.

6. **Üst/alt öğeye geçiş birinci sınıf.** Tıklanan şey çoğu zaman istenenin bir
   içi ya da dışıdır (`a.np-link` yerine `h2.np-title`). Rol penceresinde ve imleç
   kutusunda Geniş/Dar ve ←/→ kardeş düğmeleri; klavyede ok tuşları. Vurgu etiketi
   seçici adını ve benzer sayısını canlı gösterir.

7. **Claude önerisi aynı vurgu dilinde ve sınanmış gelir.** Öneri JSON'u sayfada
   koşturulur; eşleşmeyen seçici atılır ve söylenir ("9 seçicinin 9'u eşleşti").
   Panel kısa bir "Claude'un notu" gösterir (neyi neden çıkardı). Kullanıcı
   **Kabul et ve önizle** ya da **Düzelt** der; düzeltme manuel seçicinin aynısıdır.
   Gerekçe: LLM'e güven, ama sayfada doğrula; kullanıcı neyin önerildiğini
   aynı görsel dilde okuyabilsin.

8. **Önizleme okuma penceresi kartıyla aynı.** Ad = yazar (yoksa site adı),
   tutamak yerine alan adı, göreli zaman, kalın başlık + metin, tam boy görsel,
   "Sitede aç". Puan yok — puanlama ve eleme toplamada yapılır; önizleme yalnız
   çıkarılan veriyi gösterir. Eksik alanlar özet satırında sayılır
   ("1 öğede yazar yok"). Çekmece, panelin tarafında açılır; sayfa öbür yanda
   vurgularıyla görünür kalır.

9. **Kalıp önerisi URL'den türetilir, varsayılan "bölüm/\*".** Toplama her zaman
   girilen adresten yapılır; kalıp, sonraki sayfaların ve aynı düzendeki alt
   sayfaların da bu kuralla okunmasını belirler. "Tüm site" uyarısıyla sunulur
   (sayfalar farklı düzendeyse 0 öğe).

10. **Silme onay diyaloğu değil, Geri al.** Kurallar yereldir ve dışa aktarılabilir;
    silme anında geri alınabilir (8 sn, üzerine gelince/odakta süre durur).
    Gerekçe: daha az kesinti, aynı güvenlik.

11. **Sağlık görünür ve eyleme bağlı.** Her satırda son çekim + öğe sayısı;
    eşik altı "Az öğe", 0 öğe "Kural bozuldu" (+ son başarılı çekim) — ikisinde
    de satırda **Yeniden seç**. Yeniden seçim, mevcut kural hâlâ eşleşiyorsa onu
    yüklenmiş açar ("9 seçicinin 9'u hâlâ eşleşiyor"); eşleşmiyorsa nedeniyle
    birlikte başlangıç ekranını açar.

## Görsel dil — sayfa üstü vurgular

Vurgular bilinmeyen bir sayfa zemininin üstünde durur; bu yüzden renkleri
**temadan bağımsızdır** ve her biri **çift halka** taşır: 2 px rol rengi +
2 px beyaz + 1 px koyu (`#0f1419` %85). Rol rengi koyu bir zeminde 3:1'in altına
düşebilir (ölçüldü: `#0e1116` üstünde 2,2–3,2); beyaz halka orada ≥ 15:1 sağlar,
açık zeminde rol rengi ≥ 5,6:1. Renk tek başına anlam taşımaz: her rolün harfi var.

| Rol          | Harf | Renk      | Beyaz yazı | Kısayol |
| ------------ | ---- | --------- | ---------- | ------- |
| İçerik kartı | K    | `#0b57d0` | 6,4:1      | 1       |
| Başlık       | B    | `#6b2fbf` | 7,5:1      | 2       |
| Metin        | M    | `#176934` | 6,8:1      | 3       |
| Bağlantı     | L    | `#0b6e79` | 6,0:1      | 4       |
| Yazar        | Y    | `#8a4b00` | 6,8:1      | 5       |
| Zaman        | Z    | `#a1306b` | 6,7:1      | 6       |
| Görsel       | G    | `#3f4f5e` | 8,4:1      | 7       |
| Çıkar        | ⊘    | `#b3261e` | 6,5:1      | 8       |

| Durum                               | Görünüm                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| Üzerine gelme                       | 3 px düz mavi + %12 dolgu; etiket: `seçici · N` (koyu zemin, beyaz)                  |
| İmleç (klavye / açık rol penceresi) | 3 px düz + kalın koyu dış halka                                                      |
| Seçili ilk kart                     | 2 px düz, %7 dolgu, etiket "K İçerik kartı · N benzer"                               |
| Benzer kartlar                      | 2 px kesikli, köşede sıra numarası                                                   |
| Alan                                | 2 px rol renginde, içte harf rozeti (ilk kartta ad da)                               |
| Çıkarıldı (kart ya da parça)        | kırmızı çerçeve + çizgili yarı opak perde + çapraz üstü çizgi, "⊘ Çıkarıldı · neden" |
| Bu değil (kurala yazılamayan)       | gri kesikli çerçeve + soluk perde, "× Bu değil"                                      |

Etiket yazısı 11px/600; rozetler 20–22px. Katman `pointer-events: none`.

## Panel ve çekmece ölçüleri

- **Panel**: sağ alt, 16px kenar boşluğu; genişlik 360px; yükseklik en fazla
  `min(78vh, 720px)`, gövde kendi içinde kayar. Köşe 16px, gölge
  `0 12px 40px /.28`. Başlık: NMC logosu (28px) + "Yeni site kuralı" + kalıp (mono 12px)
  - Taşı (sol/sağ) · Tema · Küçült · Çık. Gövde 14px dolgu; alt bölümde birincil
    eylem (44px hap düğme, tam genişlik).
- **Küçültülmüş**: aynı köşede hap düğme, "NMC · 8 kart · aç" (44px).
- **Rol penceresi**: 288px, tıklama noktasının sağ altında, ekrana sığmazsa üstünde;
  iki sütun rol düğmesi (40px), "Çıkar" tam satır, altında Bu kart değil / Seçimi kaldır.
- **Önizleme çekmecesi**: kenara yapışık tam yükseklik, `min(440px, 100vw)`.
  Kart ölçüleri okuma penceresiyle aynı (avatar 40px, 12/16px dolgu, medya köşe 16px).
- **Options satırı**: 40px site rozeti (köşe 10px) · ad (700) / kalıp (mono, tek
  satır, `…`) / durum çipi + son çekim · Etkin anahtarı + 3 simge düğmesi (36px).
  Bozuk/zayıf/izin satırında iç bant (amber/gri) + eylem düğmesi.

Token'lar `timeline-mockup.md`'deki tablodan; yeni token yok, yalnız yukarıdaki
sabit rol renkleri (sayfa üstü, temasız).

## Klavye ve erişilebilirlik (uygulayan doğrulasın)

- **Esc** her zaman: rol penceresini kapatır → küçültülmüşse açar → önizlemeden
  seçime döner → Claude beklerken iptal eder → kaydedilmemiş seçim varsa
  "Seçiciden çıkılsın mı?" sorar (odak "Seçmeye devam et"te) → yoksa çıkar.
- **Ok tuşları** yalnız seçici bağlamındayken yakalanır: odak imleç kutusunda,
  rol penceresinde ya da sayfa gövdesindeyken. `↑` daha geniş (ebeveyn), `↓` daha
  dar (ilk çocuk), `←/→` kardeş. İmleç yoksa ilk `↓` ilk tekrar eden bloğa gelir.
  Diğer zamanlarda sayfanın kendi kısayolları ve ekran okuyucu gezinmesi bozulmaz.
- **Enter/Space** imleç kutusunda rol penceresini açar; pencerede **1–8** rol
  kısayolu, Tab pencere içinde döner (non-modal `role="dialog"`, menü değil: oklar
  geniş/dar için serbest kalmalı). Kapanınca odak imleç kutusuna döner.
- "Kendim seç" ve "Düzelt" sonrası odak imleç kutusunda; önizlemede ilk kartta;
  kayıt sonrası "Ayarlara dön"de; Options'a dönüşte yeni satırın anahtarında.
- Canlı bölge (`aria-live="polite"`, shadow içinde) her adımı söyler:
  "a.np-link, 10 benzer", "Başlık: 8/8 kartta bulundu", "2 kart dışlandı…".
- Panel `section[aria-labelledby]`, rol listesi `ul[aria-label]`, imleç kutusu
  `role="group"` + `aria-roledescription="klavye imleci"`. Devre dışı **Önizle**
  düğmesinin nedeni `aria-describedby` ile okunur.
- Options: URL hatası `aria-invalid` + `aria-describedby` (blur'da gösterilir,
  sonra yazdıkça güncellenir); kalıplar `fieldset/legend` radyo grubu; silme
  sonrası odak sonraki satırın Sil düğmesine; Geri al düğmesi bildirimde ve
  odaklanınca süre durur. Diyaloglar `<dialog>.showModal()`.
- Odak halkası 2px `--focus` (her iki temada ≥ 3:1). Dokunma hedefleri ≥ 28px
  (ikincil), ana eylemler 44px. `prefers-reduced-motion`: animasyon yok.

## Duyarlılık

- **Sayfa ≤ 520px**: panel alt sayfa olur (8px kenar, tam genişlik, en fazla 56vh),
  rol penceresi alt sayfa (en fazla 70vh, kendi içinde kayar), önizleme tam ekran.
  360px'te yatay taşma yok (ölçüldü: sayfa, panel, rol penceresi, çekmece).
- Panel bir öğeyi kapatıyorsa **Taşı** ile sola alınır; küçültülebilir.
- **Options** kap genişliğine göre (container query): ≤ 560px'te eylemler alt
  satıra iner, "Etkin" yazısı gizlenir (anahtar kalır, adı satır adından gelir).
  Sekme şeridi kendi içinde yatay kayar.
- Vurgular kaydırma ve yeniden boyutlandırmada rAF ile yeniden çizilir; görünüm
  dışındaki kutular çizilmez.

## Durumlar

| Yer           | Durum                   | Ne görünür                                                                              |
| ------------- | ----------------------- | --------------------------------------------------------------------------------------- |
| Options       | Boş                     | globe simgesi, "Henüz site yok", Site ekle + Kural içe aktar                            |
| Options       | Çalışıyor               | yeşil ✓ çip, son çekim + öğe sayısı                                                     |
| Options       | Az öğe                  | amber ⚠ çip "Az öğe", "N öğe (genelde M)", bant: eşik + "Sayfada kontrol et"            |
| Options       | Kural bozuldu           | amber ⚠ çip, "Son 3 çekimde 0 öğe · son başarılı …", bant + **Yeniden seç**             |
| Options       | İzin gerekiyor          | gri ? çip, bant + **İzin ver** (izin tarayıcıda geri alınmış)                           |
| Options       | Kapalı                  | gri – çip, satır %55 soluk                                                              |
| Options       | Yeni / içe aktarıldı    | yeşil zemin vurgusu, "Kaydedildi · kayıtta N öğe"                                       |
| Options       | Çekilemedi (maket dışı) | ağ/HTTP hatası 0 öğeden AYRI: gri çip "Çekilemedi · HTTP 503"; sağlık sayacını bozmaz   |
| Site ekle     | URL hatası              | boş / adres değil / http(s) değil / X adresi / zaten kural var                          |
| Panel         | Başlangıç               | iki seçenek + gizlilik notu; yeniden seçimde eski kuralın neden eşleşmediği             |
| Panel         | Claude bekliyor         | adım listesi (iskelet ✓ → Claude ◌ → sınama –), "Claude'a giden iskelet" açılırı, İptal |
| Panel         | Claude hata             | ⚠, düz dilde neden, teknik ayrıntı, Tekrar dene + Kendim seç                            |
| Panel         | Claude önerisi          | rol listesi (salt okunur), Claude'un notu, sınama sonucu, Kabul et / Düzelt             |
| Panel         | Seçim                   | imleç kutusu, rol listesi + kapsama, uyarılar (bağlantı yok, yazılamayan dışlama)       |
| Panel         | Çıkış onayı             | "Seçiciden çıkılsın mı?"                                                                |
| Panel         | Kaydedildi              | ✓, N öğe, "bir sonraki toplamada okunur"                                                |
| Rol penceresi | Hata                    | "Bu öğe tekrar eden bir kartın içinde değil…" (amber, pencere açık kalır)               |
| Önizleme      | Eksik alan              | özet satırında sayım; metinsiz öğe "akışa girmez" notuyla                               |
| Önizleme      | 0 öğe (maket dışı)      | Kaydet devre dışı; "Hiç öğe çıkmadı — kartı genişlet ya da dışlamaları kaldır"          |

## Mimari notlar

### Yalıtım (shadow DOM)

- Katman **tek bir host öğesinde, `attachShadow({ mode: "closed" })`**; host
  `document.documentElement`'e eklenir (body'nin `transform`/`filter`'ı fixed
  konumu bozmasın diye body'ye değil). Maket `open` kullanır (incelenebilsin diye).
- `:host { all: initial }` kalıtılan özellikleri (yazı tipi, harf aralığı, renk,
  satır yüksekliği) sıfırlar **ama CSS değişkenlerini sıfırlamaz**: sayfanın
  `--accent`'i shadow'a sızar. Bu yüzden her token `:host`'ta yeniden tanımlanır
  (makette site bilerek `--accent: #c8102e` tanımlıyor; panelde `#0b57d0` kalıyor —
  ölçüldü). Form denetimlerine `letter-spacing: normal; text-transform: none`.
- Stiller `adoptedStyleSheets` (constructable stylesheet) ile verilmeli: sayfanın
  sıkı `style-src` CSP'si `<style>` öğesini engelleyebilir. _(Uygulamada sıkı CSP'li
  bir sayfada doğrulanmalı.)_
- z-index savaşı yerine **Popover API** (`popover="manual"` + `showPopover()`):
  panel, rol penceresi ve katman tarayıcının üst katmanına (top layer) çıkar;
  sayfanın `z-index: 2147483647`'li çerez bandı bile üstüne çıkamaz. Maket sabit
  konum + yüksek z-index kullanıyor.
- Olaylar: `click` ve `keydown` dinleyicileri `document`'e **capture** aşamasında,
  yalnız seçici bağlamında `preventDefault + stopPropagation` (bağlantı gezinmesin,
  sayfanın kendi kısayolu çalışmasın). Hedef `composedPath()[0]`; shadow içinden
  gelenler sayfa öğesi sayılmaz.

### İzin ve enjeksiyon

- Manifest'e `"optional_host_permissions": ["https://*/*", "http://*/*"]` ve
  `"scripting"`; **Site ekle** düğmesi (kullanıcı hareketi) içinde
  `chrome.permissions.request({ origins: ["https://haber.example.invalid/*"] })`.
  Sabit `content_scripts` yok; seçici `chrome.scripting.executeScript` ile yalnız
  kullanıcı istediğinde, yalnız o sekmeye (ISOLATED world) enjekte edilir.
  İzin geri alınırsa (`permissions.onRemoved`) satır "İzin gerekiyor" olur.
- `<all_urls>` istenmez: mağaza incelemesi ve kullanıcı güveni açısından site
  başına izin doğru olan.

### Claude önerisi

- Yol: seçici → worker → native host → masaüstü → yerel `claude` (mevcut köprü;
  yeni mesaj tipi `rule-suggest` / `rule-suggestion`). Masaüstü kapalıysa
  "Claude'dan öner" devre dışı + neden.
- **İskelet** sayfada üretilir: etiket + kararlı öznitelik adları (`id`, `class`,
  `role`, `data-*` adları; `itemprop`, `datetime` VARLIĞI), aynı yapıdaki kardeşler
  `×N` ile katlanır, metin yerine `{t:uzunluk}`, `href` yerine yalnız yol şekli
  (`/gundem/…`, sorgu yok). Metin, tam URL, form değeri, çerez, görsel yok.
  Üst sınır ~8 KB (≈ 2–3 bin token); aşarsa derinlik kırpılır, `aside/footer/nav`
  önce düşer. Maketteki "Claude'a giden iskelet" açılırı bu biçimi gösterir.
- **İskelet de güvenilmez**: sınıf adları ve `data-*` sayfa sahibinin elinde
  (prompt injection taşıyabilir). Veri bloğu olarak gider; araçlar kapalı
  (`--tools ""`, boş MCP); çıktı zod ile `RuleSuggestion` şemasına göre ayrıştırılır;
  her seçici `document.querySelectorAll` ile sayfada sınanır (sözdizimi hatası,
  0 eşleşme, kart dışı alan → atılır ve panelde söylenir). Seçici uzunluğu ≤ 200,
  `:has()` derinliği 1.
- Patronun "claude mcp veya kendi climiz" seçeneği: önerilen **kendi CLI'ımız**
  (mevcut köprü, `claude -p` + JSON). Seçici, MCP üzerinden Claude'a canlı DOM
  aracı açmak yerine tek atımlık iskelet → JSON yargı; orkestrasyon kodda kalır
  (proje kuralı) ve sayfa içeriği hiçbir araca bağlanmaz.

### Seçici üretimi (genelleştirme)

Maket anlamlı sınıflı bir sayfa kullanıyor; gerçek sitelerde:

1. Öznitelik önceliği: `data-testid`/`data-*` > `itemprop`/`role` > anlamlı sınıf
   > etiket. Hash'li sınıflar elenir (`css-1x2y3`, `sc-…`, `_a1B2c`, ≥ 1 rakam
   > içeren 5+ karakterlik rastgele parçalar).
2. Kart: tıklanandan yukarı, aynı ebeveynde aynı seçiciye uyan ≥ 3 kardeşi olan
   ilk ata. Kart seçicisi en kısa, sayfada en çok kardeşi tutan ve kart dışı
   öğeyi tutmayan biçimde daraltılır.
3. Alan: karta göreli en kısa seçici; birden çok eşleşirse ilk. Kapsama
   `n/N` olarak gösterilir.
4. Dışlama: 4. karardaki özellik araması; sınıf yoksa öznitelik/metin uzunluğu yok —
   ayırt edemezse dürüstçe söyler.

### Toplama

- **Statik önce**: kayıt sırasında worker URL'yi `fetch` eder, HTML'i offscreen
  belgede (`chrome.offscreen`, MV3 service worker'da `DOMParser` yok) ayrıştırır
  ve kural seçicilerini koşturur. Öğe sayısı canlı sayfaya yakınsa
  `fetch.mode = "static"`: toplamada sekme açılmaz. Değilse (JS ile çizilen
  sayfa) ya da sayfalama düğme/kaydırma ise `"browser"`: sayfa gizli pencerede
  açılır (B modu altyapısı), kural enjekte edilir. Maketin önizlemesi bunu
  sayfalama seçimine göre söylüyor.
- Daha doğrusu (ileride): "Daha fazla" düğmesi genellikle bir JSON/HTML uç
  noktası çağırır. Seçici o ağ isteğini yakalayıp (X'teki A modu gibi) doğrudan
  çağırmayı önerebilir; DOM'a bağlı kalmaz, pencere açmaz, site düzen değişikliğine
  dayanıklıdır. Aynı şekilde sitenin **RSS/Atom** beslemesi varsa
  (`<link rel="alternate" type="application/rss+xml">`) "Site ekle" bunu
  algılayıp "Beslemesi var — seçici gerekmez" önermeli: en sağlam yol.
- `fetch` site çerezleriyle gider (host izni verildiğinde): üye içeriği gelir,
  ama çekim kullanıcının oturumuyla yapılır — README'de söylenmeli. Toplama
  aralığı kullanıcı isteğine bağlı (X'teki gibi); arka planda otomatik tarama yok.
- Sağlık: her çekimde öğe sayısı + alan kapsaması. `0` öğe → "bozuldu"
  (ağ hatası değil); `< minItems` → "az öğe"; başlık ve metin kapsaması ikisi de
  0 → "bozuldu". Son 10 çekimin medyanı "genelde M" olarak gösterilir.

### Hatta giriş (core) ve şema boşlukları

Özel site öğeleri aynı hatta (`HardFilter → Scorer → Selector → Verifier`) girer.
`PostSchema` bugün X'e göre:

- `source`: `site:<rule.id>`. `id`: kanonik bağlantının (sorgu/izleme parametresiz)
  karması; bağlantı yoksa başlık+metin karması (tekrar ayıklama zayıflar —
  panel bunu uyarıyor).
- `authorHandle` zorunlu (`min(1)`): yazar yoksa alan adı. Ayrı `siteName` gerekir.
- `publishedAt` zorunlu `datetime`: zaman alanı yoksa ya da göreli metinse
  ("3 saat önce") çözülemez → `capturedAt` + `publishedAtEstimated: true`
  bayrağı gerekir.
- **`title` alanı yok**: haber/blog öğesinin başlığı ayrı bir alan olmalı
  (okuma penceresi kalın gösteriyor; Scorer clickbait'i büyük ölçüde başlıktan
  yargılıyor). `text`'e gömmek clickbait yargısını bulanıklaştırır.
- `metrics`, `authorVerified`, `quoted`, `repostedBy` yok — opsiyonel oldukları
  için sorun değil; renderer boş etkileşim satırını gizlemeli.
- Scorer istemi kaynağı bilmeli ("bu bir haber sitesi kartı: başlık + özet"),
  yoksa kısa özetleri "düşük okuma değeri" sayar.
- **Görseller ve CSP**: okuma penceresi CSP'si yalnız `pbs.twimg.com`'a izin veriyor;
  rastgele site görselleri için CSP'yi açmak yerine masaüstü ana süreci görseli
  indirip özel bir protokolle (`nmc-img://<hash>`) sunmalı. Böylece CSP dar kalır,
  sayfa sahibi okuma penceresinden izleme pikseli göremez.
- Okuma penceresi: "X'te aç" → "Sitede aç"; avatar → site baş harfi (favicon
  ileride, aynı görsel yolundan).

## Kural JSON şeması (taslak)

```ts
const SiteRuleSchema = z.object({
  nmcRule: z.literal(1), // şema sürümü; artınca göç kodu
  id: z.string().min(1), // "haber.example.invalid/gundem"
  name: z.string().min(1).max(80),
  url: z.string().url(), // toplamanın başladığı adres (http/https)
  match: z.array(z.string()).min(1), // URL kalıpları, aynı alan adı: "host/yol/*"
  item: z.object({
    selector: z.string().max(200), // içerik kartı
    exclude: z.array(z.string().max(200)).default([]), // karta uygulanır: ":has(.np-sponsor)"
  }),
  fields: z
    .object({
      // seçiciler karta göreli
      title: FieldSchema.optional(),
      text: FieldSchema.optional(),
      link: FieldSchema.optional(), // attr: "href" (göreli → url'ye göre mutlak)
      author: FieldSchema.optional(),
      time: FieldSchema.optional(), // attr: "datetime" ya da metin + format ipucu
      image: FieldSchema.optional(), // attr: "src" | "srcset" | "data-src"
    })
    .refine((f) => f.title || f.text, "title ya da text gerekli"),
  exclude: z
    .object({
      within: z.array(z.string().max(200)).default([]), // alan metninden ayıklanır
    })
    .default({}),
  pagination: z.discriminatedUnion("type", [
    z.object({ type: z.literal("none") }),
    z.object({
      type: z.literal("next-link"),
      selector: z.string(),
      maxPages: z.number().int().min(1).max(10),
    }),
    z.object({
      type: z.literal("button"),
      selector: z.string(),
      maxPages: z.number().int().min(1).max(10),
    }),
    z.object({ type: z.literal("scroll"), maxPages: z.number().int().min(1).max(10) }),
  ]),
  fetch: z.object({ mode: z.enum(["static", "browser"]) }),
  health: z.object({ minItems: z.number().int().min(1) }),
  meta: z
    .object({
      // bilgi amaçlı, davranışı etkilemez
      createdWith: z.enum(["manual", "claude-suggest", "claude-suggest+edit", "import"]),
      createdAt: z.string().datetime(),
      app: z.string(),
    })
    .optional(),
});
const FieldSchema = z.object({
  selector: z.string().max(200),
  attr: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .optional(), // yoksa textContent
});
```

Örnek (maketin "Kendim seç" akışının ürettiği):

```json
{
  "nmcRule": 1,
  "id": "haber.example.invalid/gundem",
  "name": "Kuzeykent Postası — Gündem",
  "url": "https://haber.example.invalid/gundem",
  "match": ["haber.example.invalid/gundem/*"],
  "item": { "selector": "article.np-card", "exclude": [":has(.np-sponsor)"] },
  "fields": {
    "title": { "selector": "h2.np-title" },
    "text": { "selector": "p.np-summary" },
    "link": { "selector": "a.np-link", "attr": "href" },
    "author": { "selector": "span.np-author" },
    "time": { "selector": "time", "attr": "datetime" },
    "image": { "selector": "img.np-thumb", "attr": "src" }
  },
  "exclude": { "within": ["span.np-inline-promo"] },
  "pagination": { "type": "button", "selector": "button.np-more", "maxPages": 3 },
  "fetch": { "mode": "browser" },
  "health": { "minItems": 3 },
  "meta": {
    "createdWith": "manual",
    "createdAt": "2026-10-15T11:20:00Z",
    "app": "nmc-extension/0.2.0"
  }
}
```

Kurallar:

- **Kural veri, kod değil.** Betik, regex dışı ifade, URL şablonu yok; seçiciler
  yalnız `querySelectorAll`'a gider. Bu yüzden içe aktarma güvenli: en kötü kural
  yanlış öğe çeker. İçe aktarmada zod + `match` kalıplarının `url` ile aynı alan
  adında olması + boyut ≤ 64 KB; ardından site izni istenir ve kural bir kez
  sınanır (Options'ta "kayıtta N öğe").
- Kişisel veri yok: çekim geçmişi, sağlık sayaçları ve izin durumu ayrı
  (`chrome.storage.local`, `ruleState[id]`) tutulur ve dışa aktarılmaz.
- `id` = alan adı + yol; aynı `url` ikinci kez eklenemez (Options uyarısı).

## Bileşenler (eklenti)

| Bileşen                                                    | Yer           | Not                                                                       |
| ---------------------------------------------------------- | ------------- | ------------------------------------------------------------------------- |
| `SitesSection`                                             | Options       | liste + boş durum + Site ekle/İçe aktar                                   |
| `AddSiteForm`                                              | Options       | URL doğrulama, `patternsFor(url)`, izin isteği                            |
| `RuleRow`                                                  | Options       | durum çipi + bant, Etkin, Yeniden seç, Dışa aktar, Sil (Geri al)          |
| `ExportDialog` / `ImportDialog`                            | Options       | JSON, kopyala/indir, zod hataları madde madde                             |
| `PickerHost`                                               | içerik betiği | closed shadow root, adoptedStyleSheets, popover, olay yakalama            |
| `HighlightLayer`                                           | shadow        | rAF ile kutular; çift halka; perdeler                                     |
| `PickerPanel`                                              | shadow        | başlangıç / Claude bekliyor-hata-öneri / seçim / çıkış onayı / kaydedildi |
| `RolePopover`                                              | shadow        | geniş/dar/kardeş, 8 rol, bu değil, seçimi kaldır                          |
| `PreviewDrawer`                                            | shadow        | okuma penceresi kartı (`PostCard` görünümü) + kural ayarları              |
| `selectorFor(el)`, `inferItem(el)`, `distinguishing(card)` | saf modül     | birim testli (happy-dom, sentetik HTML)                                   |
| `skeletonOf(root)`                                         | saf modül     | metinsiz iskelet, boyut sınırı; birim testli                              |
| `applyRule(doc, rule)`                                     | core          | statik ve tarayıcı çekimin ortak çıkarıcısı → `Post[]`                    |

## Açık sorular

1. **Dil**: Options bugün İngilizce, maketler Türkçe. Eklenti metinleri İngilizce mi
   kalacak, yoksa `chrome.i18n` ile TR/EN mi? (Maket metinleri iki durumda da kaynak.)
2. **Masaüstü bağımlılığı**: Claude önerisi masaüstü uygulaması açıkken çalışır.
   Native host'un `claude`'u doğrudan çağırması da mümkün ama orkestrasyonu iki
   yere böler; öneri: masaüstü üzerinden, kapalıysa "Kendim seç".
3. **Gizli pencere (browser modu) başka sitelerde**: X'teki B modu risk uyarısı
   site sitesine farklı; JS ile çizilen siteler için varsayılan açık mı, kural
   başına onay mı?
4. **Şema**: `title`, `siteName`, `publishedAtEstimated` `PostSchema`'ya mı, yoksa
   ayrı bir `ArticleSchema` + ortak `FeedItem` birliğine mi? (Scorer ve renderer
   ikisini de etkiler; core'da karar gerekir.)
