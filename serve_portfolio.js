const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 9090;

const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.json': 'application/json'
};

const handler = (req, res) => {
    // Decode URI to support Vietnamese characters in filenames
    const decodedUrl = decodeURIComponent(req.url);

    // API: GET or POST config
    if (decodedUrl === '/api/config') {
        const configPath = path.join(__dirname, 'config.json');
        const tmpConfigPath = path.join('/tmp', 'config.json');
        
        if (req.method === 'GET') {
            // Check if ephemeral config exists first, otherwise use default
            let activePath = configPath;
            if (fs.existsSync(tmpConfigPath)) {
                activePath = tmpConfigPath;
            }
            fs.readFile(activePath, 'utf8', (err, data) => {
                if (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                } else {
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(data);
                }
            });
            return;
        } else if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                try {
                    JSON.parse(body);
                    // Try writing locally first (for local environment)
                    fs.writeFile(configPath, body, 'utf8', (err) => {
                        if (err) {
                            // Local write failed (e.g. read-only filesystem on Vercel)
                            // Fallback to writing to ephemeral storage /tmp
                            const tmpDir = '/tmp';
                            if (!fs.existsSync(tmpDir)) {
                                fs.mkdirSync(tmpDir, { recursive: true });
                            }
                            fs.writeFile(tmpConfigPath, body, 'utf8', (tmpErr) => {
                                if (tmpErr) {
                                    res.writeHead(500, { 'Content-Type': 'application/json' });
                                    res.end(JSON.stringify({ error: tmpErr.message }));
                                } else {
                                    res.writeHead(200, { 'Content-Type': 'application/json' });
                                    res.end(JSON.stringify({ success: true, storage: 'ephemeral' }));
                                }
                            });
                        } else {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ success: true, storage: 'local' }));
                        }
                    });
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid JSON' }));
                }
            });
            return;
        }
    }

    // API: POST upload file
    if (decodedUrl === '/api/upload' && req.method === 'POST') {
        const fileName = req.headers['x-file-name'];
        if (!fileName) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing x-file-name header' }));
            return;
        }

        const safeName = path.basename(fileName).replace(/[^a-zA-Z0-9.\-_]/g, '_');
        const localUploadsDir = path.join(__dirname, 'uploads');
        const tmpUploadsDir = path.join('/tmp', 'uploads');

        // Let's check if we can write to local uploads directory
        let targetDir = localUploadsDir;
        let isEphemeral = false;

        try {
            if (!fs.existsSync(localUploadsDir)) {
                fs.mkdirSync(localUploadsDir, { recursive: true });
            }
            // Attempt to write a dummy file to check writability
            const testPath = path.join(localUploadsDir, '.test-write');
            fs.writeFileSync(testPath, 'test');
            fs.unlinkSync(testPath);
        } catch (e) {
            // Local folder is not writable (e.g. read-only filesystem on Vercel)
            targetDir = tmpUploadsDir;
            isEphemeral = true;
            if (!fs.existsSync(tmpUploadsDir)) {
                fs.mkdirSync(tmpUploadsDir, { recursive: true });
            }
        }

        const destPath = path.join(targetDir, safeName);
        const writeStream = fs.createWriteStream(destPath);

        req.pipe(writeStream);

        writeStream.on('finish', () => {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ 
                success: true, 
                path: `uploads/${safeName}`,
                storage: isEphemeral ? 'ephemeral' : 'local'
            }));
        });

        writeStream.on('error', (err) => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        });
        return;
    }

    // File serving path resolution
    let filePath = path.join(__dirname, decodedUrl === '/' ? 'index.html' : decodedUrl);
    
    // Check if the request is for an uploaded file in /tmp/uploads (on Vercel)
    if (decodedUrl.startsWith('/uploads/')) {
        const tmpFilePath = path.join('/tmp', decodedUrl);
        if (fs.existsSync(tmpFilePath)) {
            filePath = tmpFilePath;
        }
    }

    // Security check to prevent directory traversal
    const relative = path.relative(__dirname, filePath);
    // On Vercel, files under /tmp/uploads will not be under __dirname. Let's handle that case safely
    const isTmpFile = decodedUrl.startsWith('/uploads/') && filePath.startsWith('/tmp/uploads/');
    const isSafe = isTmpFile || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    
    if (decodedUrl !== '/' && !isSafe) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Truy cập bị từ chối');
        return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Không tìm thấy tệp');
            } else {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Lỗi máy chủ: ' + err.code);
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(data);
        }
    });
};

const server = http.createServer(handler);

if (require.main === module) {
    server.listen(PORT, () => {
        console.log(`Server portfolio đang chạy tại http://localhost:${PORT}`);
    });
}

module.exports = handler;
