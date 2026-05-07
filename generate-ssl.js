const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Create ssl directory
const sslDir = path.join(__dirname, 'ssl');
if (!fs.existsSync(sslDir)) {
    fs.mkdirSync(sslDir);
}

console.log('Generating self-signed SSL certificate...');
console.log('');

// Generate private key and certificate using openssl
try {
    execSync(`openssl req -x509 -newkey rsa:2048 -keyout ssl/key.pem -out ssl/cert.pem -days 365 -nodes -subj "/C=PL/ST=Krakow/L=Krakow/O=DataWorkerStream/CN=localhost"`, {
        stdio: 'inherit',
        shell: true
    });

    console.log('');
    console.log('✅ SSL certificates generated successfully!');
    console.log('');
    console.log('📁 Files created:');
    console.log('   - ssl/key.pem');
    console.log('   - ssl/cert.pem');
    console.log('');
    console.log('You can now run: npm start');

} catch (error) {
    console.error('❌ Error generating certificates with openssl');
    console.log('');
    console.log('Trying alternative method with Node.js...');

    // Fallback: use selfsigned npm package
    try {
        const selfsigned = require('selfsigned');
        const attrs = [{ name: 'commonName', value: 'localhost' }];
        const pems = selfsigned.generate(attrs, {
            days: 365,
            keySize: 2048,
            algorithm: 'sha256'
        });

        fs.writeFileSync(path.join(sslDir, 'key.pem'), pems.private);
        fs.writeFileSync(path.join(sslDir, 'cert.pem'), pems.cert);

        console.log('');
        console.log('✅ SSL certificates generated successfully (using selfsigned)!');
        console.log('');
        console.log('📁 Files created:');
        console.log('   - ssl/key.pem');
        console.log('   - ssl/cert.pem');
        console.log('');
        console.log('You can now run: npm start');

    } catch (fallbackError) {
        console.error('❌ Both methods failed.');
        console.log('');
        console.log('Please install OpenSSL:');
        console.log('   Windows: https://slproweb.com/products/Win32OpenSSL.html');
        console.log('   Or use Git Bash which includes OpenSSL');
        console.log('');
        console.log('Or install selfsigned: npm install selfsigned');
        process.exit(1);
    }
}
