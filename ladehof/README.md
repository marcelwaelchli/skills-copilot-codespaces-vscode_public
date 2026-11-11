# Ladehof

Ein Block-Puzzle auf dem Containerhof, von oben gesehen. An der Rampe stehen
drei Containergruppen. Zieh sie auf den Hof. Jede volle Reihe oder Gasse fährt
als Zug ab und zählt als TEU.

## Spielen

`index.html` im Browser öffnen. Das Spiel ist eine einzelne Datei ohne Build-Schritt.
Der Spielstand bleibt beim Neuladen erhalten.

## Regeln

- Der Hof ist 8 Gassen breit und 10 Reihen tief. Zu Schichtbeginn stehen schon
  einige Container darauf.
- Gruppen lassen sich nicht drehen. Sind alle drei gesetzt, kommt eine neue Lieferung.
- Eine volle Reihe bringt 8 TEU, eine volle Gasse 10 TEU.
- Mehrere Züge auf einmal und Serien (Züge in aufeinanderfolgenden Zügen)
  vervielfachen die Wertung. Zwei Gruppen ohne Zug beenden die Serie.
- Ein Zug in nur einer Farbe ist ein Ganzzug und zählt dreifach.
- Ein komplett geräumter Hof bringt 50 TEU extra.
- Container mit Raute sind Eilgut. Vier abgefertigte Eilgut-Container laden ein
  Umdisponieren (höchstens zwei auf Vorrat): Es tauscht die Gruppen an der Rampe.
- Die Schicht endet, wenn keine Gruppe mehr passt und kein Umdisponieren übrig ist.

## Steuerung

Mit Maus oder Finger eine Gruppe auf den Hof ziehen. Alternativ eine Gruppe
antippen und dann die Stelle auf dem Hof antippen.

| Taste | Aktion |
| --- | --- |
| 1 2 3 | Gruppe wählen |
| ← ↑ ↓ → | Bewegen |
| Enter | Absetzen |
| Esc | Auswahl aufheben |
| U | Umdisponieren |
| N | Neue Schicht |
| M | Ton an/aus |
