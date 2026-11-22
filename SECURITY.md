# Sicherheitsbetrieb

## Vor dem Produktivbetrieb

- Node.js 20.17 oder neuer verwenden; `npm ci` ausführen und `npm run build` ausführen.
- Einen mindestens 32 Zeichen langen, zufälligen `SESSION_SECRET` ausschließlich als Deployment-Secret setzen. Nicht in Git einchecken.
- `NODE_ENV=production` setzen und die Anwendung ausschließlich hinter HTTPS bereitstellen. Die öffentliche Website und `/api` müssen unter demselben Ursprung erreichbar sein.
- `DB_PATH` auf ein persistentes, nur für den Anwendungsbenutzer zugängliches Volume setzen. Die Anwendung begrenzt die SQLite-Dateiberechtigung auf `0600`; zusätzlich Datenträger und Backups verschlüsseln.
- Vor dem ersten Start eine geprüfte Sicherung der bestehenden Datenbank anfertigen. Beim Start werden bisherige Passwort- und PIN-Spalten umbenannt und ihre Klartextwerte mit scrypt gehasht. Diese Migration zuerst mit einer Kopie der Produktionsdatenbank testen.
- Die alte Browser-Version speicherte Firmen- und Sitzungsdaten in `localStorage`. Die neue Version liest diese Daten nicht und importiert sie nicht automatisch. Vor dem Rollout benötigte lokale Daten sicher migrieren; erst nach geprüfter Migration `et_companies` und `et_session` aus den Browsern entfernen.
- `SESSION_SECRET`, `DB_PATH`, HTTPS, Sicherungen und Wiederherstellung im Deployment überwachen. Die eingebaute Anmeldebegrenzung ist pro Prozess; mehrere Serverinstanzen benötigen einen gemeinsamen Rate-Limit-Speicher.

## Datenflüsse und Betrieb

- Firmen-Code ist nur ein Bezeichner, kein Ersatz für Anmeldung. Rollen- und Firmenzugriff werden auf dem Server geprüft.
- Sitzungen liegen serverseitig in SQLite; das Cookie ist `HttpOnly`, `Secure` im Produktionsmodus und `SameSite=Strict`.
- Die Kontakt- und Newsletter-Formulare senden Daten weiterhin an Formspree. Vor dem Betrieb dort Datenschutz, Auftragsverarbeitung und Aufbewahrung prüfen. Einsatz-, GPS- und Mitarbeiterdaten werden nicht an diesen Dienst gesendet.
- Firmen-Codes werden nach Registrierung im Browser angezeigt; die frühere EmailJS-Übermittlung wurde entfernt.
- Arbeitszeit- und GPS-Daten sind personenbezogen und in SQLite nicht anwendungseitig verschlüsselt. Zugriff auf Volume und Backups daher beschränken und verschlüsseln. Aufbewahrung, Löschung und Datenschutzhinweise vor dem Produktiveinsatz fachlich prüfen.

## Lokal testen

```sh
npm ci
npm run build
npm start
```

`/api/health` sollte `{"status":"ok","service":"EinsatzTakt Backend"}` zurückgeben. Tests laufen mit `npm test`.
