import type { Theme } from '@dafe/types';
import { neon } from './neon';
import { cyber } from './cyber';
import { matrix } from './matrix';
import { dafe } from './dafe';

export const themes: Record<string, Theme> = {
  neon,
  cyber,
  matrix,
  dafe,
};

export * from './neon';
export * from './cyber';
export * from './matrix';
export * from './dafe';

export function getTheme(id: string): Theme {
  return themes[id] || themes.dafe;
}
