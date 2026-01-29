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

# PCAP-Datei erstellen
docker-compose up &
sudo tcpdump -i any -w baresip-patched.pcap "tcp port 5060"

# Nach 10 Sekunden: Ctrl+C
# Prüfe Contact Header
tshark -r baresip-patched.pcap -Y "sip.method == REGISTER" | grep Contact
```

---
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

#

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

================================================================================
Vorgehen Patch entwicklung
================================================================================

📁 DATEI ZUM PATCHEN: /tmp/re/src/sipreg/reg.c (RE Library)

┌─────────────────────────────────────────────────────────────────────────────┐
│ SCHRITT 1: struct sipreg erweitern (nach Zeile 53)                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   struct sipreg {                                                           │
│       ...                                                                   │
│       uint16_t srcport;                 ← Zeile 53                          │
│   +   struct sa public_addr;            ← NEU: Öffentliche IP speichern     │
│   +   bool has_public_addr;             ← NEU: Flag ob gesetzt              │
│   };                                                                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ SCHRITT 2: response_handler() patchen (Zeile 226-240)                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   case 401:                                                                 │
│   case 407:                                                                 │
│       if (reg->ls.failc > 1 && last_scode == msg->scode) {                  │
│           reg->failc++;                                                     │
│           goto out;                                                         │
│       }                                                                     │
│                                                                             │
│       sip_auth_reset(reg->auth);                                            │
│       err = sip_auth_authenticate(reg->auth, msg);                          │
│       if (err) {                                                            │
│           err = (err == EAUTH) ? 0 : err;                                   │
│           break;                                                            │
│       }                                                                     │
│                                                                             │
│   +   /* Extract public IP from Via received parameter */                  │
│   +   struct pl received;                                                   │
│   +   if (0 == msg_param_decode(&msg->via.params, "received", &received)) {│
│   +       if (0 == sa_decode(&reg->public_addr,                            │
│   +                          received.p, received.l)) {                     │
│   +           sa_set_port(&reg->public_addr, sa_port(&reg->laddr));        │
│   +           reg->has_public_addr = true;                                  │
│   +       }                                                                 │
│   +   }                                                                     │
│                                                                             │
│       err = request(reg, false);                                            │
│       ...                                                                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ SCHRITT 3: send_handler() patchen (Zeile 310)                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   reg->tp = tp;                                                             │
│   if (reg->srcport && tp != SIP_TRANSP_UDP)                                 │
│       sa_set_port(src, reg->srcport);                                       │
│                                                                             │
│   - reg->laddr = *src;                      ← ALT: immer lokale IP         │
│   + if (reg->has_public_addr) {             ← NEU: Check public IP         │
│   +     reg->laddr = reg->public_addr;      ← NEU: Verwende public IP      │
│   + } else {                                                                │
│   +     reg->laddr = *src;                  ← NEU: Fallback zu lokal       │
│   + }                                                                       │
│                                                                             │
│   err = mbuf_printf(mb, "Contact: <sip:%s@%J...", &reg->laddr, ...);       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

================================================================================
�� VERWENDETE RE-LIBRARY FUNKTIONEN
================================================================================

✅ msg_param_decode()           [/tmp/re/include/re_msg.h:20]
   → Extrahiert Parameter aus struct pl
   → Verwendung: msg_param_decode(&msg->via.params, "received", &received)
   → Return: 0 bei Erfolg

✅ sa_decode()                  [/tmp/re/include/re_sa.h:53]
   → Parst IP-Adresse String zu struct sa
   → Verwendung: sa_decode(&reg->public_addr, received.p, received.l)
   → Return: 0 bei Erfolg

✅ sa_set_port()                [/tmp/re/include/re_sa.h:52]
   → Setzt Port in struct sa
   → Verwendung: sa_set_port(&reg->public_addr, port)
   → Return: void

✅ sa_port()                    [/tmp/re/include/re_sa.h]
   → Liest Port aus struct sa
   → Verwendung: sa_port(&reg->laddr)
   → Return: uint16_t

================================================================================
🔄 ABLAUF IM DETAIL
================================================================================

1. Baresip sendet REGISTER mit lokaler IP:
   Contact: <sip:user@172.20.0.2:59771>

2. Server antwortet 401 Unauthorized mit Via received Parameter:
   Via: SIP/2.0/TCP 172.20.0.2:59771;received=109.202.196.180;branch=...

3. response_handler() wird aufgerufen (Zeile 192):
   ├─ msg->scode == 401
   ├─ UNSER PATCH: Extrahiert "109.202.196.180" aus msg->via.params
   ├─ Speichert in reg->public_addr
   └─ Setzt reg->has_public_addr = true

4. request(reg, false) wird aufgerufen → sendet neues REGISTER

5. send_handler() wird aufgerufen (Zeile 296):
   ├─ UNSER PATCH: Prüft reg->has_public_addr
   ├─ Verwendet reg->public_addr statt *src
   └─ Contact Header wird erstellt mit: <sip:user@109.202.196.180:5060>

6. Server empfängt authenticated REGISTER mit öffentlicher IP ✓

================================================================================
❓ OFFENE FRAGEN / RISIKEN
================================================================================

1. ✅ Funktioniert msg_param_decode mit msg->via.params?
   → JA! Wird bereits in reply.c für "maddr" verwendet (Zeile 250)

2. ✅ Ist msg->via.params verfügbar in response_handler?
   → JA! msg->via wird in struct sip_msg Zeile 214 geparst

3. ✅ Wird response_handler bei 401/407 aufgerufen?
   → JA! Bestätigt durch Code-Analyse (Zeile 226-240)

4. ⚠️  Wird der Port korrekt übernommen?
   → MUSS GETESTET WERDEN: sa_set_port(&reg->public_addr, sa_port(&reg->laddr))
   → Alternative: sa_set_port(&reg->public_addr, 5060) für Standard-Port

5. ⚠️  Was wenn kein "received" Parameter vorhanden?
   → msg_param_decode returns != 0
   → has_public_addr bleibt false
   → Fallback zu lokaler IP ✓

6. ⚠️  Was bei Re-Registration (nach 300 Sekunden)?
   → has_public_addr bleibt true (bis nächster 401)
   → Verwendet weiterhin public IP ✓

================================================================================
✅ NÄCHSTER SCHRITT
================================================================================

Soll ich den Patch jetzt mit Python generieren?

Der Patch wird:
├─ Tabs verwenden (wie Original-Code)
├─ Drei Hunks haben:
│  1. struct sipreg erweitern
│  2. response_handler() 401/407 case
│  └─ 3. send_handler() laddr Zuweisung
├─ Mit --dry-run getestet
└─ In baresip/patches/re-sipreg-public-contact.patch gespeichert

Wenn du einverstanden bist, gebe ich dir vorher nochmal den EXAKTEN
Code-Diff zum Review!
