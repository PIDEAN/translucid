import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bundledPackageRoots, completeDependencyLicenses, fallbackLicenseFile, packageLicenseText, type DependencyLicense } from '../src/build/third-party';

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'translucid-license-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const dependency = (name = 'fixture', version = '1.2.3'): DependencyLicense => ({ name, version, license: 'MIT', licenseText: null, noticeText: null, repository: 'https://example.org/source' });

it('finds all license spellings/extensions and COPYING files, ignoring directories and empty files', () => {
  const root = temp();
  writeFileSync(join(root, 'LiCeNsE.MiT.txt'), 'MIT fixture text');
  writeFileSync(join(root, 'LICENCE.custom'), 'Second fixture text');
  writeFileSync(join(root, 'copying.html'), 'Copying fixture text');
  writeFileSync(join(root, 'LICENSE.empty'), '  ');
  writeFileSync(join(root, 'README.md'), 'not a license');
  mkdirSync(join(root, 'LICENSE.folder'));
  const text = packageLicenseText(root)!;
  for (const content of ['MIT fixture text', 'Second fixture text', 'Copying fixture text']) expect(text).toContain(content);
  expect(text).not.toContain('not a license');
});

it('finds the nearest named package for real bundled modules, including nested metadata-only manifests', () => {
  const root = temp();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@scope/fixture', version: '1.2.3' }));
  mkdirSync(join(root, 'dist', 'nested'), { recursive: true });
  writeFileSync(join(root, 'dist', 'package.json'), '{"type":"module"}');
  const module = join(root, 'dist', 'nested', 'index.js');
  writeFileSync(module, 'export const value = 1;');
  const roots = bundledPackageRoots([module, `${module}?query`, '\0virtual:fixture', join(root, 'missing.js')]);
  expect([...roots.get('@scope/fixture@1.2.3')!]).toEqual([root]);
});

describe('missing-license release gate', () => {
  it('fills the plugin omission from a package directory before using a pinned fallback', () => {
    const root = temp(), fallback = temp();
    writeFileSync(join(root, 'COPYING-extra.md'), 'Exact upstream fixture');
    const dep = dependency();
    const complete = completeDependencyLicenses([dep], new Map([['fixture@1.2.3', new Set([root])]]), fallback);
    expect(complete[0]!.licenseText).toBe('Exact upstream fixture');
    expect(dep.licenseText).toBeNull();
  });

  it('accepts only a version-bound fallback with package and source headers and preserves its source', () => {
    const fallback = temp();
    const file = fallbackLicenseFile('@scope/fixture', '1.2.3');
    writeFileSync(join(fallback, file), 'Package: @scope/fixture@1.2.3\nSource: https://example.org/v1.2.3/LICENSE\n\nExact fixture license text');
    const complete = completeDependencyLicenses([dependency('@scope/fixture')], new Map(), fallback);
    expect(complete[0]).toMatchObject({ licenseText: 'Exact fixture license text', licenseSource: 'https://example.org/v1.2.3/LICENSE' });
    expect(() => completeDependencyLicenses([dependency('@scope/fixture', '1.2.4')], new Map(), fallback)).toThrow('Missing license text');
    writeFileSync(join(fallback, file), 'Package: other@1.2.3\nSource: https://example.org/LICENSE\n\nWrong text');
    expect(() => completeDependencyLicenses([dependency('@scope/fixture')], new Map(), fallback)).toThrow('Invalid version/source');
  });

  it('fails for all missing packages before a notices file can be replaced by a partial list', () => {
    const fallback = temp();
    const output = join(fallback, 'notices.txt');
    writeFileSync(output, 'Previous complete notices');
    const deps = [{ ...dependency('present'), licenseText: 'Existing upstream text' }, dependency('missing'), dependency('also-missing')];
    expect(() => {
      const completed = completeDependencyLicenses(deps, new Map(), fallback);
      writeFileSync(output, JSON.stringify(completed));
    }).toThrow(/missing@1.2.3[\s\S]*also-missing@1.2.3/);
    expect(readFileSync(output, 'utf8')).toBe('Previous complete notices');
  });
});
