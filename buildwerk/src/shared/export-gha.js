// Generates a GitHub Actions workflow that runs a macro through the CLI.
// Pure text generation, so it works in the browser and on the Node side.

import { walk } from './model.js';

const MAX_INPUTS = 25; // GitHub's limit for workflow_dispatch inputs

function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function needsWindows(macro) {
  for (const { op } of walk(macro.operations || [])) {
    if (op.enabled === false) continue;
    if (op.type === 'build.msbuild' && (op.props?.tool ?? 'msbuild') === 'msbuild') return true;
    if (op.type === 'run.shell' && ['cmd', 'powershell'].includes(op.props?.shell)) return true;
  }
  return false;
}

/**
 * @param {object} macro
 * @param {object} options
 * @param {string} options.macroPath path of the macro file relative to the repository root
 * @param {string} [options.toolPath] path of the Buildwerk folder relative to the repository root
 * @param {string} [options.branch] branch whose pushes trigger the workflow
 */
export function exportGithubActions(macro, { macroPath, toolPath = 'buildwerk', branch = 'main' }) {
  const name = macro.name || 'Buildwerk';
  const variables = (macro.variables || []).filter((v) => v.name);
  const inputs = variables.filter((v) => !v.secret && !v.persistent).slice(0, MAX_INPUTS);
  const secrets = variables.filter((v) => v.secret);
  const persistent = variables.filter((v) => v.persistent);
  const posix = (file) => String(file).replace(/\\/g, '/');

  const lines = [
    `# Erzeugt von Buildwerk aus «${posix(macroPath)}».`,
    '# Führt das Makro auf einem GitHub-Runner aus. Beim manuellen Start lassen sich',
    '# die Variablen überschreiben; leere Felder übernehmen den Wert aus dem Makro.',
  ];
  if (persistent.length) {
    lines.push(
      `# Hinweis: Persistente Variablen (${persistent.map((v) => v.name).join(', ')}) behalten ihren Wert hier nur,`,
      '# wenn die zugehörige .state.json-Datei eingecheckt wird.',
    );
  }
  lines.push(`name: ${quote(name)}`, '', 'on:', '  workflow_dispatch:');
  if (inputs.length) {
    lines.push('    inputs:');
    for (const variable of inputs) {
      const fallback = variable.value ? ` (Standard: ${variable.value})` : '';
      lines.push(
        `      ${variable.name}:`,
        `        description: ${quote((variable.description || variable.name) + fallback)}`,
        '        required: false',
      );
    }
  }
  lines.push(
    '  push:',
    `    branches: [${quote(branch)}]`,
    '',
    'permissions:',
    '  contents: read',
    '',
    'jobs:',
    '  makro:',
    '    name: Makro ausführen',
    `    runs-on: ${needsWindows(macro) ? 'windows-latest' : 'ubuntu-latest'}`,
    '    steps:',
    '      - uses: actions/checkout@v5',
    '      - uses: actions/setup-node@v5',
    '        with:',
    '          node-version: 22',
    `      - name: ${quote(name)}`,
    `        run: node "${posix(toolPath)}/bin/buildwerk.js" run "${posix(macroPath)}"`,
  );
  if (inputs.length || secrets.length) {
    lines.push('        env:');
    // Values travel through the environment, never through the command line.
    for (const variable of inputs) lines.push(`          BW_VAR_${variable.name}: \${{ inputs.${variable.name} }}`);
    for (const variable of secrets) lines.push(`          ${variable.name}: \${{ secrets.${variable.name} }}`);
  }
  return lines.join('\n') + '\n';
}

export function suggestWorkflowPath(macro) {
  const slug = (macro.name || 'buildwerk')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `.github/workflows/${slug || 'buildwerk'}.yml`;
}
