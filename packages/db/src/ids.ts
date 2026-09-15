import { randomBytes } from 'node:crypto';

export type IdPrefix = 'usr' | 'ses' | 'prj' | 'tsk' | 'run' | 'agr' | 'dec' | 'mem' | 'apr' | 'prv' | 'ci' | 'hsc' | 'imp' | 'cnv' | 'msg';

/** Time-sortable, URL-safe identifier: `<prefix>_<time base36><64 random bits hex>`. */
export function newId(prefix: IdPrefix): string {
  const time = Date.now().toString(36).padStart(9, '0');
  return `${prefix}_${time}${randomBytes(8).toString('hex')}`;
}
