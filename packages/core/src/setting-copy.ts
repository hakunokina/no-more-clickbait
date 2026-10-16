import type { UiLang } from "./i18n.js";
import { MANAGED_SETTING_FIELDS, type ManagedSettingKey } from "./schemas.js";

/**
 * The settings' UI copy per language. English is the field tables'
 * own copy (schemas.ts, one source); Turkish is typed against them, so
 * a new field or choice without its Turkish copy fails to compile.
 */

type Fields = typeof MANAGED_SETTING_FIELDS;

type FieldCopy<F> = F extends { kind: "choice"; options: readonly { value: infer V }[] }
  ? { label: string; description: string; options: Record<V & string, string> }
  : { label: string; description: string };

export type SettingCopy = {
  label: string;
  description: string;
  /** Choice fields: each value's label. */
  options?: Readonly<Record<string, string>>;
};

const TR: { [K in ManagedSettingKey]: FieldCopy<Fields[K]> } = {
  collectTarget: {
    label: "Toplanacak gönderi",
    description:
      "Akış oluşturulmadan önce akışından kaç farklı gönderi toplanacağı (sen kaydırdıkça ya " +
      "da B modunda kendiliğinden). Daha çok gönderi filtrelere daha geniş seçim sunar ama " +
      "toplaması ve değerlendirmesi daha uzun sürer.",
  },
  collectFromX: {
    label: "X'ten topla",
    description: "X ana akışından (x.com/home) gönderi toplar.",
  },
  collectFromInstagram: {
    label: "Instagram'dan topla",
    description:
      "Instagram ana akışından (instagram.com) gönderi toplar. Her kaynak kendi “Toplanacak " +
      "gönderi” sayısını toplar; B modunda Instagram aynı pencerede X'ten sonra kaydırılır. " +
      "Reklamlar çıkarılır; açıklamasız gönderiler tutulur ama puanlanmaz. Bunu açtığında " +
      "açık olan bir Instagram sekmesini yenile.",
  },
  instagramFollowedOnly: {
    label: "Instagram: yalnız takip ettiklerim",
    description:
      "Instagram'ın takip etmediğin hesaplardan önerdiği gönderileri dışarıda bırakır. Bunlar " +
      "“Toplanacak gönderi” sayısına girmez; akışın dökümü onları ayrı sayar. Kapalıyken " +
      "tutulur ve “Önerilen” diye işaretlenir.",
  },
  timelineSize: {
    label: "Bitmiş akıştaki gönderi",
    description:
      "Bitmiş bir akışın kaç gönderi gösterdiği. Filtreleri daha az gönderi geçerse akış " +
      "doldurulmaz, daha kısa biter.",
  },
  maxClickbait: {
    label: "Clickbait sınırı (1–10)",
    description:
      "Clickbait puanı bunun altında kalan gönderiler geçer. Daha sıkı bir filtre için düşür; " +
      "daha sansasyonel gönderilere izin vermek için yükselt.",
  },
  minReadValue: {
    label: "En düşük okuma değeri (0–10)",
    description:
      "Okuma değeri bunun altında kalan gönderiler hiç görünmez. Yükseltmek daha kısa, daha " +
      "yoğun bir akış verir; düşürmek akışı daha kolay doldurur.",
  },
  minReadForVerify: {
    label: "Doğrulama için okuma değeri (0–10)",
    description:
      "Okuma değeri en az bu olan gönderilerdeki olgusal iddialar web kaynaklarıyla " +
      "karşılaştırılır. Daha çok gönderiyi kontrol etmek için düşür (daha yavaş, daha çok LLM " +
      "kotası harcar); yalnız en değerlileri kontrol etmek için yükselt.",
  },
  maxVerifications: {
    label: "Çalıştırma başına en çok kaynak kontrolü",
    description:
      "Bir çalıştırmadaki web kaynağı kontrollerinin üst sınırı; önce en iyi gönderilere " +
      "verilir. Her kontrol zaman ve LLM kotası harcar.",
  },
  verifyEnabled: {
    label: "İddiaları kaynaklarla kontrol et",
    description:
      "Olgusal iddiaları göstermeden önce web'de araştırır. Kaynakların çürüttüğü iddiaları " +
      "taşıyan gönderiler çıkarılır. Daha hızlı ve ucuz çalıştırmalar için kapat.",
  },
  modeBEnabled: {
    label: "B modu: gizli bir pencerede kendiliğinden topla",
    description:
      "Varsayılan olarak kapalı ve riskli: X göz önünden uzakta açılır ve yeterli gönderi " +
      "toplanana kadar kendiliğinden kaydırılır. Otomatik gezinme X'in Hizmet Şartları'nın gri " +
      "bir alanında kalır ve hesabını riske atabilir. Açmak tarayıcının “alarms” iznini ister; " +
      "bu izni yalnız eklentinin seçenekler sayfası isteyebilir.",
  },
  modeBStrategy: {
    label: "B modunun topladığı yer",
    options: {
      "minimized-window": "Simge durumuna küçültülmüş pencere",
      "offscreen-window": "Ekran köşesinde küçük pencere (görünür)",
    },
    description:
      "Küçültülmüş pencere gönderi yüklemeyi bırakırsa köşe penceresini kullan. Tarayıcılar " +
      "bir pencerenin en az yarısını ekranda tutar; bu yüzden köşe penceresi kısmen görünür kalır.",
  },
  modeBPacing: {
    label: "B modu kaydırma hızı",
    options: { normal: "Normal", fast: "Hızlı" },
    description:
      "Hızlı, iki kat çabuk kaydırır ama X'in dikkatini çekme olasılığı daha yüksek olabilir.",
  },
  devCaptureEnabled: {
    label: "Geliştirici kaydı: ham akış yanıtlarını yerelde sakla",
    description:
      "Varsayılan olarak kapalı. Ham akış yanıtları hata ayıklama için repo dışına yazılır. " +
      "Kişisel veridir — asla paylaşma ya da commit'leme. Açıp kapatmak sayımı yeniden başlatır.",
  },
  uiLanguage: {
    label: "Dil",
    // Each language by its own name, as in the English list.
    options: { system: "Sistem dili", en: "English", tr: "Türkçe" },
    description:
      "Masaüstü uygulamasının ve akışın dili. Sistem dili Windows'u izler: Windows Türkçe ise " +
      "Türkçe, değilse İngilizce.",
  },
};

/** A managed setting's label, description and choice labels in `lang`. */
export function settingCopy(lang: UiLang, key: ManagedSettingKey): SettingCopy {
  if (lang === "tr") return TR[key];
  const field = MANAGED_SETTING_FIELDS[key];
  return {
    label: field.label,
    description: field.description,
    ...(field.kind === "choice"
      ? {
          options: Object.fromEntries(
            field.options.map((option: { value: string; label: string }) => [
              option.value,
              option.label,
            ]),
          ),
        }
      : {}),
  };
}
