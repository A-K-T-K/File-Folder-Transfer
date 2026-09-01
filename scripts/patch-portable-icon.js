// Gives the pkg-built portable .exe our app icon.
//
// pkg has no built-in icon support, and running rcedit on the FINAL packaged
// exe corrupts it: pkg locates its appended payload via a byte offset baked
// into the binary at packaging time, and rcedit resizing the PE resource
// section shifts everything after it, so that offset points at garbage.
//
// The safe order is: patch the icon onto pkg-fetch's cached base Node
// binary *before* pkg appends the payload. But pkg-fetch verifies that
// cached binary against a hardcoded sha256 on every build and silently
// re-downloads a pristine copy (undoing our patch) if it doesn't match —
// so we also update its expected-hash table to match our patched file.
//
// Re-run this once after any `npm install` that might refresh node_modules
// or clear ~/.pkg-cache, before `npm run build` / the pkg build command.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { rcedit } = require('rcedit');
const pkgFetch = require('pkg-fetch');

const NODE_RANGE = 'node18';
const ICON_PATH = path.resolve(__dirname, '..', 'src-tauri', 'icons', 'icon.ico');

async function main() {
    if (process.platform !== 'win32') {
        console.log('Skipping portable-exe icon patch (rcedit only edits Windows PE resources).');
        return;
    }
    if (!fs.existsSync(ICON_PATH)) {
        console.error(`Icon not found at ${ICON_PATH}. Run "npx tauri icon icon.svg -o src-tauri/icons" first.`);
        process.exit(1);
    }

    // Ensures the base binary is downloaded if this is the first build on this
    // machine, and returns its cache path either way.
    const baseBinary = await pkgFetch.need({ nodeRange: NODE_RANGE, platform: 'win32', arch: 'x64' });
    const nodeVersion = path.basename(baseBinary).match(/fetched-v([\d.]+)-win-x64/)[1];
    const expectedHashesFile = require.resolve('pkg-fetch/lib-es5/expected.js');

    console.log('Patching icon onto pkg base binary:', baseBinary);
    await rcedit(baseBinary, { icon: ICON_PATH });

    const newHash = crypto.createHash('sha256').update(fs.readFileSync(baseBinary)).digest('hex');
    const key = `node-v${nodeVersion}-win-x64`;

    let expectedSrc = fs.readFileSync(expectedHashesFile, 'utf8');
    const keyRegex = new RegExp(`('${key}':\\s*')[0-9a-f]+(')`);
    if (!keyRegex.test(expectedSrc)) {
        console.error(`Could not find expected-hash entry for "${key}" in ${expectedHashesFile}.`);
        process.exit(1);
    }
    expectedSrc = expectedSrc.replace(keyRegex, `$1${newHash}$2`);
    fs.writeFileSync(expectedHashesFile, expectedSrc);

    console.log('Icon patched and expected hash updated:', newHash);
    console.log('You can now run the pkg build normally.');
}

main().catch(err => {
    console.error('Failed:', err);
    process.exit(1);
});
