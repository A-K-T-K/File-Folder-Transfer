const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const os = require('os');
const open = require('open');
const { v4: uuidv4 } = require('uuid');
const qrcode = require('qrcode');

// --- Configuration ---
const PORT = process.env.PORT || 5000;
const DESKTOP_PATH = path.join(os.homedir(), 'Desktop');
let UPLOAD_FOLDER = path.join(DESKTOP_PATH, 'FileTransfer_Received');
let SERVER_NAME = 'My Local Server';

// --- Setup ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 50 * 1024 * 1024,
    cors: { origin: '*' },
    // File chunks are already binary/incompressible in practice — deflating them
    // just burns CPU on both ends for no throughput gain. Disabling this is the
    // single biggest lever for raw transfer speed over Socket.IO.
    perMessageDeflate: false
});

// --- Global State ---
let fileHandlers = {};       // transfer_id -> { socketId, stream, path, name, size, received, completed }
let socketTransfers = {};    // socket.id -> Set of transfer_id
let devices = {};            // deviceId -> { name, sids: Set }
let outgoingBatches = {};    // batchId -> { deviceId, targetSid, files: [{transferId, fileName, filePath, size}], nextIndex }
let pinCode = Math.floor(1000 + Math.random() * 9000).toString();
let securityToken = uuidv4();
const activityLogs = [];
const MAX_LOGS = 100;

// --- Logger Helper ---
function logMessage(msg) {
    const timestamp = new Date().toLocaleTimeString();
    const formatted = `[${timestamp}] ${msg}`;
    console.log(`[Server] ${formatted}`);
    activityLogs.push(formatted);
    if (activityLogs.length > MAX_LOGS) {
        activityLogs.shift();
    }
    io.of('/server_ui').emit('log_message', { message: formatted });
}

// --- Intelligent Multi-Adapter Speed-Tier Scanner ---
function getRankedNetworkInterfaces() {
    const nets = os.networkInterfaces();
    const interfaces = [];
    const virtualRegex = /vEthernet|docker|wsl|virtual|vbox|vmnet|loopback|tailscale|tap|tun/i;
    
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                const isVirtual = virtualRegex.test(name);
                let tier = 'wifi';
                let speedLabel = 'Wi-Fi LAN (Normal)';
                let score = 50;

                // Tier 1: USB Tethering (Apple Mobile Device, Android NDIS, RNDIS, Remote NDIS)
                if (/rndis|ncm|tether|apple mobile|android|usb/i.test(name) || /^192\.168\.42\./.test(net.address) || /^172\.20\.10\./.test(net.address)) {
                    tier = 'usb';
                    speedLabel = '⚡ USB Tethering (Ultra-Fast Hardware Link)';
                    score = 100;
                }
                // Tier 2: Direct Hotspot / SoftAP / Hosted Network
                else if (/^192\.168\.137\./.test(net.address) || /^192\.168\.43\./.test(net.address) || /hosted|hotspot|direct|ap/i.test(name)) {
                    tier = 'hotspot';
                    speedLabel = '📡 Direct Hotspot (Direct Point-to-Point)';
                    score = 90;
                }
                // Tier 3: Gigabit Ethernet (Wired LAN)
                else if (/ethernet|eth|en/i.test(name) && !isVirtual) {
                    tier = 'ethernet';
                    speedLabel = '🔌 Gigabit Ethernet (Wired High-Speed)';
                    score = 80;
                }
                // Tier 4: Wi-Fi LAN
                else if (/wi-fi|wlan/i.test(name) && !isVirtual) {
                    tier = 'wifi';
                    speedLabel = '📶 Wi-Fi LAN';
                    score = 70;
                } else if (isVirtual) {
                    tier = 'virtual';
                    speedLabel = '💻 Virtual Adapter';
                    score = 10;
                }

                interfaces.push({
                    name,
                    address: net.address,
                    tier,
                    speedLabel,
                    score
                });
            }
        }
    }

    // Sort by fastest score first
    interfaces.sort((a, b) => b.score - a.score);
    return interfaces;
}

let activeInterfaceIndex = 0;
function getActiveLocalIp() {
    const ranked = getRankedNetworkInterfaces();
    if (ranked.length > 0) {
        if (activeInterfaceIndex >= ranked.length) activeInterfaceIndex = 0;
        return ranked[activeInterfaceIndex].address;
    }
    return '127.0.0.1';
}

let localIp = getActiveLocalIp();

// --- Security & Path Helpers ---
function sanitizeSegment(segment) {
    if (!segment) return '_';
    // Remove null bytes and illegal characters across Windows and POSIX
    return segment
        .replace(/[\x00-\x1f<>:"/\\|?*]/g, '_')
        .replace(/^\.+/, '') // remove leading dots (prevents relative directory traversal)
        .trim() || '_';
}

function resolveSafeUploadPath(baseUploadDir, deviceName, rawRelativePath) {
    const safeDeviceName = sanitizeSegment(deviceName || 'Unknown_Device');
    const deviceRoot = path.join(path.resolve(baseUploadDir), safeDeviceName);

    // Normalize forward and back slashes, split into segments and sanitize each
    const normalized = (rawRelativePath || '').replace(/\\/g, '/');
    const segments = normalized.split('/').filter(s => s.length > 0 && s !== '.' && s !== '..');

    if (segments.length === 0) {
        segments.push(`file_${Date.now()}`);
    }

    const safeSegments = segments.map(sanitizeSegment);
    const filename = safeSegments.pop();
    const targetDir = path.join(deviceRoot, ...safeSegments);
    const fullPath = path.join(targetDir, filename);

    // Strict boundary check: fullPath must be inside baseUploadDir
    const resolvedBase = path.resolve(baseUploadDir);
    const resolvedTarget = path.resolve(fullPath);

    if (!resolvedTarget.startsWith(resolvedBase + path.sep) && resolvedTarget !== resolvedBase) {
        throw new Error('Path traversal attempt detected');
    }

    return { targetDir, filename, fullPath };
}

// Mirrors the client-side uploader's tiering (server.js's /uploader.js) so
// server-to-client sends use the same well-tuned chunk sizes.
function getDownloadChunkSize(fileSize) {
    if (fileSize < 5 * 1024 * 1024) return 64 * 1024;
    if (fileSize < 50 * 1024 * 1024) return 256 * 1024;
    if (fileSize < 500 * 1024 * 1024) return 1024 * 1024;
    return 2 * 1024 * 1024;
}

// Streams the next queued file in an outgoing batch down to the target device,
// one chunk at a time, waiting for each chunk's ack before reading more —
// same backpressure-safe approach as the upload path, just in the other direction.
function sendNextFileInBatch(batchId) {
    const batch = outgoingBatches[batchId];
    if (!batch) return;

    if (batch.nextIndex >= batch.files.length) {
        delete outgoingBatches[batchId];
        return;
    }

    const file = batch.files[batch.nextIndex++];
    const targetSocket = io.sockets.sockets.get(batch.targetSid);

    if (!targetSocket) {
        logMessage(`Send failed: '${file.fileName}' — device is no longer connected.`);
        io.of('/server_ui').emit('transfer_cancelled', { transfer_id: file.transferId, fileName: `→ ${file.fileName}` });
        sendNextFileInBatch(batchId);
        return;
    }

    const chunkSize = getDownloadChunkSize(file.size);
    const readStream = fs.createReadStream(file.filePath, { highWaterMark: chunkSize });
    let sent = 0;
    let index = 0;
    let lastProgressEmit = 0;
    let settled = false;

    io.of('/server_ui').emit('transfer_started', { transfer_id: file.transferId, fileName: `→ ${file.fileName}` });
    readStream.pause();

    function finish(cancelled) {
        if (settled) return;
        settled = true;
        readStream.destroy();
        if (cancelled) {
            io.of('/server_ui').emit('transfer_cancelled', { transfer_id: file.transferId, fileName: `→ ${file.fileName}` });
        }
        sendNextFileInBatch(batchId);
    }

    function sendNext() {
        if (settled) return;
        const chunk = readStream.read();
        if (chunk === null) return; // wait for the next 'readable' event
        targetSocket.emit('download_chunk', { transfer_id: file.transferId, chunk, index: index++ }, (response) => {
            if (settled) return;
            if (!response || response.status !== 'ok') {
                logMessage(`Device rejected chunk for '${file.fileName}'.`);
                finish(true);
                return;
            }
            sent += chunk.length;
            const now = Date.now();
            if (sent >= file.size || now - lastProgressEmit >= 100) {
                lastProgressEmit = now;
                io.of('/server_ui').emit('transfer_progress', { transfer_id: file.transferId, received: sent, total: file.size });
            }
            sendNext();
        });
    }

    readStream.on('readable', sendNext);
    readStream.on('end', () => {
        if (settled) return;
        settled = true;
        targetSocket.emit('download_file_complete', { transfer_id: file.transferId, fileName: file.fileName });
        io.of('/server_ui').emit('transfer_complete', { transfer_id: file.transferId, fileName: `→ ${file.fileName}` });
        logMessage(`Sent '${file.fileName}' to device.`);
        sendNextFileInBatch(batchId);
    });
    readStream.on('error', (err) => {
        logMessage(`Error reading '${file.fileName}' to send: ${err.message}`);
        finish(true);
    });
}

// --- Express Middleware & Routes ---
app.use(express.json());

app.get('/', (req, res) => {
    fs.readFile(path.join(__dirname, 'index.html'), 'utf8', (err, data) => {
        if (err) {
            res.status(500).send('Error loading client page.');
            return;
        }
        const token = req.query.token || 'None';
        res.send(data.replace(/\{\{\s*token\s*\}\}/g, token));
    });
});

app.get('/server', (req, res) => {
    fs.readFile(path.join(__dirname, 'server.html'), 'utf8', (err, data) => {
        if (err) {
            res.status(500).send('Error loading server dashboard.');
            return;
        }
        const urlWithToken = `http://${localIp}:${PORT}/?token=${securityToken}`;
        const displayUrl = `http://${localIp}:${PORT}`;

        qrcode.toDataURL(urlWithToken, (qrErr, qrCodeDataUrl) => {
            if (qrErr) {
                console.error('QR Code Generation Error:', qrErr);
                res.status(500).send('Error generating QR code.');
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

app.get('/icon.svg', (req, res) => {
    res.type('image/svg+xml');
    res.sendFile(path.join(__dirname, 'icon.svg'));
});

app.post('/open-uploads-folder', (req, res) => {
    try {
        if (!fs.existsSync(UPLOAD_FOLDER)) {
            fs.mkdirSync(UPLOAD_FOLDER, { recursive: true });
        }
        open(UPLOAD_FOLDER)
            .then(() => {
                logMessage(`Opened upload folder: ${UPLOAD_FOLDER}`);
                res.json({ status: 'success' });
            })
            .catch(err => {
                logMessage(`Could not open folder automatically: ${err.message}`);
                res.status(500).json({ status: 'error', message: err.message });
            });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// --- Content for the Web Worker ---
const uploaderScript = `
let currentFile = null;
let transferId = null;
let chunkIndex = 0;
let chunkSize = 0;
let inFlight = 0;
const MAX_IN_FLIGHT = 16; // Wider sliding window: more chunks in flight so throughput isn't capped by RTT
let isPaused = false;
let isFinishedReading = false;

function getChunkSize(fileSize) {
    if (fileSize < 5 * 1024 * 1024) {        // < 5MB
        return 64 * 1024;                    // 64 KB
    }
    if (fileSize < 50 * 1024 * 1024) {       // < 50MB
        return 256 * 1024;                   // 256 KB
    }
    if (fileSize < 500 * 1024 * 1024) {      // < 500MB
        return 1024 * 1024;                  // 1 MB
    }
    return 2 * 1024 * 1024;                  // 2 MB (fewer round-trips on huge files)
}

self.onmessage = (event) => {
    const { type, payload } = event.data;

    if (type === 'process_file') {
        currentFile = payload.file;
        transferId = payload.transfer_id;
        chunkIndex = 0;
        inFlight = 0;
        isPaused = false;
        isFinishedReading = false;
        chunkSize = getChunkSize(currentFile.size);

        if (currentFile.size === 0) {
            self.postMessage({ type: 'file_complete', payload: { transfer_id: transferId } });
            currentFile = null;
            return;
        }

        pumpPipeline();
    } else if (type === 'ack_chunk') {
        inFlight = Math.max(0, inFlight - 1);
        if (isFinishedReading && inFlight === 0) {
            self.postMessage({ type: 'file_complete', payload: { transfer_id: transferId } });
            currentFile = null;
        } else {
            pumpPipeline();
        }
    } else if (type === 'pause') {
        isPaused = true;
    } else if (type === 'resume') {
        isPaused = false;
        pumpPipeline();
    }
};

function pumpPipeline() {
    if (!currentFile || isPaused || isFinishedReading) return;

    while (inFlight < MAX_IN_FLIGHT && !isFinishedReading && !isPaused) {
        const start = chunkIndex * chunkSize;
        if (start >= currentFile.size) {
            isFinishedReading = true;
            if (inFlight === 0) {
                self.postMessage({ type: 'file_complete', payload: { transfer_id: transferId } });
                currentFile = null;
            }
            return;
        }

        const end = Math.min(start + chunkSize, currentFile.size);
        const chunk = currentFile.slice(start, end);
        const thisIndex = chunkIndex;
        chunkIndex++;
        inFlight++;

        const reader = new FileReader();
        reader.onload = (e) => {
            const chunkData = e.target.result;
            self.postMessage({
                type: 'chunk',
                payload: { chunk: chunkData, transfer_id: transferId, index: thisIndex }
            }, [chunkData]); // Zero-copy ArrayBuffer transfer
        };

        reader.onerror = () => {
            self.postMessage({ type: 'error', payload: { message: 'File read error on client.' } });
        };

        reader.readAsArrayBuffer(chunk);
    }
}
`;

app.get('/uploader.js', (req, res) => {
    res.type('application/javascript');
    res.send(uploaderScript);
});

// --- Socket.IO Handlers ---
io.on('connection', (socket) => {
    socketTransfers[socket.id] = new Set();

    socket.on('register_client', (data) => {
        const { deviceId, name, token, pin } = data || {};
        let isAuthenticated = false;

        if (token && token === securityToken) isAuthenticated = true;
        else if (pin && String(pin).trim() === String(pinCode).trim()) isAuthenticated = true;

        if (isAuthenticated) {
            const cleanName = sanitizeSegment(name || 'Device');
            logMessage(`Device authenticated: ${cleanName} (${deviceId ? deviceId.substring(0, 8) : 'unknown'})`);

            if (!devices[deviceId]) {
                devices[deviceId] = { name: cleanName, sids: new Set() };
                io.of('/server_ui').emit('client_connected');
            } else {
                devices[deviceId].name = cleanName;
            }
            devices[deviceId].sids.add(socket.id);

            io.of('/server_ui').emit('client_update', { clients: Object.entries(devices).map(([id, d]) => ({ id, name: d.name })) });
            socket.emit('auth_successful');
            socket.emit('server_info', { name: SERVER_NAME });
        } else {
            logMessage(`Authentication failed for device: ${name || 'Unknown'}`);
            socket.emit('auth_failed');
        }
    });

    socket.on('change_client_name', ({ deviceId, name }) => {
        if (devices[deviceId]) {
            const cleanName = sanitizeSegment(name || 'Device');
            devices[deviceId].name = cleanName;
            logMessage(`Device renamed to: ${cleanName}`);
            io.of('/server_ui').emit('client_update', { clients: Object.entries(devices).map(([id, d]) => ({ id, name: d.name })) });
        }
    });

    socket.on('start_upload', ({ relativePath, size }, callback) => {
        if (typeof callback !== 'function') return;

        let deviceName = 'Unknown_Device';
        for (const devId in devices) {
            if (devices[devId].sids.has(socket.id)) {
                deviceName = devices[devId].name;
                break;
            }
        }

        try {
            const { targetDir, filename, fullPath } = resolveSafeUploadPath(UPLOAD_FOLDER, deviceName, relativePath);
            const transfer_id = uuidv4();

            fs.mkdir(targetDir, { recursive: true }, (err) => {
                if (err) {
                    logMessage(`Error creating directory for transfer: ${err.message}`);
                    callback({ status: 'error', message: 'Failed to create directory.' });
                    return;
                }

                // Create high-throughput write stream with 1MB buffer (TCP matched)
                const fileStream = fs.createWriteStream(fullPath, { highWaterMark: 1024 * 1024 });

                fileStream.on('error', (streamErr) => {
                    logMessage(`Stream error on ${filename}: ${streamErr.message}`);
                    if (fileHandlers[transfer_id]) {
                        delete fileHandlers[transfer_id];
                    }
                    if (socketTransfers[socket.id]) {
                        socketTransfers[socket.id].delete(transfer_id);
                    }
                });

                fileHandlers[transfer_id] = {
                    socketId: socket.id,
                    stream: fileStream,
                    path: fullPath,
                    name: filename,
                    size: Number(size) || 0,
                    received: 0,
                    completed: false,
                    lastProgressEmit: 0
                };

                if (socketTransfers[socket.id]) {
                    socketTransfers[socket.id].add(transfer_id);
                }

                logMessage(`Upload started: '${filename}' (${(Number(size) / (1024 * 1024)).toFixed(2)} MB) from ${deviceName}`);
                io.of('/server_ui').emit('transfer_started', { transfer_id, fileName: filename });
                callback({ status: 'success', transfer_id });
            });
        } catch (secErr) {
            logMessage(`Security violation on upload path: ${secErr.message}`);
            callback({ status: 'error', message: 'Invalid or forbidden file path.' });
        }
    });

    socket.on('upload_chunk', ({ transfer_id, chunk }, ack) => {
        const handler = fileHandlers[transfer_id];
        if (!handler || !handler.stream || handler.completed) {
            if (ack) ack({ status: 'error', message: 'Transfer not found or already closed' });
            return;
        }

        try {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const canAcceptMore = handler.stream.write(buf);
            handler.received += buf.length;

            // Progress events don't need to fire per-chunk — that floods the socket
            // with JSON frames that compete with the actual file data. Throttle to
            // ~10/sec per transfer, but always let the final (100%) update through.
            const now = Date.now();
            const isDone = handler.received >= handler.size;
            if (isDone || now - handler.lastProgressEmit >= 100) {
                handler.lastProgressEmit = now;
                io.of('/server_ui').emit('transfer_progress', {
                    transfer_id,
                    received: handler.received,
                    total: handler.size
                });
                socket.emit('client_progress', { transfer_id, received: handler.received, total: handler.size });
            }

            if (canAcceptMore) {
                if (ack) ack({ status: 'ok' });
            } else {
                // Backpressure: wait for write stream to drain before acking
                handler.stream.once('drain', () => {
                    if (ack) ack({ status: 'ok' });
                });
            }
        } catch (chunkErr) {
            logMessage(`Chunk processing exception: ${chunkErr.message}`);
            if (ack) ack({ status: 'error', message: chunkErr.message });
        }
    });

    socket.on('end_upload', ({ transfer_id }) => {
        const handler = fileHandlers[transfer_id];
        if (handler && handler.stream && !handler.completed) {
            handler.completed = true;
            handler.stream.end(() => {
                logMessage(`Completed file: '${handler.name}' (${handler.path})`);
                socket.emit('transfer_complete', { filename: handler.name });
                io.of('/server_ui').emit('transfer_complete', { transfer_id, fileName: handler.name });
                delete fileHandlers[transfer_id];
                if (socketTransfers[socket.id]) {
                    socketTransfers[socket.id].delete(transfer_id);
                }
            });
        }
    });

    socket.on('respond_transfer_offer', ({ batchId, accept }, ack) => {
        const batch = outgoingBatches[batchId];
        if (!batch || batch.targetSid !== socket.id) {
            if (ack) ack({ status: 'error', message: 'Offer not found or expired.' });
            return;
        }

        if (!accept) {
            logMessage(`Device declined incoming files (${batch.files.length} file(s)).`);
            batch.files.forEach(f => {
                io.of('/server_ui').emit('transfer_declined', { transfer_id: f.transferId, fileName: f.fileName });
            });
            delete outgoingBatches[batchId];
            if (ack) ack({ status: 'ok' });
            return;
        }

        logMessage(`Device accepted incoming files (${batch.files.length} file(s)).`);
        if (ack) ack({ status: 'ok' });
        sendNextFileInBatch(batchId);
    });

    socket.on('cancel_upload', ({ transfer_id }) => {
        const handler = fileHandlers[transfer_id];
        if (handler) {
            logMessage(`Upload cancelled for: '${handler.name}'`);
            handler.completed = true;
            handler.stream.destroy();
            fs.unlink(handler.path, (err) => {
                if (err && err.code !== 'ENOENT') {
                    console.error(`Error deleting cancelled file ${handler.path}:`, err);
                }
            });
            io.of('/server_ui').emit('transfer_cancelled', { transfer_id, fileName: handler.name });
            delete fileHandlers[transfer_id];
            if (socketTransfers[socket.id]) {
                socketTransfers[socket.id].delete(transfer_id);
            }
        }
    });

    socket.on('disconnect', () => {
        // Cleanup all ongoing transfers initiated by this socket
        const activeIds = socketTransfers[socket.id];
        if (activeIds && activeIds.size > 0) {
            activeIds.forEach(transfer_id => {
                const handler = fileHandlers[transfer_id];
                if (handler && !handler.completed) {
                    logMessage(`Client disconnected mid-transfer. Cleaning up '${handler.name}'`);
                    handler.stream.destroy();
                    fs.unlink(handler.path, () => {});
                    io.of('/server_ui').emit('transfer_cancelled', { transfer_id, fileName: handler.name });
                    delete fileHandlers[transfer_id];
                }
            });
        }
        delete socketTransfers[socket.id];

        // Device presence cleanup
        let deviceIdToRemove = null;
        let disconnectedDeviceName = 'Unknown Device';
        for (const deviceId in devices) {
            if (devices[deviceId].sids.has(socket.id)) {
                devices[deviceId].sids.delete(socket.id);
                disconnectedDeviceName = devices[deviceId].name;
                if (devices[deviceId].sids.size === 0) {
                    deviceIdToRemove = deviceId;
                }
                break;
            }
        }

        if (deviceIdToRemove) {
            delete devices[deviceIdToRemove];
            logMessage(`Device disconnected: ${disconnectedDeviceName}`);
            io.of('/server_ui').emit('client_disconnected');
            io.of('/server_ui').emit('client_update', { clients: Object.entries(devices).map(([id, d]) => ({ id, name: d.name })) });
        }
    });
});

// --- Server UI Namespace ---
const serverUi = io.of('/server_ui');
serverUi.on('connection', (socket) => {
    socket.emit('client_update', { clients: Object.entries(devices).map(([id, d]) => ({ id, name: d.name })) });
    socket.emit('upload_directory_updated', { path: UPLOAD_FOLDER });
    socket.emit('log_history', { logs: activityLogs });
    socket.emit('interfaces_list', {
        interfaces: getRankedNetworkInterfaces(),
        activeAddress: localIp,
        pin: pinCode
    });

    socket.on('change_server_name', ({ name }) => {
        if (name && name.trim()) {
            SERVER_NAME = name.trim();
            logMessage(`Server renamed to: ${SERVER_NAME}`);
            io.emit('server_name_updated', { name: SERVER_NAME });
            serverUi.emit('server_name_updated', { name: SERVER_NAME });
        }
    });

    socket.on('change_pin', ({ pin }) => {
        const trimmed = String(pin || '').trim();
        if (/^\d{4}$/.test(trimmed)) {
            pinCode = trimmed;
            securityToken = uuidv4();
            const urlWithToken = `http://${localIp}:${PORT}/?token=${securityToken}`;
            const displayUrl = `http://${localIp}:${PORT}`;

            qrcode.toDataURL(urlWithToken, (err, qrCodeDataUrl) => {
                if (err) return;
                logMessage(`PIN updated to: ${pinCode}`);
                serverUi.emit('pin_updated', {
                    pin: pinCode,
                    qr_code: qrCodeDataUrl,
                    display_url: displayUrl
                });
            });
        } else {
            socket.emit('pin_update_failed', { message: 'PIN must be exactly 4 digits.' });
        }
    });

    socket.on('select_interface', ({ address }) => {
        if (address) {
            localIp = address;
            const urlWithToken = `http://${localIp}:${PORT}/?token=${securityToken}`;
            const displayUrl = `http://${localIp}:${PORT}`;

            qrcode.toDataURL(urlWithToken, (err, qrCodeDataUrl) => {
                if (err) return;
                logMessage(`Switched active network to: ${localIp}`);
                serverUi.emit('network_interface_changed', {
                    activeAddress: localIp,
                    display_url: displayUrl,
                    qr_code: qrCodeDataUrl
                });
            });
        }
    });

    socket.on('refresh_interfaces', () => {
        const ranked = getRankedNetworkInterfaces();
        socket.emit('interfaces_list', {
            interfaces: ranked,
            activeAddress: localIp,
            pin: pinCode
        });
    });

    socket.on('send_files', ({ deviceId, filePaths }, callback) => {
        if (typeof callback !== 'function') return;

        const device = devices[deviceId];
        if (!device || device.sids.size === 0) {
            callback({ status: 'error', message: 'That device is no longer connected.' });
            return;
        }
        if (!Array.isArray(filePaths) || filePaths.length === 0) {
            callback({ status: 'error', message: 'No files were selected.' });
            return;
        }

        const targetSid = device.sids.values().next().value;
        const files = [];

        try {
            for (const filePath of filePaths) {
                const stat = fs.statSync(filePath);
                if (!stat.isFile()) continue;
                files.push({
                    transferId: uuidv4(),
                    fileName: path.basename(filePath),
                    filePath,
                    size: stat.size
                });
            }
        } catch (err) {
            callback({ status: 'error', message: `Could not read selected file: ${err.message}` });
            return;
        }

        if (files.length === 0) {
            callback({ status: 'error', message: 'None of the selected paths are readable files.' });
            return;
        }

        const batchId = uuidv4();
        outgoingBatches[batchId] = { deviceId, targetSid, files, nextIndex: 0 };

        const targetSocket = io.sockets.sockets.get(targetSid);
        if (targetSocket) {
            targetSocket.emit('incoming_transfer_offer', {
                batchId,
                fromServer: SERVER_NAME,
                files: files.map(f => ({ transferId: f.transferId, fileName: f.fileName, size: f.size }))
            });
        }

        logMessage(`Offered ${files.length} file(s) to ${device.name}.`);
        callback({
            status: 'success',
            batchId,
            files: files.map(f => ({ transferId: f.transferId, fileName: f.fileName, size: f.size }))
        });
    });

    socket.on('change_upload_directory', ({ path: newPath }) => {
        if (newPath && newPath.trim()) {
            try {
                const resolvedPath = path.resolve(newPath.trim());
                if (!fs.existsSync(resolvedPath)) {
                    fs.mkdirSync(resolvedPath, { recursive: true });
                }
                const tempFile = path.join(resolvedPath, `_test_write_${uuidv4()}`);
                fs.writeFileSync(tempFile, 'test');
                fs.unlinkSync(tempFile);
                UPLOAD_FOLDER = resolvedPath;
                logMessage(`Upload directory changed to: ${UPLOAD_FOLDER}`);
                serverUi.emit('upload_directory_updated', { path: UPLOAD_FOLDER });
            } catch (err) {
                logMessage(`Failed to set directory '${newPath}': ${err.message}`);
                socket.emit('upload_directory_update_failed', { message: `Failed to set directory: ${err.message}` });
            }
        }
    });
});

// --- Start Server ---
server.listen(PORT, '0.0.0.0', () => {
    const url = `http://${localIp}:${PORT}/server`;
    console.log(`\n======================================================`);
    console.log(`  File-Folder Transfer Server Running`);
    console.log(`  Dashboard:  ${url}`);
    console.log(`  Local IP:   ${localIp}:${PORT}`);
    console.log(`  PIN:        ${pinCode}`);
    console.log(`  Save Dir:   ${UPLOAD_FOLDER}`);
    console.log(`======================================================\n`);
    logMessage(`Server started at http://${localIp}:${PORT}`);

    if (!process.env.TAURI_ENV_DEBUG && !process.env.TAURI_DEV && !process.env.TAURI_PLATFORM) {
        open(url).catch((err) => {
            console.log(`[Info] Headless or non-GUI environment, could not open browser: ${err.message}`);
        });
    }
});

