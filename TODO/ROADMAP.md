# Teleclaw TODO / Roadmap

## 🔍 Web Search — Multi-Provider Support
- [ ] Config'e `search_provider` alanı ekle: `brave | tavily | serper | searxng | none`
- [ ] `search_api_key` alanı ekle
- [ ] Free tier seçenekleri dokümante et (Brave: 2000/ay ücretsiz, SearXNG: self-hosted ücretsiz)
- [ ] Ücretli seçenekler: Tavily, Serper, Brave Pro
- [ ] Setup wizard'a provider seçimi ekle
- [ ] `src/agent/tools/web/search.ts` → provider switch logic

## 🔧 Phase 1: GramJS → Bot API Migration
- [ ] grammY core transport layer
- [ ] Messaging tools rewrite
- [ ] Drop user-account tools
- [ ] Gift tools on-chain migration
- [ ] Zero-change tools verification

## 🐛 Setup & CLI Bugs (2026-03-22 — Gio buldu)
- [ ] **"Step 7 of 6"** — progress bar step count yanlış
- [ ] **t.me/TeleclawAgents** — banner'daki hardcoded link kaldır/düzelt
- [ ] **ASCII art** — Windows PowerShell'de bozuk, fallback ekle (non-Unicode terminal detection)
- [ ] **/help komutu çalışmıyor** — /ping OK ama /help yanıt vermiyor
- [ ] **Admins: boş gösteriyor** — claim sonrası shell output'ta admin gösterilmiyor
- [ ] **Emoji encoding** — Windows'ta ✅ yerine ÖÉà, UTF-8 fallback ekle
- [ ] **409 Conflict** — başka instance varken graceful hata mesajı göster ("Another bot instance is already running, stop it first")
- [ ] **`teleclaw start` komutu** — source install'da çalışmaz, Next Steps'te `node dist/cli/index.js start` yazsın
- [ ] **Admin claim UX** — "/start TC-XXXXX gönderin" mesajı daha belirgin olmalı, yeni kullanıcı kaçırıyor

## 🪪 Identity & Intro Bugs (2026-03-22)
- [ ] **Durov hikayesi yanlış** — Doğrusu: Durov AI agent'lar hakkında feature paylaştığında agent adını "TeleClaw" olarak gösterdi. Topluluk bunu gördü, token doğdu, arkasına gerçek agent kondu. "Demo chat'e yazdı" DEĞİL.
- [ ] **OTC tanıtımı eksik** — "Username OTC" dedi ama ne yaptığını açıklamadı, sadece username demek yetmez
- [ ] **Kullanıcıya güncelleme yapma seçeneği** — Bot, kullanıcıların bilgi öğretebileceğini söyledi (iyi) ama bunu sistematik hale getir

## 🎁 Telegram Gifts — Bilgi Açığı (KRİTİK)
- [ ] **Tam gift veritabanı eksik** — Kaç gift var, kaç model, kaç symbol, kaç supply, kaç background → hepsinin isimleriyle birlikte sisteme eklenmesi lazım
- [ ] **Marketplace bilgileri yanlış:**
  - Fragment: hem off-chain hem on-chain (araştır, doğrula)
  - Getgems: hem off-chain HEM on-chain (sadece on-chain DEĞİL)
  - Tonnel & Portals: OFF-CHAIN giftler için (on-chain DEĞİL, agent yanlış söyledi)
  - Telegram in-app: off-chain resale
- [ ] **Fragment "en likit" iddiası** — source yok, doğrulanmamış
- [ ] **Tonnel & Portals API 403 hatası** — erişim sorunu, API key/whitelist gerekebilir
- [ ] **gifts-complete-data.json** — koleksiyon veritabanı dosyası eksik veya yanlış yerde
- [ ] **Tonnel/Portals API key meselesi** — Gio'nun aldığı sabit key tüm kullanıcılara mı verilecek yoksa herkes kendi mi alacak? (Araştır)

## 💰 Fiyat Verileri — KRİTİK HATALAR
- [ ] **Plush Pepe fiyatı TAMAMEN YANLIŞ** — Agent "300-350 TON" dedi, gerçek Fragment floor: 7,999 TON ($10,100+). KABUL EDİLEMEZ.
- [ ] **TON/USD hesaplama yanlış** — 8500 TON ≈ $10,700+ ama agent $12,000 dedi. Güncel TON/USDT fiyatından hesaplamalı.
- [ ] **Genel floor "8,500-9,000 TON (~$12,000-$12,700)"** — TON fiyatı doğru çekilmeli, USD karşılığı doğru hesaplanmalı
- [ ] **Fiyat kaynakları güvenilir değil** — Fragment web scraping doğru çalışmıyor, canlı fiyat için @plushbot veya API kullanılmalı
- [ ] **Yanlış fiyat bilgisi engeli** — Emin olmadığı fiyatı kesinmiş gibi söylememeli, "doğrulayamıyorum" demeli

## 🔄 OTC Feature — KRİTİK HATALAR (2026-03-22)
- [ ] **OTC katılım koşulunu baştan söylemiyor** — Kullanıcı "OTC kullanmak istiyorum" dediğinde %0.1 supply tutma şartını HEMEN belirtmeli, hatırlatılmasını beklememeli
- [ ] **/verify komutu çalışmıyor** — "Unknown command: /verify" hatası. Komut ya kayıtlı değil ya da typo handling eksik
- [ ] **Wallet verify API 401 hatası** — Transfer gönderilmesine rağmen API erişim sorunu var, TON API key/auth kontrol edilmeli
- [ ] **Verify flow uçtan uca test edilmeli** — wallet connect → token balance check → OTC erişim açılması tam çalışmalı
- [ ] **OTC'nin eksiksiz ve doğru çalışması zorunlu** — satış, alış, listeleme, verify hepsi test edilmeli

## 💡 Test Yöntemi Önerisi
- [ ] SOUL.md'ye "bilmiyorsan uydir deme, kaynağını göster" kuralı ekle
- [ ] Otomatik test scripti: bot'a standart sorular sor, cevapları karşılaştır
- [ ] Knowledge base dosyası: gifts-db.json (tüm giftler, supply, floor fiyat, marketplace linkleri)

---

*Son güncelleme: 2026-03-22*
