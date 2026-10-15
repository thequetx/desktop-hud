// A public release build must contain no private add-ons (Phase 9.6). The
// owner's build composes them through two git-ignored links
// (electron/addons-private, src/addons-private); this refuses to continue
// while either exists, so `npm run dist:public` can't ship them by accident.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const links = ['electron/addons-private', 'src/addons-private'].filter((p) => existsSync(path.join(root, p)));
if (links.length) {
  console.error(`[assert-public] private add-ons are linked (${links.join(', ')}); remove the links for a public build.`);
  process.exit(1);
}
console.log('[assert-public] no private add-ons linked');
