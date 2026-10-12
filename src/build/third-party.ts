import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface DependencyLicense {
  name: string | null;
  version: string | null;
  license: string | null;
  licenseText: string | null;
  noticeText: string | null;
  repository: string | { url: string } | null;
  licenseSource?: string;
}

/** Resolve actual bundled modules to package roots, including pnpm's physical package layout. */
export function bundledPackageRoots(moduleIds: string[]): Map<string, Set<string>> {
  const roots = new Map<string, Set<string>>();
  for (const id of moduleIds) {
    if (id.includes('\0')) continue;
    const path = id.replace(/^\/@fs\//, '/').split('?')[0]!;
    if (!existsSync(path)) continue;
    for (let dir = dirname(resolve(path)); ; dir = dirname(dir)) {
      const manifest = join(dir, 'package.json');
      if (existsSync(manifest)) {
        try {
          const meta = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; version?: string };
          if (meta.name && meta.version) {
            const key = `${meta.name}@${meta.version}`;
            const dirs = roots.get(key) ?? new Set<string>();
            dirs.add(dir); roots.set(key, dirs);
            break;
          }
        } catch { /* Keep searching past invalid or metadata-only nested manifests. */ }
      }
      if (dirname(dir) === dir) break;
    }
  }
  return roots;
}

/** Include all LICENSE*, LICENCE* and COPYING* files regardless of case or extension. */
export function packageLicenseText(root: string): string | undefined {
  const texts = readdirSync(root, { withFileTypes: true })
    .filter((file) => file.isFile() && /^(license|licence|copying)/i.test(file.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((file) => ({ name: file.name, text: readFileSync(join(root, file.name), 'utf8').trim() }))
    .filter((file) => file.text);
  return texts.length ? texts.map((file) => texts.length > 1 ? `${file.name}\n\n${file.text}` : file.text).join('\n\n') : undefined;
}

export const fallbackLicenseFile = (name: string, version: string) => `${name.replaceAll('/', '__')}@${version}.txt`;

/** Fallbacks must be exact-version upstream texts, with their provenance retained. */
function fallbackLicense(dir: string, name: string, version: string): { text: string; source: string } | undefined {
  const path = join(dir, fallbackLicenseFile(name, version));
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const match = raw.match(/^Package: ([^\n]+)\nSource: (https?:\/\/\S+)\n\n([\s\S]+)$/);
  if (!match || match[1] !== `${name}@${version}` || !match[3]!.trim()) throw new Error(`Invalid version/source headers in licenses/${fallbackLicenseFile(name, version)}`);
  return { text: match[3]!.trim(), source: match[2]! };
}

/** Resolve every dependency before writing either notices file; a partial list is never published. */
export function completeDependencyLicenses(deps: DependencyLicense[], roots: Map<string, Set<string>>, fallbackDir: string): DependencyLicense[] {
  const missing: string[] = [];
  const complete = deps.map((dep) => {
    if (!dep.name || !dep.version) throw new Error('Bundled dependency is missing its name or version');
    if (dep.licenseText?.trim()) return { ...dep, licenseText: dep.licenseText.trim() };
    const key = `${dep.name}@${dep.version}`;
    const files = [...(roots.get(key) ?? [])].map(packageLicenseText).filter((text): text is string => !!text);
    if (files.length) return { ...dep, licenseText: [...new Set(files)].join('\n\n') };
    const fallback = fallbackLicense(fallbackDir, dep.name, dep.version);
    if (fallback) return { ...dep, licenseText: fallback.text, licenseSource: fallback.source };
    missing.push(`${key} (licenses/${fallbackLicenseFile(dep.name, dep.version)})`);
    return dep;
  });
  if (missing.length) throw new Error(`Missing license text for bundled packages:\n${missing.join('\n')}`);
  return complete;
}
