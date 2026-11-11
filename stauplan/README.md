# Stauplan

Ein Fallblock-Puzzle im Containerhafen. Der Kran senkt Containergruppen in den
Laderaum der MS Lückenlos. Jede volle Lage wird gelöscht und zählt als TEU.

## Spielen

`index.html` im Browser öffnen. Das Spiel ist eine einzelne Datei ohne Build-Schritt.

## Regeln

- Der Laderaum ist 12 Reihen breit und 20 Lagen hoch.
- Die Gruppen bestehen aus zwei bis fünf Containern.
- Eine volle Lage wird gelöscht: 12 TEU, mehrere Lagen auf einmal zählen mehr
  (30, 54, 84, 120), jeweils mal Schicht.
- Alle 8 Lagen beginnt die nächste Schicht und der Kran wird schneller.
- Container mit Raute sind Eilgut. Vier gelöschte Eilgut-Container laden einen
  Seegang (höchstens zwei auf Vorrat).
- Der Seegang rüttelt die ganze Ladung nach unten, bis keine Lücke mehr bleibt.

## Steuerung

| Taste | Aktion |
| --- | --- |
| ← → | Bewegen |
| ↑ oder X | Drehen |
| Y oder Z | Zurückdrehen |
| ↓ | Absenken |
| Leertaste | Absetzen |
| S | Seegang |
| P oder Esc | Pause |
| M | Ton an/aus |

Am Handy: tippen dreht, seitlich ziehen bewegt, nach unten ziehen senkt ab,
nach unten wischen setzt ab. Dazu gibt es ein Tastenfeld unter dem Laderaum.
