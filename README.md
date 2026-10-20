# ioBroker Energy Flow Adapter

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Energie-Monitoring-Adapter für ioBroker mit responsivem Dashboard für Solar, Batterie, Netz und E-Fahrzeug-Laden.

## Funktionsübersicht

- **Freie Datenpunkt-Zuweisung**: Beliebige ioBroker-Datenpunkte als Eingangsquellen konfigurierbar
- **Mehrere Solarquellen**: Beliebig viele Wechselrichter oder PV-Strings summierbar
- **Batterie-Monitoring**: Laden/Entladen mit Ladestand (SoC)
- **Netz-Monitoring**: Bezug und Einspeisung
- **E-Fahrzeug-Laden**: Optionale Ladeüberwachung mit korrekter Haushaltsabgrenzung
- **Energiebilanz**: Leistungsfluss-Visualisierung mit dokumentierter Schätzmethode
- **Energie-Zähler**: Tages-, Monats- und Jahreswerte für alle Energiearten
- **Persistenz**: Messlücken-Erkennung, Zähler-Reset-Schutz, Neustart-sichere Speicherung
- **Statistiken**: Tägliche Solar-Minima, -Maxima, Durchschnitt, Spitzenleistung
- **Dashboard**: Responsives Web-Dashboard ohne VIS oder externe Abhängigkeiten
- **Demo-Modus**: Synthetische Testdaten ohne Einfluss auf echte Statistiken

## Vorzeichenkonventionen

Intern werden folgende Vorzeichenkonventionen verwendet:

| Größe | Positiv | Negativ |
|-------|---------|---------|
| Batterie | Entladen | Laden |
| Netz | Bezug (Import) | Einspeisung (Export) |
| Solar | Immer ≥ 0 | – |
| Haushalt | Immer ≥ 0 | – |
| E-Fahrzeug | Laden (≥ 0) | Nicht unterstützt |

Geräte-spezifische abweichende Konventionen können in der Konfiguration per "Vorzeichen umkehren" angepasst werden.

## Installation und Entwicklung

### Voraussetzungen

- Node.js >= 22.19.0
- npm >= 10

### Entwicklungsinstallation

```bash
git clone https://github.com/example/ioBroker.energy-flow.git
cd ioBroker.energy-flow
npm install
npm run build
```

### Build und Tests

```bash
# Build (TypeScript → JavaScript)
npm run build

# Typen prüfen
npm run check

# Tests ausführen
npm run test:ts

# Paket-Tests
npm run test:package

# Alle Tests
npm test
```

### Installation in ioBroker

1. Adapter bauen: `npm run build && npm pack`
2. Die erzeugte `.tgz`-Datei in der ioBroker Admin-Oberfläche unter "Adapter" → "Von Datei installieren" hochladen
3. Adapter-Instanz anlegen und konfigurieren

## Konfiguration

### Allgemein

- **Zeitzone**: Standard `Europe/Berlin`. Beeinflusst Tages-/Monats-/Jahresgrenzen.

### Solarquellen

Beliebig viele Solarquellen hinzufügen. Beispiel-Objekt-ID:
```
solax.0.livedata.SolarPower
```
Einheit: `W` oder `kW`. Faktor: 1.0 (Standard). Mehrere Quellen werden summiert.

### Batterie

Beispiel-Objekt-ID für Leistung (Vorzeichen: positiv = Entladen):
```
solax.0.livedata.BatteryPower
```
Für Ladestand:
```
solax.0.livedata.BatterySoc
```
Falls Ihr Wechselrichter positiv = Laden meldet: "Vorzeichen umkehren" aktivieren.

### Netz

Beispiel-Objekt-ID für Netzleistung (positiv = Bezug):
```
solax.0.livedata.GridPower
```
Für Zähler:
```
esphome.0.sensor.energy_import_total
esphome.0.sensor.energy_export_total
```

### Haushalt

Beispiel-Objekt-ID:
```
shelly.0.Shelly3EM.emeters.0.power
```
Wenn kein Sensor vorhanden: Verbrauch wird aus Solar + Netz + Batterie berechnet.

### E-Fahrzeug

Beispiel-Objekt-ID für Ladeleistung:
```
easee.0.charger_12345.state.dynamicChargerCurrent
```
Wichtig: "Ladeenergie im Haushaltsverbrauch enthalten?" korrekt setzen.

## Dashboard öffnen

Nach Konfiguration und Start des Adapters das Dashboard öffnen unter:
```
http://[ioBroker-IP]:8082/energy-flow/
```
(Port kann je nach Web-Adapter-Konfiguration abweichen)

## Messgrößen und Energieflüsse

### Bilanzgrenzen

Für eine exakte Leistungsbilanz (`Haushalt = Solar + Netz + Batterie`) müssen alle Messgrößen am selben Messpunkt (AC-Seite) gemessen werden. DC-Solarleistung und AC-Netzleistung können nicht ohne Wirkungsgradmodell direkt verglichen werden.

### Geschätzte Flüsse

Wenn keine direkte Messung einzelner Energieflüsse vorhanden ist, wird eine deterministische Schätzmethode angewandt:

1. Solar deckt zuerst Haushalt und E-Fahrzeug
2. Überschuss geht in Batterie oder Netzeinspeisung
3. Batterie deckt verbleibenden Bedarf
4. Netz deckt Rest

Alle geschätzten Werte sind im Dashboard und in den Adapter-Zuständen als `estimated` markiert.

## Datenlücken und Genauigkeit

- Messlücken > 60 Sekunden werden nicht integriert
- Zähler-Resets werden erkannt (negativer Delta) und übersprungen
- Implausible Messwertsprünge werden verworfen
- Fehlende Messwerte werden nie als 0 interpretiert

## Persistenz und Backup

Messdaten werden in ioBroker-Zuständen gespeichert:
- Kurzzeitverlauf (Standard: 30 Tage) in `energy-flow.X.energy-flow.powerHistory`
- Tagesaggregierungen in `energy-flow.X.energy-flow.persistence`

Für Backup: ioBroker-Backup-Funktion nutzt diese Zustände automatisch.

## Fehlerbehebung

- **Dashboard zeigt keine Daten**: Adapter gestartet und konfiguriert? Objekt-IDs korrekt?
- **Werte veraltet**: Max. Messwert-Alter in der Konfiguration prüfen
- **Bilanzkonflikt**: Diagnostics-Zustand `energy-flow.X.diagnostics.balanceConflict` prüfen
- **Demo-Modus aktiv**: Grünes/Lila Badge im Dashboard; über `sendTo` `disableDemo` deaktivieren

## Entwicklung

```bash
# Linting
npm run lint

# Coverage
npm run coverage

# Paket erstellen
npm pack
```

## Lizenz

MIT License – siehe [LICENSE](LICENSE)
