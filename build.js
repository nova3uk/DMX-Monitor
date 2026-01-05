const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const target = args.find(arg => arg.startsWith('--target='))?.split('=')[1] || 'all';

console.log('Building DMX Monitor...');
console.log(`Target: ${target}`);

// Step 1: Compile TypeScript
console.log('\n[1/3] Compiling TypeScript...');
execSync('npm run build', { stdio: 'inherit' });

// Step 2: Remove shebang from entry point (pkg will add its own)
console.log('\n[2/3] Preparing entry point for packaging...');
const entryPoint = path.join(__dirname, 'dist', 'index.js');
let entryContent = fs.readFileSync(entryPoint, 'utf8');
// Remove shebang if present
if (entryContent.startsWith('#!/usr/bin/env node\n')) {
    entryContent = entryContent.replace('#!/usr/bin/env node\n', '');
    fs.writeFileSync(entryPoint, entryContent);
    console.log('  Removed shebang from entry point');
} else if (entryContent.startsWith('#!/usr/bin/env node\r\n')) {
    entryContent = entryContent.replace('#!/usr/bin/env node\r\n', '');
    fs.writeFileSync(entryPoint, entryContent);
    console.log('  Removed shebang from entry point');
}

// Step 3: Package with pkg
console.log('\n[3/3] Packaging executable...');
// Use package.json as entry point to pick up pkg config including assets
let pkgCommand = 'pkg .';
if (target === 'win') {
    pkgCommand += ' --targets node20-win-x64 --output dist/dmx-monitor-win.exe';
} else if (target === 'mac') {
    pkgCommand += ' --targets node20-macos-x64 --output dist/dmx-monitor-mac';
} else if (target === 'linux') {
    pkgCommand += ' --targets node20-linux-x64 --output dist/dmx-monitor-linux';
} else {
    pkgCommand += ' --targets node20-win-x64,node20-macos-x64,node20-linux-x64 --output-path dist/';
}
try {
    execSync(pkgCommand, { stdio: 'inherit' });
} catch (error) {
    console.error('\n❌ pkg failed to create executable!');
    console.error('This might be due to missing dependencies or pkg configuration issues.');
    process.exit(1);
}

// Verify the output file was created
if (target === 'linux') {
    const outputFile = path.join(__dirname, 'dist', 'dmx-monitor-linux');
    if (!fs.existsSync(outputFile)) {
        console.error('\n❌ Error: Output file was not created!');
        process.exit(1);
    }
    const stats = fs.statSync(outputFile);
    console.log(`\n✅ Executable created: ${outputFile} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
    // Check if it's actually a binary (should be > 1MB for a pkg binary)
    if (stats.size < 1024 * 1024) {
        console.warn('⚠️  Warning: File size is suspiciously small. This might not be a proper pkg binary.');
    }
} else if (target === 'win') {
    const outputFile = path.join(__dirname, 'dist', 'dmx-monitor-win.exe');
    if (!fs.existsSync(outputFile)) {
        console.error('\n❌ Error: Output file was not created!');
        process.exit(1);
    }
    const stats = fs.statSync(outputFile);
    console.log(`\n✅ Executable created: ${outputFile} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
} else if (target === 'mac') {
    const outputFile = path.join(__dirname, 'dist', 'dmx-monitor-mac');
    if (!fs.existsSync(outputFile)) {
        console.error('\n❌ Error: Output file was not created!');
        process.exit(1);
    }
    const stats = fs.statSync(outputFile);
    console.log(`\n✅ Executable created: ${outputFile} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
}

console.log('\n✅ Build complete!');
