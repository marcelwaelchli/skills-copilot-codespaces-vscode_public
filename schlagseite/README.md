# Schlagseite

Ein Kipp-Puzzle auf dem Deck der MS Lückenlos, von oben gesehen. Du setzt keine
Container, du kippst das ganze Schiff: Alle Gruppen rutschen, bis sie anstossen.
Volle Reihen werden gelöscht und zählen als TEU.

## Spielen

`index.html` im Browser öffnen. Das Spiel ist eine einzelne Datei ohne Build-Schritt.
Der Spielstand bleibt beim Neuladen erhalten.

## Regeln

- Das Deck hat 6 mal 6 Stellplätze.
- Ein Zug kippt das Schiff nach links, rechts, vorne oder hinten. Jede Gruppe
  rutscht als starres Ganzes, bis Bordwand, eine andere Gruppe oder der
  Kranplatz sie stoppt.
- Eine volle Reihe, quer oder längs, wird gelöscht: 6 TEU. Mehrere Reihen auf
  einmal zählen mehr. Wird eine Gruppe dabei zerschnitten, rutschen ihre Teile
  getrennt weiter.
- Solange das Schiff gekippt ist, rutscht der Rest nach. Entsteht so wieder eine
  volle Reihe, ist das eine Kette und zählt mehrfach.
- Der schraffierte Kranplatz ist für die nächste Gruppe reserviert. Rutschende
  Container halten davor an. Nach jedem Zug setzt der Kran die Gruppe dort ab.
  Vollendet sie eine Reihe, zählt das doppelt (Passgenau).
- Alle 6 gelöschten Reihen beginnt eine neue Schicht mit grösseren Gruppen.
- Die Fahrt endet, wenn für die nächste Gruppe kein Platz mehr frei ist.

## Steuerung

Auf dem Deck wischen: Solange der Finger unten ist, zeigt das Spiel, wohin die
Gruppen rutschen würden; beim Loslassen wird gekippt. Alternativ die vier
Pfeiltasten unter dem Deck (mit der Maus darüberfahren zeigt die Vorschau).

| Taste | Aktion |
| --- | --- |
| ← ↑ ↓ → oder W A S D | Kippen |
| N | Neue Fahrt |
| M | Ton an/aus |
