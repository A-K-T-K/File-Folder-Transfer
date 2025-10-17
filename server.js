const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const fs = require('fs');
const os = require('os');
const open = require('open');
const { v4: uuidv4 } = require('uuid');
const { networkInterfaces } = require('os');
const qrcode = require('qrcode');

// --- Configuration ---
const PORT = 5000;
const DESKTOP_PATH = path.join(os.homedir(), 'Desktop');
let UPLOAD_FOLDER = path.join(DESKTOP_PATH, 'FileTrasfer_Recieved');
let SERVER_NAME = "My Local Server";

// --- Setup ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 40 * 1024 * 1024 });

// --- Global State ---
let fileHandlers = {};
let devices = {};
let pinCode = Math.floor(1000 + Math.random() * 9000).toString();
let securityToken = uuidv4();

// --- Helper Functions ---
function getLocalIp() {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                return net.address;
            }
        }
    }
    return '127.0.0.1';
}

const localIp = getLocalIp();

// --- Express Routes ---
app.get('/', (req, res) => {
    fs.readFile(path.join(__dirname, 'index.html'), 'utf8', (err, data) => {
        if (err) {
            res.status(500).send("Error loading client page.");
            return;
        }
        const token = req.query.token || 'None';
        res.send(data.replace(/\{\{\s*token\s*\}\}/g, token));
    });
});

app.get('/server', (req, res) => {
    fs.readFile(path.join(__dirname, 'server.html'), 'utf8', (err, data) => {
         if (err) {
            res.status(500).send("Error loading server dashboard.");
            return;
        }
        const urlWithToken = `http://${localIp}:${PORT}/?token=${securityToken}`;
        const displayUrl = `http://${localIp}:${PORT}`;
        
        qrcode.toDataURL(urlWithToken, (err, qrCodeDataUrl) => {
            if (err) {
                console.error("QR Code Generation Error:", err);
                res.status(500).send("Error generating QR code.");
                return;
            }
            const finalHtml = data
                               .replace(/\{\{\s*server_name\s*\}\}/g, SERVER_NAME)
                               .replace(/\{\{\s*display_url\s*\}\}/g, displayUrl)
                               .replace(/\{\{\s*pin\s*\}\}/g, pinCode)
                               .replace(/\{\{\s*qr_code\s*\}\}/g, qrCodeDataUrl)
                               .replace(/\{\{\s*upload_folder\s*\}\}/g, UPLOAD_FOLDER);
            res.send(finalHtml);
        });
    });
});

app.post('/open-uploads-folder', (req, res) => {
    if (!fs.existsSync(UPLOAD_FOLDER)) {
        fs.mkdirSync(UPLOAD_FOLDER, { recursive: true });
    }
    open(UPLOAD_FOLDER)
        .then(() => res.json({ status: 'success' }))
        .catch(err => res.status(500).json({ status: 'error', message: err.message }));
});

// --- Content for the Web Worker (from uploader.js) ---
const uploaderScript = `
// This script runs in a separate thread and handles all the heavy file processing.
console.log('Uploader Worker: Script loaded.');

let currentFile = null;
let transferId = null;
let chunkIndex = 0;
let chunkSize = 0;

function getChunkSize(fileSize) {
    if (fileSize < 100 * 1024 * 1024) { // < 100MB
        return 4 * 1024 * 1024; // 4MB chunks
    }
    if (fileSize < 1024 * 1024 * 1024) { // < 1GB
        return 16 * 1024 * 1024; // 16MB chunks
    }
    return 32 * 1024 * 1024; // 32MB chunks for very large files
}

self.onmessage = (event) => {
    const { type, payload } = event.data;
    console.log(\`[Worker] Received message from main: \${type}\`);

    if (type === 'process_file') {
        currentFile = payload.file;
        transferId = payload.transfer_id;
        chunkIndex = 0;
        chunkSize = getChunkSize(currentFile.size);
        console.log(\`[Worker] Starting to process file \${currentFile.name}, transfer_id: \${transferId}\`);
        readAndSendNextChunk();
    } else if (type === 'next_chunk_ok') {
        readAndSendNextChunk();
    }
};

function readAndSendNextChunk() {
    if (!currentFile) {
        console.log('[Worker] No current file to process.');
        return;
    }

    const start = chunkIndex * chunkSize;
    if (start >= currentFile.size) {
        console.log(\`[Worker] Finished processing file \${currentFile.name}\`);
        self.postMessage({ type: 'file_complete', payload: { transfer_id: transferId } });
        currentFile = null; // Clear file for the next job
        return;
    }

    const chunk = currentFile.slice(start, start + chunkSize);
    const reader = new FileReader();
    
    reader.onload = (e) => {
        const chunkData = e.target.result;
        console.log(\`[Worker] Read chunk \${chunkIndex + 1}. Sending to main thread.\`);
        // Post chunk back to the main thread to be sent over the socket
        self.postMessage({
            type: 'chunk',
            payload: { chunk: chunkData, transfer_id: transferId }
        }, [chunkData]); // Transfer the ArrayBuffer to avoid copying, which is more efficient

        chunkIndex++;
    };

    reader.onerror = (e) => {
         console.error(\`[Worker] File read error for \${currentFile.name}\`, e);
         self.postMessage({ type: 'error', payload: { message: \`File read error: \${e}\` }});
    };
    
    console.log(\`[Worker] Reading chunk \${chunkIndex + 1} for \${currentFile.name}\`);
    // Start reading the slice of the file
    reader.readAsArrayBuffer(chunk);
}
`;

app.get('/uploader.js', (req, res) => {
    res.type('application/javascript');
    res.send(uploaderScript);
});


// --- Socket.IO Handlers ---
io.on('connection', (socket) => {
    socket.on('register_client', (data) => {
        const { deviceId, name, token, pin } = data;
        let isAuthenticated = false;

        if (token === securityToken) isAuthenticated = true;
        else if (pin === pinCode) isAuthenticated = true;
        
        if (isAuthenticated) {
            console.log(`[Server] Auth successful for device: ${name}`);
            if (!devices[deviceId]) {
                devices[deviceId] = { name, sids: new Set() };
                io.of('/server_ui').emit('client_connected');
            }
            devices[deviceId].sids.add(socket.id);
            io.of('/server_ui').emit('client_update', { clients: Object.values(devices).map(d => d.name) });
            socket.emit('auth_successful');
            socket.emit('server_info', { name: SERVER_NAME });
        } else {
            console.log(`[Server] Auth failed for device: ${name}`);
            socket.emit('auth_failed');
        }
    });
    
    socket.on('change_client_name', ({ deviceId, name }) => {
        if (devices[deviceId]) {
            devices[deviceId].name = name;
            io.of('/server_ui').emit('client_update', { clients: Object.values(devices).map(d => d.name) });
        }
    });

    socket.on('start_upload', ({ relativePath, size }, callback) => {
        let deviceName = "Unknown Device";
        for (const devId in devices) {
            if (devices[devId].sids.has(socket.id)) {
                deviceName = devices[devId].name;
                break;
            }
        }
        
        const transfer_id = uuidv4();
        const filename = path.basename(relativePath);
        const deviceFolder = path.join(UPLOAD_FOLDER, deviceName);
        const targetDir = path.join(deviceFolder, path.dirname(relativePath));
        console.log(`[Server] Received start_upload for '${filename}' (transfer_id: ${transfer_id})`);

        fs.mkdir(targetDir, { recursive: true }, (err) => {
            if (err) {
                 console.error(`[Server] Error creating directory for transfer ${transfer_id}:`, err);
                 callback({ status: 'error', message: 'Failed to create directory.' });
                 return;
            }
            const filepath = path.join(targetDir, filename);
            const fileStream = fs.createWriteStream(filepath);
            
            fileHandlers[transfer_id] = { stream: fileStream, path: filepath, name: filename, size, received: 0 };
            
            io.of('/server_ui').emit('transfer_started', { transfer_id, fileName: filename });
            console.log(`[Server] Sending success ack for start_upload (transfer_id: ${transfer_id})`);
            callback({ status: 'success', transfer_id });
        });
    });

    socket.on('upload_chunk', ({ transfer_id, chunk }, ack) => {
        const handler = fileHandlers[transfer_id];
        console.log(`[Server] Received chunk for transfer_id: ${transfer_id}`);
        if (handler) {
            handler.stream.write(Buffer.from(chunk), (error) => {
                if (error) {
                    console.error(`[Server] Error writing chunk for transfer ${transfer_id}:`, error);
                    if (ack) ack({ status: 'error', message: 'Server file write error.' });
                    handler.stream.end();
                    delete fileHandlers[transfer_id];
                    return;
                }

                handler.received += chunk.byteLength;
                
                io.of('/server_ui').emit('transfer_progress', {
                    transfer_id,
                    received: handler.received,
                    total: handler.size
                });

                socket.emit('client_progress', { received: handler.received, total: handler.size });
                console.log(`[Server] Wrote chunk successfully. Sending 'ok' ack for transfer_id: ${transfer_id}`);
                if (ack) ack({ status: 'ok' });
            });
        } else {
            console.warn(`[Server] Received chunk for unknown transfer_id: ${transfer_id}`);
            if (ack) ack({ status: 'error', message: 'Transfer not found' });
        }
    });

    socket.on('end_upload', ({ transfer_id }) => {
        const handler = fileHandlers[transfer_id];
        console.log(`[Server] Received end_upload for transfer_id: ${transfer_id}`);
        if (handler) {
            handler.stream.end(() => {
                socket.emit('transfer_complete', { filename: handler.name });
                io.of('/server_ui').emit('transfer_complete', { transfer_id, fileName: handler.name });
                delete fileHandlers[transfer_id];
            });
        }
    });
    
    socket.on('cancel_upload', ({ transfer_id }) => {
        const handler = fileHandlers[transfer_id];
        console.log(`[Server] Received cancel_upload for transfer_id: ${transfer_id}`);
        if (handler) {
            handler.stream.destroy();
            fs.unlink(handler.path, (err) => {
                if (err && err.code !== 'ENOENT') {
                    console.error(`[Server] Error deleting cancelled file ${handler.path}:`, err);
                }
            });
            io.of('/server_ui').emit('transfer_cancelled', { transfer_id, fileName: handler.name });
            delete fileHandlers[transfer_id];
        }
    });

    socket.on('disconnect', () => {
        let deviceIdToRemove = null;
        for (const deviceId in devices) {
            if (devices[deviceId].sids.has(socket.id)) {
                devices[deviceId].sids.delete(socket.id);
                if (devices[deviceId].sids.size === 0) deviceIdToRemove = deviceId;
                break;
            }
        }
        if (deviceIdToRemove) {
            delete devices[deviceIdToRemove];
            io.of('/server_ui').emit('client_disconnected');
            io.of('/server_ui').emit('client_update', { clients: Object.values(devices).map(d => d.name) });
        }
    });
});

const serverUi = io.of('/server_ui');
serverUi.on('connection', (socket) => {
    socket.emit('client_update', { clients: Object.values(devices).map(d => d.name) });
    socket.emit('upload_directory_updated', { path: UPLOAD_FOLDER });

    socket.on('change_server_name', ({ name }) => {
        if (name) {
            SERVER_NAME = name;
            io.emit('server_name_updated', { name: SERVER_NAME });
            serverUi.emit('server_name_updated', { name: SERVER_NAME });
        }
    });

    socket.on('change_pin', ({ pin }) => {
        if (pin && /^\d{4}$/.test(pin)) {
            pinCode = pin;
            securityToken = uuidv4();
            const urlWithToken = `http://${localIp}:${PORT}/?token=${securityToken}`;
            const displayUrl = `http://${localIp}:${PORT}`;
            
            qrcode.toDataURL(urlWithToken, (err, qrCodeDataUrl) => {
                if(err) return;
                socket.emit('pin_updated', { pin: pinCode, qr_code: qrCodeDataUrl, display_url: displayUrl });
            });
        } else {
            socket.emit('pin_update_failed', { message: 'PIN must be 4 digits.' });
        }
    });

    socket.on('change_upload_directory', ({ path: newPath }) => {
        if (newPath) {
            try {
                const resolvedPath = path.resolve(newPath);
                if (!fs.existsSync(resolvedPath)) {
                    fs.mkdirSync(resolvedPath, { recursive: true });
                }
                const tempFile = path.join(resolvedPath, `_test_write_${uuidv4()}`);
                fs.writeFileSync(tempFile, 'test');
                fs.unlinkSync(tempFile);
                UPLOAD_FOLDER = resolvedPath;
                console.log(`[Server] Upload folder changed to: ${UPLOAD_FOLDER}`);
                serverUi.emit('upload_directory_updated', { path: UPLOAD_FOLDER });
            } catch (err) {
                console.error(`[Server] Error changing upload directory to ${newPath}:`, err);
                socket.emit('upload_directory_update_failed', { message: `Failed to set directory. Check permissions.` });
            }
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    const url = `http://${localIp}:${PORT}/server`;
    console.log(`\n[Server] Dashboard running at: ${url}`);
    console.log(`[Server] Connection PIN is: ${pinCode}`);
    console.log(`[Server] Uploads will be saved to: ${UPLOAD_FOLDER}`);
    open(url);
});

