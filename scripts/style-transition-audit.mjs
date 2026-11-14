// Diagnostic-only CSS type overlay: no production writes, emission, admission changes or new wire profile.
import ts from 'typescript';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const modelFile = path.join(root, 'core/lib/model.ts');
const aliases = [
  { name: 'Style', before: 'Record<string,string>', after: 'CssDeclaration[]' },
  { name: 'StyleOverrides', before: 'Record<string,string|null>', after: 'CssDeclarationOperation[]' },
];

export function styleAliasOverlay(text) {
  const source = ts.createSourceFile(modelFile, text, ts.ScriptTarget.Latest, true);
  const edits = aliases.map(alias => {
    const matches = source.statements.filter(node => ts.isTypeAliasDeclaration(node) && node.name.text === alias.name);
    if (matches.length !== 1 || matches[0].type.getText(source).replace(/\s/g, '') !== alias.before) throw new Error(`Draft ${alias.name} alias changed; retire or rebase this diagnostic probe explicitly.`);
    return { ...alias, start: matches[0].type.getStart(source), end: matches[0].type.end };
  });
  let overlay = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) overlay = overlay.slice(0, edit.start) + edit.after + overlay.slice(edit.end);
  return { text: overlay, aliases: edits.map(({ name, before, after }) => ({ name, before, after })) };
}

function diagnostic(value) {
  const file = value.file ? path.relative(root, value.file.fileName).split(path.sep).join('/') : null;
  const position = value.file && value.start !== undefined ? value.file.getLineAndCharacterOfPosition(value.start) : null;
  return { file, line: position ? position.line + 1 : null, column: position ? position.character + 1 : null, code: value.code,
    kind: file?.includes('/tests/') ? 'test' : 'production', message: ts.flattenDiagnosticMessageText(value.messageText, '\n') };
}

export function auditStyleTransition() {
  const configPath = path.join(root, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  if (parsed.errors.length) throw new Error(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  const options = { ...parsed.options, noEmit: true };
  const baseline = ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames, options)).map(diagnostic);
  if (baseline.length) return { status: 'blocked-baseline', activated: false, baseline };
  const host = ts.createCompilerHost(options);
  const source = host.readFile(modelFile);
  if (source === undefined) throw new Error('Cannot read the draft model for the in-memory overlay.');
  const overlay = styleAliasOverlay(source), original = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => path.resolve(file) === modelFile
    ? ts.createSourceFile(file, overlay.text, languageVersion, true)
    : original(file, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram(parsed.fileNames, options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program).map(diagnostic);
  const sources = program.getSourceFiles().filter(file => !file.isDeclarationFile && !path.relative(root, file.fileName).startsWith('..') && !file.fileName.includes(`${path.sep}node_modules${path.sep}`));
  const byFile = new Map();
  for (const item of diagnostics) byFile.set(item.file, (byFile.get(item.file) ?? 0) + 1);
  return {
    status: 'diagnostic-only', activated: false, baselineDiagnostics: 0, overlay: overlay.aliases,
    coverage: { config: 'tsconfig.json', strict: options.strict, checkJs: options.checkJs, noEmit: true, ownTsSources: sources.filter(file => file.fileName.endsWith('.ts')).length,
      ownJsSources: sources.filter(file => /\.[cm]?js$/.test(file.fileName)).length, webDomProfileRun: false,
      limitation: 'A type-alias swap is not runtime admission or a complete consumer inventory. Untyped JS, any/generic merges, browser layout code, cascade and persistence require separate inspection.' },
    summary: { diagnostics: diagnostics.length, production: diagnostics.filter(item => item.kind === 'production').length, tests: diagnostics.filter(item => item.kind === 'test').length,
      files: [...byFile].map(([file, count]) => ({ file, count })).sort((a, b) => (a.file ?? '').localeCompare(b.file ?? '')) },
    diagnostics,
  };
}

if (import.meta.main) {
  const result = auditStyleTransition();
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'blocked-baseline') process.exitCode = 1;
}
