# Plan: Contacts & Accounts Management UI

## Kontext

Ziel ist es, SIP-Kontakte und Accounts direkt im UI hinzufügen, editieren und löschen zu können — ohne manuelle Datei-Edits. Die baresip-Konfigurationsdateien `contacts` und `accounts` bleiben **single source of truth**.

---

## Architektur-Überblick

### Was baresip unterstützt
| | Contacts | Accounts |
|---|---|---|
| Runtime Add/Remove | ❌ kein Befehl | ✅ `/uanew`, `/uadel` |
| Runtime Reload | ❌ kein Befehl | ✅ via `/uanew` + `/uadel` |
| Datei-Format | Textdatei | Textdatei (komplexer) |
| Wann aktiv | Nach Neustart | Sofort (via Befehl) |

### Bestehende Config-Pfade
- **Dev:** `baresip/config/contacts`, `baresip/config/accounts`
- **Docker/Prod:** `/config/contacts`, `/config/accounts`
- `autoconnect.json` bleibt unverändert für AutoConnect-Logik

### Datei-Formate

**contacts:**
```
"Display Name" <sip:user@domain>;presence=p2p
```
Parameter: `presence={none,p2p}`, `access={allow,block}`, `audio={inactive,...}`

**accounts:**
```
"Display Name"<sip:user@domain>;transport=udp;auth_pass=PASSWORD;answermode=auto;regint=360;audio_source=alsa,in_ch1;audio_player=alsa,out_ch1;pubint=0;inreq_allowed=yes
```
Kommentierte Zeilen (`#"Name"<sip:...>`) = deaktivierte Accounts.

---

## Strategie: Contacts "Pending Restart"

Da baresip keinen Reload-Befehl für Contacts kennt:
- Änderungen werden sofort in die Datei geschrieben
- Server hält einen `contactsPendingRestart`-Flag
- UI zeigt gelbes Banner: _"Kontaktänderungen werden nach Neustart aktiv"_
- Bestehende Reconnect-Mechanik (`connection.connect()`) lädt Contacts beim nächsten Connect neu

---

## Neue Dateien (Server)

### 1. `server/services/contacts-file.ts` — Parser & Writer
```typescript
interface ContactFileEntry {
  name: string        // Display Name
  uri: string         // sip:user@domain
  presence: 'none' | 'p2p'
  access?: 'allow' | 'block'
}

parseContactsFile(path: string): ContactFileEntry[]
writeContactsFile(path: string, entries: ContactFileEntry[]): Promise<void>
```
- Liest Datei zeilenweise, ignoriert `#`-Kommentare und Header-Zeilen
- Parsed Format: `"Name" <sip:...>;presence=p2p`
- Schreibt Header-Kommentar + alle Einträge zurück
- **Reuse:** Ähnlich wie `autoconnect-config.ts` (fs/promises, mkdir recursive, JSON.stringify → hier Text)

### 2. `server/services/accounts-file.ts` — Parser & Writer
```typescript
interface AccountFileEntry {
  name: string
  uri: string         // sip:user@domain
  enabled: boolean    // false = Zeile mit # kommentiert
  transport: 'udp' | 'tcp' | 'tls'
  auth_pass: string
  answermode: 'manual' | 'early' | 'auto'
  regint: number
  audio_source: string  // z.B. "alsa,in_ch1"
  audio_player: string  // z.B. "alsa,out_ch1"
  pubint: number
  inreq_allowed: boolean
}

parseAccountsFile(path: string): AccountFileEntry[]
writeAccountsFile(path: string, entries: AccountFileEntry[]): Promise<void>
```
- Kommentierte Zeilen werden als `enabled: false` geparst, **nicht** verworfen
- Beim Schreiben: `enabled: false` → `#`-Präfix, `true` → keine Raute
- Header-Kommentar aus Original-Datei wird bewahrt (erste N Kommentarzeilen)

### 3. `nuxt.config.ts` — RuntimeConfig erweitern
```typescript
runtimeConfig: {
  // bestehend:
  baresipHost: ...,
  baresipPort: ...,
  // neu:
  contactsConfigPath: process.env.CONTACTS_CONFIG_PATH || '/config/contacts',
  accountsConfigPath:  process.env.ACCOUNTS_CONFIG_PATH  || '/config/accounts',
}
```

---

## Neue API-Endpoints (Server)

Alle Endpoints folgen dem bestehenden Pattern: `parseRequestBody()` helper, `createError()` für Fehler, Broadcast via `stateManager`.

### Contacts

| Method | Path | Aktion |
|--------|------|--------|
| `POST` | `/api/contacts` | Contact hinzufügen → Datei schreiben → `contactsPendingRestart = true` |
| `PUT` | `/api/contacts/[uri]` | Contact editieren → Datei schreiben → `contactsPendingRestart = true` |
| `DELETE` | `/api/contacts/[uri]` | Contact löschen → Datei schreiben → `contactsPendingRestart = true` |

Nach jeder Änderung: `stateManager.broadcast({ type: 'contactsUpdate', contacts: ..., pendingRestart: true })`

### Accounts

| Method | Path | Aktion |
|--------|------|--------|
| `POST` | `/api/accounts` | Account hinzufügen → Datei schreiben → `/uanew <uri>` |
| `PUT` | `/api/accounts/[uri]` | Account editieren → Datei schreiben → `/uadel <uri>` + `/uanew <uri>` |
| `DELETE` | `/api/accounts/[uri]` | Account löschen → Datei schreiben → `/uadel <uri>` |
| `POST` | `/api/accounts/[uri]/toggle` | Enable/Disable → Datei `#`-Prefix → `/uanew` oder `/uadel` |

Nach jeder Änderung: `sendCommand('uastat')` um State zu aktualisieren + Broadcast.

**Wichtig für `PUT`:** URI kann sich ändern (neue SIP-Adresse). Daher: alten URI löschen, neuen hinzufügen.

---

## Types erweitern (`types/index.ts`)

```typescript
export interface ContactFileEntry {
  name: string
  uri: string
  presence: 'none' | 'p2p'
  access?: 'allow' | 'block'
}

export interface AccountFileEntry {
  name: string
  uri: string
  enabled: boolean
  transport: 'udp' | 'tcp' | 'tls'
  auth_pass: string
  answermode: 'manual' | 'early' | 'auto'
  regint: number
  audio_source: string
  audio_player: string
  pubint: number
  inreq_allowed: boolean
}
```

---

## Neue UI-Komponenten

### 4. `components/ContactsManager.vue`

**Layout:**
- Tabelle: Name | SIP URI | Presence | Actions
- "Contact hinzufügen"-Button (grün, oben rechts)
- Gelbes Banner wenn `pendingRestart === true`: _"Kontaktänderungen werden nach Neustart aktiv"_

**Modal (Add/Edit):**
- Input: Display Name (required)
- Input: SIP URI, z.B. `sip:1234@example.com` (required, validiert)
- Select: Presence (`none` / `p2p`)
- Select: Access (`allow` / `block`, optional)
- Buttons: Speichern / Abbrechen

**Delete:** Inline Bestätigungs-Dialog (kein extra Modal, gleich wie bestehende Pattern)

**Styling:** Gleiche Muster wie bestehende Modals (Teleport, bg-gray-800, border-gray-700, Tailwind)

---

### 5. `components/AccountsManager.vue`

**Layout:**
- Tabelle: Enabled-Toggle | Name | SIP URI | Registration Status | Actions (Edit/Delete)
- "Account hinzufügen"-Button (grün, oben rechts)
- Deaktivierte Accounts grau dargestellt

**Modal (Add/Edit) — Felder:**
```
Display Name       [Text Input]          required
SIP URI            [Text Input]          required, z.B. sip:user@domain
Passwort           [Password Input]      type="password", vorausgefüllt mit "********" (Platzhalter)
                                         → leer = unveränderter Wert; neuer Wert = Password wird gesetzt
Transport          [Select: udp/tcp/tls]
Answermode         [Select: manual/early/auto]
Reg. Interval (s)  [Number: 360]
Audio Source       [Text: alsa,in_ch1]
Audio Player       [Text: alsa,out_ch1]
Pub. Interval      [Number: 0]
Inreq Allowed      [Toggle: yes/no]
```
**Passwort-Logik:** Ein Sentinel-Wert (z.B. `"********"`) zeigt an, dass das Passwort unverändert bleibt. Sobald der User das Feld ändert, wird der neue Wert gespeichert. Technisch: Frontend sendet `auth_pass: null` wenn unverändert, Server behält dann den bestehenden Wert aus der Datei.

**Enable/Disable Toggle:** Sofort ohne Modal, direkt in der Tabellenzeile (kommentiert/uncommentiert + `/uanew`/`/uadel`)

**Styling:** Gleiche Muster wie AccountCard (bg-gray-800, status badges, etc.)

---

### 6. `components/SettingsPanel.vue` — Placeholders ersetzen

Die Datei hat bereits folgende Placeholder-Sections:
- `<!-- Account Management -->` mit "Add New Account (future update)" Text
- `<!-- Contact Management -->` mit "Add New Contact (future update)" Text

Diese werden durch `<ContactsManager />` und `<AccountsManager />` ersetzt.

---

## Socket.IO: Neues Event

`contactsPendingRestart` Flag zum `WebSocketMessage`-Type und zum `init`-Event hinzufügen, damit das UI beim Connect sofort den korrekten Zustand kennt.

---

## Datei-Änderungen im Überblick

| Datei | Änderung |
|-------|----------|
| `server/services/contacts-file.ts` | **neu** — Parser/Writer |
| `server/services/accounts-file.ts` | **neu** — Parser/Writer |
| `server/api/contacts/index.post.ts` | **neu** |
| `server/api/contacts/[uri].put.ts` | **neu** |
| `server/api/contacts/[uri].delete.ts` | **neu** |
| `server/api/accounts/index.post.ts` | **neu** |
| `server/api/accounts/[uri].put.ts` | **neu** |
| `server/api/accounts/[uri].delete.ts` | **neu** |
| `server/api/accounts/[uri]/toggle.post.ts` | **neu** |
| `nuxt.config.ts` | runtimeConfig erweitern |
| `types/index.ts` | neue Types hinzufügen |
| `components/ContactsManager.vue` | **neu** |
| `components/AccountsManager.vue` | **neu** |
| `components/SettingsPanel.vue` | Placeholders ersetzen |

---

## Verifikation

1. **Contact Add:** Contact im UI hinzufügen → `cat baresip/config/contacts` zeigt neuen Eintrag → gelbes Banner erscheint
2. **Contact Edit/Delete:** Änderung → Datei aktualisiert → Banner bleibt bis Neustart
3. **Account Add:** Account im UI anlegen → Datei hat neue Zeile → baresip registriert (Registration-Status erscheint im AccountCard)
4. **Account Delete:** Löschen → Datei aktualisiert → Account verschwindet aus Accounts-Liste
5. **Account Toggle Disable:** Toggle → Zeile in Datei mit `#` → Account verschwindet → Re-enable → Account erscheint wieder
6. **Account Edit:** URI-Änderung → alter Account weg, neuer erscheint mit neuem Registrierungsstatus
7. **Restart:** Nach baresip-Neustart → Contacts aus geänderter Datei geladen → Banner verschwindet
