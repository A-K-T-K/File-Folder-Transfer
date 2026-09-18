const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'dist', 'portable');
const isWindows = process.platform === 'win32';
const serverName = isWindows ? 'server.exe' : 'server';

function fail(message) {
    console.error(`Portable build failed: ${message}`);
    process.exit(1);
}

function main() {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    if (isWindows) {
        // Patch the icon onto pkg base binary before packaging
        execSync('node scripts/patch-portable-icon.js', { cwd: ROOT, stdio: 'inherit' });
    }

    const target = isWindows ? 'node18-win-x64' : (process.platform === 'darwin' ? 'node18-macos-x64' : 'node18-linux-x64');
    const outputPath = path.join(OUTPUT_DIR, serverName);

    console.log(`Building portable server for ${target} -> ${outputPath}`);
    execSync(`npx pkg . --targets ${target} --output "${outputPath}"`, { cwd: ROOT, stdio: 'inherit' });

    if (!fs.existsSync(outputPath)) {
        fail(`expected ${serverName} in ${OUTPUT_DIR}`);
    }

    // Clean up any old file-folder-transfer.exe if present
    const oldAppPath = path.join(OUTPUT_DIR, isWindows ? 'file-folder-transfer.exe' : 'file-folder-transfer');
    if (fs.existsSync(oldAppPath)) {
        try {
            fs.unlinkSync(oldAppPath);
        } catch (e) {
            console.warn(`Could not remove ${oldAppPath}: ${e.message}`);
        }
    }

    fs.writeFileSync(
        path.join(OUTPUT_DIR, 'README.txt'),
        'File & Folder Transfer (Portable Server)\r\n\r\n' +
        'Run server.exe. It will start the local transfer server and\r\n' +
        'automatically open the dashboard in your default browser.\r\n' +
        'No installation, WebView2 runtime, or Node.js required.\r\n',
        'ascii'
    );

    console.log(`\nPortable server ready at: ${outputPath}`);
}

main();
