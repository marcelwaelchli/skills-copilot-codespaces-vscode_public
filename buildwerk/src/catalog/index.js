// The operation catalog: every operation type Buildwerk knows.

import build from './build.js';
import docker from './docker.js';
import files from './files.js';
import flow from './flow.js';
import git from './git.js';
import net from './net.js';
import run from './run.js';
import vars from './vars.js';

export const CATEGORIES = [
  { id: 'flow', label: 'Ablaufsteuerung' },
  { id: 'vars', label: 'Variablen & Protokoll' },
  { id: 'run', label: 'Programme & Skripte' },
  { id: 'file', label: 'Dateien & Ordner' },
  { id: 'git', label: 'Git' },
  { id: 'build', label: 'Build-Werkzeuge' },
  { id: 'docker', label: 'Container' },
  { id: 'net', label: 'Netzwerk' },
];

/** Variables Buildwerk provides itself. They are not exported to child processes. */
export const SYSTEM_VARIABLES = [
  { name: 'MACRO_NAME', description: 'Name des Makros' },
  { name: 'MACRO_FILE', description: 'Pfad der Makrodatei' },
  { name: 'MACRO_DIR', description: 'Ordner der Makrodatei' },
  { name: 'BASE_DIR', description: 'Basisverzeichnis für relative Pfade' },
  { name: 'WORKSPACE', description: 'Arbeitsbereich, in dem Buildwerk gestartet wurde' },
  { name: 'TEMP_DIR', description: 'Temporärer Ordner dieses Laufs, wird danach gelöscht' },
  { name: 'OS', description: 'windows, linux oder macos' },
  { name: 'DATE', description: 'Startdatum, z. B. 2026-03-14' },
  { name: 'TIME', description: 'Startzeit, z. B. 09:26:53' },
  { name: 'TIMESTAMP', description: 'Start als 20260314-092653, gut für Dateinamen' },
  { name: 'RUN_ID', description: 'Eindeutige Kennung dieses Laufs' },
  { name: 'LAST_EXIT_CODE', description: 'Exit-Code des zuletzt beendeten Prozesses' },
  { name: 'ERROR_MESSAGE', description: 'Fehlermeldung, verfügbar in «Bei Fehler»' },
  { name: 'ERROR_OPERATION', description: 'Fehlgeschlagene Operation, verfügbar in «Bei Fehler»' },
  { name: 'LOOP_INDEX', description: 'Nummer des aktuellen Schleifendurchlaufs, ab 1' },
];

const all = [...flow, ...vars, ...run, ...files, ...git, ...build, ...docker, ...net];

/** @type {Map<string, object>} */
export const catalog = new Map(all.map((def) => [def.type, def]));

/** Catalog as plain data for the browser (functions are dropped by JSON). */
export function describeCatalog() {
  return { categories: CATEGORIES, operations: all, systemVariables: SYSTEM_VARIABLES };
}
