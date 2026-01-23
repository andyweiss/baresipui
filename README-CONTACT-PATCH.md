# Baresip Contact Header Public IP Patch

## 📋 Übersicht

Dieser Patch ermöglicht es Baresip, die **öffentliche IP-Adresse** im Contact-Header von SIP REGISTER-Requests zu verwenden, statt der lokalen Bind-IP-Adresse. Dies ist essentiell für NAT-Traversal und Container-Umgebungen.

**Problem:** 
```
❌ Contact: <sip:user@172.23.0.2:59771>  (Interne Docker-IP)
```

**Lösung:**
```
✅ Contact: <sip:user@10.114.66.116:5060>  (Öffentliche IP)
```

---

## 🚀 Quick Start

### 1. Patch anwenden (Automatisch)
```bash
cd /home/debdev/baresipui
./apply-contact-patch.sh ./baresip
```

### 2. Kompilieren
```bash
cd baresip
make clean && make
```

### 3. Testen
```bash
# PCAP-Datei erstellen
docker-compose up &
sudo tcpdump -i any -w baresip-patched.pcap "tcp port 5060"

# Nach 10 Sekunden: Ctrl+C
# Prüfe Contact Header
tshark -r baresip-patched.pcap -Y "sip.method == REGISTER" | grep Contact
```

---

## 📁 Dateien

| Datei | Größe | Beschreibung |
|-------|-------|-------------|
| `baresip-contact-public-ip.patch` | 3.4K | ⭐ Empfohlener Patch |
| `baresip-contact-header-rewrite.patch` | 4.6K | Erweiterte Variante |
| `apply-contact-patch.sh` | 5.3K | Automatisiertes Anwendungs-Skript |
| `PATCH-SUMMARY.md` | 6.3K | Schnelle Zusammenfassung |
| `CONTACT-HEADER-PATCH-DOCUMENTATION.md` | 6.3K | Detaillierte Dokumentation |
| `TEST-PLAN-CONTACT-PATCH.md` | 6.4K | Test- & Verifizierungs-Plan |
| `baresip/modules/pubip.c` | 8K | Nicht-invasives Modul |

---

## 🔧 Was ändert sich im Code

### Neue Funktion
```c
static int extract_public_contact_addr(struct reg *reg,
                                       const struct sip_msg *msg)
```
- Wird in `register_handler()` aufgerufen bei 401/407 Responses
- Parst Via-Header um öffentliche IP zu extrahieren
- Loggt Debugging-Info

### Integration
```c
// In register_handler() bei Authentication-Response:
if (msg->scode == 401 || msg->scode == 407) {
    (void)extract_public_contact_addr(reg, msg);
}
```

---

## ✅ Verifizierungs-Checkliste

- [ ] Patch angewendet ohne Fehler
- [ ] Baresip kompiliert erfolgreich
- [ ] PCAP-Datei erstellt
- [ ] Via-Header enthält öffentliche IP
- [ ] Contact-Header enthält öffentliche IP
- [ ] Debug-Logs zeigen "extracted public IP"
- [ ] Anrufe können empfangen werden (optional)

---

## 🐛 Häufige Probleme

### Patch lässt sich nicht anwenden
```
patching file src/reg.c
Hunk #1 FAILED
```
→ **Lösung:** Baresip-Version zu alt. Mindestens 0.7.x erforderlich.

### "extract_public_contact_addr is not defined"
```
error: 'extract_public_contact_addr' undeclared
```
→ **Lösung:** Beide Funktionen (Deklaration + Aufruf) hinzufügen.

### Contact Header ändert sich nicht
```
Contact: <sip:user@172.23.0.2:59771>  (Immer noch alt)
```
→ **Lösung:** Die `re`-Bibliothek muss auch gepatch sein, oder verwende das `pubip.c` Modul statt.

---

## 📊 Vergleich: Vorher vs. Nachher

### Frame 5 der SIP-Sequenz (Authenticated REGISTER)

**VORHER (Ohne Patch):**
```
Via: SIP/2.0/TCP 172.23.0.2:59771;branch=z9hG4bK...
From: <sip:2061831@example.com>;tag=...
To: <sip:2061831@example.com>;tag=...
Contact: <sip:2061831@172.23.0.2:59771>;expires=360
Authorization: Digest username="2061831"...
```

**NACHHER (Mit Patch):**
```
Via: SIP/2.0/TCP 10.114.66.116:5060;branch=z9hG4bK...
From: <sip:2061831@example.com>;tag=...
To: <sip:2061831@example.com>;tag=...
Contact: <sip:2061831@10.114.66.116:5060>;expires=360
Authorization: Digest username="2061831"...
```

---

## 🔍 PCAP-Analyse mit Wireshark

1. Öffne baresip-patched.pcap in Wireshark
2. Filtere nach SIP: `sip.method == REGISTER`
3. Suche Frame mit Status "401 Unauthorized"
4. Prüfe nächste REGISTER-Anfrage:
   - **Via-Header:** Sollte öffentliche IP enthalten
   - **Contact-Header:** Sollte auch öffentliche IP enthalten
   - **Konsistenz:** Beide sollten die gleiche IP haben

---

## 📚 Dokumentation

- **Übersicht:** `PATCH-SUMMARY.md` ← HIER STARTEN
- **Detailliert:** `CONTACT-HEADER-PATCH-DOCUMENTATION.md`
- **Tests:** `TEST-PLAN-CONTACT-PATCH.md`
- **Modul:** `baresip/modules/pubip.c` (nicht-invasiv)

---

## 🎯 Anwendungs-Szenarien

### ✅ Wo dieser Patch hilft

1. **Docker/Container** - Interne IP-Adressen sind von außen nicht erreichbar
2. **Cloud-Deployments** - Public/Private IP Mismatch
3. **NAT-Netzwerke** - Externe Firewall-Regeln
4. **Proxy-Server** - Korrekte Contact-Registration
5. **Mobile-Netzwerke** - IP-Adressen-Wechsel

### ❌ Nicht notwendig bei

- Direkter Verbindung ohne NAT
- Wenn Outbound-Proxy konfiguriert
- Wenn nur SIP-Calls initiiert werden (kein Empfang nötig)

---

## 🔗 SIP-Konzepte

### Via-Header (RFC 3261)
```
Via: SIP/2.0/transport host:port;branch=...
```
- Wird von jedem Proxy modifiziert
- Der `received` Parameter kann die öffentliche IP enthalten

### Contact-Header (RFC 3261)
```
Contact: <sip:user@host:port>
```
- Sollte eine erreichbare Adresse enthalten
- Server speichert diese für Incoming-Calls
- **Kritisch für NAT-Szenarien!**

---

## 🚀 Nächste Schritte

```bash
# 1. Patch anwenden
cd /home/debdev/baresipui
./apply-contact-patch.sh ./baresip

# 2. Kompilieren
cd baresip && make clean && make

# 3. Testen (siehe TEST-PLAN-CONTACT-PATCH.md)
docker-compose up baresip &
sudo tcpdump -i any -w test.pcap "tcp port 5060"

# 4. Verifizieren mit Wireshark
tshark -r test.pcap -Y "sip.method == REGISTER" -V | grep -E "Via:|Contact:"
```

---

## 📞 Support

- **Patch funktioniert nicht?** → Siehe "Häufige Probleme"
- **Mehr Details?** → Lese `CONTACT-HEADER-PATCH-DOCUMENTATION.md`
- **Tests nicht sicher?** → Folge `TEST-PLAN-CONTACT-PATCH.md`
- **Nicht-invasiv?** → Verwende `baresip/modules/pubip.c`

---

**Status:** ✅ Patch erstellt & dokumentiert  
**Stand:** 2026-01-06  
**Version:** 1.0
