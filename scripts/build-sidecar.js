// Builds the standalone Node server as a pkg executable and places it in
// src-tauri/binaries/ under the name+triple Tauri's sidecar mechanism expects
// (server-<rust-target-triple>[.exe]). Runs automatically before `tauri build`
// / `tauri dev` via tauri.conf.json's build.beforeBuildCommand — without this,
// the native window has nothing to load, since the Tauri app no longer assumes
// an already-running `node server.js` in production.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BINARIES_DIR = path.join(ROOT, 'src-tauri', 'binaries');

const PKG_TARGETS = {
    win32: 'node18-win-x64',
    darwin: 'node18-macos-x64',
    linux: 'node18-linux-x64',
};

function main() {
    const pkgTarget = PKG_TARGETS[process.platform];
    if (!pkgTarget) {
        console.error(`No pkg target mapped for platform "${process.platform}".`);
        process.exit(1);
    }

    const triple = execSync('rustc -vV', { cwd: ROOT }).toString().match(/host:\s*(\S+)/)[1];
    const ext = process.platform === 'win32' ? '.exe' : '';
    const outputBase = path.join(BINARIES_DIR, `server-${triple}`);

    fs.mkdirSync(BINARIES_DIR, { recursive: true });

    if (process.platform === 'win32') {
        // Must run before pkg builds the .exe — see scripts/patch-portable-icon.js
        // for why the icon can't be patched onto the final packaged binary.
        execSync('node scripts/patch-portable-icon.js', { cwd: ROOT, stdio: 'inherit' });
    }

    console.log(`Building sidecar for ${pkgTarget} -> ${outputBase}${ext}`);
    execSync(`npx pkg . --targets ${pkgTarget} --output "${outputBase}"`, { cwd: ROOT, stdio: 'inherit' });

    if (!fs.existsSync(outputBase + ext)) {
        console.error('Sidecar build did not produce the expected output file.');
        process.exit(1);
    }
    console.log('Sidecar ready:', outputBase + ext);
}

main();
