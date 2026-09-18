const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = 'A-K-T-K/File-Folder-Transfer';
const TAG = 'v0.0.1';
const ASSET_PATH = path.join(__dirname, '..', 'dist', 'portable', 'server.exe');

async function main() {
    console.log('Retrieving GitHub credentials...');
    const out = cp.execSync('git credential fill', { input: 'protocol=https\nhost=github.com\n' }).toString();
    const tokenMatch = out.match(/password=(.+)/);
    if (!tokenMatch) {
        throw new Error('Could not find password in git credentials');
    }
    const token = tokenMatch[1].trim();

    const headers = {
        'Authorization': `token ${token}`,
        'User-Agent': 'NodeJS-Release-Uploader',
        'Accept': 'application/vnd.github.v3+json'
    };

    console.log(`Checking if release ${TAG} already exists...`);
    let releaseRes = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, { headers });
    let releaseData;

    if (releaseRes.ok) {
        releaseData = await releaseRes.json();
        console.log(`Found existing release: ${releaseData.name} (ID: ${releaseData.id})`);
    } else {
        console.log(`Creating new release ${TAG}...`);
        const createRes = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tag_name: TAG,
                target_commitish: 'main',
                name: 'File & Folder Transfer v0.0.1',
                body: '### File & Folder Transfer v0.0.1\r\n\r\nPortable server for local file and folder transfers between PC and mobile devices.\r\n\r\n- **Standalone**: Run `server.exe` directly — no installation, WebView2, or Node.js required.\r\n- **Auto-Launch**: Starts the local server and automatically opens the dashboard in your default browser.\r\n- **Offline**: Fully self-contained with embedded Fluent UI components and QR-code pairing.\r\n- **High-Speed & Reliable**: Tiered chunking, sliding window worker pipelines, and sequential chunk reassembly buffer.',
                draft: false,
                prerelease: false
            })
        });

        if (!createRes.ok) {
            const errText = await createRes.text();
            throw new Error(`Failed to create release: ${createRes.status} ${errText}`);
        }
        releaseData = await createRes.json();
        console.log(`Release created successfully! (ID: ${releaseData.id})`);
    }

    // Check if asset already exists in release
    const existingAsset = (releaseData.assets || []).find(a => a.name === 'server.exe');
    if (existingAsset) {
        console.log(`Deleting previous asset ${existingAsset.name} (ID: ${existingAsset.id})...`);
        const delRes = await fetch(`https://api.github.com/repos/${REPO}/releases/assets/${existingAsset.id}`, {
            method: 'DELETE',
            headers
        });
        if (!delRes.ok) {
            console.warn('Failed to delete existing asset:', await delRes.text());
        }
    }

    console.log(`Reading asset: ${ASSET_PATH}`);
    const fileStat = fs.statSync(ASSET_PATH);
    console.log(`Asset size: ${(fileStat.size / (1024 * 1024)).toFixed(2)} MB`);

    const uploadUrl = releaseData.upload_url.replace(/\{.*\}/, '') + `?name=server.exe`;
    console.log(`Uploading to: ${uploadUrl}`);

    const fileStream = fs.createReadStream(ASSET_PATH);
    const uploadRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
            'Authorization': `token ${token}`,
            'User-Agent': 'NodeJS-Release-Uploader',
            'Content-Type': 'application/octet-stream',
            'Content-Length': fileStat.size
        },
        body: fileStream,
        duplex: 'half'
    });

    if (!uploadRes.ok) {
        const errText = await uploadRes.text();
        throw new Error(`Upload failed: ${uploadRes.status} ${errText}`);
    }

    const uploadedAsset = await uploadRes.json();
    console.log(`\nAsset uploaded successfully!`);
    console.log(`Asset Name: ${uploadedAsset.name}`);
    console.log(`Asset Size: ${uploadedAsset.size} bytes`);
    console.log(`Download URL: ${uploadedAsset.browser_download_url}`);
    console.log(`Release URL: ${releaseData.html_url}`);
}

main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
