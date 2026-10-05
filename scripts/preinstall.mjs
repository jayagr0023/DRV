import { existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

for (const file of ['package-lock.json', 'yarn.lock']) {
    const path = resolve(process.cwd(), file);
    if (existsSync(path)) unlinkSync(path);
}

if (!process.env.npm_config_user_agent?.startsWith('pnpm/')) {
    console.error('Use pnpm instead');
    process.exit(1);
}