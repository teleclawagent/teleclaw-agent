# Teleclaw TODO / Roadmap

*Son güncelleme: 2026-03-24*

## ✅ Tamamlanan (audit sonrası)
- ~~"Step 7 of 6" — progress bar~~ → Temizlendi
- ~~t.me/TeleclawAgents hardcoded link~~ → Kaldırıldı
- ~~/help komutu çalışmıyor~~ → Çalışıyor (admin + user versiyon)
- ~~409 Conflict~~ → Graceful error mesajı eklendi
- ~~Durov hikayesi yanlış~~ → SOUL.md'de düzeltildi
- ~~Fiyat hallucination~~ → Zero Hallucination Rule + tool chain zorunluluğu SOUL.md'de
- ~~"bilmiyorsan uydurma" kuralı~~ → SOUL.md + soul/loader.ts fallback
- ~~6 GramJS messaging tool scope eksik~~ → `userbot-only` eklendi (5c116bb)
- ~~5 modül register-all'da eksik~~ → portfolio, alpha-radar, whale-watcher, deals eklendi (5c116bb)
- ~~Sub-agent cleanup race condition~~ → try/finally fix (5c116bb)
- ~~Cron hardcoded timezone~~ → System timezone kullanıyor (5c116bb)

---

## 🔴 Açık — Launch Sonrası Öncelik

### 🔍 Web Search — Multi-Provider Support
- [ ] Config'e `search_provider` alanı ekle: `brave | tavily | serper | searxng | none`
- [ ] `search_api_key` alanı ekle
- [ ] Free tier seçenekleri dokümante et (Brave: 2000/ay ücretsiz, SearXNG: self-hosted ücretsiz)
- [ ] Setup wizard'a provider seçimi ekle

### 🔧 Phase 1: GramJS → Bot API Migration
- [ ] grammY core transport layer
- [ ] Messaging tools rewrite
- [ ] Drop user-account tools
- [ ] Gift tools on-chain migration
- [ ] Zero-change tools verification

### 🎁 Gift Data
- [ ] gifts-complete-data.json — koleksiyon veritabanı (supply, model, backdrop, symbol)
- [ ] Tonnel & Portals API 403 — key/whitelist çözümü veya disabled olarak bırak

### 🔄 OTC
- [ ] Verify flow end-to-end test (wallet connect → balance check → erişim)
- [ ] /verify komutu test

### 🔔 Cron Persistence
- [ ] Reminders SQLite'a persist et, restart'ta reload

---

## 🟡 Nice-to-Have

- [ ] Windows emoji encoding fallback (UTF-8 detection)
- [ ] ASCII art Windows PowerShell fallback
- [ ] Admin claim UX iyileştirme
- [ ] `teleclaw start` source install'da doğru komut göstersin
