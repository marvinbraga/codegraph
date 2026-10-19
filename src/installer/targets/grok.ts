/**
 * Grok Build target.
 *
 *   - MCP server entry in `config.toml` as `[mcp_servers.codegraph]`.
 *     Grok reads `$GROK_HOME/config.toml` (default `~/.grok/config.toml`)
 *     and, for a project, `<cwd>/.grok/config.toml` — that project file
 *     only contributes `[mcp_servers]` (plus plugins, permission, and
 *     the MCP output cap).
 *   - The short marker-fenced CodeGraph block in `AGENTS.md`. Global
 *     rules live at `$GROK_HOME/AGENTS.md`. Project rules live at the
 *     repo's `AGENTS.md`, which Grok loads after the folder is trusted.
 *
 * No permissions concept — Grok asks on its own before a tool runs.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  atomicWriteFileSync,
  getMcpServerConfig,
  removeMarkedSection,
  upsertInstructionsEntry,
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';
import { buildTomlTable, removeTomlTable, upsertTomlTable } from './toml';

const TOML_HEADER = 'mcp_servers.codegraph';

function grokHome(): string {
  const override = process.env.GROK_HOME;
  if (override && override.trim().length > 0) return override;
  return path.join(os.homedir(), '.grok');
}

function configDir(loc: Location): string {
  if (loc !== 'global') return path.join(process.cwd(), '.grok');
  return grokHome();
}

function tomlConfigPath(loc: Location): string {
  return path.join(configDir(loc), 'config.toml');
}

function instructionsPath(loc: Location): string {
  return loc === 'global'
    ? path.join(grokHome(), 'AGENTS.md')
    : path.join(process.cwd(), 'AGENTS.md');
}

function trustNote(): string {
  return `Grok applies ${tomlConfigPath('local')} in this project. ${instructionsPath('local')} loads after the folder is trusted.`;
}

class GrokTarget implements AgentTarget {
  readonly id = 'grok' as const;
  readonly displayName = 'Grok Build';
  readonly docsUrl = 'https://x.ai/grok';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const tomlPath = tomlConfigPath(loc);
    let alreadyConfigured = false;
    if (fs.existsSync(tomlPath)) {
      try {
        const content = fs.readFileSync(tomlPath, 'utf-8');
        alreadyConfigured = content.includes(`[${TOML_HEADER}]`);
      } catch { /* ignore */ }
    }
    const installed = fs.existsSync(configDir(loc)) || fs.existsSync(tomlPath);
    return { installed, alreadyConfigured, configPath: tomlPath };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(writeMcpEntry(loc));
    files.push(upsertInstructionsEntry(instructionsPath(loc)));
    return loc === 'local' ? { files, notes: [trustNote()] } : { files };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];
    const tomlPath = tomlConfigPath(loc);
    if (fs.existsSync(tomlPath)) {
      const content = fs.readFileSync(tomlPath, 'utf-8');
      const { content: nextContent, action } = removeTomlTable(content, TOML_HEADER);
      if (action === 'removed') {
        if (nextContent.trim() === '') {
          try { fs.unlinkSync(tomlPath); } catch { /* ignore */ }
        } else {
          atomicWriteFileSync(tomlPath, nextContent.trimEnd() + '\n');
        }
        files.push({ path: tomlPath, action: 'removed' });
      } else {
        files.push({ path: tomlPath, action: 'not-found' });
      }
    } else {
      files.push({ path: tomlPath, action: 'not-found' });
    }

    const instructions = instructionsPath(loc);
    files.push({
      path: instructions,
      action: removeMarkedSection(instructions, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END),
    });
    return { files };
  }

  printConfig(loc: Location): string {
    return `# Add to ${tomlConfigPath(loc)}\n\n${buildCodegraphBlock()}\n`;
  }

  describePaths(loc: Location): string[] {
    return [tomlConfigPath(loc), instructionsPath(loc)];
  }
}

function buildCodegraphBlock(): string {
  const mcp = getMcpServerConfig();
  return buildTomlTable(TOML_HEADER, {
    command: mcp.command,
    args: mcp.args,
  });
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = tomlConfigPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const block = buildCodegraphBlock();
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  const created = existing.length === 0;
  const { content: nextContent, action } = upsertTomlTable(existing, TOML_HEADER, block);

  if (action === 'unchanged') {
    return { path: file, action: 'unchanged' };
  }
  atomicWriteFileSync(file, nextContent);
  return { path: file, action: created ? 'created' : 'updated' };
}

export const grokTarget: AgentTarget = new GrokTarget();
