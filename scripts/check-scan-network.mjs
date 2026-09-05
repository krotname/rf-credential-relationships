import { loadCatalogs } from '../collect-rf-equivalent-domains.mjs';

const catalogs = await loadCatalogs({ catalogs: true, timeoutMs: 15000 });
if (catalogs.errors.length) throw new Error(catalogs.errors.join('; '));
if (!catalogs.bitwarden.length || !catalogs.apple.length) throw new Error('Пустой внешний каталог');
console.log(`Каталоги доступны: Bitwarden ${catalogs.bitwarden.length}, Apple ${catalogs.apple.length}`);
