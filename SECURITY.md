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

## Deployment auf Render

`render.yaml` definiert einen Node-Webservice in Frankfurt mit einem persistenten 1-GB-Datenträger. Ein Datenträger ist bei Render nur mit einem kostenpflichtigen Webservice verfügbar; vor dem Anlegen die aktuellen Preise und den ausgewählten Compute-Plan im Render-Dashboard prüfen. Der Service ist auf den Branch `security/backend-hardening` eingestellt.

1. Änderungen mit `render.yaml` in das GitHub-Repository pushen.
2. Im Render-Dashboard **New > Blueprint** auswählen, das GitHub-Repository verbinden, den Branch `security/backend-hardening` wählen und die angezeigte Kosten-/Ressourcenübersicht prüfen.
3. Den Blueprint nur dann bereitstellen, wenn Service, Frankfurt-Region und persistenter Datenträger korrekt angezeigt werden. Render generiert `SESSION_SECRET` automatisch.
4. Nach erfolgreichem Deploy in den Service-Einstellungen `app.einsatztakt.de` als Custom Domain hinzufügen bzw. verifizieren. Beim DNS-Anbieter den von Render angezeigten CNAME-Zielwert für `app` eintragen. Die bestehende Root-Domain `einsatztakt.de` und deren GitHub-Pages-Konfiguration dabei nicht ändern. Vorhandene `AAAA`-Records für `app` gemäß Render-Anleitung entfernen.
5. `https://app.einsatztakt.de/api/health` prüfen, anschließend Registrierung, Login, Session-Cookie, Datenbank-Persistenz nach einem Redeploy und Wiederherstellung aus Backup testen.

Render kann das Deployment, die Custom-Domain-Verifizierung und DNS-Änderungen nicht allein durch einen Git-Push abschließen. Dazu sind Zugriff auf das Render-Dashboard und die DNS-Verwaltung erforderlich. Das bestehende GitHub-Pages-Frontend bleibt separat auf der Root-Domain bestehen, bis es bewusst umgestellt wird.
